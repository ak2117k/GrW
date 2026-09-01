import { surviveBootWork } from '../../../common/utils/survive-boot-work';
import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { PrismaService } from '../../../common/prisma/prisma.service';
import { SellFuturesTradeRepository } from '../repositories/sell-futures-trade.repository';
import { MARGIN_PCT, MAX_OPEN_POSITIONS, PAPER_MARGIN_POOL } from '../constants';

export class SellFuturesPositionCapError extends Error {
  constructor(public readonly openTrades: number) {
    super(`sell-futures position-cap reached (${openTrades}/${MAX_OPEN_POSITIONS})`);
    this.name = 'SellFuturesPositionCapError';
  }
}
export class SellFuturesMarginExhaustedError extends Error {
  constructor(public readonly cash: number, public readonly required: number) {
    super(`sell-futures margin-exhausted (cash=${cash}, required=${required})`);
    this.name = 'SellFuturesMarginExhaustedError';
  }
}
export class SellFuturesKillSwitchError extends Error {
  constructor() {
    super('sell-futures kill-switch is active');
    this.name = 'SellFuturesKillSwitchError';
  }
}

export interface SellFuturesAccountSnapshot {
  id: string;
  startingBalance: number;
  cash: number;
  realizedPnl: number;
  fees: number;
  deployedCapital: number;
  killSwitchAt: Date | null;
}

/**
 * Paper margin account for the SELL-futures track. Unlike the equity tracks
 * (which deploy full notional), a short future posts ESTIMATED MARGIN only:
 * margin = notional × MARGIN_PCT (flat SPAN proxy — spec §Out of scope).
 * Margin is deployed on open and released on close.
 */
@Injectable()
export class SellFuturesPaperAccountService implements OnModuleInit {
  private readonly logger = new Logger(SellFuturesPaperAccountService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly trades: SellFuturesTradeRepository,
  ) {}

  /**
   * Guarded: an unreachable database must not stop the API from serving. Nest
   * runs module hooks concurrently under Promise.all inside `app.listen()`, so
   * an unguarded rejection here aborts init and the port is never bound. This
   * reconcile is a self-healing balance check that the next boot redoes.
   */
  async onModuleInit(): Promise<void> {
    await surviveBootWork(
      'reconcile the sell-futures paper account',
      () => this.reconcileAtBoot(),
      this.logger,
    );
  }

  private async reconcileAtBoot(): Promise<void> {
    const existing = await this.prisma.sellFuturesPaperAccount.findFirst();
    if (!existing) {
      await this.prisma.sellFuturesPaperAccount.create({
        data: { startingBalance: PAPER_MARGIN_POOL, cash: PAPER_MARGIN_POOL },
      });
      this.logger.log(`Seeded sell_futures_paper_account with ₹${PAPER_MARGIN_POOL}`);
      return;
    }
    const realized = await this.trades.sumRealized();
    const deployed = (await this.trades.sumOpenNotional()) * MARGIN_PCT;
    const recomputedCash =
      existing.startingBalance + realized.pnl - realized.fees - deployed;
    if (Math.abs(recomputedCash - existing.cash) > 1) {
      this.logger.warn(
        `sell_futures_paper_account.cash drift: stored=${existing.cash} recomputed=${recomputedCash} — overwriting`,
      );
      await this.prisma.sellFuturesPaperAccount.update({
        where: { id: existing.id },
        data: {
          cash: recomputedCash,
          realizedPnl: realized.pnl,
          fees: realized.fees,
          deployedCapital: deployed,
        },
      });
    }
  }

  async snapshot(): Promise<SellFuturesAccountSnapshot> {
    const row = await this.prisma.sellFuturesPaperAccount.findFirst();
    if (!row) throw new Error('sell_futures_paper_account row missing — call onModuleInit first');
    return row;
  }

  /** Kill-switch + position-cap gate (no price needed). */
  async admit(opts: { openTrades: number }): Promise<void> {
    const a = await this.snapshot();
    if (a.killSwitchAt) throw new SellFuturesKillSwitchError();
    if (opts.openTrades >= MAX_OPEN_POSITIONS) throw new SellFuturesPositionCapError(opts.openTrades);
  }

  /** Margin-availability gate (needs the live notional → checked after the quote). */
  async ensureMargin(marginRequired: number): Promise<void> {
    const a = await this.snapshot();
    if (a.cash < marginRequired) throw new SellFuturesMarginExhaustedError(a.cash, marginRequired);
  }

  async applyEntry(args: {
    entryPrice: number; quantity: number; entryFees: number;
  }): Promise<void> {
    const margin = args.entryPrice * args.quantity * MARGIN_PCT;
    const a = await this.snapshot();
    await this.prisma.sellFuturesPaperAccount.update({
      where: { id: a.id },
      data: {
        // Margin is locked (deployed) and fees leave cash on the entry leg.
        cash: a.cash - margin - args.entryFees,
        deployedCapital: a.deployedCapital + margin,
        fees: a.fees + args.entryFees,
      },
    });
  }

  async applyExit(args: {
    entryPrice: number; exitPrice: number; quantity: number;
    sideMul: 1 | -1; exitFees: number;
  }): Promise<void> {
    const a = await this.snapshot();
    const margin = args.entryPrice * args.quantity * MARGIN_PCT;
    // SHORT: sideMul = -1 → profit when exitPrice < entryPrice.
    const slicePnl =
      args.sideMul * (args.exitPrice - args.entryPrice) * args.quantity;
    await this.prisma.sellFuturesPaperAccount.update({
      where: { id: a.id },
      data: {
        // Release the locked margin, book P&L, charge the exit-leg fees.
        cash: a.cash + margin + slicePnl - args.exitFees,
        deployedCapital: a.deployedCapital - margin,
        realizedPnl: a.realizedPnl + slicePnl,
        fees: a.fees + args.exitFees,
      },
    });
  }
}
