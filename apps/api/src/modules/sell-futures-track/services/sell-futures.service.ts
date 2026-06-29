import { Injectable, Logger } from '@nestjs/common';
import { Prisma, WatchEventType, WatchStatus } from '@prisma/client';
import { computeOrderCharges } from '../../trade-engine/services/trade-charges';
import {
  SellFuturesWatchRepository, SellFuturesCreateEntryInput,
} from '../repositories/sell-futures-watch.repository';
import { SellFuturesTradeRepository } from '../repositories/sell-futures-trade.repository';
import { SellFuturesPaperAccountService } from './sell-futures-paper-account.service';
import { FutureSelectorService } from './future-selector.service';
import { AngelOneAdapterService } from '../../market-data/services/angel-one-adapter.service';
import {
  PROFIT_TARGET_PCT, HARD_STOP_PCT, TRADE_COOLDOWN_MS, MARGIN_PCT,
} from '../constants';

export class SellFuturesNoFutureError extends Error {
  constructor(public readonly symbol: string) {
    super(`sell-futures: ${symbol} has no tradeable stock future — short skipped`);
    this.name = 'SellFuturesNoFutureError';
  }
}
export class SellFuturesSymbolDupError extends Error {
  constructor(public readonly symbol: string) {
    super(`sell-futures: ${symbol} future already has an active entry`);
    this.name = 'SellFuturesSymbolDupError';
  }
}
export class SellFuturesCooldownError extends Error {
  constructor(public readonly symbol: string) {
    super(`sell-futures: ${symbol} future in cooldown`);
    this.name = 'SellFuturesCooldownError';
  }
}
export class SellFuturesNoQuoteError extends Error {
  constructor(public readonly symbol: string) {
    super(`sell-futures: ${symbol} rejected — live futures quote unavailable`);
    this.name = 'SellFuturesNoQuoteError';
  }
}

export interface SellFuturesCreateFromAlertInput {
  alertId: string | null;
  setupId: string | null;
  symbol: string;          // equity symbol (e.g. RELIANCE)
  token: string;           // equity token (NSE)
  exchange: string;        // NSE
  side: 'BUY' | 'SELL';
  initialPrice: number;    // equity Chartink hit price
  initialScore: number;
  initialBreakdown: Prisma.InputJsonValue;
  scannerName: string | null;
}

/**
 * SELL-Futures track entry gates + paper execution + SHORT exit logic.
 *
 * Mirrors UngatedWatchService but shorts the resolved STOCK FUTURE (NFO) on a
 * bearish (SELL) signal rather than the equity. The future is resolved INSIDE
 * gate 1 (FutureSelectorService), so the Chartink trigger only passes the
 * equity symbol + side.
 *
 *   gate 1: resolve future            → SellFuturesNoFutureError
 *   gate 2: symbol dedup (fut token)  → SellFuturesSymbolDupError
 *   gate 3: cooldown 45m (fut token)  → SellFuturesCooldownError
 *   gate 4: cap / kill / margin pool  → PositionCap / KillSwitch / MarginExhausted
 *   gate 5: live quote on NFO token   → SellFuturesNoQuoteError
 *   size:   quantity = lotSize (1 lot)
 *   target: entry × (1 − 2%);  hard SL: entry × (1 + 0.4%)
 */
@Injectable()
export class SellFuturesService {
  private readonly logger = new Logger(SellFuturesService.name);

  // Exit tuning — mirrors the ungated track (side-aware, reused for SHORT).
  private readonly PARTIAL_EXIT_THRESHOLD_PCT = 0.01;
  private readonly PARTIAL_EXIT_FRACTION = 0.5;
  private readonly TRAILING_STOP_PCT = 0.005;

  constructor(
    private readonly repo: SellFuturesWatchRepository,
    private readonly trades: SellFuturesTradeRepository,
    private readonly account: SellFuturesPaperAccountService,
    private readonly selector: FutureSelectorService,
    private readonly adapter: AngelOneAdapterService,
  ) {}

  async createFromAlert(input: SellFuturesCreateFromAlertInput) {
    // Gate 1 — resolve the stock future. No future ⇒ this track can't act.
    const future = await this.selector.resolve(input.symbol);
    if (!future) throw new SellFuturesNoFutureError(input.symbol);

    // Gate 2 — symbol dedup on the FUTURES token.
    const active = await this.repo.findActiveByToken(future.token);
    if (active.length > 0) throw new SellFuturesSymbolDupError(input.symbol);

    // Gate 3 — cooldown on the FUTURES token (45 min since last execution).
    const cooldownSince = new Date(Date.now() - TRADE_COOLDOWN_MS);
    if (await this.repo.wasTokenExecutedSince(future.token, cooldownSince)) {
      throw new SellFuturesCooldownError(input.symbol);
    }

    // Gate 4a — kill-switch + position cap (no price needed).
    const openTrades = await this.repo.countOpenTrades();
    await this.account.admit({ openTrades });

    // Gate 5 — live quote on the FUTURES NFO token. Executing at a stale price
    // is worse than skipping.
    let futPrice: number | null = null;
    try {
      const live = await this.adapter.getLiveQuote(future.token, future.exchange);
      if (live?.ltp && live.ltp > 0) futPrice = live.ltp;
    } catch (err) {
      this.logger.warn(
        `[sell-futures] live futures quote failed for ${input.symbol} (${future.tradingsymbol}): ` +
        `${err instanceof Error ? err.message : err}`,
      );
    }
    if (futPrice == null) throw new SellFuturesNoQuoteError(input.symbol);

    // Gate 4b — margin availability (needs the live notional).
    const quantity = future.lotSize;
    const notional = futPrice * quantity;
    await this.account.ensureMargin(notional * MARGIN_PCT);

    // Targets (SHORT): target below entry, hard SL above.
    const executedPrice = futPrice;
    const profitTarget = executedPrice * (1 - PROFIT_TARGET_PCT);

    // Create the WATCHING entry, carrying both the equity symbol and the
    // resolved futures contract.
    const createInput: SellFuturesCreateEntryInput = {
      alertId: input.alertId,
      setupId: input.setupId,
      symbol: input.symbol,
      token: future.token,
      exchange: future.exchange,
      eqToken: input.token,
      futTradingsymbol: future.tradingsymbol,
      futExpiry: future.expiry,
      lotSize: future.lotSize,
      side: 'SELL',
      initialPrice: executedPrice,
      initialScore: input.initialScore,
      initialBreakdown: input.initialBreakdown,
      profitTarget,
      profitTargetSource: 'fallback-2pct',
      stopLossScore: 45,
    };
    const entry = await this.repo.createEntry(createInput);
    await this.repo.createEvent({
      watchEntryId: entry.id,
      eventType: WatchEventType.INITIAL,
      price: executedPrice,
      score: input.initialScore,
      breakdown: input.initialBreakdown,
      notes: `short ${future.tradingsymbol} (lot ${quantity}) | eq alert ₹${input.initialPrice}`,
    });

    // Auto-execute the paper SHORT at the live futures price.
    const trade = await this.openTrade({
      instrumentId: entry.id,
      quantity,
      entryPrice: executedPrice,
      exchange: future.exchange,
      target: profitTarget,
    });
    await this.repo.update(entry.id, {
      status: WatchStatus.TRADED,
      paperTradeId: trade.id,
      executedAt: new Date(),
      executedPrice,
      quantity,
    });

    return entry;
  }

  // ── Paper execution (folded in; no live broker, no gateway) ───────────────

  private async openTrade(input: {
    instrumentId: string; quantity: number; entryPrice: number;
    exchange: string; target?: number | null;
  }) {
    const charges = computeOrderCharges({
      side: 'SELL', price: input.entryPrice, quantity: input.quantity, exchange: input.exchange,
    });
    const trade = await this.trades.createTrade({
      instrumentId: input.instrumentId,
      side: 'SELL',
      orderType: 'MARKET',
      positionType: 'INTRADAY',
      quantity: input.quantity,
      entryPrice: input.entryPrice,
      target: input.target ?? null,
      stoploss: null,
      fees: charges.total,
      status: 'OPEN',
      isPaperTrade: true,
      strategy: 'sell-futures',
      entryTime: new Date(),
    });
    await this.account.applyEntry({
      entryPrice: input.entryPrice,
      quantity: input.quantity,
      entryFees: charges.total,
    });
    return trade;
  }

  private async closeTrade(tradeId: string, opts: { reason: string; exitPrice: number; quantity?: number }) {
    const trade = await this.trades.getTradeById(tradeId);
    if (!trade) throw new Error(`SellFuturesTrade ${tradeId} not found`);
    if (trade.status !== 'OPEN' && trade.status !== 'PARTIALLY_FILLED') {
      throw new Error(`Cannot close trade with status ${trade.status}`);
    }
    const closeQty = Math.min(
      Math.max(1, Math.floor(opts.quantity ?? trade.quantity)),
      trade.quantity,
    );
    const isFullClose = closeQty >= trade.quantity;
    const sideMul: 1 | -1 = trade.side === 'BUY' ? 1 : -1; // SELL → -1

    // Exit leg of a short is a BUY-to-cover.
    const exitCharges = computeOrderCharges({
      side: 'BUY', price: opts.exitPrice, quantity: closeQty, exchange: 'NFO',
    });

    const entryPrice = trade.entryPrice ?? 0;
    const slicePnl = sideMul * (opts.exitPrice - entryPrice) * closeQty;
    const cumulativePnl = (trade.pnl ?? 0) + slicePnl;
    const closedQuantity = ((trade as any).closedQuantity ?? 0) + closeQty;
    const pnlPercent =
      entryPrice > 0 ? (cumulativePnl / (entryPrice * closedQuantity)) * 100 : 0;

    const updateData: any = {
      pnl: cumulativePnl,
      pnlPercent,
      closedQuantity,
      fees: (trade.fees ?? 0) + exitCharges.total,
      exitReasonTag: opts.reason,
      exitNotes: opts.reason,
    };
    if (isFullClose) {
      updateData.exitPrice = opts.exitPrice;
      updateData.exitTime = new Date();
      updateData.status = 'CLOSED';
      updateData.quantity = trade.quantity;
    } else {
      updateData.quantity = trade.quantity - closeQty;
      updateData.status = 'PARTIALLY_FILLED';
    }

    const updated = await this.trades.update(tradeId, updateData);
    await this.account.applyExit({
      entryPrice,
      exitPrice: opts.exitPrice,
      quantity: closeQty,
      sideMul,
      exitFees: exitCharges.total,
    });
    return updated;
  }

  // ── Tick entrypoint (SHORT exits) ─────────────────────────────────────────

  async onTick(token: string, ltp: number, ts: Date): Promise<void> {
    const entries = await this.repo.findActiveByToken(token);
    for (const entry of entries) {
      if (entry.status !== 'TRADED') continue;
      try {
        await this.repo.update(entry.id, { currentPrice: ltp, lastTickAt: ts });
      } catch (err) {
        this.logger.warn(`[sell-futures] failed to persist tick for ${entry.symbol}: ${err}`);
      }
      try {
        await this.applyTick(entry, ltp);
      } catch (err) {
        this.logger.warn(
          `[sell-futures] applyTick ${entry.symbol} threw: ${err instanceof Error ? err.message : err}`,
        );
      }
    }
  }

  private async applyTick(entry: any, ltp: number): Promise<void> {
    const sideMul: 1 | -1 = entry.side === 'BUY' ? 1 : -1; // SELL → -1

    // 1. Target-hit wins first (SHORT: ltp at/below the target).
    const isTargetHit =
      entry.profitTarget != null &&
      (sideMul === 1 ? ltp >= entry.profitTarget : ltp <= entry.profitTarget);
    if (isTargetHit) return this.transitionTargetHit(entry, ltp);

    // 2. Hard loss-cut — two-strike stop-hunt guard (30s poll cadence).
    const openLoss = this.computeOpenPnl(entry, ltp);
    const threshold = -HARD_STOP_PCT *
      (entry.executedPrice ?? entry.initialPrice) *
      (entry.remainingQty ?? entry.quantity ?? 0);
    if (openLoss <= threshold) {
      const currentBreachCount: number = entry.slBreachCount ?? 0;
      if (currentBreachCount < 1) {
        this.logger.warn(
          `[sell-futures] ${entry.symbol}: first SL breach (stop-hunt guard) — ltp=${ltp} ` +
          `loss=₹${Math.abs(openLoss).toFixed(0)}, awaiting confirmation on next poll`,
        );
        await this.repo.update(entry.id, { slBreachCount: currentBreachCount + 1 });
        return;
      }
      // Confirmed breakdown — cap the exit at the SL price (SHORT: price above).
      const ref = entry.executedPrice ?? entry.initialPrice;
      const slPrice = sideMul === 1
        ? ref * (1 - HARD_STOP_PCT)
        : ref * (1 + HARD_STOP_PCT);
      const cappedExitPrice = sideMul === 1
        ? Math.max(ltp, slPrice)
        : Math.min(ltp, slPrice);
      return this.transitionLossCut(entry, cappedExitPrice, openLoss);
    }

    // Price recovered inside the SL band — reset the breach counter.
    if ((entry.slBreachCount ?? 0) > 0) {
      this.logger.log(
        `[sell-futures] ${entry.symbol}: SL breach count reset (price recovered, ltp=${ltp})`,
      );
      await this.repo.update(entry.id, { slBreachCount: 0 });
    }

    // 3. Partial-exit / trailing-stop (side-aware; paper-approximate on a lot).
    if (!entry.partialExitedAt) {
      await this.checkPartialExitTrigger(entry, ltp);
    } else {
      await this.updateTrailingStop(entry, ltp);
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
    await this.closeTrade(entry.paperTradeId, { reason: 'target-hit', exitPrice: price });
    await this.repo.update(entry.id, {
      status: WatchStatus.TARGET_HIT, closedAt: new Date(), closedReason: 'target-hit',
    });
  }

  private async transitionLossCut(entry: any, exitPrice: number, openLoss: number): Promise<void> {
    await this.repo.createEvent({
      watchEntryId: entry.id, eventType: WatchEventType.SL_HIT_PRICE, price: exitPrice,
      notes: `cause:loss-cut loss:${Math.abs(openLoss).toFixed(0)}`,
    });
    await this.closeTrade(entry.paperTradeId, { reason: 'sl-loss-cut', exitPrice });
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

    const initialQty = entry.quantity ?? entry.lotSize ?? 1;
    const partialQty = Math.floor(initialQty * this.PARTIAL_EXIT_FRACTION);
    const remainingQty = initialQty - partialQty;
    const trailingStopPrice = sideMul === 1
      ? ltp * (1 - this.TRAILING_STOP_PCT)
      : ltp * (1 + this.TRAILING_STOP_PCT);

    await this.closeTrade(entry.paperTradeId, {
      reason: 'partial-exit', quantity: partialQty, exitPrice: ltp,
    });
    await this.repo.createEvent({
      watchEntryId: entry.id, eventType: WatchEventType.PARTIAL_EXIT, price: ltp,
      notes: `partial 50% covered at +${(moveFavor * 100).toFixed(2)}%, trail @ ${trailingStopPrice.toFixed(2)}`,
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
      newStop = sideMul === 1 ? ltp * (1 - this.TRAILING_STOP_PCT) : ltp * (1 + this.TRAILING_STOP_PCT);
      await this.repo.update(entry.id, {
        trailingHighWater: highWater,
        trailingStopPrice: newStop,
      });
    }
    const hit = sideMul === 1 ? ltp <= newStop : ltp >= newStop;
    if (hit) {
      await this.closeTrade(entry.paperTradeId, { reason: 'trailing-stop', exitPrice: ltp });
      await this.repo.createEvent({
        watchEntryId: entry.id, eventType: WatchEventType.TRAILING_STOP_HIT, price: ltp,
        notes: `trail stop fired (high-water ${highWater}, stop ${newStop.toFixed(2)})`,
      });
      await this.repo.update(entry.id, {
        status: WatchStatus.EXITED, closedAt: new Date(), closedReason: 'trailing-stop',
      });
    }
  }

  // ── EOD square-off (15:15 IST) ────────────────────────────────────────────

  /**
   * Close every open TRADED short at the live futures LTP. Called by the
   * tick poller's 15:15 IST cron so intraday positions never carry overnight.
   */
  async squareOffOpenPositions(): Promise<{ closed: number; errors: number }> {
    const all = await this.repo.findAllActive();
    const traded = all.filter((e) => e.status === WatchStatus.TRADED);
    if (traded.length === 0) return { closed: 0, errors: 0 };

    const byExchange = new Map<string, string[]>();
    for (const e of traded) {
      const list = byExchange.get(e.exchange) ?? [];
      list.push(e.token);
      byExchange.set(e.exchange, list);
    }
    const ltpMap = new Map<string, number>();
    for (const [exchange, tokens] of byExchange) {
      const m = await this.adapter
        .getLtpsBatch(exchange, [...new Set(tokens)])
        .catch(() => new Map<string, number>());
      for (const [tok, ltp] of m) ltpMap.set(tok, ltp);
    }

    let closed = 0;
    let errors = 0;
    for (const entry of traded) {
      try {
        const exitPrice =
          ltpMap.get(entry.token) ??
          (entry as any).currentPrice ??
          (entry as any).executedPrice ??
          0;
        if (exitPrice <= 0) {
          this.logger.warn(`[sell-futures-eod] no exit price for ${entry.symbol} — skipping`);
          continue;
        }
        if (entry.paperTradeId) {
          await this.closeTrade(entry.paperTradeId, { reason: 'eod-square-off', exitPrice });
        }
        await this.repo.update(entry.id, {
          status: WatchStatus.EXITED,
          closedAt: new Date(),
          closedReason: 'eod-square-off',
        });
        closed++;
      } catch (err) {
        this.logger.warn(
          `[sell-futures-eod] failed to close ${entry.symbol}: ${err instanceof Error ? err.message : err}`,
        );
        errors++;
      }
    }
    this.logger.warn(`[sell-futures-eod] done — closed=${closed} errors=${errors}`);
    return { closed, errors };
  }
}
