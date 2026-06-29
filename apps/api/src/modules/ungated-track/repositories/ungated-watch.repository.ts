import { Injectable } from '@nestjs/common';
import { Prisma, UngatedWatchEntry, WatchEventType, WatchStatus } from '@prisma/client';
import { PrismaService } from '../../../common/prisma/prisma.service';

export interface UngatedCreateEntryInput {
  alertId: string | null;
  setupId: string | null;
  symbol: string;
  token: string;
  exchange: string;
  side: 'BUY' | 'SELL';
  initialPrice: number;
  initialScore: number;
  initialBreakdown: Prisma.InputJsonValue;
  profitTarget: number;
  // 'fallback-2pct' retained for historical rows; new entries use 'fallback-3pct'
  // since the 2026-06-27 pure 3%/-1.5% threshold change.
  profitTargetSource: 'indicator-sr' | 'fallback-2pct' | 'fallback-3pct';
  stopLossScore: number;
}

export interface UngatedCreateEventInput {
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
 * MIRROR OF apps/api/src/modules/watch-monitor/repositories/watch.repository.ts
 * Keep correctness changes in sync. See specs/2026-05-20-ungated-shadow-track-design.md.
 *
 * Differences vs gated counterpart:
 *  - No options-leg columns (equity-only experiment)
 *  - No `findScannerNames` / `findTradeRealization` — those live on
 *    ungated-trade.repository.ts + the controller does the join.
 */
@Injectable()
export class UngatedWatchRepository {
  constructor(private readonly prisma: PrismaService) {}

  async createEntry(input: UngatedCreateEntryInput): Promise<UngatedWatchEntry> {
    return this.prisma.ungatedWatchEntry.create({
      data: {
        alertId: input.alertId,
        setupId: input.setupId,
        symbol: input.symbol,
        token: input.token,
        exchange: input.exchange,
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

  async createEvent(input: UngatedCreateEventInput) {
    return this.prisma.ungatedWatchEvent.create({
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

  async findById(id: string): Promise<UngatedWatchEntry | null> {
    return this.prisma.ungatedWatchEntry.findUnique({ where: { id } });
  }

  async findByIdWithEvents(id: string) {
    return this.prisma.ungatedWatchEntry.findUnique({
      where: { id },
      include: { events: { orderBy: { createdAt: 'desc' }, take: 100 } },
    });
  }

  async findActiveByToken(token: string): Promise<UngatedWatchEntry[]> {
    return this.prisma.ungatedWatchEntry.findMany({
      where: { token, status: { notIn: CLOSED_STATES } },
    });
  }

  async findAllActive(): Promise<UngatedWatchEntry[]> {
    return this.prisma.ungatedWatchEntry.findMany({
      where: { status: { notIn: CLOSED_STATES } },
    });
  }

  async countActive(): Promise<number> {
    return this.prisma.ungatedWatchEntry.count({
      where: { status: { notIn: CLOSED_STATES } },
    });
  }

  async countOpenTrades(): Promise<number> {
    // "Open" = TRADED (executed and not yet exited).
    return this.prisma.ungatedWatchEntry.count({
      where: { status: WatchStatus.TRADED },
    });
  }

  async wasTokenExecutedSince(token: string, since: Date): Promise<boolean> {
    const n = await this.prisma.ungatedWatchEntry.count({
      where: { token, executedAt: { gte: since } },
    });
    return n > 0;
  }

  async list(opts: { status?: WatchStatus; date?: string }) {
    const where: Prisma.UngatedWatchEntryWhereInput = {};
    if (opts.status) where.status = opts.status;
    if (opts.date) {
      const start = new Date(`${opts.date}T00:00:00.000+05:30`);
      const end = new Date(`${opts.date}T23:59:59.999+05:30`);
      where.createdAt = { gte: start, lte: end };
    }
    return this.prisma.ungatedWatchEntry.findMany({
      where,
      orderBy: { createdAt: 'desc' },
    });
  }

  /**
   * Returns the realized P&L (₹) of the most recent closed trade for a token
   * within the given `since` window (defaults to all-time when omitted).
   * Returns null when no qualifying trade exists — first-time entry always allowed.
   * Mirrors WatchRepository.getLastClosedPnlForToken.
   */
  async getLastClosedPnlForToken(token: string, since?: Date): Promise<number | null> {
    const entry = await this.prisma.ungatedWatchEntry.findFirst({
      where: {
        token,
        status: { in: [WatchStatus.TARGET_HIT, WatchStatus.STOPPED, WatchStatus.EXITED] },
        closedAt: since ? { gte: since } : { not: null },
      },
      orderBy: { closedAt: 'desc' },
      select: { paperTradeId: true },
    });
    if (!entry?.paperTradeId) return null;
    const trade = await this.prisma.ungatedTrade.findUnique({
      where: { id: entry.paperTradeId },
      select: { pnl: true },
    });
    return trade?.pnl ?? null;
  }

  async update(id: string, data: Prisma.UngatedWatchEntryUpdateInput) {
    return this.prisma.ungatedWatchEntry.update({ where: { id }, data });
  }

  /**
   * Resolve alertId -> Chartink scanner name. Batched; deduped; null-safe.
   * Mirrors WatchRepository.findScannerNames — the ungated controller does the
   * scanner-name join itself (this repo has no relations to ChartinkAlert).
   */
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
