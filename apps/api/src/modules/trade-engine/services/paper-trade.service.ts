import { Injectable, Logger, OnModuleInit, Inject, Optional } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { TradeEventType } from '@prisma/client';
import {
  BrokerAdapter,
  OrderRequest,
  OrderResponse,
  TickData,
} from '../../../common/interfaces/broker-adapter.interface';
import { TradeRepository } from '../repositories/trade.repository';
import {
  MarketFeedService,
  BROKER_ADAPTER_TOKEN,
} from '../../market-data/services/market-feed.service';
import { v4 as uuidv4 } from 'uuid';

/** Simulated slippage range: 0.01% to 0.05%. */
const MIN_SLIPPAGE_PCT = 0.0001;
const MAX_SLIPPAGE_PCT = 0.0005;

/** Default starting virtual capital (INR). ₹20,00,000 (20 lakhs). */
// Shared paper float for ALL paper tracks (watch, adaptive, breakout, ungated,
// manual) — the RiskManager's checkPaperCashSufficient gates BUYs against it.
// Raised ₹20L → ₹40L: ~16 concurrent positions deploying ₹17-18L exhausted the
// old float intraday, declining later alerts that then sat stuck in WATCHING.
// On boot the balance is rebuilt from trade history off this basis (see
// onModuleInit), so a restart rebases the running account to the new float.
const DEFAULT_VIRTUAL_CAPITAL = 4_000_000;

/**
 * Epoch — trades created BEFORE this timestamp do not affect the paper
 * account balance. They remain in the `trades` table for journal/audit but
 * are skipped during the startup cash-flow replay.
 *
 * Why: the trades table accumulated months of paper trades from older
 * signal-generator runs, AI-advisor experiments, and backtests. Including
 * them in the balance recompute baked ~₹1.2L of legacy losses into the
 * starting position. Setting the epoch to NOW gives the user a clean
 * ₹20L starting point to track current strategy findings without
 * destroying historical journal data.
 *
 * Set to 2026-05-14 11:00 UTC (16:30 IST — just past market close on the
 * day this feature was reset). To restart tracking from a new clean slate,
 * bump this constant.
 */
const PAPER_ACCOUNT_EPOCH = new Date('2026-05-14T11:00:00Z');

interface PendingPaperOrder {
  id: string;
  request: OrderRequest;
  createdAt: Date;
}

interface VirtualPosition {
  symbol: string;
  exchange: string;
  /** Angel One feed token — used by refreshOpenPositions to poll the LTP. */
  token: string;
  side: 'BUY' | 'SELL';
  quantity: number;
  averagePrice: number;
  ltp: number;
  pnl: number;
}

@Injectable()
export class PaperTradeService implements OnModuleInit {
  private readonly logger = new Logger(PaperTradeService.name);

  /** Pending limit/SL orders waiting for price triggers. */
  private readonly pendingOrders = new Map<string, PendingPaperOrder>();

  /** Virtual positions keyed by `symbol:exchange:side`. */
  private readonly virtualPositions = new Map<string, VirtualPosition>();

  /** Virtual cash balance — spendable cash, excludes deferred profit. */
  private virtualBalance = DEFAULT_VIRTUAL_CAPITAL;

  /**
   * Profit from winning exits, withheld from the spendable cash balance
   * until the 18:00 IST after-hours settlement (see applyExitAccounting
   * and settlePendingProfit). It still counts toward equity — it is the
   * user's money, just not yet released to cash.
   */
  private pendingProfit = 0;

  /** Callbacks for when a pending order fills. */
  private readonly fillCallbacks = new Map<
    string,
    (response: OrderResponse) => void
  >();

  /** LTP cache for simulating fills. */
  private readonly ltpCache = new Map<string, number>();

  constructor(
    private readonly tradeRepository: TradeRepository,
    private readonly marketFeed: MarketFeedService,
    @Optional()
    @Inject(BROKER_ADAPTER_TOKEN)
    private readonly brokerAdapter: BrokerAdapter | null = null,
  ) {}

  /**
   * On API startup, replay every persisted paper trade to recover the balance.
   * The trades table is the source of truth — we never store balance separately,
   * so in-memory state cannot drift from the trade history.
   *
   * Replay rules (mirror what fillAtPrice + applyExitAccounting do live):
   *   - Closed           : balance += pnl − fees   (broker charges netted out)
   *   - Open BUY         : balance -= entry × qty
   *   - Open SELL        : balance += entry × qty   (short credits cash on open)
   *   - PARTIALLY_FILLED : as Open on the remaining qty, plus balance += pnl − fees
   *                        (realized P&L already booked on the closed slice)
   *
   * It also rehydrates the in-memory virtualPositions map so deployedCapital
   * and openPositions survive a restart.
   *
   * Note: deferred profit (pendingProfit) is in-memory only. A restart
   * treats every closed trade's profit as already settled — the replay
   * folds it straight into the balance. So restarting between a winning
   * close and the 18:00 settlement effectively settles that profit early;
   * acceptable for a paper account, where the replay is a clean-slate
   * approximation anyway.
   */
  async onModuleInit(): Promise<void> {
    try {
      const paperTrades = await this.tradeRepository.findPaperTradesSince(
        PAPER_ACCOUNT_EPOCH,
      );
      let bal = DEFAULT_VIRTUAL_CAPITAL;
      let realized = 0;
      const positions = new Map<string, VirtualPosition>();

      for (const t of paperTrades) {
        // A trade is "still open" ONLY if its status is one of the open
        // statuses the rest of the platform recognises (the same set
        // TradeRepository.getOpenTrades() filters on). Every other status
        // — CLOSED, CANCELLED, REJECTED, EXPIRED, … — is non-open and must
        // NOT be re-hydrated as an open position. Before the fix the replay
        // only excluded `status === 'CLOSED'`, so a trade carrying any
        // other terminal status was wrongly rebuilt as a ghost open
        // position, overstating deployedCapital.
        const isOpen =
          t.status === 'OPEN' || t.status === 'PARTIALLY_FILLED';

        if (!isOpen) {
          // A non-open trade's net cash effect is its realized P&L less the
          // broker charges booked on its legs. `fees` accumulates real SEBI
          // per-order charges — see applyEntryCharge / applyExitAccounting.
          // CANCELLED/REJECTED trades carry pnl=null → net 0, a clean no-op.
          const net = (t.pnl ?? 0) - (t.fees ?? 0);
          bal += net;
          realized += net;
          continue;
        }

        // OPEN / PARTIALLY_FILLED — still an open position whose
        // `quantity` is the units that remain open.
        if (t.entryPrice == null || t.quantity <= 0) continue;
        const remainingValue = t.entryPrice * t.quantity;
        if (t.side === 'BUY') {
          bal -= remainingValue;
        } else {
          bal += remainingValue;
        }
        // An OPEN trade's entry charge was debited live by applyEntryCharge
        // and recorded on `fees`; subtract it so a restart is exact. (A
        // PARTIALLY_FILLED trade's fees are already netted by the pnl-fees
        // line below, so only do this for pure-OPEN.)
        if (t.status === 'OPEN') {
          bal -= t.fees ?? 0;
        }
        // A PARTIALLY_FILLED trade already realized P&L on its closed slice
        // (less the broker charge); that cash moved with the partial close,
        // so fold the net back in.
        if (t.status === 'PARTIALLY_FILLED' && t.pnl != null) {
          const net = t.pnl - (t.fees ?? 0);
          bal += net;
          realized += net;
        }

        // Rehydrate the in-memory virtual position so getAccount() reports
        // deployedCapital / openPositions correctly after a restart.
        const inst = (t as any).instrument;
        if (inst?.symbol && inst?.exchange) {
          positions.set(`${inst.symbol}:${inst.exchange}`, {
            symbol: inst.symbol,
            exchange: inst.exchange,
            token: inst.token ?? '',
            side: t.side as 'BUY' | 'SELL',
            quantity: t.quantity,
            averagePrice: t.entryPrice,
            ltp: t.entryPrice,
            pnl: 0,
          });
        }
      }

      this.virtualBalance = bal;
      this.pendingProfit = 0;
      this.virtualPositions.clear();
      for (const [key, pos] of positions) {
        this.virtualPositions.set(key, pos);
      }

      const deployed = Array.from(positions.values()).reduce(
        (sum, p) => sum + p.averagePrice * p.quantity,
        0,
      );
      const openCount = positions.size;
      this.logger.log(
        `[Paper] Balance recovered (epoch=${PAPER_ACCOUNT_EPOCH.toISOString()}) ` +
          `from ${paperTrades.length} trades: ` +
          `start=₹${DEFAULT_VIRTUAL_CAPITAL.toLocaleString('en-IN')} → ` +
          `current=₹${bal.toLocaleString('en-IN')} ` +
          `(realized=₹${realized.toFixed(0)}, open=${openCount}, deployed=₹${deployed.toFixed(0)})`,
      );

      // Rebuild the resting-order map so PENDING limit/stop orders survive a
      // restart instead of being silently dropped. The limit/trigger price now
      // lives on the trade row (limitPrice/triggerPrice), so we can fully
      // reconstruct the OrderRequest the tick-checker needs.
      const pendingTrades = await this.tradeRepository.findPendingPaperTrades();
      this.pendingOrders.clear();
      let restored = 0;
      for (const t of pendingTrades) {
        const inst = (t as any).instrument;
        if (!inst?.token || !t.orderId) continue;
        this.pendingOrders.set(t.orderId, {
          id: t.orderId,
          request: {
            symbol: inst.symbol,
            token: inst.token,
            exchange: inst.exchange,
            side: t.side as 'BUY' | 'SELL',
            orderType: t.orderType as OrderRequest['orderType'],
            quantity: t.quantity,
            price: t.limitPrice ?? undefined,
            triggerPrice: t.triggerPrice ?? undefined,
            positionType: t.positionType as OrderRequest['positionType'],
            source: t.source as OrderRequest['source'],
          },
          createdAt: t.createdAt,
        });
        restored++;
      }
      if (restored > 0) {
        this.logger.log(`[Paper] Restored ${restored} pending resting order(s) from DB`);
      }
    } catch (err) {
      this.logger.warn(
        `[Paper] Balance recovery failed — keeping default ₹${DEFAULT_VIRTUAL_CAPITAL.toLocaleString('en-IN')}: ${
          err instanceof Error ? err.message : err
        }`,
      );
    }
  }

  /**
   * Simulate order execution.
   * MARKET orders fill immediately at LTP with slippage.
   * LIMIT / STOPLOSS orders are stored as pending and checked on every tick.
   */
  async simulateOrder(request: OrderRequest): Promise<OrderResponse> {
    const orderId = `PAPER-${uuidv4().slice(0, 8).toUpperCase()}`;

    this.logger.log(
      `[Paper] Simulating ${request.orderType} ${request.side} order: ${request.symbol} x${request.quantity}`,
    );

    if (request.orderType === 'MARKET') {
      return this.fillMarketOrder(orderId, request);
    }

    // LIMIT / STOPLOSS / STOPLOSS_MARKET: store as pending
    this.pendingOrders.set(orderId, {
      id: orderId,
      request,
      createdAt: new Date(),
    });

    // Check if we can fill immediately based on cached LTP. Keyed by token
    // alone — the instrument token is unique and is the one identifier both
    // ticks and orders reliably carry (symbol/exchange casing varies).
    const ltp = this.ltpCache.get(request.token);
    if (ltp !== undefined) {
      const canFill = this.canFillAtPrice(request, ltp);
      if (canFill) {
        this.pendingOrders.delete(orderId);
        return this.fillAtPrice(orderId, request, ltp);
      }
    }

    return {
      orderId,
      status: 'PENDING',
      message: `Paper order pending — waiting for price trigger`,
    };
  }

  /**
   * Called on every tick to check if any pending paper orders should fill.
   */
  simulateTick(tick: TickData): void {
    this.ltpCache.set(tick.token, tick.ltp);

    // Update virtual positions with latest LTP
    for (const pos of this.virtualPositions.values()) {
      if (pos.symbol === tick.symbol) {
        pos.ltp = tick.ltp;
        const multiplier = pos.side === 'BUY' ? 1 : -1;
        pos.pnl = multiplier * (tick.ltp - pos.averagePrice) * pos.quantity;
      }
    }

    // Check pending orders
    for (const [orderId, pending] of this.pendingOrders.entries()) {
      if (pending.request.token !== tick.token) continue;

      if (this.canFillAtPrice(pending.request, tick.ltp)) {
        this.pendingOrders.delete(orderId);
        const response = this.fillAtPrice(orderId, pending.request, tick.ltp);

        const callback = this.fillCallbacks.get(orderId);
        if (callback) {
          callback(response);
          this.fillCallbacks.delete(orderId);
        }

        // Settle the persisted trade row so a deferred fill becomes a visible
        // OPEN position. Without this the DB row stayed PENDING forever even
        // after the in-memory order filled (the old callback was never wired
        // for manual orders, and was lost on restart anyway).
        this.persistDeferredFill(orderId, response.fillPrice ?? tick.ltp);

        this.logger.log(
          `[Paper] Pending order ${orderId} filled at ${tick.ltp}`,
        );
      }
    }
  }

  /**
   * Register a callback for when a pending paper order fills.
   */
  onOrderFill(orderId: string, callback: (response: OrderResponse) => void): void {
    this.fillCallbacks.set(orderId, callback);
  }

  /**
   * Remove a resting order from the in-memory map (user cancel). No-op if the
   * order already filled or was never tracked here. The DB row is marked
   * CANCELLED by the caller (TradeExecutionService.cancelPendingOrder).
   */
  cancelPendingOrder(orderId: string): void {
    this.pendingOrders.delete(orderId);
    this.fillCallbacks.delete(orderId);
  }

  /**
   * Settle the persisted trade row for a resting order that filled on a later
   * tick. Fire-and-forget: simulateTick is sync and on the hot tick path, so we
   * don't await the write; failures are logged, not thrown.
   */
  private persistDeferredFill(orderId: string, fillPrice: number): void {
    this.tradeRepository
      .findByOrderId(orderId)
      .then(async (trade) => {
        if (!trade || trade.status !== 'PENDING') return undefined;
        const updated = await this.tradeRepository.updateTrade(trade.id, {
          status: 'OPEN',
          entryPrice: fillPrice,
          entryTime: new Date(),
        });
        // Per-trade event log: a resting LIMIT/STOP order just filled.
        // Best-effort — a log failure must not break the settle path.
        try {
          await this.tradeRepository.createTradeEvent({
            tradeId: trade.id,
            eventType: TradeEventType.FILLED,
            price: fillPrice,
            quantity: trade.quantity,
            notes: 'resting order filled',
          });
        } catch (err) {
          this.logger.warn(
            `[Paper] trade-event log write failed for deferred fill ${orderId}: ${
              err instanceof Error ? err.message : err
            }`,
          );
        }
        return updated;
      })
      .catch((err) =>
        this.logger.warn(
          `[Paper] failed to settle deferred fill ${orderId}: ${
            err instanceof Error ? err.message : err
          }`,
        ),
      );
  }

  getVirtualBalance(): number {
    return this.virtualBalance;
  }

  getVirtualPositions(): VirtualPosition[] {
    return Array.from(this.virtualPositions.values());
  }

  /**
   * Account summary for the UI badge: starting capital, current cash balance,
   * deployed capital tied up in open positions, unrealized P&L from live
   * ticks, and pending (deferred) profit awaiting the 18:00 settlement.
   * `equity = balance + deployed + unrealizedPnl + pendingProfit` is the
   * total mark-to-market account value.
   *
   * `deployedCapital` and `openPositions` are derived from the `Trade`
   * table's open trades — the SAME source RiskManagerService.getDailyRiskStatus()
   * uses (Σ entryPrice × quantity over status IN ['OPEN','PARTIALLY_FILLED']).
   * The DB is the single source of truth, so the badge and the risk engine
   * can never drift. (Before the fix this summed the in-memory
   * `virtualPositions` map, which left ghost entries when a position closed
   * mid-session via a path other than a netting SELL fill — overstating
   * deployed capital and equity.)
   *
   * `unrealizedPnl` stays live (it is recomputed from market ticks by
   * refreshOpenPositions / simulateTick), but is summed ONLY for positions
   * that are still open in the DB — a stale entry in the in-memory map for
   * an already-closed trade contributes nothing.
   */
  async getAccount(): Promise<{
    startingCapital: number;
    balance: number;
    deployedCapital: number;
    unrealizedPnl: number;
    pendingProfit: number;
    equity: number;
    openPositions: number;
    epoch: string;
  }> {
    // DB open trades — the authoritative open-position set.
    const openTrades = await this.tradeRepository.getOpenTrades();
    const deployed = openTrades.reduce(
      (sum, t) => sum + (t.entryPrice ?? 0) * t.quantity,
      0,
    );
    const openPositions = openTrades.length;

    // Live unrealized P&L: only count in-memory positions that correspond
    // to a still-open DB trade (keyed by symbol:exchange). Ghost positions
    // — left in the map after a close — are excluded.
    const openKeys = new Set(
      openTrades
        .map((t) => {
          const inst = (t as any).instrument;
          return inst?.symbol && inst?.exchange
            ? `${inst.symbol}:${inst.exchange}`
            : null;
        })
        .filter((k): k is string => k != null),
    );
    let unrealized = 0;
    for (const [key, pos] of this.virtualPositions) {
      if (openKeys.has(key)) {
        unrealized += pos.pnl;
      }
    }

    return {
      startingCapital: DEFAULT_VIRTUAL_CAPITAL,
      balance: this.virtualBalance,
      deployedCapital: deployed,
      unrealizedPnl: unrealized,
      pendingProfit: this.pendingProfit,
      equity:
        this.virtualBalance + deployed + unrealized + this.pendingProfit,
      openPositions,
      epoch: PAPER_ACCOUNT_EPOCH.toISOString(),
    };
  }

  /** Deferred profit from winning exits awaiting the 18:00 IST settlement. */
  getPendingProfit(): number {
    return this.pendingProfit;
  }

  /**
   * Apply paper-account accounting for ONE position exit (close event).
   *
   * `exitCharge` is the real per-order charge (see trade-charges.ts), passed
   * in by the caller. The SELL fill in fillAtPrice() already credited the
   * full exit value to cash, so here:
   *   - LOSS  : just remove the exit charge.
   *   - PROFIT: claw the realized gain back out of cash into `pendingProfit`
   *             (released at the 18:00 settlement), and remove the charge.
   *
   * Returns the charge so the caller can record it on the trade's `fees`.
   */
  applyExitAccounting(realizedPnl: number, exitCharge: number): number {
    this.virtualBalance -= exitCharge;
    if (realizedPnl > 0) {
      this.virtualBalance -= realizedPnl;
      this.pendingProfit += realizedPnl;
      this.logger.log(
        `[Paper] Exit accounting: -₹${exitCharge.toFixed(2)} charges, ` +
          `₹${realizedPnl.toFixed(0)} profit deferred to 18:00 settlement ` +
          `(pending=₹${this.pendingProfit.toFixed(0)})`,
      );
    } else {
      this.logger.log(
        `[Paper] Exit accounting: -₹${exitCharge.toFixed(2)} charges ` +
          `(loss of ₹${Math.abs(realizedPnl).toFixed(0)} booked)`,
      );
    }
    return exitCharge;
  }

  /** Debit a paper ENTRY order's charges from the virtual balance (R6). */
  applyEntryCharge(charge: number): void {
    this.virtualBalance -= charge;
    this.logger.log(`[Paper] Entry charges: -₹${charge.toFixed(2)}`);
  }

  /**
   * After-hours profit settlement — runs daily at 18:00 IST. Winning exits
   * withhold their profit from spendable cash during the session (see
   * applyExitAccounting); this sweeps the accumulated `pendingProfit` into
   * the balance once trading is done for the day.
   */
  @Cron('0 0 18 * * *', { timeZone: 'Asia/Kolkata' })
  settlePendingProfit(): void {
    if (this.pendingProfit <= 0) return;
    const settled = this.pendingProfit;
    this.virtualBalance += settled;
    this.pendingProfit = 0;
    this.logger.log(
      `[Paper] 18:00 settlement — credited ₹${settled.toFixed(0)} of ` +
        `deferred profit. Balance now ₹${this.virtualBalance.toLocaleString('en-IN')}`,
    );
  }

  /**
   * Live equity refresher — runs every 15 s. Open paper positions' unrealized
   * P&L is normally updated by simulateTick(), but the equity-symbol tick
   * stream does not reliably reach this service, so the badge would freeze
   * at the entry price. This polls MarketFeedService's quote cache directly
   * and recomputes ltp/pnl on every open position, keeping
   * getAccount().equity live without depending on the tick handler.
   */
  @Cron('*/15 * * * * *', { timeZone: 'Asia/Kolkata' })
  async refreshOpenPositions(): Promise<void> {
    for (const pos of this.virtualPositions.values()) {
      if (!pos.token) continue;
      // Prefer the WebSocket quote cache. When the token isn't on the WS —
      // Angel One caps the socket at ~50 tokens, so open-position tokens are
      // routinely squeezed out by indices + the scanner — fall back to a REST
      // broker quote. Without this an equity position freezes at its entry
      // price (pnl 0, +0 unrealized) the moment its WS slot is lost.
      let ltp = this.marketFeed.getQuote(pos.token)?.ltp ?? 0;
      if (ltp <= 0) {
        ltp = await this.fetchRestLtp(pos.token, pos.exchange);
      }
      if (ltp <= 0) continue;
      pos.ltp = ltp;
      const multiplier = pos.side === 'BUY' ? 1 : -1;
      pos.pnl = multiplier * (ltp - pos.averagePrice) * pos.quantity;
    }
  }

  /**
   * Fetch a fresh LTP straight from the broker's REST quote API — used by
   * refreshOpenPositions when a position's token has no WebSocket tick.
   * Returns 0 (caller keeps the last value) when no broker is wired or the
   * call fails. Calls are naturally paced — refreshOpenPositions awaits them
   * one position at a time.
   */
  private async fetchRestLtp(token: string, exchange: string): Promise<number> {
    if (!this.brokerAdapter) return 0;
    try {
      const tick = await this.brokerAdapter.getLiveQuote(token, exchange || 'NSE');
      const ltp = (tick as { ltp?: number } | null)?.ltp;
      return typeof ltp === 'number' && ltp > 0 ? ltp : 0;
    } catch (err) {
      this.logger.warn(
        `fetchRestLtp(${token}) failed: ${err instanceof Error ? err.message : err}`,
      );
      return 0;
    }
  }

  getPendingOrders(): PendingPaperOrder[] {
    return Array.from(this.pendingOrders.values());
  }

  resetVirtualPortfolio(startingCapital?: number): void {
    this.virtualBalance = startingCapital ?? DEFAULT_VIRTUAL_CAPITAL;
    this.pendingProfit = 0;
    this.virtualPositions.clear();
    this.pendingOrders.clear();
    this.fillCallbacks.clear();
    this.logger.log(
      `[Paper] Virtual portfolio reset. Balance: ${this.virtualBalance}`,
    );
  }

  // ------------------------------------------------------------------
  //  Private helpers
  // ------------------------------------------------------------------

  private async fillMarketOrder(
    orderId: string,
    request: OrderRequest,
  ): Promise<OrderResponse> {
    let ltp = this.ltpCache.get(request.token) ?? request.price ?? 0;

    // Fallback for symbols NOT on the ~50-token live WS feed: the tick cache is
    // empty, so a MARKET paper order would fill at ₹0 and get rejected. Fetch a
    // fresh broker quote (the same price the order ticket shows via /quote) so
    // the order fills at the real last price. Seeds the cache for later ticks.
    if (!(ltp > 0) && this.brokerAdapter) {
      try {
        const q = await this.brokerAdapter.getLiveQuote(request.token, request.exchange);
        if (q?.ltp && q.ltp > 0) {
          ltp = q.ltp;
          this.ltpCache.set(request.token, ltp);
        }
      } catch (err) {
        this.logger.warn(
          `[paper] market-fill quote fallback failed for ${request.symbol}: ${err instanceof Error ? err.message : err}`,
        );
      }
    }

    return this.fillAtPrice(orderId, request, ltp);
  }

  private fillAtPrice(
    orderId: string,
    request: OrderRequest,
    basePrice: number,
  ): OrderResponse {
    const slippage = this.calculateSlippage(basePrice, request.side);
    const fillPrice = basePrice + slippage;

    // Update virtual balance
    const orderValue = fillPrice * request.quantity;
    if (request.side === 'BUY') {
      this.virtualBalance -= orderValue;
    } else {
      this.virtualBalance += orderValue;
    }

    // Update virtual positions with proper netting. Key is symbol:exchange
    // (no side) so an opposite-side fill REDUCES or FLIPS the existing
    // position rather than spawning a duplicate slot. This is how a real
    // brokerage net position view works.
    const posKey = `${request.symbol}:${request.exchange}`;
    const existing = this.virtualPositions.get(posKey);

    if (!existing) {
      // No position yet — open a new one.
      this.virtualPositions.set(posKey, {
        symbol: request.symbol,
        exchange: request.exchange,
        token: request.token,
        side: request.side as 'BUY' | 'SELL',
        quantity: request.quantity,
        averagePrice: fillPrice,
        ltp: fillPrice,
        pnl: 0,
      });
    } else if (existing.side === request.side) {
      // Same side — average in (scale up).
      const totalQty = existing.quantity + request.quantity;
      existing.averagePrice =
        (existing.averagePrice * existing.quantity +
          fillPrice * request.quantity) /
        totalQty;
      existing.quantity = totalQty;
    } else {
      // Opposite side — net the position.
      if (request.quantity < existing.quantity) {
        // Partial close: reduce qty, keep avg (cost basis unchanged on remainder).
        existing.quantity -= request.quantity;
      } else if (request.quantity === existing.quantity) {
        // Full close: position flat.
        this.virtualPositions.delete(posKey);
      } else {
        // Over-close: flip side. Excess qty opens a new position on the
        // opposite side at the new fill price.
        const excess = request.quantity - existing.quantity;
        this.virtualPositions.set(posKey, {
          symbol: request.symbol,
          exchange: request.exchange,
          token: request.token,
          side: request.side as 'BUY' | 'SELL',
          quantity: excess,
          averagePrice: fillPrice,
          ltp: fillPrice,
          pnl: 0,
        });
      }
    }

    this.logger.log(
      `[Paper] Order ${orderId} filled: ${request.side} ${request.symbol} x${request.quantity} @ ${fillPrice.toFixed(2)}`,
    );

    return {
      orderId,
      status: 'FILLED',
      message: `Paper trade filled at ${fillPrice.toFixed(2)} (slippage: ${slippage.toFixed(4)})`,
      fillPrice,
    };
  }

  private canFillAtPrice(request: OrderRequest, ltp: number): boolean {
    switch (request.orderType) {
      case 'LIMIT':
        // BUY limit fills when price drops to or below limit
        // SELL limit fills when price rises to or above limit
        if (request.side === 'BUY' && request.price !== undefined) {
          return ltp <= request.price;
        }
        if (request.side === 'SELL' && request.price !== undefined) {
          return ltp >= request.price;
        }
        return false;

      case 'STOPLOSS':
      case 'STOPLOSS_MARKET':
        // BUY SL triggers when price rises above trigger
        // SELL SL triggers when price falls below trigger
        if (
          request.side === 'BUY' &&
          request.triggerPrice !== undefined
        ) {
          return ltp >= request.triggerPrice;
        }
        if (
          request.side === 'SELL' &&
          request.triggerPrice !== undefined
        ) {
          return ltp <= request.triggerPrice;
        }
        return false;

      default:
        return false;
    }
  }

  /**
   * Simulate realistic slippage between 0.01% and 0.05%.
   * BUY orders slip up, SELL orders slip down (adverse fill).
   */
  private calculateSlippage(price: number, side: string): number {
    const pct =
      MIN_SLIPPAGE_PCT +
      Math.random() * (MAX_SLIPPAGE_PCT - MIN_SLIPPAGE_PCT);
    const slippage = price * pct;
    return side === 'BUY' ? slippage : -slippage;
  }
}
