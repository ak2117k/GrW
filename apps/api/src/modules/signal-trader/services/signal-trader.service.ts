import { Inject, Injectable, Logger, Optional, type OnApplicationBootstrap, type OnModuleDestroy } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { RiskManagerService } from '../../trade-engine/services/risk-manager.service';
import type { ExecuteTradeDto } from '../../trade-engine/dto/trade.dto';
import { isLiveTradingEnabled } from '../../trade-engine/live-trading';
import { coreEntryAllowed } from '../../trade-core/risk-wall/kill-gate';
import { sendOpsAlert } from '../../../common/utils/ops-alert';
import { bootJobsEnabled } from '../../../common/utils/boot-jobs';
import { SignalTraderRepository } from '../repositories/signal-trader.repository';
import { resolveContract, segmentFor, type ResolvedContract, type ResolveResult } from '../domain/contract-resolver';
import { applyJudgeTightening, evaluateGate, planEntry, type EntryPlan, type GateCheck, type GateFacts, type GateResult, type TriggerState } from '../domain/gate';
import { judgeDecision, SIGNAL_JUDGE_PROMPT_VERSION, type JudgeVerdict } from '../domain/judge';
import { slEnforceability } from '../domain/execution';
import { skipAlert, takeAlert, triggerArmedAlert, triggerFiredAlert, updateAlert } from '../domain/alerts';
import { entryNotReached, judgeFresh, readTrigger, triggerExpiry, triggerHit, triggerOf } from '../domain/trigger';
import { SIGNAL_READY, SIGNAL_UPDATE, type SignalReadyEvent, type SignalUpdateEvent, type SignalView } from '../domain/signal.types';
import type { SignalTraderConfig } from '../domain/signal-trader.config';
import { SignalJudgeService } from './signal-judge.service';
import { SignalContextService } from './signal-context.service';
import { SignalExecutorService } from './signal-executor.service';
import type { PaperOpenInput, PaperOpenResult } from './signal-paper.service';
import { fundsCheck, isFundsRejection, marginPosition, needsMargin, parseMarginResponse, requiredFunds, type BrokerMargin, type FundsCheck } from '../domain/funds';
import { SIGNAL_PAPER_SKIP_REASON, paperAlert } from '../domain/paper';

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
/** The owner's broker RMS available cash (₹), or null when it cannot be read. */
export const SIGNAL_FUNDS = Symbol('SIGNAL_FUNDS');
export interface FundsLike {
  available(userId: string): Promise<number | null>;
  /**
   * Raw SmartAPI marginApi answer for one position over the owner's LIVE session (never a second
   * login); parsed by parseMarginResponse. Optional: absent → the estimate is used.
   */
  margin?(userId: string, position: Record<string, unknown>): Promise<unknown>;
}
/** Opens the PAPER (no funds) trade (SignalPaperService). */
export const SIGNAL_PAPER = Symbol('SIGNAL_PAPER');
export interface PaperLike {
  open(i: PaperOpenInput): Promise<PaperOpenResult>;
}

/** What the funds → PAPER path needs about one live TAKE. */
interface NoFundsContext {
  decisionId: string;
  signal: SignalView;
  plan: EntryPlan;
  expiry: string | null;
  channel: string;
  what: string;
  required: number;
  available: number | null;
  method: FundsCheck['funds']['method'];
}

/** Facts that do not depend on the entry price. */
interface BaseFacts {
  contract: ResolveResult;
  c: ResolvedContract | null;
  marketOpen: boolean | null;
  minutesToClose: number | null;
  ltp: number | null;
  tradesToday: number | null;
  signalLossToday: number | null;
  clusterTaken: boolean | null;
  holding: boolean | null;
  coreOff: boolean | null;
  slEnf: ReturnType<typeof slEnforceability>;
}

export interface JudgeTake {
  ok: true;
  verdict: JudgeVerdict;
  effectiveConfidence: number;
  agreeCount: number;
  conflict: boolean;
  record: unknown;
  judgedAt: string;
}
export type JudgeOutcome = JudgeTake | { ok: false; reason: string; detail: string; record: unknown };

/** One armed trigger in the watch (rebuilt from the DB after a restart). */
export interface PendingTrigger {
  decisionId: string;
  signal: SignalView;
  event: SignalReadyEvent;
  channel: string;
  trigger: TriggerState;
  gate: GateCheck[];
  judge: JudgeOutcome;
  plan: EntryPlan;
  nextPollAt: number;
  persistedAt: number;
}

/** A stored judge record (SignalDecision.judge of an armed trigger) back into a TAKE outcome. */
export function judgeFromRecord(rec: unknown, agreeCount: number, conflict: boolean): JudgeTake | null {
  if (!rec || typeof rec !== 'object' || Array.isArray(rec)) return null;
  const r = rec as Record<string, unknown>;
  if (r.verdict !== 'TAKE') return null;
  const n = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
  const verdict: JudgeVerdict = {
    verdict: 'TAKE',
    confidence: n(r.confidence) ?? 0,
    reasons: Array.isArray(r.reasons) ? r.reasons.filter((x): x is string => typeof x === 'string') : [],
    entry: n(r.entry),
    sl: n(r.sl),
    targets: Array.isArray(r.targets) ? r.targets.filter((x): x is number => typeof x === 'number') : [],
    lots: n(r.lots),
  };
  return { ok: true, verdict, effectiveConfidence: n(r.effectiveConfidence) ?? verdict.confidence, agreeCount, conflict, record: rec, judgedAt: typeof r.judgedAt === 'string' ? r.judgedAt : '' };
}

/** Re-evaluations allowed for one signal (a low-confidence SKIP upgraded by corroboration). */
const MAX_EVALUATIONS = 3;

export interface EvaluationResult {
  decisionId: string;
  /** PENDING = BUY ABOVE / SELL BELOW not reached yet: armed, the LTP is being watched. */
  decision: 'TAKE' | 'SKIP' | 'PAPER' | 'PENDING';
  skipReason: string | null;
  placed?: string;
  /** PAPER: the paper trade id, or why it could not be opened. */
  paper?: PaperOpenResult;
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
export class SignalTraderService implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger(SignalTraderService.name);
  private chain: Promise<unknown> = Promise.resolve();
  /** Armed triggers (the DB is the source of truth; this is the watch list). */
  private readonly pending = new Map<string, PendingTrigger>();
  private timer: ReturnType<typeof setInterval> | null = null;
  private ticking = false;

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
    @Optional() @Inject(SIGNAL_FUNDS) private readonly funds?: FundsLike,
    @Optional() @Inject(SIGNAL_PAPER) private readonly paper?: PaperLike,
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
    if (this.cfg.mode !== 'off' && bootJobsEnabled()) {
      void this.resumeTriggers().catch((err) => this.logger.error(`[signal-trader] resuming pending triggers failed: ${errText(err)}`));
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
      if (prior.some((d) => d.decision === 'TAKE' || d.decision === 'PAPER' || d.status === 'PENDING')) return null;
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

  /** Facts that do not depend on the entry price (one read per evaluation / trigger fire). */
  private async gatherBase(s: SignalView, e: Pick<SignalReadyEvent, 'clusterId'>, now: Date): Promise<BaseFacts> {
    const cfg = this.cfg;
    const owner = cfg.ownerUserId;
    const exchange = segmentFor(s);
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
    const [tradesToday, signalLossToday, clusterTaken, holding, coreOff] = await Promise.all([
      this.safe(() => this.repo.tradesToday(cfg.mode, now)),
      this.safe(() => this.repo.signalLossToday(now)),
      this.safe(() => this.repo.clusterTaken(e.clusterId ?? null)),
      c && owner ? this.safe(() => this.repo.holding(owner, c.token, now)) : Promise.resolve(null),
      owner ? this.safe(() => coreEntryAllowed('signal-trader', { userId: owner, ref: c?.tradingsymbol ?? s.underlying })) : Promise.resolve(false),
    ]);
    const slEnf = slEnforceability(this.env, owner, c?.exchange ?? null, c?.tradingsymbol ?? null);
    return { contract, c, marketOpen, minutesToClose, ltp, tradesToday, signalLossToday, clusterTaken, holding, coreOff, slEnf };
  }

  private async safe<T>(fn: () => Promise<T>): Promise<T | null> {
    try {
      return await fn();
    } catch (err) {
      this.logger.warn(`[signal-trader] fact read failed: ${errText(err)}`);
      return null;
    }
  }

  /** Engine SL (when the signal has none) + plan + risk manager + the full gate, at entry price `price`. */
  private async planAndGate(decisionId: string, s: SignalView, base: BaseFacts, price: number | null, now: Date): Promise<{ gate: GateResult; plan: EntryPlan | null }> {
    const cfg = this.cfg;
    const owner = cfg.ownerUserId;
    let engineSl: number | null = null;
    let engineSlInfo: GateFacts['engineSlInfo'] = null;
    if (s.sl === null && base.c && price !== null && price > 0) {
      if (!cfg.engineSl) {
        engineSlInfo = { method: null, detail: 'SIGNAL_ENGINE_SL=off' };
      } else {
        try {
          const r = await this.context.engineSl({ signal: s, contract: base.c, price, ownerUserId: owner, now, optionPct: cfg.engineSlOptionPct, bufferPct: cfg.engineSlBufferPct });
          engineSl = r.sl;
          engineSlInfo = { method: r.method, detail: r.detail };
        } catch (err) {
          engineSlInfo = { method: null, detail: `engine SL failed: ${errText(err)}` };
        }
      }
    }
    const planned = planEntry({ signal: s, contract: base.contract, ltp: price, engineSl, engineSlInfo }, cfg);
    const plan = planned.plan;
    const riskManager = plan ? await this.safe(() => this.risk.validateTrade(this.riskDto(plan, decisionId))) : null;
    const facts: GateFacts = {
      signal: s,
      ownerUserId: owner,
      marketOpen: base.marketOpen,
      minutesToClose: base.minutesToClose,
      contract: base.contract,
      ltp: price,
      engineSl,
      engineSlInfo,
      tradesToday: base.tradesToday,
      signalLossToday: base.signalLossToday,
      clusterTaken: base.clusterTaken,
      holding: base.holding,
      coreKillSwitchOff: base.coreOff,
      riskManager: riskManager ? { allowed: riskManager.allowed, reason: riskManager.reason } : null,
      liveTradingEnabled: isLiveTradingEnabled(),
      slEnforceable: { ok: base.slEnf.ok, detail: base.slEnf.detail },
    };
    return { gate: evaluateGate(facts, planned.checks, cfg), plan };
  }

  private async pipeline(decisionId: string, s: SignalView, e: SignalReadyEvent, channel: string, now: Date): Promise<EvaluationResult> {
    const what = describeSignal(s);
    const base = await this.gatherBase(s, e, now);
    const pg = await this.planAndGate(decisionId, s, base, base.ltp, now);
    if (!pg.gate.pass || !pg.plan) {
      const armed = await this.maybeArm(decisionId, s, e, channel, now, base, pg.gate);
      if (armed) return armed;
      const failed = pg.gate.checks.find((x) => x.name === pg.gate.skipReason);
      return this.skip(decisionId, pg.gate.skipReason ?? 'gate', failed?.detail ?? '', pg.gate.checks, null, pg.plan, channel, what);
    }
    const j = await this.runJudge(decisionId, s, e, channel, now, pg.plan, base.tradesToday);
    if (!j.ok) return this.skip(decisionId, j.reason, j.detail, pg.gate.checks, j.record, pg.plan, channel, what);
    return this.act(decisionId, s, channel, now, pg.gate.checks, pg.plan, j, base);
  }

  /** The AI judge on a plan. Never throws (an unavailable judge = SKIP). */
  private async runJudge(decisionId: string, s: SignalView, e: SignalReadyEvent, channel: string, now: Date, plan: EntryPlan, tradesToday: number | null): Promise<JudgeOutcome> {
    const cfg = this.cfg;
    const owner = cfg.ownerUserId;
    const what = describeSignal(s);
    const cluster = await this.repo.cluster(e.clusterId ?? null).catch(() => null);
    const agreeCount = e.agreeCount ?? cluster?.agreeCount ?? 1;
    const conflict = e.conflict === true || cluster?.conflict === true;
    const [market, channelStats, channelViews] = await Promise.all([
      this.context.build({ underlying: s.underlying, kind: s.instrumentKind, exchange: plan.exchange, ownerUserId: owner, now }),
      this.repo.channelStats(s.channelId).catch(() => null),
      // Telegram channels' market views on this underlying (read-only context; never a trigger).
      Promise.resolve()
        .then(() => this.repo.channelViews(s.underlying, now))
        .catch((err: unknown) => ({ status: 'unavailable', reason: `channel views: ${err instanceof Error ? err.message : String(err)}` })),
    ]);
    const packet = {
      promptVersion: SIGNAL_JUDGE_PROMPT_VERSION,
      at: now.toISOString(),
      signal: { text: s.rawText.slice(0, 1500), parsed: what, channel, receivedAt: s.receivedAt?.toISOString() ?? null },
      cluster: { agreeCount, conflict, channels: cluster?.channelIds.length ?? null, strong: !conflict && agreeCount >= cfg.strongChannels },
      channelStats: channelStats ?? { status: 'unavailable', reason: 'no self-review byChannel stats yet' },
      channelViews,
      plan: {
        contract: plan.tradingsymbol,
        side: plan.side,
        ltp: plan.ltp,
        limit: plan.limitPrice,
        sl: plan.sl,
        slSource: plan.slSource,
        engineSl: plan.engineSl ?? null,
        trigger: plan.trigger ? { price: plan.trigger.price, op: plan.trigger.op, expiresAt: plan.trigger.expiresAt } : null,
        targets: plan.targets,
        lots: plan.lots,
        qty: plan.qty,
        riskRupees: plan.riskRupees,
      },
      caps: { maxLots: cfg.maxLots, maxLossPerTrade: cfg.maxLossPerTrade, tradesToday, maxTradesPerDay: cfg.maxTradesPerDay },
      market,
    };
    const out = await this.judge.judge(packet, { model: cfg.judgeModel, timeoutMs: cfg.judgeTimeoutMs, slotWaitMs: cfg.judgeSlotWaitMs, userId: owner });
    if (!out.ok) {
      return { ok: false, reason: out.reason, detail: out.detail, record: { unavailable: out.reason, detail: out.detail, latencyMs: out.latencyMs, packet } };
    }
    const v = out.verdict;
    const verdict = judgeDecision(v, { agreeCount, conflict }, cfg);
    const record = { ...v, effectiveConfidence: verdict.effectiveConfidence, latencyMs: out.latencyMs, model: cfg.judgeModel, judgedAt: now.toISOString(), packet };
    if (!verdict.take) return { ok: false, reason: verdict.reason ?? 'judge_skip', detail: v.reasons[0] ?? '', record };
    return { ok: true, verdict: v, effectiveConfidence: verdict.effectiveConfidence, agreeCount, conflict, record, judgedAt: now.toISOString() };
  }

  /** After the gate and a TAKE verdict: shadow record, or live pre-send check → funds → LIMIT order. */
  private async act(decisionId: string, s: SignalView, channel: string, now: Date, gateChecks: GateCheck[], plan: EntryPlan, j: JudgeTake, base: BaseFacts): Promise<EvaluationResult> {
    const cfg = this.cfg;
    const owner = cfg.ownerUserId;
    const what = describeSignal(s);
    const v = j.verdict;
    const tightened = applyJudgeTightening(plan, { sl: v.sl, lots: v.lots }, s.instrumentKind);
    const finalPlan = tightened.plan;
    const judgeWithChanges = { ...(j.record as Record<string, unknown>), tightened: tightened.changed };
    const { agreeCount, conflict } = j;

    // ---- shadow: identical pipeline, no order ----
    if (cfg.mode !== 'live') {
      await this.repo.finishDecision(decisionId, { gate: gateChecks, judge: judgeWithChanges, plan: finalPlan, decision: 'TAKE', skipReason: null });
      void sendOpsAlert(`signal-take:${decisionId}`, takeAlert({ mode: cfg.mode, channel, plan: finalPlan, agreeCount, conflict, confidence: j.effectiveConfidence, reasons: v.reasons }));
      return { decisionId, decision: 'TAKE', skipReason: null };
    }

    // ---- live: re-check price (the judge took time) right before the order ----
    const fresh = await this.quotes.ltp(owner as string, finalPlan.token, finalPlan.exchange).catch(() => null);
    const inBand = fresh !== null && fresh >= finalPlan.bandLow - 1e-9 && fresh <= finalPlan.bandHigh + 1e-9;
    const stillProtective = fresh !== null && (finalPlan.side === 'BUY' ? finalPlan.sl < fresh : finalPlan.sl > fresh);
    const recheck: GateCheck = { name: 'pre_send_price', ok: inBand && stillProtective, required: true, detail: fresh === null ? 'no fresh quote before sending' : `LTP ${fresh} vs band [${finalPlan.bandLow}, ${finalPlan.bandHigh}], SL ${finalPlan.sl}` };
    const checks: GateCheck[] = [...gateChecks, recheck];
    if (!recheck.ok) {
      return this.skip(decisionId, 'price_moved', recheck.detail, checks, judgeWithChanges, finalPlan, channel, what);
    }

    // ---- live: enough funds for this entry? (unknown → sent as before; short → PAPER / SKIP) ----
    const broker = needsMargin(finalPlan.side, s.instrumentKind) ? await this.brokerMargin(owner as string, finalPlan, base.slEnf.qtyUnit) : null;
    const need = requiredFunds(finalPlan, s, cfg, broker);
    const available = await this.readFunds(owner as string);
    const funds = fundsCheck(available, need);
    checks.push(funds);
    const noFunds: NoFundsContext = { decisionId, signal: s, plan: finalPlan, expiry: base.c?.expiry ?? null, channel, what, required: need.required, available, method: need.method };
    if (funds.ok === false) {
      return this.paperOrSkip(noFunds, funds, checks, judgeWithChanges);
    }

    await this.repo.finishDecision(decisionId, { gate: checks, judge: judgeWithChanges, plan: finalPlan, decision: 'TAKE', skipReason: null });
    void sendOpsAlert(`signal-take:${decisionId}`, takeAlert({ mode: 'live', channel, plan: finalPlan, agreeCount, conflict, confidence: j.effectiveConfidence, reasons: v.reasons }));
    const placed = await this.executor.place({
      decisionId,
      ownerUserId: owner as string,
      plan: finalPlan,
      product: cfg.product,
      qtyUnit: base.slEnf.qtyUnit,
      channel,
      signalSummary: what,
      fillWaitSec: cfg.fillWaitSec,
      onRejected: (reason) => this.onBrokerReject(noFunds, reason),
    });
    void now;
    return { decisionId, decision: 'TAKE', skipReason: null, placed: placed.kind };
  }

  /** Broker margin calculator (SmartAPI marginApi over the owner's live session). Never throws. */
  private async brokerMargin(owner: string, plan: EntryPlan, qtyUnit: 'units' | 'lots' | null): Promise<BrokerMargin> {
    if (!this.funds?.margin) return { ok: false, reason: 'margin calculator not wired' };
    try {
      return parseMarginResponse(await this.funds.margin(owner, marginPosition(plan, this.cfg.product, qtyUnit)));
    } catch (err) {
      return { ok: false, reason: errText(err).slice(0, 160) };
    }
  }

  // ───────────────────────── pending triggers (BUY ABOVE / SELL BELOW) ─────────────────────────

  /**
   * The gate failed only because "ABOVE/BELOW x" is not reached yet: re-run the whole gate as if the
   * entry were at x; when that passes (and the judge says TAKE), keep the decision PENDING and watch.
   * null = not a waiting case (the caller SKIPs as before).
   */
  private async maybeArm(decisionId: string, s: SignalView, e: SignalReadyEvent, channel: string, now: Date, base: BaseFacts, gate: GateResult): Promise<EvaluationResult | null> {
    const cfg = this.cfg;
    if (cfg.triggerWaitMin <= 0 || gate.skipReason !== 'entry_tolerance' || !entryNotReached(s, base.ltp, cfg.entryTolerancePct)) return null;
    const trig = triggerOf(s, cfg.entryTolerancePct);
    if (!trig) return null;
    const what = describeSignal(s);
    const expiresAt = triggerExpiry(now, cfg.triggerWaitMin, base.minutesToClose, cfg.minMinutesToClose);
    if (!expiresAt) return null;
    const hyp = await this.planAndGate(decisionId, s, base, trig.price, now);
    if (!hyp.gate.pass || !hyp.plan) {
      const failed = hyp.gate.checks.find((x) => x.name === hyp.gate.skipReason);
      return this.skip(decisionId, hyp.gate.skipReason ?? 'gate', `entry not reached (LTP ${base.ltp} vs ${trig.op} ${trig.price}); at the trigger: ${failed?.detail ?? ''}`, hyp.gate.checks, null, hyp.plan, channel, what);
    }
    const pendingNow = await this.safe(() => this.repo.pendingTriggerCount());
    if (pendingNow === null || pendingNow >= cfg.triggerMaxPending) {
      const real = gate.checks.find((x) => x.name === 'entry_tolerance');
      return this.skip(decisionId, 'entry_tolerance', `${real?.detail ?? 'entry not reached'} — trigger watch full (${pendingNow ?? '?'}/${cfg.triggerMaxPending})`, gate.checks, null, null, channel, what);
    }
    const trigger: TriggerState = { ...trig, armedAt: now.toISOString(), expiresAt: expiresAt.toISOString(), judgedAt: null, lastLtp: base.ltp, lastCheckAt: now.toISOString() };
    const planAtTrigger: EntryPlan = { ...hyp.plan, trigger };
    const j = await this.runJudge(decisionId, s, e, channel, now, planAtTrigger, base.tradesToday);
    if (!j.ok) return this.skip(decisionId, j.reason, j.detail, hyp.gate.checks, j.record, planAtTrigger, channel, what);
    trigger.judgedAt = j.judgedAt;
    const checks: GateCheck[] = [
      ...hyp.gate.checks.map((c) => (c.name === 'entry_tolerance' ? { ...c, ok: null, required: true, detail: `waiting for ${trig.op} ${trig.price} (LTP ${base.ltp}); band [${trig.bandLow}, ${trig.bandHigh}]` } : c)),
    ];
    if (!(await this.repo.armTrigger(decisionId, { gate: checks, judge: j.record, plan: planAtTrigger }))) return null;
    this.pending.set(decisionId, { decisionId, signal: s, event: e, channel, trigger, gate: checks, judge: j, plan: planAtTrigger, nextPollAt: 0, persistedAt: now.getTime() });
    this.ensureTimer();
    void sendOpsAlert(
      `signal-arm:${decisionId}`,
      triggerArmedAlert({ mode: cfg.mode, channel, what, symbol: hyp.plan.tradingsymbol, op: trig.op, price: trig.price, ltp: base.ltp, expiresAt: trigger.expiresAt, slSource: hyp.plan.engineSl ? `engine ${hyp.plan.engineSl.method}` : hyp.plan.slSource }),
    );
    return { decisionId, decision: 'PENDING', skipReason: null };
  }

  private ensureTimer(): void {
    if (this.timer || this.pending.size === 0) return;
    this.timer = setInterval(() => void this.checkTriggers(new Date()), Math.min(this.cfg.triggerPollSec, 5) * 1000);
    (this.timer as { unref?: () => void }).unref?.();
  }

  private stopTimerIfIdle(): void {
    if (this.timer && this.pending.size === 0) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** Armed triggers held in memory (the page reads the DB; this is for tests / diagnostics). */
  pendingIds(): string[] {
    return [...this.pending.keys()];
  }

  /**
   * One watch pass: expire what is due, poll each armed trigger's LTP at most every
   * SIGNAL_TRIGGER_POLL_SEC (≥ 5 s), and fire the ones inside their no-chase band. Never throws.
   */
  async checkTriggers(now: Date = new Date()): Promise<void> {
    if (this.ticking) return;
    this.ticking = true;
    try {
      for (const p of [...this.pending.values()]) {
        try {
          await this.checkOne(p, now);
        } catch (err) {
          this.logger.warn(`[signal-trader] trigger ${p.decisionId} check failed: ${errText(err)}`);
        }
      }
    } finally {
      this.ticking = false;
      this.stopTimerIfIdle();
    }
  }

  private async checkOne(p: PendingTrigger, now: Date): Promise<void> {
    const t = p.trigger;
    if (now.getTime() >= Date.parse(t.expiresAt)) {
      this.pending.delete(p.decisionId);
      await this.enqueue(() => this.expire(p));
      return;
    }
    if (now.getTime() < p.nextPollAt) return;
    p.nextPollAt = now.getTime() + this.cfg.triggerPollSec * 1000;
    const owner = this.cfg.ownerUserId;
    const ltp = owner ? await this.quotes.ltp(owner, p.plan.token, p.plan.exchange).catch(() => null) : null;
    t.lastLtp = ltp;
    t.lastCheckAt = now.toISOString();
    if (!triggerHit(t, ltp)) {
      if (now.getTime() - p.persistedAt >= 30_000) {
        p.persistedAt = now.getTime();
        await this.repo.touchTrigger(p.decisionId, { ...p.plan, trigger: t }).catch(() => undefined);
      }
      return;
    }
    void sendOpsAlert(`signal-trigger:${p.decisionId}:${t.lastCheckAt}`, triggerFiredAlert({ mode: this.cfg.mode, symbol: p.plan.tradingsymbol, op: t.op, price: t.price, ltp: ltp as number }));
    const r = await this.enqueue(() => this.fire(p, new Date(now.getTime())));
    if (r !== 'WAIT') this.pending.delete(p.decisionId);
  }

  /**
   * The trigger price was reached: the FULL gate again on a fresh read (caps, kill switch, risk
   * manager, holding…); the judge again only when its verdict is older than SIGNAL_JUDGE_REUSE_MIN;
   * then the normal shadow / live path (pre-send price, funds, LIMIT order). Price back out of the
   * band by now → keep waiting.
   */
  async fire(p: PendingTrigger, now: Date): Promise<EvaluationResult | 'WAIT'> {
    const s = p.signal;
    const what = describeSignal(s);
    try {
      const base = await this.gatherBase(s, p.event, now);
      const pg = await this.planAndGate(p.decisionId, s, base, base.ltp, now);
      if (!pg.gate.pass || !pg.plan) {
        if (pg.gate.skipReason === 'entry_tolerance' && now.getTime() < Date.parse(p.trigger.expiresAt)) return 'WAIT';
        const failed = pg.gate.checks.find((x) => x.name === pg.gate.skipReason);
        return this.skip(p.decisionId, pg.gate.skipReason ?? 'gate', `at the trigger: ${failed?.detail ?? ''}`, pg.gate.checks, p.judge.record, pg.plan ?? p.plan, p.channel, what);
      }
      const plan: EntryPlan = { ...pg.plan, trigger: { ...p.trigger } };
      let j: JudgeOutcome = p.judge;
      if (!judgeFresh(p.trigger.judgedAt, now, this.cfg.judgeReuseMin)) {
        j = await this.runJudge(p.decisionId, s, p.event, p.channel, now, plan, base.tradesToday);
      } else {
        j = { ...p.judge, record: { ...(p.judge.record as Record<string, unknown>), reused: true } };
      }
      if (!j.ok) return this.skip(p.decisionId, j.reason, j.detail, pg.gate.checks, j.record, plan, p.channel, what);
      return await this.act(p.decisionId, s, p.channel, now, pg.gate.checks, plan, j, base);
    } catch (err) {
      this.logger.error(`[signal-trader] trigger fire for ${p.decisionId} failed: ${errText(err)}`);
      return this.skip(p.decisionId, 'internal_error', errText(err), p.gate, p.judge.record, p.plan, p.channel, what);
    }
  }

  private expire(p: PendingTrigger): Promise<EvaluationResult> {
    const t = p.trigger;
    const mins = Math.round((Date.parse(t.expiresAt) - Date.parse(t.armedAt)) / 60_000);
    return this.skip(p.decisionId, 'trigger_expired', `waited ${mins} min for ${t.op} ${t.price}; last LTP ${t.lastLtp ?? '?'}`, p.gate, p.judge.record, { ...p.plan, trigger: t }, p.channel, describeSignal(p.signal));
  }

  /** After a restart: every PENDING trigger back into the watch (expired ones SKIPped at once). */
  async resumeTriggers(now: Date = new Date()): Promise<number> {
    const rows = await this.repo.pendingTriggers();
    let n = 0;
    for (const r of rows) {
      if (this.pending.has(r.id)) continue;
      const trigger = readTrigger(r.plan);
      const signal = await this.repo.signal(r.signalId).catch(() => null);
      const channel = await this.repo.channelTitle(r.channelId ?? null).catch(() => r.channelId ?? 'unknown channel');
      const gate = Array.isArray(r.gate) ? (r.gate as unknown as GateCheck[]) : [];
      const plan = (r.plan ?? null) as unknown as EntryPlan | null;
      const judge = judgeFromRecord(r.judge, r.agreeCount ?? 1, r.conflict === true);
      if (!trigger || !signal || !plan || !judge) {
        await this.skip(r.id, 'internal_error', 'pending trigger unreadable after a restart', gate, r.judge, plan, channel, signal ? describeSignal(signal) : r.signalId);
        continue;
      }
      const p: PendingTrigger = {
        decisionId: r.id,
        signal,
        event: { signalId: r.signalId, clusterId: r.clusterId ?? null, agreeCount: r.agreeCount ?? 1, conflict: r.conflict === true },
        channel,
        trigger,
        gate,
        judge,
        plan,
        nextPollAt: 0,
        persistedAt: now.getTime(),
      };
      if (now.getTime() >= Date.parse(trigger.expiresAt)) {
        await this.enqueue(() => this.expire(p));
        continue;
      }
      this.pending.set(r.id, p);
      n++;
    }
    this.ensureTimer();
    if (n) this.logger.warn(`[signal-trader] resumed ${n} pending trigger(s)`);
    return n;
  }

  /** The owner's RMS available cash; null (= 'unknown') on any failure. Never throws. */
  private async readFunds(owner: string): Promise<number | null> {
    if (!this.funds) return null;
    try {
      const v = await this.funds.available(owner);
      return typeof v === 'number' && Number.isFinite(v) ? v : null;
    } catch (err) {
      this.logger.warn(`[signal-trader] funds read failed (recorded unknown): ${errText(err)}`);
      return null;
    }
  }

  /**
   * Every check and the judge said TAKE, the account is short: a PAPER trade when the owner's
   * `paperOnNoFunds` is on (decision PAPER — not a TAKE, so no live cap counts it), else a plain
   * SKIP('insufficient_funds'). No broker call either way.
   */
  private async paperOrSkip(n: NoFundsContext, check: FundsCheck, checks: GateCheck[], judge: unknown): Promise<EvaluationResult> {
    const on = this.paper ? await this.repo.paperOnNoFunds() : false;
    if (!on) {
      const why = this.paper ? 'paper-on-no-funds is OFF' : 'paper path not wired';
      return this.skip(n.decisionId, SIGNAL_PAPER_SKIP_REASON, `${check.detail} — ${why}`, checks, judge, n.plan, n.channel, n.what);
    }
    await this.repo.finishDecision(n.decisionId, { gate: checks, judge, plan: n.plan, decision: 'PAPER', skipReason: SIGNAL_PAPER_SKIP_REASON });
    const paper = await this.openPaper(n, 'funds_check');
    return { decisionId: n.decisionId, decision: 'PAPER', skipReason: SIGNAL_PAPER_SKIP_REASON, paper };
  }

  /**
   * The broker rejected a live entry: when the text says funds/margin and the setting is on, the
   * decision becomes PAPER — at most once (claimPaperFallback is a conditional update on 'TAKE').
   */
  async onBrokerReject(n: NoFundsContext, reason: string): Promise<PaperOpenResult | null> {
    if (!isFundsRejection(reason) || !this.paper) return null;
    if (!(await this.repo.paperOnNoFunds())) return null;
    const check = {
      name: 'broker_funds_reject',
      ok: false,
      required: true,
      detail: `broker rejected the entry for funds/margin: ${reason.slice(0, 300)}`,
      funds: { available: n.available, required: n.required, ok: false, method: n.method },
    };
    if (!(await this.repo.claimPaperFallback(n.decisionId, check))) return null;
    return this.openPaper(n, 'broker_reject', reason);
  }

  private async openPaper(n: NoFundsContext, trigger: PaperOpenInput['trigger'], brokerReason?: string): Promise<PaperOpenResult> {
    const why = trigger === 'broker_reject' ? 'broker rejected the live entry for funds/margin' : 'account funds short of the entry';
    let res: PaperOpenResult;
    try {
      res = await (this.paper as PaperLike).open({
        decisionId: n.decisionId,
        plan: n.plan,
        signal: n.signal,
        expiry: n.expiry,
        product: this.cfg.product,
        channel: n.channel,
        what: n.what,
        why,
        trigger,
      });
    } catch (err) {
      res = { ok: false, reason: errText(err) };
    }
    const p = n.plan;
    const result = res.ok
      ? `Paper trade ${res.tradeId}${res.duplicate ? ' (already open)' : ''}: ${p.side} ${p.tradingsymbol} x${p.qty} @ ${res.entryPrice ?? p.limitPrice} | SL ${p.sl} | T1 ${p.targets[0] ?? 'none'} — no live order.`
      : `Paper trade could NOT be opened: ${res.reason}`;
    void sendOpsAlert(`signal-paper:${n.decisionId}`, paperAlert({ required: n.required, available: n.available, what: n.what, channel: n.channel, result, brokerReason }));
    return res;
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
