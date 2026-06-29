import { Injectable } from '@nestjs/common';
import { Prisma, WatchEntry, WatchEvent, WatchEventType, WatchStatus } from '@prisma/client';
import { PrismaService } from '../../../common/prisma/prisma.service';

export interface CreateEntryInput {
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
  profitTargetSource: 'indicator-sr' | 'fallback-2pct';
  stopLossScore: number;
  recoveryReEntry?: boolean;
  optionsToken?: string | null;
  optionsType?: 'CE' | 'PE' | null;
  optionsExpiry?: Date | null;
  optionsStrike?: number | null;
  optionsLotSize?: number | null;
  optionsSelectionScore?: number | null;
}

export interface CreateEventInput {
  watchEntryId: string;
  eventType: WatchEventType;
  price?: number | null;
  score?: number | null;
  breakdown?: Prisma.InputJsonValue | null;
  priceDelta?: number | null;
  scoreDelta?: number | null;
  notes?: string | null;
}

/**
 * Convert an IST calendar day (YYYY-MM-DD) to its UTC instant range.
 * IST = UTC+5:30, so IST 00:00 is 18:30 UTC on the previous day.
 */
export function istDayRange(date: string): { start: Date; end: Date } {
  return {
    start: new Date(`${date}T00:00:00.000+05:30`),
    end: new Date(`${date}T23:59:59.999+05:30`),
  };
}

@Injectable()
export class WatchRepository {
  constructor(private readonly prisma: PrismaService) {}

  async createEntry(input: CreateEntryInput): Promise<WatchEntry> {
    return this.prisma.watchEntry.create({
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
        recoveryReEntry: input.recoveryReEntry ?? false,
        optionsToken: input.optionsToken ?? null,
        optionsType: input.optionsType ?? null,
        optionsExpiry: input.optionsExpiry ?? null,
        optionsStrike: input.optionsStrike ?? null,
        optionsLotSize: input.optionsLotSize ?? null,
        optionsSelectionScore: input.optionsSelectionScore ?? null,
      },
    });
  }

  async createEvent(input: CreateEventInput): Promise<WatchEvent> {
    return this.prisma.watchEvent.create({
      data: {
        watchEntryId: input.watchEntryId,
        eventType: input.eventType,
        price: input.price ?? null,
        score: input.score ?? null,
        breakdown: input.breakdown == null ? Prisma.JsonNull : input.breakdown,
        priceDelta: input.priceDelta ?? null,
        scoreDelta: input.scoreDelta ?? null,
        notes: input.notes ?? null,
      },
    });
  }

  async findById(id: string): Promise<WatchEntry | null> {
    return this.prisma.watchEntry.findUnique({ where: { id } });
  }

  async findByIdWithEvents(id: string) {
    return this.prisma.watchEntry.findUnique({
      where: { id },
      include: { events: { orderBy: { createdAt: 'desc' }, take: 100 } },
    });
  }

  async findActiveBySetupId(setupId: string): Promise<WatchEntry | null> {
    return this.prisma.watchEntry.findFirst({
      where: { setupId, status: { in: [WatchStatus.WATCHING, WatchStatus.TRADED] } },
    });
  }

  async findAllActive(): Promise<WatchEntry[]> {
    return this.prisma.watchEntry.findMany({
      where: { status: { in: [WatchStatus.WATCHING, WatchStatus.TRADED] } },
      orderBy: { createdAt: 'desc' },
    });
  }

  async list(opts: {
    status?: WatchStatus;
    date?: string;
    limit?: number;
  }): Promise<WatchEntry[]> {
    const where: Prisma.WatchEntryWhereInput = {};
    if (opts.status) where.status = opts.status;
    if (opts.date) {
      const { start, end } = istDayRange(opts.date);
      where.createdAt = { gte: start, lte: end };
    }
    return this.prisma.watchEntry.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      take: opts.limit ?? (opts.date ? 200 : 50),
    });
  }

  async findActiveByToken(token: string): Promise<WatchEntry[]> {
    return this.prisma.watchEntry.findMany({
      where: {
        status: { in: [WatchStatus.WATCHING, WatchStatus.TRADED] },
        OR: [{ token }, { optionsToken: token }],
      },
    });
  }

  async countActive(): Promise<number> {
    return this.prisma.watchEntry.count({
      where: { status: { in: [WatchStatus.WATCHING, WatchStatus.TRADED] } },
    });
  }

  /**
   * True if any watch entry for this token was EXECUTED at or after `since`.
   * Backs the 45-minute re-entry cooldown (R2).
   *
   * Deliberately does NOT filter on `status`: a closed trade's entry moves
   * to a terminal status (TARGET_HIT / STOPPED / EXITED) while `executedAt`
   * is retained, and the cooldown MUST catch those closed trades. Filtering
   * by status=TRADED would silently limit the cooldown to still-open trades.
   * (WATCHING / DISMISSED entries never have `executedAt` set, so they
   * cannot false-positive.)
   */
  async wasTokenExecutedSince(token: string, since: Date): Promise<boolean> {
    const count = await this.prisma.watchEntry.count({
      where: { token, executedAt: { gte: since } },
    });
    return count > 0;
  }

  /**
   * All TRADED entries that were executed today (IST date). Used by
   * RiskGuardService to compute the running daily P&L.
   */
  async findTradedToday(): Promise<WatchEntry[]> {
    // Compute today's IST midnight as a UTC instant.
    const now = new Date();
    const istOffsetMs = 5.5 * 60 * 60 * 1000;
    const istNow = new Date(now.getTime() + istOffsetMs);
    const istMidnight = new Date(
      Date.UTC(istNow.getUTCFullYear(), istNow.getUTCMonth(), istNow.getUTCDate()),
    );
    // The boundary in UTC is IST midnight - 5h30m
    const utcStart = new Date(istMidnight.getTime() - istOffsetMs);
    return this.prisma.watchEntry.findMany({
      where: {
        status: WatchStatus.TRADED,
        executedAt: { gte: utcStart },
      },
    });
  }

  /**
   * All entries that are currently WATCHING or TRADED. Used by square-off
   * to find everything that needs to be closed.
   */
  async findAllActiveOrTraded(): Promise<WatchEntry[]> {
    return this.prisma.watchEntry.findMany({
      where: { status: { in: [WatchStatus.WATCHING, WatchStatus.TRADED] } },
      orderBy: { createdAt: 'desc' },
    });
  }

  /**
   * Returns the realized P&L (₹) of the most recent EXECUTED-and-CLOSED trade
   * for a token within the given `since` window (defaults to all-time when
   * omitted), or null when no qualifying trade exists (first-time entry always
   * allowed). Used by the green-only re-entry gate in WatchService.
   *
   * Only terminal statuses with a known trade are considered:
   * TARGET_HIT / STOPPED / EXITED. DISMISSED entries never have a linked
   * trade (no executedAt) and are excluded.
   */
  async getLastClosedPnlForToken(token: string, since?: Date): Promise<number | null> {
    const entry = await this.prisma.watchEntry.findFirst({
      where: {
        token,
        status: { in: [WatchStatus.TARGET_HIT, WatchStatus.STOPPED, WatchStatus.EXITED] },
        closedAt: since ? { gte: since } : { not: null },
      },
      orderBy: { closedAt: 'desc' },
      select: { paperTradeId: true, liveTradeId: true },
    });
    if (!entry) return null;
    const tradeId = entry.paperTradeId ?? entry.liveTradeId;
    if (!tradeId) return null;
    const trade = await this.prisma.trade.findUnique({
      where: { id: tradeId },
      select: { pnl: true },
    });
    return trade?.pnl ?? null;
  }

  /**
   * Like getLastClosedPnlForToken, but also returns the entry (executed) price
   * of that last closed trade — the loss-recovery re-entry gate needs it to
   * check the symbol has reclaimed the level it broke. entryPrice falls back to
   * the entry's initialPrice if executedPrice is unexpectedly absent.
   */
  async getLastClosedTradeForToken(
    token: string,
    since?: Date,
  ): Promise<{ pnl: number; entryPrice: number } | null> {
    const entry = await this.prisma.watchEntry.findFirst({
      where: {
        token,
        status: { in: [WatchStatus.TARGET_HIT, WatchStatus.STOPPED, WatchStatus.EXITED] },
        closedAt: since ? { gte: since } : { not: null },
      },
      orderBy: { closedAt: 'desc' },
      select: { paperTradeId: true, liveTradeId: true, executedPrice: true, initialPrice: true },
    });
    if (!entry) return null;
    const tradeId = entry.paperTradeId ?? entry.liveTradeId;
    if (!tradeId) return null;
    const trade = await this.prisma.trade.findUnique({ where: { id: tradeId }, select: { pnl: true } });
    if (trade?.pnl == null) return null;
    return { pnl: trade.pnl, entryPrice: entry.executedPrice ?? entry.initialPrice };
  }

  /**
   * Count loss-recovery re-entries already admitted for a token within the
   * window (today). Backs the once-per-day recovery cap.
   */
  async countRecoveryReentriesToday(token: string, since: Date): Promise<number> {
    return this.prisma.watchEntry.count({
      where: { token, recoveryReEntry: true, initialAt: { gte: since } },
    });
  }

  async update(id: string, data: Prisma.WatchEntryUpdateInput): Promise<WatchEntry> {
    return this.prisma.watchEntry.update({ where: { id }, data });
  }

  /** Resolve alertId -> Chartink scanner name. Batched; deduped. */
  async findScannerNames(alertIds: string[]): Promise<Map<string, string>> {
    const ids = [...new Set(alertIds.filter((x): x is string => !!x))];
    if (ids.length === 0) return new Map();
    const alerts = await this.prisma.chartinkAlert.findMany({
      where: { id: { in: ids } },
      include: { scanner: true },
    });
    return new Map(alerts.map((a) => [a.id, a.scanner.scanName]));
  }

  /**
   * Resolve tradeId -> { pnl, fees }. Batched; rows with null pnl are
   * omitted (trade hasn't been priced out yet). Null `fees` is coerced
   * to 0 so the watch summary footer can sum them without NaN.
   */
  async findTradeRealization(
    tradeIds: string[],
  ): Promise<Map<string, { pnl: number; fees: number }>> {
    const ids = [...new Set(tradeIds.filter((x): x is string => !!x))];
    if (ids.length === 0) return new Map();
    const trades = await this.prisma.trade.findMany({
      where: { id: { in: ids } },
      select: { id: true, pnl: true, fees: true },
    });
    return new Map(
      trades
        .filter((t) => t.pnl != null)
        .map((t) => [t.id, { pnl: t.pnl as number, fees: t.fees ?? 0 }]),
    );
  }
}
