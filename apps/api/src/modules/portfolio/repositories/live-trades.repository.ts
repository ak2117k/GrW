import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../../common/prisma/prisma.service';

/** The trade_trackers columns the live views read. */
export interface LiveTrackerRow {
  id: string;
  symbol: string;
  exchange: string;
  token: string;
  kind: string;
  entryPrice: number;
  qty: number;
  entryTime: Date;
  exitPrice: number | null;
  exitTime: Date | null;
  status: string;
  lastLtp: number | null;
  pnl: number | null;
  pnlPercent: number | null;
}

/** The ai_exit_executions columns used to attribute who closed a tracker. */
export interface LiveExitRow {
  trackerId: string;
  verdictId: string;
  mode: string;
  status: string;
  verdictReason: string;
  fillPrice: number | null;
  createdAt: Date;
}

/** A LIVE (isPaperTrade=false) row of the trades table, with its instrument. */
export interface LiveOrderRow {
  id: string;
  side: string;
  quantity: number;
  entryPrice: number | null;
  exitPrice: number | null;
  pnl: number | null;
  pnlPercent: number | null;
  status: string;
  strategy: string | null;
  source: string;
  entryTime: Date | null;
  exitTime: Date | null;
  createdAt: Date;
  instrument: { symbol: string; exchange: string; segment: string; token: string } | null;
}

/**
 * Reads the LIVE (real-money) trade sources for one user: the broker-position
 * trackers, the executor's exit rows, and live rows of the trades table.
 *
 * Every query filters on `userId` explicitly. trade_trackers and
 * ai_exit_executions are not tenant-scoped models, and an ADMIN request is never
 * auto-scoped, so the explicit filter is what keeps each user to their own rows.
 */
@Injectable()
export class LiveTradesRepository {
  constructor(private readonly prisma: PrismaService) {}

  async listTrackers(userId: string): Promise<LiveTrackerRow[]> {
    return this.prisma.tradeTracker.findMany({
      where: { userId },
      select: {
        id: true,
        symbol: true,
        exchange: true,
        token: true,
        kind: true,
        entryPrice: true,
        qty: true,
        entryTime: true,
        exitPrice: true,
        exitTime: true,
        status: true,
        lastLtp: true,
        pnl: true,
        pnlPercent: true,
      },
      orderBy: { entryTime: 'desc' },
    });
  }

  /** Live exit orders the executor actually sent (dry-run and refused rows excluded). */
  async listLiveExits(userId: string): Promise<LiveExitRow[]> {
    return this.prisma.aiExitExecution.findMany({
      where: { userId, mode: 'live', status: { in: ['PLACED', 'FILLED'] } },
      select: {
        trackerId: true,
        verdictId: true,
        mode: true,
        status: true,
        verdictReason: true,
        fillPrice: true,
        createdAt: true,
      },
      orderBy: { createdAt: 'asc' },
    });
  }

  async listLiveOrders(userId: string): Promise<LiveOrderRow[]> {
    return this.prisma.trade.findMany({
      where: {
        userId,
        isPaperTrade: false,
        status: { notIn: ['PENDING', 'REJECTED', 'CANCELLED'] },
      },
      select: {
        id: true,
        side: true,
        quantity: true,
        entryPrice: true,
        exitPrice: true,
        pnl: true,
        pnlPercent: true,
        status: true,
        strategy: true,
        source: true,
        entryTime: true,
        exitTime: true,
        createdAt: true,
        instrument: { select: { symbol: true, exchange: true, segment: true, token: true } },
      },
      orderBy: { createdAt: 'desc' },
    }) as unknown as Promise<LiveOrderRow[]>;
  }
}
