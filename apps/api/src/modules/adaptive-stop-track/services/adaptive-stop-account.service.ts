import { surviveBootWork } from '../../../common/utils/survive-boot-work';
import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { PrismaService } from '../../../common/prisma/prisma.service';
import { AdaptiveStopTradeRepository } from '../repositories/adaptive-stop-trade.repository';
import { STARTING_BALANCE, MAX_CONCURRENT } from '../constants';

export const TRADE_CAPITAL = 2_00_000;

export class AdaptiveStopCapitalExhaustedError extends Error {
  constructor(public readonly cash: number) {
    super(`adaptive-stop capital-exhausted (cash=${cash})`);
    this.name = 'AdaptiveStopCapitalExhaustedError';
  }
}
export class AdaptiveStopPositionCapError extends Error {
  constructor(public readonly openTrades: number) {
    super(`adaptive-stop position-cap reached (${openTrades}/${MAX_CONCURRENT})`);
    this.name = 'AdaptiveStopPositionCapError';
  }
}
export class AdaptiveStopKillSwitchError extends Error {
  constructor() {
    super('adaptive-stop kill-switch is active');
    this.name = 'AdaptiveStopKillSwitchError';
  }
}

export interface AdaptiveStopAccountSnapshot {
  id: string;
  startingBalance: number;
  cash: number;
  realizedPnl: number;
  fees: number;
  deployedCapital: number;
  killSwitchAt: Date | null;
}

@Injectable()
export class AdaptiveStopAccountService implements OnModuleInit {
  private readonly logger = new Logger(AdaptiveStopAccountService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly trades: AdaptiveStopTradeRepository,
  ) {}

  /**
   * Guarded: an unreachable database must not stop the API from serving. Nest
   * runs module hooks concurrently under Promise.all inside `app.listen()`, so
   * an unguarded rejection here aborts init and the port is never bound. This
   * reconcile is a self-healing balance check that the next boot redoes.
   */
  async onModuleInit(): Promise<void> {
    await surviveBootWork(
      'reconcile the adaptive-stop paper account',
      () => this.reconcileAtBoot(),
      this.logger,
    );
  }

  private async reconcileAtBoot(): Promise<void> {
    const existing = await this.prisma.adaptiveStopPaperAccount.findFirst();
    if (!existing) {
      await this.prisma.adaptiveStopPaperAccount.create({
        data: { startingBalance: STARTING_BALANCE, cash: STARTING_BALANCE },
      });
      this.logger.log(`Seeded adaptive_stop_paper_account with ₹${STARTING_BALANCE}`);
      return;
    }
    const realized = await this.trades.sumRealized();
    const deployed = await this.trades.sumDeployedOpen();
    const recomputedCash =
      existing.startingBalance + realized.pnl - realized.fees - deployed;
    if (Math.abs(recomputedCash - existing.cash) > 1) {
      this.logger.warn(
        `adaptive_stop_paper_account.cash drift: stored=${existing.cash} recomputed=${recomputedCash} — overwriting`,
      );
      await this.prisma.adaptiveStopPaperAccount.update({
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

  async snapshot(): Promise<AdaptiveStopAccountSnapshot> {
    const row = await this.prisma.adaptiveStopPaperAccount.findFirst();
    if (!row) throw new Error('adaptive_stop_paper_account row missing — call onModuleInit first');
    return row;
  }

  async admit(opts: { openTrades: number }): Promise<void> {
    const a = await this.snapshot();
    if (a.killSwitchAt) throw new AdaptiveStopKillSwitchError();
    if (a.cash < TRADE_CAPITAL) throw new AdaptiveStopCapitalExhaustedError(a.cash);
    if (opts.openTrades >= MAX_CONCURRENT) throw new AdaptiveStopPositionCapError(opts.openTrades);
  }

  async applyEntry(args: {
    entryPrice: number; quantity: number; entryFees: number;
  }): Promise<void> {
    const notional = args.entryPrice * args.quantity;
    const a = await this.snapshot();
    await this.prisma.adaptiveStopPaperAccount.update({
      where: { id: a.id },
      data: {
        // Fees are real money — they leave the cash balance on every leg, not
        // just sit in a counter. Without this, the closing invariant
        // (cash == startingBalance + realizedPnl − fees) breaks by the
        // total-fees figure.
        cash: a.cash - notional - args.entryFees,
        deployedCapital: a.deployedCapital + notional,
        fees: a.fees + args.entryFees,
      },
    });
  }

  async applyExit(args: {
    entryPrice: number; exitPrice: number; quantity: number;
    sideMul: 1 | -1; exitFees: number;
  }): Promise<void> {
    const a = await this.snapshot();
    const cashIn = args.exitPrice * args.quantity;
    const deployedOut = args.entryPrice * args.quantity;
    const slicePnl =
      args.sideMul * (args.exitPrice - args.entryPrice) * args.quantity;
    await this.prisma.adaptiveStopPaperAccount.update({
      where: { id: a.id },
      data: {
        // Same fee accounting as applyEntry: exit-leg charges leave cash, too.
        cash: a.cash + cashIn - args.exitFees,
        deployedCapital: a.deployedCapital - deployedOut,
        realizedPnl: a.realizedPnl + slicePnl,
        fees: a.fees + args.exitFees,
      },
    });
  }
}
