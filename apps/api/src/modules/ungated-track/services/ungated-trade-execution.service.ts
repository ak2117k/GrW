import { Injectable, Logger } from '@nestjs/common';
import { computeOrderCharges } from '../../trade-engine/services/trade-charges';
import { UngatedTradeRepository } from '../repositories/ungated-trade.repository';
import { UngatedPaperAccountService } from './ungated-paper-account.service';

export interface UngatedOpenTradeInput {
  instrumentId: string;
  side: 'BUY' | 'SELL';
  quantity: number;
  entryPrice: number;
  exchange: string;
  target?: number | null;
  stoploss?: number | null;
}

export interface UngatedCloseTradeOpts {
  reason: string;
  exitPrice: number;   // REQUIRED on ungated track
  quantity?: number;   // omit to close all; partial otherwise
}

/**
 * MIRROR (paper-only subset) of trade-execution.service.ts.
 * No live broker — every trade is paper. opts.exitPrice is REQUIRED,
 * so the silent-price-drift bug class from commits 9fb5bcd / 75a8559
 * is impossible by construction here.
 */
@Injectable()
export class UngatedTradeExecutionService {
  private readonly logger = new Logger(UngatedTradeExecutionService.name);

  constructor(
    private readonly trades: UngatedTradeRepository,
    private readonly account: UngatedPaperAccountService,
  ) {}

  async openTrade(input: UngatedOpenTradeInput) {
    const charges = computeOrderCharges({
      side: input.side,
      price: input.entryPrice,
      quantity: input.quantity,
      exchange: input.exchange,
    });
    const trade = await this.trades.createTrade({
      instrumentId: input.instrumentId,
      side: input.side,
      orderType: 'MARKET',
      positionType: 'INTRADAY',
      quantity: input.quantity,
      entryPrice: input.entryPrice,
      target: input.target ?? null,
      stoploss: input.stoploss ?? null,
      fees: charges.total,
      status: 'OPEN',
      isPaperTrade: true,
      entryTime: new Date(),
    });
    await this.account.applyEntry({
      entryPrice: input.entryPrice,
      quantity: input.quantity,
      entryFees: charges.total,
    });
    return trade;
  }

  async closeTrade(tradeId: string, opts: UngatedCloseTradeOpts) {
    const trade = await this.trades.getTradeById(tradeId);
    if (!trade) throw new Error(`UngatedTrade ${tradeId} not found`);
    if (trade.status !== 'OPEN' && trade.status !== 'PARTIALLY_FILLED') {
      throw new Error(`Cannot close trade with status ${trade.status}`);
    }
    const closeQty = Math.min(
      Math.max(1, Math.floor(opts.quantity ?? trade.quantity)),
      trade.quantity,
    );
    const isFullClose = closeQty >= trade.quantity;
    const sideMul: 1 | -1 = trade.side === 'BUY' ? 1 : -1;
    const exitSide = trade.side === 'BUY' ? 'SELL' : 'BUY';

    const exitCharges = computeOrderCharges({
      side: exitSide as 'BUY' | 'SELL',
      price: opts.exitPrice,
      quantity: closeQty,
      exchange: 'NSE',
    });

    const entryPrice = trade.entryPrice ?? 0;
    const slicePnl = sideMul * (opts.exitPrice - entryPrice) * closeQty;
    const cumulativePnl = (trade.pnl ?? 0) + slicePnl;
    // Cumulative shares closed so far, across every leg of this position.
    const closedQuantity = ((trade as any).closedQuantity ?? 0) + closeQty;
    // Position-level return: cumulative P&L over the cost basis of ALL shares
    // closed so far (entry × closedQuantity), not just this leg. After a
    // partial exit this correctly blends each leg instead of showing only the
    // final leg's percent.
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
      entryPrice: trade.entryPrice ?? 0,
      exitPrice: opts.exitPrice,
      quantity: closeQty,
      sideMul,
      exitFees: exitCharges.total,
    });

    return updated;
  }
}
