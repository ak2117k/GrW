import { Injectable, Logger } from '@nestjs/common';
import { Prisma, WatchEventType, WatchStatus } from '@prisma/client';
import {
  UngatedWatchRepository, UngatedCreateEntryInput,
} from '../repositories/ungated-watch.repository';
import { UngatedTradeRepository } from '../repositories/ungated-trade.repository';
import { UngatedPaperAccountService, TRADE_CAPITAL } from './ungated-paper-account.service';
import { UngatedTradeExecutionService } from './ungated-trade-execution.service';
import { UngatedWatchGateway } from '../gateways/ungated-watch.gateway';
import { AngelOneAdapterService } from '../../market-data/services/angel-one-adapter.service';
import { isHullScanner } from './ungated-scanner-filter';
// Note: NO MarketFeedService dependency — the ungated track uses
// `UngatedTickPoller` (REST every 30s) to sidestep the broker's
// ~50-token WebSocket cap. See specs/2026-05-20-ungated-shadow-track-design.md.

export class UngatedSymbolDupError extends Error {
  constructor(public readonly symbol: string) {
    super(`ungated: symbol ${symbol} already has an active entry`);
    this.name = 'UngatedSymbolDupError';
  }
}
export class UngatedCooldownError extends Error {
  constructor(public readonly symbol: string) {
    super(`ungated: symbol ${symbol} in cooldown`);
    this.name = 'UngatedCooldownError';
  }
}

export class UngatedLastLossError extends Error {
  constructor(public readonly symbol: string, pnl: number) {
    super(`ungated: ${symbol} last closed trade was a loss (₹${pnl.toFixed(0)}) — entry blocked`);
    this.name = 'UngatedLastLossError';
  }
}

export class UngatedSellDirectionError extends Error {
  constructor(public readonly symbol: string) {
    super(`ungated: ${symbol} side=SELL rejected — ungated track is BUY-only`);
    this.name = 'UngatedSellDirectionError';
  }
}

export class UngatedScannerNotAllowedError extends Error {
  constructor(public readonly symbol: string, public readonly scannerName: string | null) {
    super(
      `ungated: ${symbol} rejected — scanner "${scannerName ?? 'unknown'}" not allowed ` +
      `(Hull-only filter active; set UNGATED_HULL_ONLY=false to admit all scanners)`,
    );
    this.name = 'UngatedScannerNotAllowedError';
  }
}

export class UngatedStaleEntryError extends Error {
  constructor(public readonly symbol: string, public readonly dynamicRR: number) {
    super(`ungated: ${symbol} stale entry — dynamic R:R ${dynamicRR.toFixed(2)} below minimum; move already consumed`);
    this.name = 'UngatedStaleEntryError';
  }
}

export class UngatedNoQuoteError extends Error {
  constructor(public readonly symbol: string) {
    super(`ungated: ${symbol} rejected — live quote unavailable, cannot enter at stale Chartink price`);
    this.name = 'UngatedNoQuoteError';
  }
}

export interface UngatedCreateFromAlertInput {
  alertId: string | null;
  setupId: string | null;
  symbol: string;
  token: string;
  exchange: string;
  side: 'BUY' | 'SELL';
  initialPrice: number;
  initialScore: number;
  initialBreakdown: Prisma.InputJsonValue;
  scannerName: string | null;
}

// Updated 2026-06-27: pure 3% target / 1.5% stop hold (candle-replay optimum
// on the Hull-only ungated set). Partial-exit + trailing removed below so the
// live track actually realises the right-tail the backtest modelled.
const PROFIT_TARGET_PCT = 0.03; // 3% from fill price — no indicator-sr on ungated (YAGNI)
export const TRADE_COOLDOWN_MS = 45 * 60_000;
const HARD_STOP_PCT = 0.015;

@Injectable()
export class UngatedWatchService {
  private readonly logger = new Logger(UngatedWatchService.name);

  constructor(
    private readonly repo: UngatedWatchRepository,
    private readonly trades: UngatedTradeRepository,
    private readonly account: UngatedPaperAccountService,
    private readonly exec: UngatedTradeExecutionService,
    private readonly gateway: UngatedWatchGateway,
    private readonly adapter: AngelOneAdapterService,
  ) {}

  async createFromAlert(input: UngatedCreateFromAlertInput) {
    // 0a. Hull-only scanner gate — the ungated track's profit is concentrated in
    //    the `Anand 100Hull >200 hull` scanner; admit ONLY Hull-scanner signals.
    //    Toggle off with UNGATED_HULL_ONLY=false (read at call time so tests can
    //    flip it per-case). Fail-closed: a null/unresolved scanner name is rejected.
    if (process.env.UNGATED_HULL_ONLY !== 'false' && !isHullScanner(input.scannerName)) {
      throw new UngatedScannerNotAllowedError(input.symbol, input.scannerName);
    }

    // 0b. BUY-only gate — ungated track trades equities long only.
    if (input.side !== 'BUY') throw new UngatedSellDirectionError(input.symbol);

    // 1. Symbol dedup — token-based, mirrors gated rule.
    const active = await this.repo.findActiveByToken(input.token);
    if (active.length > 0) throw new UngatedSymbolDupError(input.symbol);

    // 2. Cooldown — block re-entry on the same token within 45 minutes of
    //    its last execution. Mirrors WatchService.createFromAlert. Without
    //    this the ungated track would loss-cut, immediately re-enter on
    //    the next scanner trigger, loss-cut again, and bleed cash on
    //    repeat ASHAPURMIN-style scenarios.
    const cooldownSince = new Date(Date.now() - TRADE_COOLDOWN_MS);
    if (await this.repo.wasTokenExecutedSince(input.token, cooldownSince)) {
      throw new UngatedCooldownError(input.symbol);
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
        `[ungated] ${input.symbol}: last closed trade was a loss (₹${lastPnl.toFixed(0)}) — entry blocked`,
      );
      throw new UngatedLastLossError(input.symbol, lastPnl);
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
        `[ungated] live quote failed for ${input.symbol}: ${err instanceof Error ? err.message : err}`,
      );
    }
    if (liveQuote == null) {
      this.logger.warn(
        `[ungated] ${input.symbol}: rejected — live quote unavailable (Chartink alert price ₹${input.initialPrice} may be stale)`,
      );
      throw new UngatedNoQuoteError(input.symbol);
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
        `[ungated] ${input.symbol}: stale entry blocked — already moved +${(moveFromAlert * 100).toFixed(2)}% ` +
        `from alert ₹${input.initialPrice} (live ₹${liveQuote})`,
      );
      throw new UngatedStaleEntryError(input.symbol, moveFromAlert / HARD_STOP_PCT);
    }
    const executedPrice = liveQuote;
    const profitTarget = executedPrice * (1 + PROFIT_TARGET_PCT); // 3% from fill

    // 6. Admission (capital + position cap + kill switch).
    const openTrades = await this.repo.countOpenTrades();
    await this.account.admit({ openTrades });

    // 7. profitTarget and executedPrice are already set in step 5 above,
    //    anchored to the live fill price so the target is always 2% from entry.

    // 8. Create the WATCHING entry row.
    const createInput: UngatedCreateEntryInput = {
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
      profitTargetSource: 'fallback-3pct',
      stopLossScore: 45,
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

    const qty = Math.max(1, Math.floor(TRADE_CAPITAL / Math.max(executedPrice, 1)));
    const trade = await this.exec.openTrade({
      instrumentId: entry.id,
      side: input.side,
      quantity: qty,
      entryPrice: executedPrice,
      exchange: input.exchange,
      target: profitTarget,
    });
    await this.repo.update(entry.id, {
      status: WatchStatus.TRADED,
      paperTradeId: trade.id,
      executedAt: new Date(),
      executedPrice,
      quantity: qty,
    });

    // No feed.subscribeForWatch here: ungated entries are driven by the
    // REST poller (UngatedTickPoller) on a 30-second cron, not WS.

    return entry;
  }

  // --- Constants ---
  // Pure 3% target / 1.5% stop hold (2026-06-27). Partial-exit + trailing were
  // removed so the position holds full size to target or stop — matching the
  // candle-replay backtest that produced the +3%/-1.5% edge (the old +1% partial
  // and 0.5% trail capped the right tail the edge depends on). The two-strike
  // stop-hunt guard is retained (orthogonal to the threshold).
  private readonly HARD_STOP_PCT = 0.015;

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
        this.logger.warn(`[ungated] failed to persist tick for ${entry.symbol}: ${err}`);
      }
      try {
        await this.applyTick(entry, ltp);
      } catch (err) {
        this.logger.warn(
          `[ungated] applyTick ${entry.symbol} threw: ${err instanceof Error ? err.message : err}`,
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

    // 2. Hard loss-cut (R5) — two-strike stop-hunt guard.
    // REST polling fires every 30s. A brief fake selloff (stop-hunt) within
    // one 30s window would trigger an immediate cut even though the price
    // recovers in the next poll. Require 2 consecutive breach polls before
    // exiting so genuine breakdowns are still caught while stop-hunts that
    // recover within 30s are ignored.
    const openLoss = this.computeOpenPnl(entry, ltp);
    const threshold = -this.HARD_STOP_PCT *
      (entry.executedPrice ?? entry.initialPrice) *
      (entry.remainingQty ?? entry.quantity ?? 0);
    if (openLoss <= threshold) {
      const currentBreachCount: number = entry.slBreachCount ?? 0;
      if (currentBreachCount < 1) {
        // First breach — increment counter, do NOT exit yet.
        this.logger.warn(
          `[ungated] ${entry.symbol}: first SL breach (stop-hunt guard) — ltp=${ltp} ` +
          `loss=₹${Math.abs(openLoss).toFixed(0)}, awaiting confirmation on next poll`,
        );
        await this.repo.update(entry.id, { slBreachCount: currentBreachCount + 1 });
        return;
      }
      // Second consecutive breach — confirmed breakdown, exit.
      // REST polling fires every 30s — by the time the poller observes the
      // trigger, ltp may already be well below (BUY) or above (SELL) the
      // theoretical SL price. Cap the exit at the threshold price so the
      // recorded loss never exceeds the intended -1.5%, matching how a
      // real stop-limit order would behave.
      const ref = entry.executedPrice ?? entry.initialPrice;
      const slPrice = sideMul === 1
        ? ref * (1 - this.HARD_STOP_PCT)
        : ref * (1 + this.HARD_STOP_PCT);
      const cappedExitPrice = sideMul === 1
        ? Math.max(ltp, slPrice)
        : Math.min(ltp, slPrice);
      return this.transitionLossCut(entry, cappedExitPrice, openLoss);
    }

    // Price is ABOVE the SL level — reset breach counter if it was non-zero
    // so a price recovery between two polls clears the strike count.
    if ((entry.slBreachCount ?? 0) > 0) {
      this.logger.log(
        `[ungated] ${entry.symbol}: SL breach count reset (price recovered above SL, ltp=${ltp})`,
      );
      await this.repo.update(entry.id, { slBreachCount: 0 });
    }

    // 3. (Pure-hold: partial-exit + trailing removed 2026-06-27.) The only exits
    //    are target-hit (+3%, step 1) and the two-strike hard stop (-1.5%, step 2).
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

}
