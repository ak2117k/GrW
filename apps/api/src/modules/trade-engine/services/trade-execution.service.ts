import {
  Injectable,
  Logger,
  Inject,
  Optional,
  HttpException,
  HttpStatus,
  BadRequestException,
} from '@nestjs/common';
import {
  BrokerAdapter,
  OrderRequest,
  TickData,
} from '../../../common/interfaces/broker-adapter.interface';
import { BROKER_ADAPTER_TOKEN } from '../../market-data/services/market-feed.service';
import { isLiveTradingEnabled, LIVE_TRADING_DISABLED_MESSAGE } from '../live-trading';
import { MarketFeedService } from '../../market-data/services/market-feed.service';
import { MarketContextService } from '../../market-data/services/market-context.service';
import { SettingsService } from '../../settings/services/settings.service';
import { PaperTradeService } from './paper-trade.service';
import { RiskManagerService } from './risk-manager.service';
import { OrderTrackerService } from './order-tracker.service';
import { PositionManagerService } from './position-manager.service';
import { TradeRepository } from '../repositories/trade.repository';
import { TradeGateway } from '../gateways/trade.gateway';
import {
  ExecuteTradeDto,
  ModifyTradeDto,
  TradeFilterDto,
  ExitReasonTag,
} from '../dto/trade.dto';
import { Trade, Prisma, TradeEventType } from '@prisma/client';
import { computeOrderCharges } from './trade-charges';

/**
 * Strip an option/futures suffix to recover the underlying symbol.
 * "NIFTY24APR22500CE" → "NIFTY", "BANKNIFTY24APR45000PE" → "BANKNIFTY".
 * Used so MarketContextService can fetch the index-level context (spot,
 * PCR, max-pain) even when the trade is on a derivative leg.
 */
function deriveUnderlying(symbol: string): string {
  const upper = (symbol ?? '').toUpperCase();
  const match = upper.match(/^(MIDCPNIFTY|BANKNIFTY|FINNIFTY|NIFTY|SENSEX)/);
  if (match) return match[1];
  return upper;
}

@Injectable()
export class TradeExecutionService {
  private readonly logger = new Logger(TradeExecutionService.name);

  constructor(
    @Optional()
    @Inject(BROKER_ADAPTER_TOKEN)
    private readonly brokerAdapter: BrokerAdapter | null,
    private readonly paperTradeService: PaperTradeService,
    private readonly riskManagerService: RiskManagerService,
    private readonly orderTrackerService: OrderTrackerService,
    private readonly positionManagerService: PositionManagerService,
    private readonly tradeRepository: TradeRepository,
    private readonly tradeGateway: TradeGateway,
    private readonly settingsService: SettingsService,
    private readonly marketFeedService: MarketFeedService,
    private readonly marketContextService: MarketContextService,
  ) {}

  /**
   * Execute a trade. This is the SINGLE entry point for ALL trade execution.
   *
   * Flow:
   * 1. Risk validation (ALWAYS, even for paper trades)
   * 2. Route to paper or real broker
   * 3. Persist trade record
   * 4. Track order lifecycle
   * 5. Emit WebSocket update
   */
  async executeTrade(request: ExecuteTradeDto): Promise<Trade> {
    this.logger.log(
      `Executing trade: ${request.side} ${request.symbol} x${request.quantity} (${request.orderType})`,
    );

    // ---- STEP 1: Risk validation — MANDATORY, NEVER SKIP ----
    const riskResult = await this.riskManagerService.validateTrade(request);
    if (!riskResult.allowed) {
      this.logger.warn(
        `Trade blocked by risk manager: ${riskResult.reason}`,
      );
      throw new HttpException(
        `Trade rejected: ${riskResult.reason}`,
        HttpStatus.FORBIDDEN,
      );
    }

    // ---- STEP 2: Determine paper vs. real trading mode ----
    const settings = await this.settingsService.getSettings();
    // Paper-safe default: an explicit per-order flag wins, but a MISSING flag
    // falls back to the global setting (which defaults to paper). A missing
    // flag must NEVER route live — never invert this nullish-coalescing.
    const isPaperTrade = request.isPaper ?? settings.paperTrading;

    // Origin track — defaults to MANUAL when the caller doesn't tag it, so the
    // manual-trade page (which scopes to source = 'MANUAL') only ever shows
    // user-placed orders. Watch / auto-trade / scanner set this explicitly.
    const source = request.source ?? 'MANUAL';

    // ---- STEP 3: Resolve instrument ID for the trade record ----
    const instrumentId = await this.tradeRepository.findInstrumentId(
      request.symbol,
      request.exchange,
      request.token,
    );

    if (!instrumentId) {
      throw new HttpException(
        `Instrument not found: ${request.symbol} on ${request.exchange}`,
        HttpStatus.NOT_FOUND,
      );
    }

    // ---- STEP 4: Place order ----
    const orderRequest: OrderRequest = {
      symbol: request.symbol,
      token: request.token,
      exchange: request.exchange,
      side: request.side,
      orderType: request.orderType,
      quantity: request.quantity,
      price: request.price,
      triggerPrice: request.triggerPrice,
      positionType: request.positionType,
      source,
    };

    let orderId: string | undefined;
    let initialStatus = 'PENDING';
    let entryPrice: number | undefined;
    let entryTime: Date | undefined;

    if (isPaperTrade) {
      // Paper trading — simulate the order
      const paperResponse =
        await this.paperTradeService.simulateOrder(orderRequest);
      orderId = paperResponse.orderId;

      if (paperResponse.status === 'FILLED') {
        initialStatus = 'OPEN';
        // Prefer the simulator's slippage-adjusted fillPrice. Fall back to
        // request.price / triggerPrice only as a defensive measure — for
        // MARKET orders these are undefined, which is precisely the bug
        // that previously persisted entryPrice = null/0 and corrupted P&L.
        entryPrice =
          paperResponse.fillPrice ?? request.price ?? request.triggerPrice;
        entryTime = new Date();

        // Refuse to persist a ₹0/undefined paper fill. A MARKET order on an
        // instrument with no live quote previously logged an error but
        // persisted entryPrice = 0, corrupting P&L and the position ledger.
        // Reject BEFORE creating the trade row. A LIMIT/SL order still fills
        // at request.price / triggerPrice even when the LTP is 0.
        if (!entryPrice || entryPrice <= 0) {
          this.logger.error(
            `Paper trade ${orderId} filled but no entryPrice resolved — ` +
              `fillPrice=${paperResponse.fillPrice}, request.price=${request.price}, ` +
              `triggerPrice=${request.triggerPrice}. Rejecting (no ₹0 fills).`,
          );
          throw new BadRequestException(
            `No live price available for ${request.symbol} — cannot place a ` +
              `MARKET paper order at ₹0. Try a LIMIT order or wait for a live quote.`,
          );
        }
      }

      this.logger.log(
        `[Paper] Order ${orderId}: ${paperResponse.status} — ${paperResponse.message}`,
      );
    } else {
      // Real trading — place via broker adapter.
      // Hard backstop: refuse live placement unless LIVE_TRADING_ENABLED=true,
      // even though isPaper:false reached here. This is the single chokepoint for
      // real-money OPENING orders — downstream auto-SL/tracking only run for live
      // orders, so blocking here keeps the whole live path dormant by default.
      if (!isLiveTradingEnabled()) {
        this.logger.warn(
          `[Live BLOCKED] ${request.side} ${request.symbol} x${request.quantity} — ${LIVE_TRADING_DISABLED_MESSAGE}`,
        );
        throw new HttpException(
          LIVE_TRADING_DISABLED_MESSAGE,
          HttpStatus.FORBIDDEN,
        );
      }
      if (!this.brokerAdapter) {
        throw new HttpException(
          'No broker adapter configured — cannot place real orders',
          HttpStatus.SERVICE_UNAVAILABLE,
        );
      }

      const response = await this.brokerAdapter.placeOrder(orderRequest);
      orderId = response.orderId;

      this.logger.log(
        `[Live] Order ${orderId}: ${response.status} — ${response.message}`,
      );

      // placeOrder signals a broker rejection/failure by RETURN VALUE
      // (status REJECTED/FAILED, empty orderId) — it does NOT throw. Surface
      // that actual broker message instead of persisting a phantom PENDING row
      // and reporting "executed successfully". This is the single point where a
      // real-money order can fail at the broker (e.g. an unfunded account's RMS
      // margin reject), so the user must see exactly why it failed.
      if (!orderId || response.status === 'REJECTED' || response.status === 'FAILED') {
        this.logger.warn(
          `[Live REJECTED] ${request.side} ${request.symbol} x${request.quantity} — ${response.message}`,
        );
        throw new BadRequestException(
          `Order rejected by broker: ${response.message ?? 'no reason returned'}`,
        );
      }
    }

    // ---- STEP 4b: Capture market context snapshot ----
    // Tolerant: a snapshot failure must NOT block the trade. The service
    // already swallows individual upstream failures and returns nulls; we
    // wrap one more time defensively so a totally broken context capture
    // (e.g. exception thrown before Promise.all even resolves) still lets
    // the trade record persist.
    const underlying = deriveUnderlying(request.symbol);
    let context: Awaited<ReturnType<MarketContextService['snapshot']>> | null = null;
    try {
      context = await this.marketContextService.snapshot(underlying);
    } catch (err) {
      this.logger.warn(
        `Market context snapshot failed for ${underlying}: ${
          err instanceof Error ? err.message : err
        }`,
      );
    }

    // ---- STEP 5: Create trade record in DB ----
    const trade = await this.tradeRepository.createTrade({
      instrumentId,
      signalId: request.signalId ?? undefined,
      orderId,
      side: request.side,
      orderType: request.orderType,
      positionType: request.positionType,
      quantity: request.quantity,
      entryPrice,
      // Persist resting-order prices so a PENDING limit/stop survives a restart
      // and the UI can show what it's waiting for. Null for MARKET orders.
      limitPrice: initialStatus === 'PENDING' ? (request.price ?? null) : null,
      triggerPrice: initialStatus === 'PENDING' ? (request.triggerPrice ?? null) : null,
      stoploss: request.stoploss,
      target: request.target,
      status: initialStatus,
      strategy: request.strategy,
      isPaperTrade,
      source,
      entryTime,
      entryReason: request.entryReason ?? null,
      entryTags: request.entryTags ?? [],
      spotAtEntry: context?.spot ?? null,
      vixAtEntry: context?.vix ?? null,
      vixRegimeAtEntry: context?.vixRegime ?? null,
      pcrAtEntry: context?.pcr ?? null,
      maxPainAtEntry: context?.maxPain ?? null,
      adRatioAtEntry: context?.adRatio ?? null,
      contextSnapshot: context
        ? ({
            ...context,
            capturedAt: context.capturedAt.toISOString(),
          } as unknown as Prisma.InputJsonValue)
        : null,
    });

    // ---- STEP 5b: Append to the per-trade event log (best-effort) ----
    // CREATED is always logged. If the order filled immediately (a MARKET
    // fill → status OPEN with a real entryPrice), a FILLED event follows.
    // Any caller-supplied stoploss/target is logged as SL_SET / TARGET_SET.
    const createdPrice =
      entryPrice ?? request.price ?? request.triggerPrice ?? null;
    await this.emitTradeEvent({
      tradeId: trade.id,
      eventType: TradeEventType.CREATED,
      price: createdPrice,
      quantity: request.quantity,
      notes: `${isPaperTrade ? 'paper' : 'LIVE'} ${request.orderType} ${request.side}`,
    });
    if (request.stoploss != null) {
      await this.emitTradeEvent({
        tradeId: trade.id,
        eventType: TradeEventType.SL_SET,
        price: request.stoploss,
      });
    }
    if (request.target != null) {
      await this.emitTradeEvent({
        tradeId: trade.id,
        eventType: TradeEventType.TARGET_SET,
        price: request.target,
      });
    }
    if (initialStatus === 'OPEN' && entryPrice) {
      await this.emitTradeEvent({
        tradeId: trade.id,
        eventType: TradeEventType.FILLED,
        price: entryPrice,
        quantity: request.quantity,
      });
    }

    // ---- STEP 6: Start order tracking ----
    if (!isPaperTrade && orderId) {
      this.orderTrackerService.trackOrder(
        orderId,
        trade.id,
        request.stoploss,
        orderRequest,
      );
    }

    // If paper trade filled immediately, add to position manager
    if (isPaperTrade && initialStatus === 'OPEN' && entryPrice) {
      this.positionManagerService.addPosition(trade.id, {
        symbol: request.symbol,
        token: request.token,
        exchange: request.exchange,
        side: request.side,
        quantity: request.quantity,
        averagePrice: entryPrice,
        positionType: request.positionType,
      });
    }

    // R6: charge the paper ENTRY order and record it on the trade row so the
    // startup balance replay can reconstruct it.
    if (isPaperTrade && initialStatus === 'OPEN' && entryPrice) {
      const entryCharges = computeOrderCharges({
        side: request.side as 'BUY' | 'SELL',
        price: entryPrice,
        quantity: request.quantity,
        exchange: request.exchange,
      });
      this.paperTradeService.applyEntryCharge(entryCharges.total);
      await this.tradeRepository.updateTrade(trade.id, { fees: entryCharges.total });
    }

    // ---- STEP 7: Emit trade event via WebSocket ----
    this.tradeGateway.emitTradeUpdate(trade);

    this.logger.log(
      `Trade created: ${trade.id} (${isPaperTrade ? 'PAPER' : 'LIVE'}) — ${initialStatus}`,
    );

    return trade;
  }

  /**
   * Close an open trade by placing an opposite order.
   *
   * Accepts either the legacy `string` (for back-compat with existing
   * call sites like the kill-switch) or the structured M5 close-options
   * object: `{exitReasonTag, exitNotes, reason?}`.
   */
  async closeTrade(
    tradeId: string,
    reasonOrOpts?:
      | string
      | {
          exitReasonTag?: ExitReasonTag | string | null;
          exitNotes?: string | null;
          reason?: string | null;
          /** Close only this many units (partial exit). Omit to close all. */
          quantity?: number;
          /**
           * Caller-known trigger price (target-hit, loss-cut, trailing-stop).
           * When supplied, the paper-trade close fills at THIS price instead
           * of the cached LTP at simulation time. Without it, the Trade row's
           * recorded exitPrice can drift from the trigger price by the time
           * the close order runs, silently under-/over-reporting realised P&L.
           * Ignored for live trades — the broker is authoritative there.
           */
          exitPrice?: number;
        },
  ): Promise<Trade> {
    const opts =
      typeof reasonOrOpts === 'string'
        ? { reason: reasonOrOpts }
        : reasonOrOpts ?? {};

    const trade = await this.tradeRepository.getTradeById(tradeId);
    if (!trade) {
      throw new HttpException('Trade not found', HttpStatus.NOT_FOUND);
    }

    if (trade.status !== 'OPEN' && trade.status !== 'PARTIALLY_FILLED') {
      throw new HttpException(
        `Cannot close trade with status: ${trade.status}`,
        HttpStatus.BAD_REQUEST,
      );
    }

    // Quantity to close: an explicit `quantity` closes only that slice
    // (partial exit); omitted or over-sized closes the whole remaining trade.
    const closeQty = Math.min(
      Math.max(1, Math.floor(opts.quantity ?? trade.quantity)),
      trade.quantity,
    );
    const isFullClose = closeQty >= trade.quantity;

    const instrument = (trade as any).instrument;
    const exitSide = trade.side === 'BUY' ? 'SELL' : 'BUY';

    const closeOrder: OrderRequest = {
      symbol: instrument?.symbol ?? '',
      token: instrument?.token ?? '',
      exchange: instrument?.exchange ?? '',
      side: exitSide as 'BUY' | 'SELL',
      orderType: 'MARKET',
      quantity: closeQty,
      positionType: trade.positionType as
        | 'INTRADAY'
        | 'DELIVERY'
        | 'CARRYFORWARD',
    };

    let exitPrice = 0;

    if (trade.isPaperTrade) {
      // Resolve a usable price BEFORE simulating, so the paper fill — and
      // the cash credited back to the virtual balance — uses a real exit
      // price even when the instrument has no cached LTP. Without a price
      // on the close order the simulator fills at 0, credits no cash, and
      // books a phantom catastrophic loss.
      //
      // Preference: caller-supplied `opts.exitPrice` (the actual stop/target
      // trigger price) wins, then cached LTP, then entry price. The caller-
      // supplied path matters: by the time the close order runs the cached
      // LTP can have drifted several rupees from the trigger that decided
      // the exit, silently under-/over-reporting the realised P&L on the
      // Trade row.
      const callerExitPrice =
        typeof opts.exitPrice === 'number' && opts.exitPrice > 0
          ? opts.exitPrice
          : null;
      const lastPrice = instrument
        ? await this.getLastPrice(instrument.token, instrument.exchange)
        : null;
      closeOrder.price =
        callerExitPrice ??
        (lastPrice && lastPrice > 0
          ? lastPrice
          : trade.entryPrice && trade.entryPrice > 0
            ? trade.entryPrice
            : undefined);

      const paperResponse =
        await this.paperTradeService.simulateOrder(closeOrder);

      // Pick the first STRICTLY-POSITIVE price. A 0 fill (no LTP) must never
      // be accepted — find(>0) is used instead of the ?? chain, which would
      // treat a literal 0 as a valid value and corrupt P&L. callerExitPrice
      // is checked first so the trigger price wins over a stale cached fill.
      exitPrice =
        [callerExitPrice, paperResponse.fillPrice, lastPrice, trade.entryPrice].find(
          (p): p is number => typeof p === 'number' && p > 0,
        ) ?? 0;

      if (!exitPrice || exitPrice <= 0) {
        this.logger.error(
          `Paper close ${paperResponse.orderId} resolved no exitPrice — ` +
            `fillPrice=${paperResponse.fillPrice}, lastPrice=${lastPrice}, ` +
            `trade.entryPrice=${trade.entryPrice}. This will corrupt P&L.`,
        );
      }

      this.logger.log(
        `[Paper] Close order ${paperResponse.orderId}: ${paperResponse.status}`,
      );
    } else {
      if (!this.brokerAdapter) {
        throw new HttpException(
          'No broker adapter configured',
          HttpStatus.SERVICE_UNAVAILABLE,
        );
      }

      const response = await this.brokerAdapter.placeOrder(closeOrder);
      this.logger.log(
        `[Live] Close order ${response.orderId}: ${response.status}`,
      );

      // For live trades, fetch the actual LTP
      if (instrument) {
        try {
          const quote = await this.brokerAdapter.getLiveQuote(
            instrument.symbol,
            instrument.exchange,
          );
          exitPrice = quote.ltp;
        } catch {
          exitPrice = trade.entryPrice ?? 0;
        }
      }
    }

    // Calculate P&L on the slice being closed, then accumulate it onto any
    // P&L already realized by earlier partial closes of this same trade.
    const entryPrice = trade.entryPrice ?? 0;
    const multiplier = trade.side === 'BUY' ? 1 : -1;
    const slicePnl = multiplier * (exitPrice - entryPrice) * closeQty;
    const pnl = (trade.pnl ?? 0) + slicePnl;
    // Price-return percentage — quantity-independent, so it stays correct
    // after a partial exit. The old pnl / (entryPrice × trade.quantity) used
    // the post-shrink remaining quantity as the denominator while pnl was the
    // cumulative total → an inflated % on every partially-exited trade.
    const pnlPercent =
      entryPrice > 0
        ? (multiplier * (exitPrice - entryPrice) / entryPrice) * 100
        : 0;

    // R6: real per-order charges on the SELL exit leg, applied to the paper
    // account and accumulated onto the trade's `fees`.
    const exitCharges = computeOrderCharges({
      side: exitSide as 'BUY' | 'SELL',
      price: exitPrice,
      quantity: closeQty,
      exchange: instrument?.exchange ?? 'NSE',
    });
    if (trade.isPaperTrade) {
      this.paperTradeService.applyExitAccounting(slicePnl, exitCharges.total);
    }
    const brokerCharge = trade.isPaperTrade ? exitCharges.total : 0;
    const totalFees = (trade.fees ?? 0) + brokerCharge;

    // Pick the human-readable note: prefer structured exitNotes, fall back
    // to the legacy `reason` string (kill-switch path), preserve original
    // notes otherwise.
    const exitNote =
      opts.exitNotes ?? opts.reason ?? null;
    const noteForLegacyField = opts.reason
      ? `Closed: ${opts.reason}`
      : trade.notes ?? undefined;

    // Full close → CLOSED with exit price/time. Partial close → the trade
    // stays open as PARTIALLY_FILLED with its quantity reduced to the
    // remainder, so the trades table never accumulates orphan rows.
    const updatedTrade = await this.tradeRepository.updateTrade(
      tradeId,
      isFullClose
        ? {
            status: 'CLOSED',
            exitPrice,
            exitTime: new Date(),
            pnl,
            pnlPercent,
            fees: totalFees,
            notes: noteForLegacyField,
            exitReasonTag: opts.exitReasonTag ?? null,
            exitNotes: exitNote,
          }
        : {
            status: 'PARTIALLY_FILLED',
            quantity: trade.quantity - closeQty,
            pnl,
            pnlPercent,
            fees: totalFees,
            notes: noteForLegacyField,
          },
    );

    // ---- Append to the per-trade event log (best-effort) ----
    // A partial close logs PARTIAL_EXIT for the leg. A full close logs the
    // SPECIFIC exit type so the audit log distinguishes a stop-out from a
    // target hit from a plain square-off (the whole point of the log) — we
    // map the exit reason/tag onto SL_HIT / TARGET_HIT, else generic CLOSED.
    // price = the slice exit price, pnl = cumulative realized P&L,
    // quantity = the units closed on this leg.
    const exitTag = (opts.exitReasonTag as string) ?? '';
    const reasonStr = `${exitTag} ${exitNote ?? ''}`.toLowerCase();
    const fullCloseType =
      exitTag === 'HIT_TARGET' || /target/.test(reasonStr)
        ? TradeEventType.TARGET_HIT
        : exitTag === 'STOPPED_OUT' || exitTag === 'MOVED_STOP' || /\bsl\b|stop|loss-cut/.test(reasonStr)
          ? TradeEventType.SL_HIT
          : TradeEventType.CLOSED;
    await this.emitTradeEvent({
      tradeId,
      eventType: isFullClose ? fullCloseType : TradeEventType.PARTIAL_EXIT,
      price: exitPrice,
      quantity: closeQty,
      pnl,
      notes: exitTag || exitNote || null,
    });

    // Mirror the close into the in-memory position tracker: a full close
    // removes the position, a partial close shrinks it. Both book only THIS
    // slice's realized P&L (slicePnl) — a prior partial already booked its
    // own slice, so passing the cumulative pnl would double-count it.
    if (isFullClose) {
      this.positionManagerService.removePosition(tradeId, slicePnl);
    } else {
      this.positionManagerService.reducePosition(tradeId, closeQty, slicePnl);
    }

    // Emit updates
    this.tradeGateway.emitTradeUpdate(updatedTrade);

    this.logger.log(
      `Trade ${tradeId} ${isFullClose ? 'closed' : 'partially closed'} ` +
        `(${closeQty} @ ${exitPrice.toFixed(2)}). P&L: ${pnl.toFixed(2)} (${pnlPercent.toFixed(2)}%)`,
    );

    return updatedTrade;
  }

  /**
   * KILL SWITCH: Close ALL open positions immediately with market orders.
   */
  async closeAllPositions(reason: string): Promise<{ closed: number }> {
    this.logger.error(`CLOSE ALL POSITIONS: ${reason}`);

    // Activate kill switch to block new trades
    this.riskManagerService.activateKillSwitch(reason);

    // Notify settings service
    await this.settingsService.activateKillSwitch();

    // Emit kill switch event
    this.tradeGateway.emitKillSwitchActivated(reason);

    // Close every open trade
    const openTrades = await this.tradeRepository.getOpenTrades();
    let closed = 0;

    for (const trade of openTrades) {
      try {
        await this.closeTrade(trade.id, `Kill switch: ${reason}`);
        closed++;
      } catch (error) {
        this.logger.error(
          `Failed to close trade ${trade.id}: ${error.message}`,
        );
      }
    }

    this.logger.error(
      `Kill switch executed: ${closed}/${openTrades.length} positions closed`,
    );

    // Emit updated risk status
    const riskStatus = await this.riskManagerService.getDailyRiskStatus();
    this.tradeGateway.emitRiskStatus(riskStatus);

    return { closed };
  }

  /**
   * Modify an open trade's stoploss, target, or quantity.
   */
  async modifyTrade(
    tradeId: string,
    updates: ModifyTradeDto,
  ): Promise<Trade> {
    const trade = await this.tradeRepository.getTradeById(tradeId);
    if (!trade) {
      throw new HttpException('Trade not found', HttpStatus.NOT_FOUND);
    }

    if (trade.status !== 'OPEN' && trade.status !== 'PARTIALLY_FILLED') {
      throw new HttpException(
        `Cannot modify trade with status: ${trade.status}`,
        HttpStatus.BAD_REQUEST,
      );
    }

    const updateData: Record<string, any> = {};

    if (updates.stoploss !== undefined) {
      updateData.stoploss = updates.stoploss;
    }
    if (updates.target !== undefined) {
      updateData.target = updates.target;
    }
    if (updates.quantity !== undefined) {
      updateData.quantity = updates.quantity;
    }

    if (Object.keys(updateData).length === 0) {
      throw new HttpException(
        'No fields to update',
        HttpStatus.BAD_REQUEST,
      );
    }

    // If live trade and broker adapter available, try to modify the broker order
    if (!trade.isPaperTrade && this.brokerAdapter && trade.orderId) {
      try {
        await this.brokerAdapter.modifyOrder(trade.orderId, {
          price: updates.stoploss,
          quantity: updates.quantity,
        });
      } catch (error) {
        this.logger.warn(
          `Failed to modify broker order ${trade.orderId}: ${error.message}`,
        );
      }
    }

    const updatedTrade = await this.tradeRepository.updateTrade(
      tradeId,
      updateData,
    );

    this.tradeGateway.emitTradeUpdate(updatedTrade);

    this.logger.log(
      `Trade ${tradeId} modified: ${JSON.stringify(updateData)}`,
    );

    return updatedTrade;
  }

  /**
   * Get all currently open trades.
   */
  async getOpenTrades(source?: string): Promise<Trade[]> {
    return this.tradeRepository.getOpenTrades(source);
  }

  /**
   * Resting (PENDING) orders — LIMIT/STOPLOSS orders waiting for their price.
   * Optional `source` scopes to one origin track (e.g. 'MANUAL').
   */
  async getPendingTrades(source?: string): Promise<Trade[]> {
    return this.tradeRepository.getPendingTrades(source);
  }

  /**
   * Cancel a resting (PENDING) order: drop it from the paper engine's pending
   * map and mark the DB row CANCELLED. Only PENDING orders can be cancelled —
   * an OPEN position must be closed via closeTrade, not cancelled.
   */
  async cancelPendingOrder(tradeId: string): Promise<Trade> {
    const trade = await this.tradeRepository.getTradeById(tradeId);
    if (!trade) {
      throw new HttpException('Trade not found', HttpStatus.NOT_FOUND);
    }
    if (trade.status !== 'PENDING') {
      throw new HttpException(
        `Cannot cancel a ${trade.status} order — only PENDING orders can be cancelled`,
        HttpStatus.BAD_REQUEST,
      );
    }
    // Drop from the paper engine's in-memory resting map (no-op if absent).
    if (trade.orderId) {
      this.paperTradeService.cancelPendingOrder(trade.orderId);
    }
    // Live resting orders cancel at the broker too (risk-reducing — not gated).
    if (!trade.isPaperTrade && trade.orderId && this.brokerAdapter) {
      try {
        await this.brokerAdapter.cancelOrder(trade.orderId);
      } catch (err) {
        this.logger.warn(
          `Broker cancel failed for ${trade.orderId}: ${err instanceof Error ? err.message : err}`,
        );
      }
    }
    await this.tradeRepository.updateTrade(tradeId, { status: 'CANCELLED' });
    await this.emitTradeEvent({
      tradeId,
      eventType: TradeEventType.CANCELLED,
      price: trade.limitPrice ?? trade.triggerPrice ?? null,
      quantity: trade.quantity,
      notes: 'user cancelled pending order',
    });
    const updated = await this.tradeRepository.getTradeById(tradeId);
    if (updated) this.tradeGateway.emitTradeUpdate(updated);
    return updated ?? trade;
  }

  /**
   * Get paginated trade history with filters.
   */
  async getTradeHistory(
    filters: TradeFilterDto,
  ): Promise<{ trades: Trade[]; total: number }> {
    return this.tradeRepository.getTradeHistory(filters);
  }

  /**
   * Get a single trade by ID.
   */
  async getTradeById(tradeId: string): Promise<Trade> {
    const trade = await this.tradeRepository.getTradeById(tradeId);
    if (!trade) {
      throw new HttpException('Trade not found', HttpStatus.NOT_FOUND);
    }
    return trade;
  }

  /**
   * Handle incoming tick data — routes to paper trade simulator and position manager.
   */
  handleTick(tick: TickData): void {
    this.paperTradeService.simulateTick(tick);
    this.positionManagerService.updatePositionPnL(tick);
  }

  // ------------------------------------------------------------------
  //  Private helpers
  // ------------------------------------------------------------------

  /**
   * Append one row to the per-trade event log. BEST-EFFORT: an event-log
   * write must NEVER block or fail a trade, so every failure is swallowed
   * with a warning. Mirrors the tolerant market-context snapshot in
   * executeTrade.
   */
  private async emitTradeEvent(input: {
    tradeId: string;
    eventType: TradeEventType;
    price?: number | null;
    quantity?: number | null;
    pnl?: number | null;
    notes?: string | null;
  }): Promise<void> {
    try {
      await this.tradeRepository.createTradeEvent(input);
    } catch (err) {
      this.logger.warn(
        `Trade-event log write failed (${input.eventType} for ${input.tradeId}): ${
          err instanceof Error ? err.message : err
        }`,
      );
    }
  }

  private async getLastPrice(
    token: string,
    exchange: string,
  ): Promise<number | null> {
    try {
      if (this.brokerAdapter) {
        const quote = await this.brokerAdapter.getLiveQuote(token, exchange);
        return quote.ltp;
      }
    } catch {
      // Fallback: no live price available
    }
    return null;
  }
}
