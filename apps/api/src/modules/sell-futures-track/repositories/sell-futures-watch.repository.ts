import { Injectable } from '@nestjs/common';
import { Prisma, SellFuturesWatchEntry, WatchEventType, WatchStatus } from '@prisma/client';
import { PrismaService } from '../../../common/prisma/prisma.service';

export interface SellFuturesCreateEntryInput {
  alertId: string | null;
  setupId: string | null;
  symbol: string;          // equity symbol
  token: string;           // resolved FUTURES NFO token
  exchange: string;        // 'NFO'
  eqToken: string | null;  // equity token (NSE)
  futTradingsymbol: string | null;
  futExpiry: Date | null;
  lotSize: number | null;
  side: 'BUY' | 'SELL';
  initialPrice: number;
  initialScore: number;
  initialBreakdown: Prisma.InputJsonValue;
  profitTarget: number;
  profitTargetSource: 'fallback-2pct';
  stopLossScore: number;
}

export interface SellFuturesCreateEventInput {
  watchEntryId: string;
  eventType: WatchEventType;
  price?: number | null;
  score?: number | null;
  breakdown?: Prisma.InputJsonValue | null;
  priceDelta?: number | null;
  scoreDelta?: number | null;
  notes?: string | null;
}

const CLOSED_STATES = [
  WatchStatus.STOPPED,
  WatchStatus.TARGET_HIT,
  WatchStatus.EXITED,
  WatchStatus.DISMISSED,
];

/**
 * MIRROR of ungated-watch.repository.ts for the SELL-futures track.
 * Differences: the entry also carries the resolved futures contract
 * (eqToken / futTradingsymbol / futExpiry / lotSize); `token`/`exchange`
 * are the FUTURES NFO token so dedup + quotes + exits key off the future.
 */
@Injectable()
export class SellFuturesWatchRepository {
  constructor(private readonly prisma: PrismaService) {}

  async createEntry(input: SellFuturesCreateEntryInput): Promise<SellFuturesWatchEntry> {
    return this.prisma.sellFuturesWatchEntry.create({
      data: {
        alertId: input.alertId,
        setupId: input.setupId,
        symbol: input.symbol,
        token: input.token,
        exchange: input.exchange,
        eqToken: input.eqToken,
        futTradingsymbol: input.futTradingsymbol,
        futExpiry: input.futExpiry,
        lotSize: input.lotSize,
        side: input.side,
        initialPrice: input.initialPrice,
        initialScore: input.initialScore,
        initialBreakdown: input.initialBreakdown,
        profitTarget: input.profitTarget,
        profitTargetSource: input.profitTargetSource,
        stopLossScore: input.stopLossScore,
      },
    });
  }

  async createEvent(input: SellFuturesCreateEventInput) {
    return this.prisma.sellFuturesWatchEvent.create({
      data: {
        watchEntryId: input.watchEntryId,
        eventType: input.eventType,
        price: input.price ?? null,
        score: input.score ?? null,
        breakdown: (input.breakdown ?? Prisma.JsonNull) as Prisma.InputJsonValue,
        priceDelta: input.priceDelta ?? null,
        scoreDelta: input.scoreDelta ?? null,
        notes: input.notes ?? null,
      },
    });
  }

  async findById(id: string): Promise<SellFuturesWatchEntry | null> {
    return this.prisma.sellFuturesWatchEntry.findUnique({ where: { id } });
  }

  async findByIdWithEvents(id: string) {
    return this.prisma.sellFuturesWatchEntry.findUnique({
      where: { id },
      include: { events: { orderBy: { createdAt: 'desc' }, take: 100 } },
    });
  }

  async findActiveByToken(token: string): Promise<SellFuturesWatchEntry[]> {
    return this.prisma.sellFuturesWatchEntry.findMany({
      where: { token, status: { notIn: CLOSED_STATES } },
    });
  }

  async findAllActive(): Promise<SellFuturesWatchEntry[]> {
    return this.prisma.sellFuturesWatchEntry.findMany({
      where: { status: { notIn: CLOSED_STATES } },
    });
  }

  async countActive(): Promise<number> {
    return this.prisma.sellFuturesWatchEntry.count({
      where: { status: { notIn: CLOSED_STATES } },
    });
  }

  async countOpenTrades(): Promise<number> {
    return this.prisma.sellFuturesWatchEntry.count({
      where: { status: WatchStatus.TRADED },
    });
  }

  async wasTokenExecutedSince(token: string, since: Date): Promise<boolean> {
    const n = await this.prisma.sellFuturesWatchEntry.count({
      where: { token, executedAt: { gte: since } },
    });
    return n > 0;
  }

  async list(opts: { status?: WatchStatus; date?: string }) {
    const where: Prisma.SellFuturesWatchEntryWhereInput = {};
    if (opts.status) where.status = opts.status;
    if (opts.date) {
      const start = new Date(`${opts.date}T00:00:00.000+05:30`);
      const end = new Date(`${opts.date}T23:59:59.999+05:30`);
      where.createdAt = { gte: start, lte: end };
    }
    return this.prisma.sellFuturesWatchEntry.findMany({
      where,
      orderBy: { createdAt: 'desc' },
    });
  }

  async update(id: string, data: Prisma.SellFuturesWatchEntryUpdateInput) {
    return this.prisma.sellFuturesWatchEntry.update({ where: { id }, data });
  }

  async findScannerNames(alertIds: Array<string | null>): Promise<Map<string, string>> {
    const ids = [...new Set(alertIds.filter((x): x is string => !!x))];
    if (ids.length === 0) return new Map();
    const alerts = await this.prisma.chartinkAlert.findMany({
      where: { id: { in: ids } },
      include: { scanner: true },
    });
    return new Map(alerts.map((a) => [a.id, a.scanner.scanName]));
  }
}
