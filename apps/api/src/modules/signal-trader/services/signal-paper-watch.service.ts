import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { TradeExecutionService } from '../../trade-engine/services/trade-execution.service';
import { TradeRepository } from '../../trade-engine/repositories/trade.repository';
import { bootJobsEnabled } from '../../../common/utils/boot-jobs';
import { SignalTraderRepository } from '../repositories/signal-trader.repository';
import { decisionIdFromTags, horizonFromTags, orderedTargets, paperExitDecision } from '../domain/paper';
import { aiCheck, aiDecisionOf } from '../domain/ai-check';
import type { PaperTradeRow } from '../repositories/signal-trader.repository';
import type { SignalTraderConfig } from '../domain/signal-trader.config';
import { emptyShadow, grossPnl, shadowLine, stepShadow, type ShadowParams, type ShadowState } from '../domain/exit-shadow';
import { NOISE_LOOKBACK_MIN, parseExitDisciplineConfig } from '../../exit-discipline/config';
import { noiseFromBars } from '../../exit-discipline/noise';
import type { MinuteBar } from '../../exit-discipline/types';
import { PaperSentinelService, type PaperPosition } from '../../paper-sentinel/paper-sentinel.service';
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
}

/** A noise unit is re-read this often (sooner while it is still unknown). */
const NOISE_REFRESH_MS = 30 * 60_000;
const NOISE_RETRY_MS = 5 * 60_000;

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

/**
 * SL / target exits for the PAPER (no funds) trades. The paper engine has none of its own (the open
 * paper refresher only marks option P&L, and each paper track runs its own exit poller), so this is
 * the minimal one for these tagged trades: every 30 s, a fresh LTP over the owner's own Angel feed
 * session (a quote, never an order), then paperExitDecision → TradeExecutionService.closeTrade with
 * the exit price and reason tag (the standard paper close: journal, charges, paper balance), else a
 * mark-to-market P&L on the row. Only trades whose strategy is TELEGRAM_SIGNAL_NO_FUNDS are touched.
 */
@Injectable()
export class SignalPaperWatchService {
  private readonly logger = new Logger(SignalPaperWatchService.name);
  private busy = false;
  /** Paper exit shadow (domain/exit-shadow): per open trade, restored from its TRACK row on first sight. */
  private readonly shadows = new Map<string, Shadowed>();
  private readonly shadowParams: ShadowParams;
  /** Target trailing: each open trade's plan targets (domain/paper orderedTargets). */
  private readonly targets = new Map<string, number[]>();

  constructor(
    @Inject(SIGNAL_TRADER_CONFIG) private readonly cfg: SignalTraderConfig,
    private readonly repo: SignalTraderRepository,
    private readonly exec: TradeExecutionService,
    private readonly trades: TradeRepository,
    @Inject(SIGNAL_SESSION_CLOCK) private readonly clock: SessionClockLike,
    @Inject(SIGNAL_QUOTES) private readonly quotes: QuotesLike,
    @Optional() @Inject(SIGNAL_BARS) private readonly bars?: BarsLike,
    // Shadow stage 2: the live AI sentinel on these trades (looks + AI exits recorded, never acted on).
    @Optional() private readonly paperSentinel?: PaperSentinelService,
  ) {
    const d = parseExitDisciplineConfig(process.env);
    this.shadowParams = { armN: d.floorArmN, trailN: d.floorTrailN, givebackN: d.givebackN };
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
      const d = paperExitDecision({
        side: t.side,
        ltp,
        sl: t.stoploss,
        target: t.target,
        product: t.positionType,
        minutesToClose,
        // A carried (BTST / POSITIONAL) trade: held overnight, closed on its contract's expiry day / at the hold limit.
        horizon: horizonFromTags(t.entryTags),
        entryTime: t.entryTime ?? t.createdAt,
        now,
        expiry: inst.expiry ?? null,
        // Target trailing: a hit target that is not the last steps the SL up instead of exiting.
        entry: t.entryPrice,
        targets: await this.targetsFor(t),
      });
      try {
        if (!d.exit && d.trail) {
          // The row IS the trail state (restart-safe): its stoploss and target move, the trade stays open.
          await this.trades.updateTrade(t.id, { stoploss: d.trail.sl, target: d.trail.target });
          t.stoploss = d.trail.sl;
          t.target = d.trail.target;
          this.logger.warn(`[signal-paper] trailed paper ${inst.symbol} (${t.id}): ${d.trail.reason}`);
        }
        if (d.exit) {
          const line = this.shadowOn() ? await this.shadowSettle(t, d.price, now) : null;
          await this.exec.closeTrade(t.id, { exitReasonTag: d.tag, reason: d.reason, exitNotes: line ? `${d.reason} | shadow: ${line}` : d.reason, exitPrice: d.price });
          exited += 1;
          this.targets.delete(t.id);
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

  /** The plan's targets for a paper trade (ordered, beyond the entry); read once per trade, [] when none. */
  private async targetsFor(t: PaperTradeRow): Promise<number[]> {
    const cached = this.targets.get(t.id);
    if (cached) return cached;
    const decisionId = decisionIdFromTags(t.entryTags);
    let out: number[] = [];
    try {
      const plan = decisionId && t.entryPrice ? await this.repo.decisionPlan(decisionId) : null;
      out = plan && t.entryPrice ? orderedTargets(t.side, t.entryPrice, plan.targets) : [];
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
