import { Injectable, Logger } from '@nestjs/common';
import { Prisma, TradeEventType } from '@prisma/client';
import { PrismaService } from '../../../common/prisma/prisma.service';
import { SYSTEM_USER_ID } from '../../../common/tenant/tenant.constants';
import { Trade, TradeEvent, DailyPerformance } from '@prisma/client';
import { TradeFilterDto, DailyPerformanceData } from '../dto/trade.dto';

export interface CreateTradeEventInput {
  tradeId: string;
  eventType: TradeEventType;
  price?: number | null;
  quantity?: number | null;
  pnl?: number | null;
  notes?: string | null;
}

@Injectable()
export class TradeRepository {
  private readonly logger = new Logger(TradeRepository.name);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Return paper trades created on/after `since`, ordered by createdAt ASC
   * so a cash-flow replay produces the same final balance the in-memory
   * service had before restart. Used by PaperTradeService.onModuleInit()
   * with the PAPER_ACCOUNT_EPOCH cutoff so legacy trades stay in the DB
   * for journal/audit but don't pollute the current balance.
   */
  async findPaperTradesSince(since: Date): Promise<Trade[]> {
    return this.prisma.trade.findMany({
      where: { isPaperTrade: true, createdAt: { gte: since } },
      orderBy: { createdAt: 'asc' },
      // instrument is needed to rehydrate virtual positions on restart.
      include: { instrument: true },
    });
  }

  async createTrade(data: {
    instrumentId: string;
    signalId?: string;
    orderId?: string;
    side: string;
    orderType: string;
    positionType: string;
    quantity: number;
    entryPrice?: number;
    limitPrice?: number | null;
    triggerPrice?: number | null;
    stoploss?: number;
    target?: number;
    status: string;
    strategy?: string;
    isPaperTrade: boolean;
    source?: string;
    entryTime?: Date;
    notes?: string;
    // ---- M5: entry context capture ----
    entryReason?: string | null;
    entryTags?: string[];
    spotAtEntry?: number | null;
    vixAtEntry?: number | null;
    vixRegimeAtEntry?: string | null;
    pcrAtEntry?: number | null;
    maxPainAtEntry?: number | null;
    adRatioAtEntry?: number | null;
    contextSnapshot?: Prisma.InputJsonValue | null;
  }): Promise<Trade> {
    const { contextSnapshot, ...rest } = data;
    return this.prisma.trade.create({
      data: {
        // No tenant context on the engine path → stamp the ADMIN owner so the
        // NOT NULL userId column (TDA-001) is satisfied (the interceptor only
        // stamps when a request context is active).
        userId: SYSTEM_USER_ID,
        ...rest,
        // Prisma Json columns require explicit handling: undefined/null
        // both leave the column empty, but `null` passes through cleanly
        // when the field is optional in the schema.
        ...(contextSnapshot !== undefined && contextSnapshot !== null
          ? { contextSnapshot }
          : {}),
      },
    });
  }

  async updateTrade(
    id: string,
    data: Partial<{
      orderId: string;
      entryPrice: number;
      exitPrice: number;
      stoploss: number;
      target: number;
      pnl: number;
      pnlPercent: number;
      fees: number;
      status: string;
      quantity: number;
      entryTime: Date;
      exitTime: Date;
      notes: string;
      // ---- M5: exit-reason capture ----
      exitReasonTag: string | null;
      exitNotes: string | null;
    }>,
  ): Promise<Trade> {
    return this.prisma.trade.update({
      where: { id },
      data,
    });
  }

  /**
   * Resting (PENDING) orders — LIMIT/STOPLOSS orders waiting for the market to
   * reach their price. Optional `source` scopes to one origin track (e.g.
   * 'MANUAL'). Ordered newest-first for the UI's pending-orders list.
   */
  async getPendingTrades(source?: string): Promise<Trade[]> {
    return this.prisma.trade.findMany({
      where: {
        status: 'PENDING',
        ...(source ? { source } : {}),
      },
      include: { instrument: true, signal: true },
      orderBy: { createdAt: 'desc' },
    });
  }

  /**
   * All PENDING paper orders, oldest-first. Used by PaperTradeService.onModuleInit
   * to rebuild the in-memory pending map after a restart so resting orders are
   * not silently dropped.
   */
  async findPendingPaperTrades(): Promise<Trade[]> {
    return this.prisma.trade.findMany({
      where: { status: 'PENDING', isPaperTrade: true },
      include: { instrument: true },
      orderBy: { createdAt: 'asc' },
    });
  }

  /** Look up a trade by its (broker/paper) order id — used to settle a deferred fill. */
  async findByOrderId(orderId: string): Promise<Trade | null> {
    return this.prisma.trade.findFirst({ where: { orderId } });
  }

  async getOpenTrades(source?: string): Promise<Trade[]> {
    return this.prisma.trade.findMany({
      where: {
        status: { in: ['OPEN', 'PARTIALLY_FILLED'] },
        // Optional origin filter (e.g. 'MANUAL'). Omitted ⇒ all open trades,
        // so existing consumers (kill-switch, positions sync) are unaffected.
        ...(source ? { source } : {}),
      },
      include: { instrument: true, signal: true },
      orderBy: { createdAt: 'desc' },
    });
  }

  async getTradeById(id: string): Promise<Trade | null> {
    return this.prisma.trade.findUnique({
      where: { id },
      include: { instrument: true, signal: true },
    });
  }

  async getTradeHistory(
    filters: TradeFilterDto,
  ): Promise<{ trades: Trade[]; total: number }> {
    const page = filters.page ?? 1;
    const limit = filters.limit ?? 20;
    const skip = (page - 1) * limit;

    const where: Prisma.TradeWhereInput = {};

    if (filters.status) {
      where.status = filters.status;
    }
    if (filters.strategy) {
      where.strategy = filters.strategy;
    }
    if (filters.isPaperTrade !== undefined) {
      where.isPaperTrade = filters.isPaperTrade;
    }
    if (filters.from || filters.to) {
      where.createdAt = {};
      if (filters.from) (where.createdAt as Prisma.DateTimeFilter).gte = new Date(filters.from);
      if (filters.to) (where.createdAt as Prisma.DateTimeFilter).lte = new Date(filters.to);
    }
    // M5 journal filters: bucket trades by VIX regime captured at entry
    // and by structured exit-reason tag.
    if (filters.vixRegime) {
      where.vixRegimeAtEntry = filters.vixRegime;
    }
    if (filters.exitReasonTag) {
      where.exitReasonTag = filters.exitReasonTag;
    }

    const [trades, total] = await Promise.all([
      this.prisma.trade.findMany({
        where,
        include: { instrument: true },
        orderBy: { createdAt: 'desc' },
        skip,
        take: limit,
      }),
      this.prisma.trade.count({ where }),
    ]);

    return { trades, total };
  }

  async getTodayTrades(): Promise<Trade[]> {
    const todayStart = new Date();
    todayStart.setHours(0, 0, 0, 0);

    return this.prisma.trade.findMany({
      where: {
        createdAt: { gte: todayStart },
      },
      include: { instrument: true },
      orderBy: { createdAt: 'desc' },
    });
  }

  async getDailyPnL(date: Date): Promise<number> {
    const dayStart = new Date(date);
    dayStart.setHours(0, 0, 0, 0);
    const dayEnd = new Date(date);
    dayEnd.setHours(23, 59, 59, 999);

    const result = await this.prisma.trade.aggregate({
      where: {
        status: 'CLOSED',
        exitTime: { gte: dayStart, lte: dayEnd },
      },
      _sum: { pnl: true },
    });

    return result._sum.pnl ?? 0;
  }

  async saveDailyPerformance(
    data: DailyPerformanceData,
  ): Promise<DailyPerformance> {
    return this.prisma.dailyPerformance.upsert({
      where: { date: data.date },
      update: {
        totalPnl: data.totalPnl,
        realizedPnl: data.realizedPnl,
        unrealizedPnl: data.unrealizedPnl,
        totalTrades: data.totalTrades,
        winningTrades: data.winningTrades,
        losingTrades: data.losingTrades,
        maxDrawdown: data.maxDrawdown,
        capitalDeployed: data.capitalDeployed,
      },
      create: {
        // DailyPerformance.date is `@unique` (not `@@unique([userId, date])`),
        // so the `where` needs no userId; only the engine (ADMIN) writes this
        // row. Stamp the owner so the NOT NULL userId column is satisfied.
        userId: SYSTEM_USER_ID,
        date: data.date,
        totalPnl: data.totalPnl,
        realizedPnl: data.realizedPnl,
        unrealizedPnl: data.unrealizedPnl,
        totalTrades: data.totalTrades,
        winningTrades: data.winningTrades,
        losingTrades: data.losingTrades,
        maxDrawdown: data.maxDrawdown,
        capitalDeployed: data.capitalDeployed,
      },
    });
  }

  /**
   * Append one row to the per-trade event log. Mirrors the watch-track
   * `createEvent` pattern. Callers MUST treat this as best-effort — an
   * event-log write must never block or fail a trade.
   */
  async createTradeEvent(input: CreateTradeEventInput): Promise<TradeEvent> {
    return this.prisma.tradeEvent.create({
      data: {
        tradeId: input.tradeId,
        eventType: input.eventType,
        price: input.price ?? null,
        quantity: input.quantity ?? null,
        pnl: input.pnl ?? null,
        notes: input.notes ?? null,
      },
    });
  }

  /** Per-trade event log, newest-first. */
  async getTradeEvents(tradeId: string): Promise<TradeEvent[]> {
    return this.prisma.tradeEvent.findMany({
      where: { tradeId },
      orderBy: { createdAt: 'desc' },
    });
  }

  /**
   * Find instrument by symbol+exchange, or by token.
   * Returns the instrumentId needed for trade creation.
   */
  async findInstrumentId(
    symbol: string,
    exchange: string,
    token: string,
  ): Promise<string | null> {
    const instrument = await this.prisma.instrument.findFirst({
      where: {
        OR: [
          { symbol, exchange },
          { token, exchange },
        ],
      },
      select: { id: true },
    });
    return instrument?.id ?? null;
  }
}
