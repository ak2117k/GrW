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
   * The instruments row a new trade links to (its instrumentId).
   *
   * The exchange REUSES tokens after a contract expires: NFO 95394 was GODREJCP25AUG26940CE (expired
   * 2026-08-25) and is CDSL23NOV261260CE in November. The old `findFirst({OR: [{symbol}, {token}]})`
   * returned whichever row the planner met first, so a paper trade on CDSL was linked to the expired
   * GODREJCP row (prod 2026-11-03). Now (pickInstrumentRow): the exact tradingsymbol wins; a token-only
   * match is accepted only from a row that has not expired (newest expiry first). Null when only an
   * expired row shares the token — the caller upserts the right row (signal / engine paper) or refuses.
   */
  async findInstrumentId(
    symbol: string,
    exchange: string,
    token: string,
    now: Date = new Date(),
  ): Promise<string | null> {
    const rows = await this.prisma.instrument.findMany({
      where: { exchange, OR: [{ symbol }, { token }] },
      select: { id: true, symbol: true, token: true, expiry: true, updatedAt: true },
      take: 50,
    });
    return pickInstrumentRow(rows, symbol, token, now)?.id ?? null;
  }

  /**
   * Mark-to-market an OPEN trade's unrealised pnl, conditional on status OPEN in the same statement:
   * a mark computed from a quote read before a concurrent close (the AI sentinel's exit, a stop) must
   * never overwrite the realised pnl that close wrote — prod 2026-11-03 BSE23NOV263600CE closed at
   * 175.5 (gross −33.34) and was left at −363.34, the sweep's stale mark at LTP 173.85. False when the
   * trade was no longer OPEN.
   */
  async markOpenTrade(id: string, mark: { pnl: number; pnlPercent: number }): Promise<boolean> {
    const r = await this.prisma.trade.updateMany({
      where: { id, status: 'OPEN' },
      data: { pnl: mark.pnl, pnlPercent: mark.pnlPercent },
    });
    return r.count > 0;
  }
}

export interface InstrumentCandidate {
  id: string;
  symbol: string;
  token: string;
  expiry: Date | null;
  updatedAt?: Date | null;
}

const istDayOf = (d: Date) => new Date(d.getTime() + 5.5 * 3_600_000).toISOString().slice(0, 10);

/**
 * Pure: which of the rows sharing a symbol or a token (same exchange) a trade on `symbol` / `token`
 * links to.
 *  1. Same tradingsymbol AND token, else same tradingsymbol — newest expiry first.
 *  2. Token only (callers that pass the token as the symbol, an equity stored under another symbol
 *     spelling): only a row not expired on `now`'s IST day (no expiry = cash, always live), newest
 *     expiry first, then the most recently refreshed. A reused token's expired contract is never
 *     returned.
 */
export function pickInstrumentRow<T extends InstrumentCandidate>(rows: readonly T[], symbol: string, token: string, now: Date): T | null {
  const far = Number.MAX_SAFE_INTEGER;
  const newest = (a: T, b: T) =>
    (b.expiry?.getTime() ?? far) - (a.expiry?.getTime() ?? far) || (b.updatedAt?.getTime() ?? 0) - (a.updatedAt?.getTime() ?? 0);
  const bySymbol = rows.filter((r) => r.symbol === symbol);
  const exact = bySymbol.filter((r) => r.token === token).sort(newest);
  if (exact.length) return exact[0];
  if (bySymbol.length) return [...bySymbol].sort(newest)[0];
  const today = istDayOf(now);
  const live = rows.filter((r) => r.token === token && (r.expiry === null || istDayOf(r.expiry) >= today)).sort(newest);
  return live[0] ?? null;
}
