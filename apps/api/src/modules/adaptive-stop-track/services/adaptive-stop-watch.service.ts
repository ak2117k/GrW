import { Injectable, Logger } from '@nestjs/common';
import { Prisma, WatchEventType, WatchStatus } from '@prisma/client';
import {
  AdaptiveStopWatchRepository, AdaptiveStopCreateEntryInput,
} from '../repositories/adaptive-stop-watch.repository';
import { AdaptiveStopTradeRepository } from '../repositories/adaptive-stop-trade.repository';
import { AdaptiveStopAccountService } from './adaptive-stop-account.service';
import { AdaptiveStopTradeExecutionService } from './adaptive-stop-trade-execution.service';
import { AdaptiveStopGateway } from '../gateways/adaptive-stop.gateway';
import { AngelOneAdapterService } from '../../market-data/services/angel-one-adapter.service';
import { resolveStop, resolveTrail, sizeQuantity } from '../adaptive-stop-math';
import { evaluateDecisionGate, type GateCandle } from '../adaptive-stop-decision-gate';
import {
  GRACE_MS, PROFIT_TARGET_PCT, RISK_PER_TRADE,
  DECISION_GATE_ENABLED, GATE_NEAR_SUPPORT_PCT, GATE_RSI_HOT, GATE_VWAP_EXT_PCT, GATE_SR_LOOKBACK_DAYS,
  GATE_REQUIRE_15M_MACD, GATE_FETCH_ATTEMPTS, GATE_RETRY_MS, GATE_MIN_CANDLES,
} from '../constants';
import { atr } from '../../signal-generator/strategies/indicators';
// Note: NO MarketFeedService dependency — the adaptive-stop track uses
// a REST poller (mirrors the ungated track) to sidestep the broker's
// ~50-token WebSocket cap.

export class AdaptiveStopSymbolDupError extends Error {
  constructor(public readonly symbol: string) {
    super(`adaptive-stop: symbol ${symbol} already has an active entry`);
    this.name = 'AdaptiveStopSymbolDupError';
  }
}
export class AdaptiveStopCooldownError extends Error {
  constructor(public readonly symbol: string) {
    super(`adaptive-stop: symbol ${symbol} in cooldown`);
    this.name = 'AdaptiveStopCooldownError';
  }
}

export class AdaptiveStopLastLossError extends Error {
  constructor(public readonly symbol: string, pnl: number) {
    super(`adaptive-stop: ${symbol} last closed trade was a loss (₹${pnl.toFixed(0)}) — entry blocked`);
    this.name = 'AdaptiveStopLastLossError';
  }
}

export class AdaptiveStopSellDirectionError extends Error {
  constructor(public readonly symbol: string) {
    super(`adaptive-stop: ${symbol} side=SELL rejected — adaptive-stop track is BUY-only`);
    this.name = 'AdaptiveStopSellDirectionError';
  }
}

export class AdaptiveStopStaleEntryError extends Error {
  constructor(public readonly symbol: string, public readonly dynamicRR: number) {
    super(`adaptive-stop: ${symbol} stale entry — dynamic R:R ${dynamicRR.toFixed(2)} below minimum; move already consumed`);
    this.name = 'AdaptiveStopStaleEntryError';
  }
}

export class AdaptiveStopNoQuoteError extends Error {
  constructor(public readonly symbol: string) {
    super(`adaptive-stop: ${symbol} rejected — live quote unavailable, cannot enter at stale Chartink price`);
    this.name = 'AdaptiveStopNoQuoteError';
  }
}

export class AdaptiveStopRiskBudgetError extends Error {
  constructor(public readonly symbol: string) {
    super(`adaptive-stop: ${symbol} rejected — stop distance exceeds the per-trade risk budget (qty < 1)`);
    this.name = 'AdaptiveStopRiskBudgetError';
  }
}

export class AdaptiveStopDecisionGateError extends Error {
  constructor(public readonly symbol: string, public readonly gateReason: string) {
    super(`adaptive-stop: ${symbol} rejected by decision gate — ${gateReason}`);
    this.name = 'AdaptiveStopDecisionGateError';
  }
}

export interface AdaptiveStopCreateFromAlertInput {
  alertId: string | null;
  setupId: string | null;
  symbol: string;
  token: string;
  exchange: string;
  side: 'BUY' | 'SELL';
  initialPrice: number;
  initialScore: number;
  initialBreakdown: Prisma.InputJsonValue;
}

export const TRADE_COOLDOWN_MS = 45 * 60_000;
const HARD_STOP_PCT = 0.004;

@Injectable()
export class AdaptiveStopWatchService {
  private readonly logger = new Logger(AdaptiveStopWatchService.name);

  constructor(
    private readonly repo: AdaptiveStopWatchRepository,
    private readonly trades: AdaptiveStopTradeRepository,
    private readonly account: AdaptiveStopAccountService,
    private readonly exec: AdaptiveStopTradeExecutionService,
    private readonly gateway: AdaptiveStopGateway,
    private readonly adapter: AngelOneAdapterService,
  ) {}

  /** Recent 5m ATR(14) for the token via the broker adapter, or 0 on any failure. */
  private async atr5mFor(token: string, exchange: string): Promise<number> {
    try {
      const now = new Date();
      const from = new Date(now.getTime() - 3 * 24 * 3600 * 1000);
      const c = await this.adapter.getHistoricalData(token, exchange, '5m', from, now);
      if (!Array.isArray(c) || c.length < 21) return 0;
      const a = atr(
        c.map((x: any) => x.high),
        c.map((x: any) => x.low),
        c.map((x: any) => x.close),
        14,
      );
      return a ?? 0;
    } catch {
      return 0;
    }
  }

  /**
   * Decision Gate (CORE2): fetch the multi-day 15m series and evaluate the
   * structural filter at the live fill price. Fails OPEN on any data/fetch
   * problem (a candle gap must never silently suppress an entry — that would
   * corrupt the A/B vs the other tracks). See adaptive-stop-decision-gate.ts.
   */
  private async evaluateGate(token: string, exchange: string, entry: number) {
    const now = new Date();
    const from = new Date(now.getTime() - GATE_SR_LOOKBACK_DAYS * 24 * 3600 * 1000);
    // Harden the 15m fetch: a transient feed/REST blip (or a momentarily-partial
    // series) must not switch the gate off on the first try. Retry before
    // giving up; only then does the gate fall back to its fail-open skip.
    let candles: GateCandle[] = [];
    for (let attempt = 1; attempt <= GATE_FETCH_ATTEMPTS; attempt++) {
      try {
        const c = await this.adapter.getHistoricalData(token, exchange, '15m', from, now);
        if (c && c.length) candles = c as GateCandle[];
        if (candles.length >= GATE_MIN_CANDLES) break; // enough to judge
      } catch (err) {
        this.logger.warn(
          `[adaptive-stop] decision-gate 15m fetch attempt ${attempt}/${GATE_FETCH_ATTEMPTS} for ${token} failed: ${err instanceof Error ? err.message : err}`,
        );
      }
      if (attempt < GATE_FETCH_ATTEMPTS) await this.delay(GATE_RETRY_MS);
    }
    // evaluateDecisionGate itself returns {skipped:true, pass:true} when the data
    // is still insufficient — so a persistent gap still fails OPEN, but now it's
    // recorded (the caller persists gateSkipped/reason) instead of being silent.
    return evaluateDecisionGate(entry, candles, now.getTime(), {
      nearSupportPct: GATE_NEAR_SUPPORT_PCT,
      rsiHot: GATE_RSI_HOT,
      vwapExtPct: GATE_VWAP_EXT_PCT,
      requireMacdBullish: GATE_REQUIRE_15M_MACD,
    });
  }

  /** Small awaitable backoff — a method so tests can stub it to resolve instantly. */
  private delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  async createFromAlert(input: AdaptiveStopCreateFromAlertInput) {
    // 0. BUY-only gate — adaptive-stop track trades equities long only.
    if (input.side !== 'BUY') throw new AdaptiveStopSellDirectionError(input.symbol);

    // 1. Symbol dedup — token-based, mirrors gated rule.
    const active = await this.repo.findActiveByToken(input.token);
    if (active.length > 0) throw new AdaptiveStopSymbolDupError(input.symbol);

    // 2. Cooldown — block re-entry on the same token within 45 minutes of
    //    its last execution. Mirrors WatchService.createFromAlert. Without
    //    this the adaptive-stop track would loss-cut, immediately re-enter on
    //    the next scanner trigger, loss-cut again, and bleed cash on
    //    repeat ASHAPURMIN-style scenarios.
    const cooldownSince = new Date(Date.now() - TRADE_COOLDOWN_MS);
    if (await this.repo.wasTokenExecutedSince(input.token, cooldownSince)) {
      throw new AdaptiveStopCooldownError(input.symbol);
    }

    // 3. Green-only re-entry gate: block re-entry if the last closed trade
    //    for this symbol TODAY was a loss. Same-day only — yesterday's loss
    //    does not carry over to the next session.
    const todayIst = new Date(
      new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' }) + 'T00:00:00.000+05:30',
    );
    const lastPnl = await this.repo.getLastClosedPnlForToken(input.token, todayIst);
    if (lastPnl !== null && lastPnl <= 0) {
      this.logger.warn(
        `[adaptive-stop] ${input.symbol}: last closed trade was a loss (₹${lastPnl.toFixed(0)}) — entry blocked`,
      );
      throw new AdaptiveStopLastLossError(input.symbol, lastPnl);
    }

    // 4. Fetch live quote — required for entry price and upside gate.
    //    Reject the trade when unavailable: executing at a stale Chartink price
    //    (potentially 10–30% away from the real market) is worse than skipping.
    let liveQuote: number | null = null;
    try {
      const live = await this.adapter.getLiveQuote(input.token, input.exchange);
      if (live?.ltp && live.ltp > 0) liveQuote = live.ltp;
    } catch (err) {
      this.logger.warn(
        `[adaptive-stop] live quote failed for ${input.symbol}: ${err instanceof Error ? err.message : err}`,
      );
    }
    if (liveQuote == null) {
      this.logger.warn(
        `[adaptive-stop] ${input.symbol}: rejected — live quote unavailable (Chartink alert price ₹${input.initialPrice} may be stale)`,
      );
      throw new AdaptiveStopNoQuoteError(input.symbol);
    }

    // 5. Upside gate — block when the stock has already moved > 1% above the
    //    Chartink alert price before we can execute. Covers the genuine "already
    //    ran away" case while tolerating the normal 0–0.5% candle-close-to-
    //    execution drift. The old "remaining < 2%" check fired on any upward
    //    tick from alert price — too sensitive for intraday momentum signals.
    //    After this check, profitTarget is anchored to the live fill price so
    //    the target is always 2% from actual entry.
    const moveFromAlert = input.initialPrice > 0 ? (liveQuote - input.initialPrice) / input.initialPrice : 0;
    if (moveFromAlert > 0.01) {
      this.logger.warn(
        `[adaptive-stop] ${input.symbol}: stale entry blocked — already moved +${(moveFromAlert * 100).toFixed(2)}% ` +
        `from alert ₹${input.initialPrice} (live ₹${liveQuote})`,
      );
      throw new AdaptiveStopStaleEntryError(input.symbol, moveFromAlert / HARD_STOP_PCT);
    }
    const executedPrice = liveQuote;
    const profitTarget = executedPrice * (1 + PROFIT_TARGET_PCT); // 2% from fill

    // 5b. DECISION GATE (CORE2) — the post-score structural filter. The score
    //     gate is non-predictive (rewards extension); this only admits entries
    //     that are AT support and NOT extended, the read that forward-validated
    //     (held-out: 50% win / +₹373/trade vs ungated 31% / −₹5,075). Evaluated
    //     at the live fill price. Toggle via DECISION_GATE_ENABLED to A/B.
    let gateResult: ReturnType<typeof evaluateDecisionGate> | null = null;
    if (DECISION_GATE_ENABLED) {
      gateResult = await this.evaluateGate(input.token, input.exchange, executedPrice);
      if (!gateResult.pass) {
        this.logger.warn(`[adaptive-stop] ${input.symbol}: decision-gate REJECT — ${gateResult.reason}`);
        throw new AdaptiveStopDecisionGateError(input.symbol, gateResult.reason);
      }
      this.logger.log(
        `[adaptive-stop] ${input.symbol}: decision-gate ${gateResult.skipped ? 'SKIPPED (failed open)' : 'PASS'} — ${gateResult.reason}`,
      );
    }

    // 6. Admission (capital + position cap + kill switch).
    const openTrades = await this.repo.countOpenTrades();
    await this.account.admit({ openTrades });

    // 7. Risk-first sizing + volatility stop at the live fill price.
    //    Stop = ATR_MULT × 5m-ATR(14), floored/capped; qty sized so the
    //    loss-at-stop equals RISK_PER_TRADE. Reject when even 1 share would
    //    exceed the risk budget (stop distance too wide).
    const atr5m = await this.atr5mFor(input.token, input.exchange);
    const stop = resolveStop(executedPrice, atr5m);
    const qty = sizeQuantity(stop.stopDist);
    if (qty < 1) {
      this.logger.warn(
        `[adaptive-stop] ${input.symbol}: stop ₹${stop.stopDist.toFixed(2)} exceeds risk budget — rejected`,
      );
      throw new AdaptiveStopRiskBudgetError(input.symbol);
    }

    // 8. Create the WATCHING entry row (with the resolved stop + risk metadata).
    const createInput: AdaptiveStopCreateEntryInput = {
      alertId: input.alertId,
      setupId: input.setupId,
      symbol: input.symbol,
      token: input.token,
      exchange: input.exchange,
      side: input.side,
      initialPrice: input.initialPrice,
      initialScore: input.initialScore,
      initialBreakdown: input.initialBreakdown,
      profitTarget,
      profitTargetSource: 'fallback-2pct',
      stopLossScore: 45,
      riskAmount: RISK_PER_TRADE,
      atrAtEntry: atr5m,
      stopPct: stop.stopPct,
      stopPrice: stop.stopPrice,
      stopBasis: stop.basis,
      // Decision Gate outcome (observability — measure how often it fails open).
      gateSkipped: gateResult ? gateResult.skipped : undefined,
      gateReason: gateResult ? gateResult.reason : undefined,
      gateDetail: gateResult ? (gateResult.detail as unknown as Prisma.InputJsonValue) : undefined,
    };
    const entry = await this.repo.createEntry(createInput);
    await this.repo.createEvent({
      watchEntryId: entry.id,
      eventType: WatchEventType.INITIAL,
      price: input.initialPrice,
      score: input.initialScore,
      breakdown: input.initialBreakdown,
    });

    // 9. Auto-execute at the LIVE broker price fetched in step 4 above.
    //    executedPrice and profitTarget are already anchored to the same
    //    live snapshot from step 5 — no second broker round-trip needed.
    const trade = await this.exec.openTrade({
      instrumentId: entry.id,
      side: input.side,
      quantity: qty,
      entryPrice: executedPrice,
      exchange: input.exchange,
      target: profitTarget,
      stoploss: stop.stopPrice,
    });
    await this.repo.update(entry.id, {
      status: WatchStatus.TRADED,
      paperTradeId: trade.id,
      executedAt: new Date(),
      executedPrice,
      quantity: qty,
    });

    // No feed.subscribeForWatch here: adaptive-stop entries are driven by the
    // REST poller on a cron, not WS.

    return entry;
  }

  // --- Constants ---
  private readonly PARTIAL_EXIT_THRESHOLD_PCT = 0.01;
  private readonly PARTIAL_EXIT_FRACTION = 0.5;
  // Trailing give-back is now ATR-based (resolveTrail), not a flat percent — see
  // TRAIL_ATR_MULT/TRAIL_MIN_PCT/TRAIL_MAX_PCT in constants.ts.
  private readonly MATERIAL_CHANGE_PCT = 0.0025;

  // --- Public tick entrypoint ---
  async onTick(token: string, ltp: number, ts: Date): Promise<void> {
    const entries = await this.repo.findActiveByToken(token);
    for (const entry of entries) {
      if (entry.status !== 'TRADED') continue;
      // Persist the live price so the frontend's P&L column has a value
      // to render. Mirrors what gated WatchService writes on every tick.
      try {
        await this.repo.update(entry.id, { currentPrice: ltp, lastTickAt: ts });
        // Push the full updated row via WebSocket so the frontend merges
        // in place — no per-tick refetch, no table flash.
        const fresh = await this.repo.findById(entry.id);
        if (fresh) this.gateway.emitEntry(fresh);
      } catch (err) {
        this.logger.warn(`[adaptive-stop] failed to persist tick for ${entry.symbol}: ${err}`);
      }
      try {
        await this.applyTick(entry, ltp);
      } catch (err) {
        this.logger.warn(
          `[adaptive-stop] applyTick ${entry.symbol} threw: ${err instanceof Error ? err.message : err}`,
        );
      }
    }
  }

  private async applyTick(entry: any, ltp: number): Promise<void> {
    const sideMul: 1 | -1 = entry.side === 'BUY' ? 1 : -1;

    // 1. Target-hit wins first.
    const isTargetHit =
      entry.profitTarget != null &&
      (sideMul === 1 ? ltp >= entry.profitTarget : ltp <= entry.profitTarget);
    if (isTargetHit) return this.transitionTargetHit(entry, ltp);

    // 2. Per-entry volatility stop with a 2-minute entry grace + two-strike guard.
    //    No stop is honored in the first GRACE_MS after the fill so the position
    //    has room to breathe through normal entry noise. After grace, the stored
    //    `stopPrice` (vol-stop set at entry) is the breach level. REST polling
    //    fires every 30s, so a brief fake selloff (stop-hunt) within one window
    //    would otherwise cut immediately — require 2 consecutive breach polls.
    const sinceEntryMs = entry.executedAt ? Date.now() - new Date(entry.executedAt).getTime() : Infinity;
    const inGrace = sinceEntryMs < GRACE_MS;
    const ref = entry.executedPrice ?? entry.initialPrice;
    const stopPrice = entry.stopPrice ?? ref * (1 - 0.008);
    const breached = sideMul === 1 ? ltp <= stopPrice : ltp >= stopPrice;
    if (!inGrace && breached) {
      const cur = entry.slBreachCount ?? 0;
      if (cur < 1) {
        this.logger.warn(
          `[adaptive-stop] ${entry.symbol}: first SL breach (stop-hunt guard) — ltp=${ltp} ` +
          `stop=${stopPrice}, awaiting confirmation on next poll`,
        );
        await this.repo.update(entry.id, { slBreachCount: cur + 1 });
        return;
      }
      // Second consecutive breach — confirmed breakdown, exit. Cap the exit at
      // the stop price so the recorded loss never exceeds the intended stop,
      // matching how a real stop-limit order would behave (30s poll may overshoot).
      const openLoss = this.computeOpenPnl(entry, ltp);
      const cappedExit = sideMul === 1 ? Math.max(ltp, stopPrice) : Math.min(ltp, stopPrice);
      return this.transitionLossCut(entry, cappedExit, openLoss);
    }

    // Price is on the safe side of the stop — reset breach counter if non-zero
    // so a price recovery between two polls clears the strike count.
    if (!breached && (entry.slBreachCount ?? 0) > 0) {
      this.logger.log(
        `[adaptive-stop] ${entry.symbol}: SL breach count reset (price recovered above stop, ltp=${ltp})`,
      );
      await this.repo.update(entry.id, { slBreachCount: 0 });
    }

    // 3. Partial-exit / trailing-stop.
    if (!entry.partialExitedAt) {
      await this.checkPartialExitTrigger(entry, ltp);
    } else {
      await this.updateTrailingStop(entry, ltp);
    }

    // Material price-move event so the entry's event log stays alive between
    // transitions (mirrors the gated WatchService). Only fires on >=0.25% moves.
    const last = entry.lastEventPrice ?? entry.initialPrice;
    if (last > 0) {
      const delta = (ltp - last) / last;
      if (Math.abs(delta) >= this.MATERIAL_CHANGE_PCT) {
        await this.repo.createEvent({
          watchEntryId: entry.id,
          eventType: WatchEventType.PRICE_CHANGE,
          price: ltp,
          priceDelta: delta * 100,
          score: null,
          breakdown: null,
        });
        await this.repo.update(entry.id, { lastEventPrice: ltp });
      }
    }
  }

  private computeOpenPnl(entry: any, ltp: number): number {
    const ref = entry.executedPrice ?? entry.initialPrice;
    const sideMul: 1 | -1 = entry.side === 'BUY' ? 1 : -1;
    const qty = entry.remainingQty ?? entry.quantity ?? 0;
    return (ltp - ref) * sideMul * qty;
  }

  private async transitionTargetHit(entry: any, price: number): Promise<void> {
    await this.repo.createEvent({
      watchEntryId: entry.id, eventType: WatchEventType.TARGET_HIT, price,
    });
    await this.exec.closeTrade(entry.paperTradeId, {
      reason: 'target-hit', exitPrice: price,
    });
    await this.repo.update(entry.id, {
      status: WatchStatus.TARGET_HIT, closedAt: new Date(), closedReason: 'target-hit',
    });
  }

  private async transitionLossCut(entry: any, exitPrice: number, openLoss: number): Promise<void> {
    await this.repo.createEvent({
      watchEntryId: entry.id, eventType: WatchEventType.SL_HIT_PRICE, price: exitPrice,
      notes: `cause:loss-cut loss:${Math.abs(openLoss).toFixed(0)}`,
    });
    await this.exec.closeTrade(entry.paperTradeId, {
      reason: 'sl-loss-cut', exitPrice,
    });
    await this.repo.update(entry.id, {
      status: WatchStatus.STOPPED, closedAt: new Date(), closedReason: 'loss-cut',
      currentPrice: exitPrice,
    });
  }

  private async checkPartialExitTrigger(entry: any, ltp: number): Promise<void> {
    const ref = entry.executedPrice ?? entry.initialPrice;
    if (ref <= 0) return;
    const sideMul: 1 | -1 = entry.side === 'BUY' ? 1 : -1;
    const moveFavor = ((ltp - ref) / ref) * sideMul;
    if (moveFavor < this.PARTIAL_EXIT_THRESHOLD_PCT) return;

    const initialQty = entry.quantity ??
      Math.max(1, Math.floor(2_00_000 / Math.max(ref, 1)));
    const partialQty = Math.floor(initialQty * this.PARTIAL_EXIT_FRACTION);
    const remainingQty = initialQty - partialQty;
    // ATR-based give-back from the partial-exit price (the first high-water).
    const trailingStopPrice = resolveTrail(ltp, entry.atrAtEntry, sideMul).stopPrice;

    await this.exec.closeTrade(entry.paperTradeId, {
      reason: 'partial-exit', quantity: partialQty, exitPrice: ltp,
    });
    await this.repo.createEvent({
      watchEntryId: entry.id, eventType: WatchEventType.PARTIAL_EXIT, price: ltp,
      notes: `partial 50% sold at +${(moveFavor * 100).toFixed(2)}%, trail @ ${trailingStopPrice.toFixed(2)}`,
    });
    await this.repo.update(entry.id, {
      partialExitedAt: new Date(),
      partialExitPrice: ltp,
      partialQty,
      remainingQty,
      trailingHighWater: ltp,
      trailingStopPrice,
    });
  }

  private async updateTrailingStop(entry: any, ltp: number): Promise<void> {
    const sideMul: 1 | -1 = entry.side === 'BUY' ? 1 : -1;
    let highWater = entry.trailingHighWater;
    let newStop = entry.trailingStopPrice;
    const moves = sideMul === 1 ? ltp > highWater : ltp < highWater;
    if (moves) {
      highWater = ltp;
      // Ratchet the ATR-based give-back up with each new high-water.
      newStop = resolveTrail(ltp, entry.atrAtEntry, sideMul).stopPrice;
      await this.repo.update(entry.id, {
        trailingHighWater: highWater,
        trailingStopPrice: newStop,
      });
    }
    const hit = sideMul === 1 ? ltp <= newStop : ltp >= newStop;
    if (hit) {
      await this.exec.closeTrade(entry.paperTradeId, {
        reason: 'trailing-stop', exitPrice: ltp,
      });
      await this.repo.createEvent({
        watchEntryId: entry.id, eventType: WatchEventType.TRAILING_STOP_HIT, price: ltp,
        notes: `trail stop fired (high-water ${highWater}, stop ${newStop.toFixed(2)})`,
      });
      await this.repo.update(entry.id, {
        status: WatchStatus.EXITED, closedAt: new Date(), closedReason: 'trailing-stop',
      });
    }
  }
}
