import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { TradeExecutionService } from '../../trade-engine/services/trade-execution.service';
import { TradeRepository } from '../../trade-engine/repositories/trade.repository';
import { bootJobsEnabled } from '../../../common/utils/boot-jobs';
import { SignalTraderRepository } from '../repositories/signal-trader.repository';
import {
  decisionIdFromTags,
  horizonFromTags,
  isCarried,
  orderedTargets,
  paperExitDecision,
  paperTrailConfig,
  type PaperNoise,
  type PaperTrailConfig,
} from '../domain/paper';
import { atr14 } from '../domain/atr';
import type { SignalHorizon } from '../domain/signal.types';
import { DEFAULT_SESSION_MINUTES } from '../../exit-discipline/noise';
import { aiCheck, aiDecisionOf } from '../domain/ai-check';
import type { PaperTradeRow } from '../repositories/signal-trader.repository';
import type { SignalTraderConfig } from '../domain/signal-trader.config';
import { emptyShadow, grossPnl, shadowLine, stepShadow, type ShadowParams, type ShadowState } from '../domain/exit-shadow';
import { NOISE_LOOKBACK_MIN, parseExitDisciplineConfig } from '../../exit-discipline/config';
import { noiseFromBars } from '../../exit-discipline/noise';
import type { MinuteBar } from '../../exit-discipline/types';
import { PaperSentinelService, type PaperAiExit, type PaperPosition } from '../../paper-sentinel/paper-sentinel.service';
import {
  SIGNAL_QUOTES,
  SIGNAL_SESSION_CLOCK,
  SIGNAL_TRADER_CONFIG,
  type QuotesLike,
  type SessionClockLike,
} from './signal-trader.service';

const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));
const r2 = (n: number) => Math.round(n * 100) / 100;

/** 1-min bars of a contract over the owner's own Angel session (the shadow's noise unit). */
export const SIGNAL_BARS = Symbol('SIGNAL_BARS');
export interface BarsLike {
  minuteBars(userId: string, token: string, exchange: string, from: Date, to: Date): Promise<MinuteBar[]>;
  /** Daily bars (a carried trade's noise scale: the contract's daily ATR). Optional: absent ⇒ the 1-min N scaled to a day. */
  dailyBars?(userId: string, token: string, exchange: string, from: Date, to: Date): Promise<Array<{ high: number; low: number; close: number }>>;
}

/** A noise unit is re-read this often (sooner while it is still unknown). */
const NOISE_REFRESH_MS = 30 * 60_000;
const NOISE_RETRY_MS = 5 * 60_000;
/** Daily bars read for a carried trade's ATR(14). */
const DAILY_LOOKBACK_DAYS = 40;

const istDay = (d: Date) => new Date(d.getTime() + 5.5 * 3_600_000).toISOString().slice(0, 10);

/** A carried trade's daily ATR, read once per trade per IST day (retried after NOISE_RETRY_MS when unreadable). */
interface DailyAtr {
  day: string;
  atr: number | null;
  at: number;
  /** Read today (else a retry is due after NOISE_RETRY_MS). */
  fresh: boolean;
}

interface Shadowed {
  decisionId: string | null;
  /** The plan's reference stop (0 / null = none); not shadowed when the trade carries a real stop. */
  refSl: number | null;
  baseline: 'learn' | 'stop';
  state: ShadowState;
  n: number | null;
  nMethod: string | null;
  nAt: number;
}

/** The HELD row's follow state: the closed trade's own exit rules, carried on after the AI closed it. */
interface HeldFollow {
  side: string;
  entry: number;
  qty: number;
  sl: number | null;
  target: number | null;
  targets: number[];
  /** The plan's own SL (rows written before 2026-10-29 lack it). */
  planSl?: number | null;
  product: string;
  tags: string[];
  entryTime: string;
  token: string;
  exchange: string;
  symbol: string;
  expiry: string | null;
  ai: { rule: string; price: number; at: string };
}

/**
 * SL / target exits for the PAPER (no funds) trades. The paper engine has none of its own (the open
 * paper refresher only marks option P&L, and each paper track runs its own exit poller), so this is
 * the minimal one for these tagged trades: every 30 s, a fresh LTP over the owner's own Angel feed
 * session (a quote, never an order), then paperExitDecision → TradeExecutionService.closeTrade with
 * the exit price and reason tag (the standard paper close: journal, charges, paper balance), else a
 * mark-to-market P&L on the row. Only trades whose strategy is in PAPER_WATCH_STRATEGIES are touched
 * (TELEGRAM_SIGNAL_NO_FUNDS and the entry engine's ENGINE_ENTRY).
 */
@Injectable()
export class SignalPaperWatchService {
  private readonly logger = new Logger(SignalPaperWatchService.name);
  private busy = false;
  /** Paper exit shadow (domain/exit-shadow): per open trade, restored from its TRACK row on first sight. */
  private readonly shadows = new Map<string, Shadowed>();
  private readonly shadowParams: ShadowParams;
  /** Target trailing: each open trade's plan targets (domain/paper orderedTargets) and plan SL. */
  private readonly targets = new Map<string, number[]>();
  private readonly planSls = new Map<string, number | null>();
  /** Carried trades: the contract's daily ATR (the noise scale of a multi-day trade). */
  private readonly dailyAtrs = new Map<string, DailyAtr>();
  private readonly trailCfg: PaperTrailConfig = paperTrailConfig(process.env);

  constructor(
    @Inject(SIGNAL_TRADER_CONFIG) private readonly cfg: SignalTraderConfig,
    private readonly repo: SignalTraderRepository,
    private readonly exec: TradeExecutionService,
    private readonly trades: TradeRepository,
    @Inject(SIGNAL_SESSION_CLOCK) private readonly clock: SessionClockLike,
    @Inject(SIGNAL_QUOTES) private readonly quotes: QuotesLike,
    @Optional() @Inject(SIGNAL_BARS) private readonly bars?: BarsLike,
    // Shadow stage 2: the live AI sentinel on these trades; its exits close them (owner 2026-10-29).
    @Optional() private readonly paperSentinel?: PaperSentinelService,
  ) {
    const d = parseExitDisciplineConfig(process.env);
    this.shadowParams = { armN: d.floorArmN, trailN: d.floorTrailN, givebackN: d.givebackN };
    this.paperSentinel?.onExit((e) => this.closeByAi(e));
  }

  /**
   * The AI sentinel's exit, as live: the paper trade closes at the AI's price (the standard paper close)
   * with the AI's reason on the exit notes. Then, for the night review, a HELD row follows the trade on
   * its own rules (SL, trailing targets, square-off) to say what holding would have made instead.
   */
  async closeByAi(e: PaperAiExit): Promise<void> {
    const t = await this.repo.openPaperTrade(e.tradeId);
    if (!t?.instrument || !t.entryPrice) return; // closed meanwhile by its own rules: that close stands
    const inst = t.instrument;
    const targets = await this.targetsFor(t);
    const planSl = this.planSls.get(t.id) ?? null;
    const line = this.shadowOn() ? await this.shadowSettle(t, e.price, e.at) : null;
    const what = e.rule === 'AI_TRIGGER' ? 'AI trigger' : 'AI exit';
    const notes = [`${what}: ${e.reason}`, line ? `shadow: ${line}` : null, 'night review: the HELD row follows what holding would have made'];
    await this.exec.closeTrade(t.id, {
      exitReasonTag: 'AI_EXIT',
      reason: `paper closed by the AI sentinel (${e.rule})`,
      exitNotes: notes.filter(Boolean).join(' | ').slice(0, 2000),
      exitPrice: e.price,
    });
    this.forget(t.id);
    this.logger.warn(`[signal-paper] closed paper ${inst.symbol} (${t.id}) on ${e.rule} @ ${e.price}: ${e.reason}`);
    if (t.entryTags.includes('learn')) await this.scoreAi(t, e.price, 'AI_EXIT', e.at);
    try {
      const follow: HeldFollow = {
        side: t.side, entry: t.entryPrice, qty: t.quantity, sl: t.stoploss, target: t.target, targets, planSl,
        product: t.positionType, tags: t.entryTags, entryTime: (t.entryTime ?? t.createdAt).toISOString(),
        token: inst.token, exchange: inst.exchange, symbol: inst.symbol, expiry: inst.expiry ? inst.expiry.toISOString() : null,
        ai: { rule: e.rule, price: e.price, at: e.at.toISOString() },
      };
      await this.repo.startHeldFollow(t.id, decisionIdFromTags(t.entryTags), grossPnl(t.side, t.entryPrice, e.price, t.quantity), follow);
    } catch (err) {
      this.logger.warn(`[signal-paper] HELD follow for ${t.id} not started: ${errText(err)}`);
    }
  }

  /**
   * Night review: each AI-closed trade, still followed on its own rules. On their exit the HELD row is
   * settled: rulePnl = what holding made, heldPnl = what the AI's close made, saved = held − AI
   * (> 0: holding would have beaten the AI). Never throws.
   */
  private async followHeld(owner: string, now: Date): Promise<void> {
    let rows: Awaited<ReturnType<SignalTraderRepository['followingHeld']>>;
    try {
      rows = await this.repo.followingHeld();
    } catch (err) {
      this.logger.warn(`[signal-paper] HELD follow read failed: ${errText(err)}`);
      return;
    }
    for (const r of rows) {
      try {
        const f = r.detail as HeldFollow | null;
        if (!f?.token || !f.exchange || !(f.entry > 0)) continue;
        if (!this.clock.isOpen(f.exchange, now)) continue;
        const ltp = await this.quotes.ltp(owner, f.token, f.exchange).catch(() => null);
        const horizon = horizonFromTags(f.tags);
        // A carried trade follows on its daily-ATR rules too (an intraday one has no shadow N any more: plain steps).
        const noise = isCarried(horizon) ? await this.noiseFor(owner, `held:${r.tradeId}`, horizon, f, now) : undefined;
        const d = paperExitDecision({
          side: f.side, ltp, sl: f.sl, target: f.target, product: f.product, minutesToClose: this.clock.minutesToClose(f.exchange, now),
          horizon, entryTime: new Date(f.entryTime), now, expiry: f.expiry ? new Date(f.expiry) : null,
          entry: f.entry, targets: f.targets, planSl: f.planSl ?? null, noise,
        });
        if (!d.exit && d.trail) {
          await this.repo.updateHeld(r.id, { detail: { ...f, sl: d.trail.sl, target: d.trail.target } });
        } else if (d.exit) {
          const held = grossPnl(f.side, f.entry, d.price, f.qty);
          const ai = r.heldPnl ?? grossPnl(f.side, f.entry, f.ai.price, f.qty);
          const reason = `held: ${d.reason} → ${held} vs AI ${f.ai.rule} @ ${f.ai.price} → ${ai}`;
          await this.repo.updateHeld(r.id, { detail: f, done: { at: now, price: d.price, reason, rulePnl: held, saved: r2(held - ai) } });
          this.dailyAtrs.delete(`held:${r.tradeId}`);
          this.logger.log(`[signal-paper] HELD follow ${f.symbol} (${r.tradeId}) done — ${reason}`);
        }
      } catch (err) {
        this.logger.warn(`[signal-paper] HELD follow ${r.tradeId}: ${errText(err)}`);
      }
    }
  }

  private shadowOn(): boolean {
    return (process.env.PAPER_EXIT_SHADOW ?? 'on').trim().toLowerCase() !== 'off';
  }

  @Cron('*/30 * * * * *', { timeZone: 'Asia/Kolkata' })
  async tick(): Promise<void> {
    if (this.cfg.mode === 'off' || !bootJobsEnabled() || this.busy) return;
    this.busy = true;
    try {
      await this.sweep(new Date());
    } catch (err) {
      this.logger.warn(`[signal-paper] sweep failed: ${errText(err)}`);
    } finally {
      this.busy = false;
    }
  }

  async sweep(now: Date): Promise<{ checked: number; exited: number }> {
    const owner = this.cfg.ownerUserId;
    if (!owner) return { checked: 0, exited: 0 };
    const open = await this.repo.openPaperTrades();
    let exited = 0;
    const priced: PaperPosition[] = [];
    /** Open, market-open and not closed this sweep — priced or not (the paper sentinel keeps these). */
    const stillOpen = new Set<string>();
    for (const t of open) {
      const inst = t.instrument;
      if (!inst?.token || !inst.exchange) continue;
      let isOpen = false;
      let minutesToClose: number | null = null;
      try {
        isOpen = this.clock.isOpen(inst.exchange, now);
        minutesToClose = this.clock.minutesToClose(inst.exchange, now);
      } catch {
        isOpen = false;
      }
      if (!isOpen) continue;
      const ltp = await this.quotes.ltp(owner, inst.token, inst.exchange).catch(() => null);
      // Shadow first, on the same LTP: a stop crossed on the tick the trade exits is still recorded.
      if (this.shadowOn()) await this.shadowStep(owner, t, ltp, now);
      const horizon = horizonFromTags(t.entryTags);
      const targets = await this.targetsFor(t);
      const d = paperExitDecision({
        side: t.side,
        ltp,
        sl: t.stoploss,
        target: t.target,
        product: t.positionType,
        minutesToClose,
        // A carried (BTST / POSITIONAL) trade: held overnight, closed on its contract's expiry day / at the hold limit.
        horizon,
        entryTime: t.entryTime ?? t.createdAt,
        now,
        expiry: inst.expiry ?? null,
        // Target trailing: a hit target that is not the last steps the SL up instead of exiting.
        entry: t.entryPrice,
        targets,
        planSl: this.planSls.get(t.id) ?? null,
        // The noise trail + breakeven guard, on the horizon's noise scale (1-min N intraday, daily ATR carried).
        noise: await this.noiseFor(owner, t.id, horizon, inst, now),
      });
      try {
        if (!d.exit && d.trail) {
          // The row IS the trail state (restart-safe): its stoploss and target move, the trade stays open.
          await this.repo.setPaperTrail(t.id, d.trail.sl, d.trail.target);
          t.stoploss = d.trail.sl;
          t.target = d.trail.target;
          this.logger.warn(`[signal-paper] trailed paper ${inst.symbol} (${t.id}): ${d.trail.reason}`);
        }
        if (d.exit) {
          const line = this.shadowOn() ? await this.shadowSettle(t, d.price, now) : null;
          await this.exec.closeTrade(t.id, { exitReasonTag: d.tag, reason: d.reason, exitNotes: line ? `${d.reason} | shadow: ${line}` : d.reason, exitPrice: d.price });
          exited += 1;
          this.forget(t.id);
          this.logger.warn(`[signal-paper] closed paper ${inst.symbol} (${t.id}): ${d.reason}`);
          if (t.entryTags.includes('learn')) await this.scoreAi(t, d.price, d.tag, now);
        } else {
          stillOpen.add(t.id);
        }
        if (!d.exit && ltp !== null && ltp > 0 && t.entryPrice && t.entryPrice > 0) {
          priced.push({
            tradeId: t.id, userId: owner, symbol: inst.symbol, exchange: inst.exchange, token: inst.token, side: t.side, quantity: t.quantity,
            entryPrice: t.entryPrice, entryTime: t.entryTime ?? t.createdAt, product: t.positionType ?? null,
            decisionId: decisionIdFromTags(t.entryTags), ltp, ltpAt: now,
          });
          const sign = String(t.side).toUpperCase() === 'BUY' ? 1 : -1;
          const pnl = sign * (ltp - t.entryPrice) * t.quantity;
          await this.trades.updateTrade(t.id, { pnl: r2(pnl), pnlPercent: r2(((sign * (ltp - t.entryPrice)) / t.entryPrice) * 100) });
        }
      } catch (err) {
        this.logger.warn(`[signal-paper] ${inst.symbol} (${t.id}): ${errText(err)}`);
      }
    }
    if (this.shadowOn()) this.paperSentinel?.observe(priced, now, stillOpen);
    if (this.shadowOn()) await this.followHeld(owner, now);
    return { checked: open.length, exited };
  }

  /**
   * One shadow step for an open paper trade: the live exit rules on this LTP, recorded never acted on
   * (domain/exit-shadow). Restores the state from the TRACK row the first time a trade is seen (restart),
   * refreshes the noise unit, persists new hits and a changed state. Never throws.
   */
  private async shadowStep(owner: string, t: PaperTradeRow, ltp: number | null, now: Date): Promise<void> {
    try {
      if (!t.entryPrice || !(t.entryPrice > 0)) return;
      const sh = this.shadows.get(t.id) ?? (await this.shadowLoad(t));
      this.shadows.set(t.id, sh);
      await this.refreshNoise(owner, t, sh, now);
      const before = JSON.stringify(sh.state);
      const r = stepShadow(sh.state, { side: t.side, entry: t.entryPrice, ltp, refSl: sh.refSl, n: sh.n, params: this.shadowParams, now });
      sh.state = r.state;
      for (const h of r.hits) {
        await this.repo.saveShadowHit(t.id, sh.decisionId, h.rule, h.hit, { baseline: sh.baseline, peak: r.state.peak, n: sh.n, nMethod: sh.nMethod, floorLevel: r.state.floorLevel, refSl: sh.refSl });
        this.logger.log(`[signal-paper] shadow ${h.rule} ${t.instrument?.symbol} @ ${h.hit.price}: ${h.hit.reason}`);
      }
      if (JSON.stringify(sh.state) !== before) await this.repo.saveShadowTrack(t.id, sh.decisionId, this.trackDetail(sh));
    } catch (err) {
      this.logger.warn(`[signal-paper] shadow step ${t.id}: ${errText(err)}`);
    }
  }

  /**
   * The noise trail + breakeven guard inputs, on the trade's horizon (owner 2026-10-29):
   * - INTRADAY: the exit shadow's contract 1-min noise N and best price since entry (stepped on this same
   *   LTP just before), the live trail distance (FLOOR_TRAIL_N), guard PAPER_STEP_MIN_N × N. Undefined
   *   without a shadow (PAPER_EXIT_SHADOW=off) ⇒ the only target exits, every step as before.
   * - Carried (BTST / POSITIONAL): the contract's DAILY ATR(14) (read once per trade per IST day; when
   *   unreadable, the 1-min N × √(session minutes) — the inverse of exit-discipline's daily→1-min scaling),
   *   trail PAPER_CARRIED_TRAIL_ATR × ATR, guard PAPER_STEP_MIN_ATR × ATR. Undefined when neither is known.
   */
  private async noiseFor(
    owner: string,
    tradeId: string,
    horizon: SignalHorizon,
    inst: { token: string; exchange: string },
    now: Date,
  ): Promise<PaperNoise | undefined> {
    const sh = this.shadows.get(tradeId);
    const peak = sh?.state.peak ?? null;
    if (!isCarried(horizon)) {
      return sh ? { n: sh.n, peak, trailN: this.shadowParams.trailN, minStepN: this.trailCfg.stepMinN, unit: '1m N' } : undefined;
    }
    const atr = await this.dailyAtrFor(owner, tradeId, inst, now);
    const scaled = sh?.n && sh.n > 0 ? r2(sh.n * Math.sqrt(DEFAULT_SESSION_MINUTES)) : null;
    const n = atr ?? scaled;
    if (n === null) return undefined;
    return { n, peak, trailN: this.trailCfg.carriedTrailAtr, minStepN: this.trailCfg.stepMinAtr, unit: atr !== null ? 'daily ATR' : 'daily ATR (1m N scaled)' };
  }

  /** The contract's daily ATR(14) over the owner's session; cached per trade per IST day. Null when unreadable. */
  private async dailyAtrFor(owner: string, tradeId: string, inst: { token: string; exchange: string }, now: Date): Promise<number | null> {
    const day = istDay(now);
    const c = this.dailyAtrs.get(tradeId);
    if (c && c.day === day && (c.fresh || now.getTime() - c.at < NOISE_RETRY_MS)) return c.atr;
    let atr: number | null = null;
    if (this.bars?.dailyBars) {
      try {
        const bars = await this.bars.dailyBars(owner, inst.token, inst.exchange, new Date(now.getTime() - DAILY_LOOKBACK_DAYS * 86_400_000), now);
        atr = atr14(bars ?? []);
      } catch (err) {
        this.logger.warn(`[signal-paper] daily ATR for ${tradeId}: ${errText(err)}`);
      }
    }
    // Unreadable today: keep the last good one (an earlier day's) rather than drop to the scaled fallback; retry later.
    this.dailyAtrs.set(tradeId, { day, atr: atr ?? c?.atr ?? null, at: now.getTime(), fresh: atr !== null });
    return atr ?? c?.atr ?? null;
  }

  private forget(tradeId: string): void {
    this.targets.delete(tradeId);
    this.planSls.delete(tradeId);
    this.dailyAtrs.delete(tradeId);
  }

  /** The plan's targets for a paper trade (ordered, beyond the entry) and its SL; read once per trade, [] when none. */
  private async targetsFor(t: PaperTradeRow): Promise<number[]> {
    const cached = this.targets.get(t.id);
    if (cached) return cached;
    const decisionId = decisionIdFromTags(t.entryTags);
    let out: number[] = [];
    try {
      const plan = decisionId && t.entryPrice ? await this.repo.decisionPlan(decisionId) : null;
      out = plan && t.entryPrice ? orderedTargets(t.side, t.entryPrice, plan.targets) : [];
      const sl = Number(plan?.sl);
      this.planSls.set(t.id, Number.isFinite(sl) && sl > 0 ? sl : null);
    } catch (err) {
      this.logger.warn(`[signal-paper] targets for ${t.id}: ${errText(err)} — T1 exits as before`);
      return [];
    }
    this.targets.set(t.id, out);
    return out;
  }

  private trackDetail(sh: Shadowed): Record<string, unknown> {
    return { state: sh.state, refSl: sh.refSl, baseline: sh.baseline, n: sh.n, nMethod: sh.nMethod, nAt: sh.nAt };
  }

  private async shadowLoad(t: PaperTradeRow): Promise<Shadowed> {
    const decisionId = decisionIdFromTags(t.entryTags);
    const rows = await this.repo.shadowRows([t.id]);
    const track = rows.find((r) => r.rule === 'TRACK');
    const saved = track?.detail && typeof track.detail === 'object' ? (track.detail as Partial<Shadowed> & { state?: ShadowState }) : null;
    // The baseline as first seen: after target trailing a learning trade carries a real (moved) SL on its row,
    // and re-deriving it from the row would wrongly turn it into a 'stop' trade with no reference stop.
    if (saved && (saved.baseline === 'learn' || saved.baseline === 'stop')) {
      const state = saved.state ?? emptyShadow();
      for (const r of rows) {
        if (r.rule !== 'TRACK' && r.wouldExitAt && r.price !== null) state.hits[r.rule as keyof ShadowState['hits']] = { at: r.wouldExitAt.toISOString(), price: r.price, reason: 'restored' };
      }
      return { decisionId, refSl: saved.refSl ?? null, baseline: saved.baseline, state, n: saved.n ?? null, nMethod: saved.nMethod ?? null, nAt: saved.nAt ?? 0 };
    }
    const real = t.stoploss !== null && t.stoploss > 0;
    let refSl: number | null = null;
    if (!real && decisionId) {
      const plan = await this.repo.decisionPlan(decisionId);
      const sl = Number(plan?.sl);
      refSl = Number.isFinite(sl) && sl > 0 ? sl : null;
    }
    const state = saved?.state ?? emptyShadow();
    // Hits already written stay written (a restart never re-records a rule at a later price).
    for (const r of rows) {
      if (r.rule !== 'TRACK' && r.wouldExitAt && r.price !== null) state.hits[r.rule as keyof ShadowState['hits']] = { at: r.wouldExitAt.toISOString(), price: r.price, reason: 'restored' };
    }
    return { decisionId, refSl, baseline: real ? 'stop' : 'learn', state, n: saved?.n ?? null, nMethod: saved?.nMethod ?? null, nAt: saved?.nAt ?? 0 };
  }

  /** The contract's 1-min noise unit (exit-discipline noiseFromBars over the last NOISE_LOOKBACK_MIN). */
  private async refreshNoise(owner: string, t: PaperTradeRow, sh: Shadowed, now: Date): Promise<void> {
    if (!this.bars || !t.instrument?.token) return;
    const age = now.getTime() - sh.nAt;
    if (age < (sh.n === null ? NOISE_RETRY_MS : NOISE_REFRESH_MS)) return;
    sh.nAt = now.getTime();
    const bars = await this.bars.minuteBars(owner, t.instrument.token, t.instrument.exchange, new Date(now.getTime() - NOISE_LOOKBACK_MIN * 60_000), now).catch(() => []);
    const reading = noiseFromBars(bars);
    if (reading) {
      sh.n = r2(reading.n);
      sh.nMethod = reading.method;
    }
  }

  /** At the paper close: settle every shadow row against the held result; the line for the exit notes. */
  private async shadowSettle(t: PaperTradeRow, exit: number, now: Date): Promise<string | null> {
    try {
      if (!t.entryPrice) return null;
      const entry = t.entryPrice;
      const held = grossPnl(t.side, entry, exit, t.quantity);
      const hits = await this.repo.settleShadows(t.id, { heldPnl: held, rulePnl: (p) => grossPnl(t.side, entry, p, t.quantity), at: now });
      this.shadows.delete(t.id);
      return shadowLine(Object.fromEntries(hits.map((h) => [h.rule, h])), held);
    } catch (err) {
      this.logger.warn(`[signal-paper] shadow settle ${t.id}: ${errText(err)}`);
      return null;
    }
  }

  /** Learning mode: the closed trade held against the judge's own call (never throws). */
  private async scoreAi(t: PaperTradeRow, exit: number, tag: string, now: Date): Promise<void> {
    const decisionId = decisionIdFromTags(t.entryTags);
    if (!decisionId) return;
    try {
      const judge = await this.repo.decisionJudge(decisionId);
      const check = aiCheck({ aiDecision: aiDecisionOf(judge), side: t.side, entry: t.entryPrice, exit, qty: t.quantity, exitTag: tag, at: now });
      await this.repo.recordAiCheck(decisionId, check);
      this.logger.log(`[signal-paper] AI check ${decisionId}: AI said ${check.aiDecision}, move ${check.movePct}% → ${check.correct === null ? 'not scored' : check.correct ? 'RIGHT' : 'WRONG'}`);
    } catch (err) {
      this.logger.warn(`[signal-paper] AI check for ${decisionId} failed: ${errText(err)}`);
    }
  }
}
