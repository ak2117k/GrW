import { Inject, Injectable, Logger, type OnApplicationBootstrap } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { RiskManagerService } from '../../trade-engine/services/risk-manager.service';
import type { ExecuteTradeDto } from '../../trade-engine/dto/trade.dto';
import { isLiveTradingEnabled } from '../../trade-engine/live-trading';
import { coreEntryAllowed } from '../../trade-core/risk-wall/kill-gate';
import { sendOpsAlert } from '../../../common/utils/ops-alert';
import { bootJobsEnabled } from '../../../common/utils/boot-jobs';
import { SignalTraderRepository } from '../repositories/signal-trader.repository';
import { resolveContract, segmentFor, type ResolveResult } from '../domain/contract-resolver';
import { applyJudgeTightening, evaluateGate, planEntry, type EntryPlan, type GateCheck, type GateFacts } from '../domain/gate';
import { judgeDecision, SIGNAL_JUDGE_PROMPT_VERSION } from '../domain/judge';
import { slEnforceability } from '../domain/execution';
import { skipAlert, takeAlert, updateAlert } from '../domain/alerts';
import { SIGNAL_READY, SIGNAL_UPDATE, type SignalReadyEvent, type SignalUpdateEvent, type SignalView } from '../domain/signal.types';
import type { SignalTraderConfig } from '../domain/signal-trader.config';
import { SignalJudgeService } from './signal-judge.service';
import { SignalContextService } from './signal-context.service';
import { SignalExecutorService } from './signal-executor.service';

export const SIGNAL_TRADER_CONFIG = Symbol('SIGNAL_TRADER_CONFIG');
export const SIGNAL_TRADER_ENV = Symbol('SIGNAL_TRADER_ENV');
/** Holiday-aware session clock (market-hub SessionClock). */
export const SIGNAL_SESSION_CLOCK = Symbol('SIGNAL_SESSION_CLOCK');
/** The Angel scrip master (raw rows). */
export const SIGNAL_INSTRUMENT_MASTER = Symbol('SIGNAL_INSTRUMENT_MASTER');
/** A fresh LTP over the owner's own Angel session. */
export const SIGNAL_QUOTES = Symbol('SIGNAL_QUOTES');

export interface SessionClockLike {
  isOpen(exchange: string, at?: Date): boolean;
  minutesToClose(exchange: string, at?: Date): number | null;
}
export interface InstrumentMasterLike {
  getInstrumentMaster(): Promise<unknown[]>;
}
export interface QuotesLike {
  ltp(userId: string, token: string, exchange: string): Promise<number | null>;
}

/** Re-evaluations allowed for one signal (a low-confidence SKIP upgraded by corroboration). */
const MAX_EVALUATIONS = 3;

export interface EvaluationResult {
  decisionId: string;
  decision: 'TAKE' | 'SKIP';
  skipReason: string | null;
  placed?: string;
}

const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));

export function describeSignal(s: SignalView): string {
  const inst = s.instrumentKind === 'CE' || s.instrumentKind === 'PE' ? `${s.underlying} ${s.strike ?? '?'} ${s.instrumentKind}` : `${s.underlying} ${s.instrumentKind}`;
  const entry = s.entryType === 'RANGE' ? `${s.entryLow}-${s.entryHigh}` : `${s.entryType} ${s.entryLow}`;
  return `${s.side} ${inst} ${entry} SL ${s.sl ?? 'none'} T ${s.targets.join('/') || 'none'}`;
}

/**
 * Stream X orchestrator: `signal.ready` → deterministic gate → AI judge → (live) LIMIT entry /
 * (shadow) record only → alerts. Evaluations are SERIALISED (one at a time) so two channels posting
 * the same trade cannot both pass "not holding" / "cluster not taken" in a race; the DB claims
 * (unique decision per signal+evaluation, unique order per decision) are the durable backstop.
 */
@Injectable()
export class SignalTraderService implements OnApplicationBootstrap {
  private readonly logger = new Logger(SignalTraderService.name);
  private chain: Promise<unknown> = Promise.resolve();

  constructor(
    @Inject(SIGNAL_TRADER_CONFIG) private readonly cfg: SignalTraderConfig,
    @Inject(SIGNAL_TRADER_ENV) private readonly env: Record<string, string | undefined>,
    private readonly repo: SignalTraderRepository,
    private readonly judge: SignalJudgeService,
    private readonly context: SignalContextService,
    private readonly executor: SignalExecutorService,
    private readonly risk: RiskManagerService,
    @Inject(SIGNAL_SESSION_CLOCK) private readonly clock: SessionClockLike,
    @Inject(SIGNAL_INSTRUMENT_MASTER) private readonly master: InstrumentMasterLike,
    @Inject(SIGNAL_QUOTES) private readonly quotes: QuotesLike,
  ) {}

  get config(): SignalTraderConfig {
    return this.cfg;
  }

  onApplicationBootstrap(): void {
    for (const p of this.cfg.problems) this.logger.warn(`[signal-trader] ${p}`);
    this.logger.warn(`[signal-trader] mode=${this.cfg.mode} maxLots=${this.cfg.maxLots} maxLoss=₹${this.cfg.maxLossPerTrade} trades/day=${this.cfg.maxTradesPerDay} dailyStop=₹${this.cfg.dailyLossStop}`);
    if (this.cfg.mode === 'live' && bootJobsEnabled()) {
      void this.repo
        .pendingOrders(new Date())
        .then((rows) => this.executor.resume(rows, this.cfg.fillWaitSec))
        .catch((err) => this.logger.error(`[signal-trader] resuming open orders failed: ${errText(err)}`));
    }
  }

  @OnEvent(SIGNAL_READY)
  onReady(e: SignalReadyEvent): Promise<EvaluationResult | null> {
    if (this.cfg.mode === 'off' || !e?.signalId) return Promise.resolve(null);
    return this.enqueue(() => this.evaluate(e));
  }

  @OnEvent(SIGNAL_UPDATE)
  onUpdate(e: SignalUpdateEvent): Promise<void> {
    if (this.cfg.mode === 'off') return Promise.resolve();
    return this.handleUpdate(e).catch((err) => this.logger.warn(`[signal-trader] update failed: ${errText(err)}`));
  }

  private enqueue<T>(work: () => Promise<T>): Promise<T> {
    const run = this.chain.then(work, work);
    this.chain = run.catch(() => undefined);
    return run;
  }

  /** One evaluation of one signal. Never throws: every claimed decision is finished. */
  async evaluate(e: SignalReadyEvent, now: Date = new Date()): Promise<EvaluationResult | null> {
    const prior = await this.repo.decisionsFor(e.signalId);
    let evaluation = 1;
    if (prior.length > 0) {
      if (prior.some((d) => d.decision === 'TAKE' || d.status === 'PENDING')) return null;
      const last = prior[prior.length - 1];
      const corroborated = last.skipReason === 'low_confidence' && e.agreeCount > (last.agreeCount ?? 0);
      if (!corroborated || prior.length >= MAX_EVALUATIONS) return null;
      evaluation = last.evaluation + 1;
    }

    const owner = this.cfg.ownerUserId;
    let signal: SignalView | null = null;
    let readError: string | null = null;
    try {
      signal = await this.repo.signal(e.signalId);
    } catch (err) {
      readError = errText(err);
    }
    const decisionId = await this.repo.claimDecision({
      signalId: e.signalId,
      evaluation,
      clusterId: e.clusterId ?? null,
      channelId: signal?.channelId ?? null,
      userId: owner,
      underlying: signal?.underlying ?? null,
      mode: this.cfg.mode,
      agreeCount: e.agreeCount,
      conflict: e.conflict === true,
    });
    if (!decisionId) return null; // a duplicate event: someone else is evaluating it

    if (!signal) {
      return this.skip(decisionId, 'signal_unreadable', readError ?? 'the signal is missing or not tradable as stated', [], null, null, 'unknown channel', e.signalId);
    }
    const channel = await this.repo.channelTitle(signal.channelId).catch(() => signal!.channelId ?? 'unknown channel');
    try {
      return await this.pipeline(decisionId, signal, e, channel, now);
    } catch (err) {
      this.logger.error(`[signal-trader] evaluation of ${e.signalId} failed: ${errText(err)}`);
      return this.skip(decisionId, 'internal_error', errText(err), [], null, null, channel, describeSignal(signal));
    }
  }

  private async pipeline(decisionId: string, s: SignalView, e: SignalReadyEvent, channel: string, now: Date): Promise<EvaluationResult> {
    const cfg = this.cfg;
    const owner = cfg.ownerUserId;
    const what = describeSignal(s);
    const exchange = segmentFor(s);

    // ---- facts ----
    let contract: ResolveResult | null = null;
    try {
      contract = resolveContract(await this.master.getInstrumentMaster(), s, now);
    } catch (err) {
      contract = { ok: false, reason: `instrument master unavailable: ${errText(err)}` };
    }
    const c = contract.ok ? contract.contract : null;
    let marketOpen: boolean | null = null;
    let minutesToClose: number | null = null;
    try {
      marketOpen = this.clock.isOpen(c?.exchange ?? exchange, now);
      minutesToClose = this.clock.minutesToClose(c?.exchange ?? exchange, now);
    } catch {
      marketOpen = null;
    }
    const ltp = c && owner ? await this.quotes.ltp(owner, c.token, c.exchange).catch(() => null) : null;
    let engineSl: number | null = null;
    if (s.sl === null && s.instrumentKind === 'EQ' && ltp) {
      const lv = await this.context.nearestLevels(s.underlying, s.instrumentKind, ltp, owner);
      engineSl = s.side === 'BUY' ? (lv?.support ?? null) : (lv?.resistance ?? null);
    }
    const planned = planEntry({ signal: s, contract, ltp, engineSl }, cfg);
    const plan = planned.plan;

    const safe = async <T>(fn: () => Promise<T>): Promise<T | null> => {
      try {
        return await fn();
      } catch (err) {
        this.logger.warn(`[signal-trader] fact read failed: ${errText(err)}`);
        return null;
      }
    };
    const [tradesToday, signalLossToday, clusterTaken, holding, coreOff, riskManager] = await Promise.all([
      safe(() => this.repo.tradesToday(cfg.mode, now)),
      safe(() => this.repo.signalLossToday(now)),
      safe(() => this.repo.clusterTaken(e.clusterId ?? null)),
      c && owner ? safe(() => this.repo.holding(owner, c.token, now)) : Promise.resolve(null),
      owner ? safe(() => coreEntryAllowed('signal-trader', { userId: owner, ref: c?.tradingsymbol ?? s.underlying })) : Promise.resolve(false),
      plan ? safe(() => this.risk.validateTrade(this.riskDto(plan, decisionId))) : Promise.resolve(null),
    ]);
    const slEnf = slEnforceability(this.env, owner, c?.exchange ?? null, c?.tradingsymbol ?? null);
    const facts: GateFacts = {
      signal: s,
      ownerUserId: owner,
      marketOpen,
      minutesToClose,
      contract,
      ltp,
      engineSl,
      tradesToday,
      signalLossToday,
      clusterTaken,
      holding,
      coreKillSwitchOff: coreOff,
      riskManager: riskManager ? { allowed: riskManager.allowed, reason: riskManager.reason } : null,
      liveTradingEnabled: isLiveTradingEnabled(),
      slEnforceable: { ok: slEnf.ok, detail: slEnf.detail },
    };
    const gate = evaluateGate(facts, planned.checks, cfg);
    if (!gate.pass || !plan) {
      const failed = gate.checks.find((x) => x.name === gate.skipReason);
      return this.skip(decisionId, gate.skipReason ?? 'gate', failed?.detail ?? '', gate.checks, null, plan, channel, what);
    }

    // ---- AI judge ----
    const cluster = await this.repo.cluster(e.clusterId ?? null).catch(() => null);
    const agreeCount = e.agreeCount ?? cluster?.agreeCount ?? 1;
    const conflict = e.conflict === true || cluster?.conflict === true;
    const [market, channelStats] = await Promise.all([
      this.context.build({ underlying: s.underlying, kind: s.instrumentKind, exchange: plan.exchange, ownerUserId: owner, now }),
      this.repo.channelStats(s.channelId).catch(() => null),
    ]);
    const packet = {
      promptVersion: SIGNAL_JUDGE_PROMPT_VERSION,
      at: now.toISOString(),
      signal: { text: s.rawText.slice(0, 1500), parsed: what, channel, receivedAt: s.receivedAt?.toISOString() ?? null },
      cluster: { agreeCount, conflict, channels: cluster?.channelIds.length ?? null, strong: !conflict && agreeCount >= cfg.strongChannels },
      channelStats: channelStats ?? { status: 'unavailable', reason: 'no self-review byChannel stats yet' },
      plan: { contract: plan.tradingsymbol, side: plan.side, ltp: plan.ltp, limit: plan.limitPrice, sl: plan.sl, slSource: plan.slSource, targets: plan.targets, lots: plan.lots, qty: plan.qty, riskRupees: plan.riskRupees },
      caps: { maxLots: cfg.maxLots, maxLossPerTrade: cfg.maxLossPerTrade, tradesToday, maxTradesPerDay: cfg.maxTradesPerDay },
      market,
    };
    const out = await this.judge.judge(packet, { model: cfg.judgeModel, timeoutMs: cfg.judgeTimeoutMs, slotWaitMs: cfg.judgeSlotWaitMs, userId: owner });
    if (!out.ok) {
      return this.skip(decisionId, out.reason, out.detail, gate.checks, { unavailable: out.reason, detail: out.detail, latencyMs: out.latencyMs, packet }, plan, channel, what);
    }
    const v = out.verdict;
    const verdict = judgeDecision(v, { agreeCount, conflict }, cfg);
    const judgeRecord = { ...v, effectiveConfidence: verdict.effectiveConfidence, latencyMs: out.latencyMs, model: cfg.judgeModel, packet };
    if (!verdict.take) {
      return this.skip(decisionId, verdict.reason ?? 'judge_skip', v.reasons[0] ?? '', gate.checks, judgeRecord, plan, channel, what);
    }
    const tightened = applyJudgeTightening(plan, { sl: v.sl, lots: v.lots }, s.instrumentKind);
    const finalPlan = tightened.plan;
    const judgeWithChanges = { ...judgeRecord, tightened: tightened.changed };

    // ---- shadow: identical pipeline, no order ----
    if (cfg.mode !== 'live') {
      await this.repo.finishDecision(decisionId, { gate: gate.checks, judge: judgeWithChanges, plan: finalPlan, decision: 'TAKE', skipReason: null });
      void sendOpsAlert(`signal-take:${decisionId}`, takeAlert({ mode: cfg.mode, channel, plan: finalPlan, agreeCount, conflict, confidence: verdict.effectiveConfidence, reasons: v.reasons }));
      return { decisionId, decision: 'TAKE', skipReason: null };
    }

    // ---- live: re-check price (the judge took time) right before the order ----
    const fresh = await this.quotes.ltp(owner as string, finalPlan.token, finalPlan.exchange).catch(() => null);
    const inBand = fresh !== null && fresh >= finalPlan.bandLow - 1e-9 && fresh <= finalPlan.bandHigh + 1e-9;
    const stillProtective = fresh !== null && (finalPlan.side === 'BUY' ? finalPlan.sl < fresh : finalPlan.sl > fresh);
    const recheck: GateCheck = { name: 'pre_send_price', ok: inBand && stillProtective, required: true, detail: fresh === null ? 'no fresh quote before sending' : `LTP ${fresh} vs band [${finalPlan.bandLow}, ${finalPlan.bandHigh}], SL ${finalPlan.sl}` };
    const checks = [...gate.checks, recheck];
    if (!recheck.ok) {
      return this.skip(decisionId, 'price_moved', recheck.detail, checks, judgeWithChanges, finalPlan, channel, what);
    }
    await this.repo.finishDecision(decisionId, { gate: checks, judge: judgeWithChanges, plan: finalPlan, decision: 'TAKE', skipReason: null });
    void sendOpsAlert(`signal-take:${decisionId}`, takeAlert({ mode: 'live', channel, plan: finalPlan, agreeCount, conflict, confidence: verdict.effectiveConfidence, reasons: v.reasons }));
    const placed = await this.executor.place({
      decisionId,
      ownerUserId: owner as string,
      plan: finalPlan,
      product: cfg.product,
      qtyUnit: slEnf.qtyUnit,
      channel,
      signalSummary: what,
      fillWaitSec: cfg.fillWaitSec,
    });
    return { decisionId, decision: 'TAKE', skipReason: null, placed: placed.kind };
  }

  private async skip(
    decisionId: string,
    reason: string,
    detail: string,
    checks: GateCheck[],
    judge: unknown,
    plan: EntryPlan | null,
    channel: string,
    what: string,
  ): Promise<EvaluationResult> {
    try {
      await this.repo.finishDecision(decisionId, { gate: checks, judge, plan, decision: 'SKIP', skipReason: reason });
    } catch (err) {
      this.logger.error(`[signal-trader] could not record SKIP for ${decisionId}: ${errText(err)}`);
    }
    void sendOpsAlert(`signal-skip:${decisionId}`, skipAlert({ mode: this.cfg.mode, channel, what, reason, detail }));
    return { decisionId, decision: 'SKIP', skipReason: reason };
  }

  /** The shared risk backstop sees the LIVE order shape (price = our LIMIT, so its capital cap is real). */
  private riskDto(plan: EntryPlan, decisionId: string): ExecuteTradeDto {
    return {
      symbol: plan.tradingsymbol,
      token: plan.token,
      exchange: plan.exchange,
      side: plan.side,
      orderType: 'LIMIT',
      quantity: plan.qty,
      price: plan.limitPrice,
      positionType: this.cfg.product,
      stoploss: plan.sl,
      isPaper: false,
      source: 'AUTO',
      signalId: decisionId,
      strategy: 'TELEGRAM_SIGNAL',
    } as unknown as ExecuteTradeDto;
  }

  /**
   * A channel follow-up ("SL hit", "exit now"…). Information for the sentinel only: appended to the
   * traded position's thesis (the judge reads it on its next look) and alerted. NEVER an order.
   */
  async handleUpdate(e: SignalUpdateEvent): Promise<void> {
    if (!e?.signalId) return;
    const order = await this.repo.orderForSignal(e.signalId);
    const kind = String(e.kind ?? 'UPDATE');
    const text = String(e.text ?? '').trim() || kind;
    if (!order) return;
    let passed = false;
    if (order.trackerId) {
      const at = new Date().toISOString().slice(11, 16);
      passed = await this.repo.appendThesisNote(order.trackerId, order.userId, `Channel update ${at}Z (${kind}${e.price ? ` @ ${e.price}` : ''}): ${text.slice(0, 300)} — information only, not an instruction.`);
    }
    void sendOpsAlert(`signal-update:${order.id}:${kind}:${text.slice(0, 40)}`, updateAlert({ symbol: order.tradingsymbol, kind, text: passed ? text : `${text} (no open tracker to pass it to)` }));
  }
}
