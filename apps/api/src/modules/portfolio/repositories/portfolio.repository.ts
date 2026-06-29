import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../../common/prisma/prisma.service';
import { SYSTEM_USER_ID } from '../../../common/tenant/tenant.constants';

@Injectable()
export class PortfolioRepository {
  private readonly logger = new Logger(PortfolioRepository.name);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Get all trades within a date range
   */
  async getTradesByDateRange(from: Date, to: Date) {
    return this.prisma.trade.findMany({
      where: {
        createdAt: { gte: from, lte: to },
      },
      include: {
        instrument: { select: { symbol: true, exchange: true, segment: true } },
      },
      orderBy: { createdAt: 'desc' },
    });
  }

  /**
   * Get daily performance records in a date range
   */
  async getDailyPerformanceRange(from: Date, to: Date) {
    return this.prisma.dailyPerformance.findMany({
      where: {
        date: { gte: from, lte: to },
      },
      orderBy: { date: 'asc' },
    });
  }

  /**
   * Get trades grouped by segment with aggregated P&L.
   *
   * NOTE: `segment` lives on the related Instrument, not on Trade, and Prisma
   * `groupBy` cannot group across a relation. So this stays a `findMany`, but
   * it is narrowed to `select` ONLY the two columns the reduce needs
   * (`pnl` + `instrument.segment`) instead of pulling whole trade rows via
   * `include`. That keeps the row-transfer payload tiny while still letting
   * us bucket by segment in JS.
   */
  async getTradesBySegment() {
    const trades = await this.prisma.trade.findMany({
      where: {
        status: { in: ['CLOSED', 'FILLED'] },
        pnl: { not: null },
      },
      select: {
        pnl: true,
        instrument: { select: { segment: true } },
      },
    });

    const segmentMap = new Map<string, { pnl: number; count: number; wins: number; losses: number }>();
    for (const trade of trades) {
      const segment = trade.instrument?.segment || 'UNKNOWN';
      const entry = segmentMap.get(segment) || { pnl: 0, count: 0, wins: 0, losses: 0 };
      entry.pnl += trade.pnl ?? 0;
      entry.count += 1;
      if ((trade.pnl ?? 0) > 0) entry.wins += 1;
      else if ((trade.pnl ?? 0) < 0) entry.losses += 1;
      segmentMap.set(segment, entry);
    }

    return Array.from(segmentMap.entries()).map(([segment, stats]) => ({
      segment,
      pnl: stats.pnl,
      trades: stats.count,
      wins: stats.wins,
      losses: stats.losses,
    }));
  }

  /**
   * Get trades grouped by strategy with win/loss counts
   */
  async getTradesByStrategy() {
    const baseWhere = {
      status: { in: ['CLOSED', 'FILLED'] },
      pnl: { not: null },
      strategy: { not: null },
    } as const;

    // Push the aggregation into the DB: one groupBy for sum/count of all
    // closed trades per strategy, plus two thin groupBys for the win/loss
    // counts. Only summarized rows (one per strategy) cross the wire, instead
    // of every trade row being streamed back and reduced in JS.
    const [totals, winRows, lossRows] = await Promise.all([
      this.prisma.trade.groupBy({
        by: ['strategy'],
        where: baseWhere,
        _sum: { pnl: true },
        _count: { _all: true },
      }),
      this.prisma.trade.groupBy({
        by: ['strategy'],
        where: { ...baseWhere, pnl: { gt: 0 } },
        _count: { _all: true },
      }),
      this.prisma.trade.groupBy({
        by: ['strategy'],
        where: { ...baseWhere, pnl: { lt: 0 } },
        _count: { _all: true },
      }),
    ]);

    const winsByStrategy = new Map<string, number>();
    for (const row of winRows as any[]) {
      winsByStrategy.set(row.strategy ?? 'unknown', row._count?._all ?? 0);
    }
    const lossesByStrategy = new Map<string, number>();
    for (const row of lossRows as any[]) {
      lossesByStrategy.set(row.strategy ?? 'unknown', row._count?._all ?? 0);
    }

    return (totals as any[]).map((row) => {
      const strategy = row.strategy ?? 'unknown';
      const trades = row._count?._all ?? 0;
      const wins = winsByStrategy.get(strategy) ?? 0;
      const losses = lossesByStrategy.get(strategy) ?? 0;
      return {
        strategy,
        pnl: row._sum?.pnl ?? 0,
        trades,
        wins,
        losses,
        winRate: trades > 0 ? (wins / trades) * 100 : 0,
      };
    });
  }

  /**
   * Get aggregate trade statistics
   */
  async getTradeStats() {
    const [total, wins, losses] = await Promise.all([
      this.prisma.trade.count({
        where: { status: { in: ['CLOSED', 'FILLED'] } },
      }),
      this.prisma.trade.count({
        where: { status: { in: ['CLOSED', 'FILLED'] }, pnl: { gt: 0 } },
      }),
      this.prisma.trade.count({
        where: { status: { in: ['CLOSED', 'FILLED'] }, pnl: { lt: 0 } },
      }),
    ]);

    const aggregates = await this.prisma.trade.aggregate({
      where: { status: { in: ['CLOSED', 'FILLED'] }, pnl: { not: null } },
      _sum: { pnl: true },
      _avg: { pnl: true },
    });

    const avgProfit = await this.prisma.trade.aggregate({
      where: { status: { in: ['CLOSED', 'FILLED'] }, pnl: { gt: 0 } },
      _avg: { pnl: true },
    });

    const avgLoss = await this.prisma.trade.aggregate({
      where: { status: { in: ['CLOSED', 'FILLED'] }, pnl: { lt: 0 } },
      _avg: { pnl: true },
    });

    return {
      total,
      wins,
      losses,
      totalPnl: aggregates._sum.pnl ?? 0,
      avgPnl: aggregates._avg.pnl ?? 0,
      avgProfit: avgProfit._avg.pnl ?? 0,
      avgLoss: avgLoss._avg.pnl ?? 0,
    };
  }

  /**
   * Get the count of open positions
   */
  async getOpenPositionCount(): Promise<number> {
    return this.prisma.trade.count({
      where: { status: { in: ['OPEN', 'PARTIALLY_FILLED'] } },
    });
  }

  /**
   * Get today's P&L
   */
  async getTodayPnl(): Promise<number> {
    const startOfDay = new Date();
    startOfDay.setHours(0, 0, 0, 0);

    const result = await this.prisma.trade.aggregate({
      where: {
        status: { in: ['CLOSED', 'FILLED'] },
        pnl: { not: null },
        exitTime: { gte: startOfDay },
      },
      _sum: { pnl: true },
    });

    return result._sum.pnl ?? 0;
  }

  /**
   * Get P&L for a date range
   */
  async getPnlForRange(from: Date, to: Date): Promise<number> {
    const result = await this.prisma.trade.aggregate({
      where: {
        status: { in: ['CLOSED', 'FILLED'] },
        pnl: { not: null },
        exitTime: { gte: from, lte: to },
      },
      _sum: { pnl: true },
    });

    return result._sum.pnl ?? 0;
  }

  /**
   * Upsert daily performance snapshot
   */
  async saveDailySnapshot(
    date: Date,
    data: {
      totalPnl: number;
      realizedPnl: number;
      unrealizedPnl: number;
      totalTrades: number;
      winningTrades: number;
      losingTrades: number;
      maxDrawdown: number;
      capitalDeployed: number;
    },
  ) {
    return this.prisma.dailyPerformance.upsert({
      where: { date },
      update: data,
      // DailyPerformance.date is `@unique`, so the `where` needs no userId; only
      // the engine (ADMIN) writes this row. Stamp the owner so the NOT NULL
      // userId column (TDA-001) is satisfied on the no-context engine path.
      create: { userId: SYSTEM_USER_ID, date, ...data },
    });
  }

  /**
   * Get paginated trade journal
   */
  async getTradeJournal(options: {
    from?: Date;
    to?: Date;
    strategy?: string;
    segment?: string;
    status?: string;
    side?: string;
    vixRegime?: string;
    exitReasonTag?: string;
    page: number;
    limit: number;
    sortBy: string;
    order: 'asc' | 'desc';
  }) {
    const where: any = {};

    if (options.from || options.to) {
      where.createdAt = {};
      if (options.from) where.createdAt.gte = options.from;
      if (options.to) where.createdAt.lte = options.to;
    }

    if (options.strategy) where.strategy = options.strategy;
    if (options.status) where.status = options.status;
    if (options.side) where.side = options.side;
    // M5: filter by entry-time market regime + structured exit reason.
    if (options.vixRegime) where.vixRegimeAtEntry = options.vixRegime;
    if (options.exitReasonTag) where.exitReasonTag = options.exitReasonTag;

    // For segment filtering we need to filter on the related instrument
    if (options.segment) {
      where.instrument = { segment: options.segment };
    }

    const orderBy: any = {};
    switch (options.sortBy) {
      case 'pnl':
        orderBy.pnl = options.order;
        break;
      case 'strategy':
        orderBy.strategy = options.order;
        break;
      default:
        orderBy.createdAt = options.order;
    }

    const skip = (options.page - 1) * options.limit;

    const [trades, total] = await Promise.all([
      this.prisma.trade.findMany({
        where,
        include: {
          instrument: { select: { symbol: true, exchange: true, segment: true } },
        },
        orderBy,
        skip,
        take: options.limit,
      }),
      this.prisma.trade.count({ where }),
    ]);

    return {
      trades,
      total,
      page: options.page,
      limit: options.limit,
      totalPages: Math.ceil(total / options.limit),
    };
  }

  /**
   * Get recent closed trades
   */
  async getRecentTrades(limit: number = 5) {
    return this.prisma.trade.findMany({
      where: { status: { in: ['CLOSED', 'FILLED'] } },
      include: {
        instrument: { select: { symbol: true, exchange: true, segment: true } },
      },
      orderBy: { updatedAt: 'desc' },
      take: limit,
    });
  }
}
