import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../../common/prisma/prisma.service';
import { realizedIntradayPnlPct } from '../intraday-pnl';

const NOTIONAL = 200_000;
// swing track's notional capital base (₹20,00,000), adjustable
const SWING_BASE_CAPITAL = 2_000_000;

export interface CreateEntryInput {
  symbol: string;
  token: string | null;
  entryPrice: number;
  alertId: string;
  scoreBreakdown: unknown;
}

export interface UpdateStatusInput {
  status: string;
  exitPrice?: number;
  exitedAt?: Date;
  exitReason?: string;
}

export interface ListEntriesFilter {
  status?: string;
  from?: Date;
  to?: Date;
}

export interface PnlSummaryPeriod {
  avgExitPct: number;
  count: number;
  winCount: number;
  totalPnlRs: number;
}

export interface PnlSummary {
  daily: PnlSummaryPeriod;
  weekly: PnlSummaryPeriod;
  monthly: PnlSummaryPeriod;
  yearly: PnlSummaryPeriod;
}

@Injectable()
export class AnandDualTrackRepository {
  constructor(private readonly prisma: PrismaService) {}

  async createIntradayEntry(input: CreateEntryInput): Promise<{ id: string }> {
    return this.prisma.intradayEntry.create({
      data: {
        symbol: input.symbol,
        token: input.token,
        entryPrice: input.entryPrice,
        alertId: input.alertId,
        targetPct: 5,
        stopPct: 5,
        scoreBreakdown:
          input.scoreBreakdown == null
            ? Prisma.JsonNull
            : (input.scoreBreakdown as Prisma.InputJsonValue),
      },
      select: { id: true },
    });
  }

  async createSwingEntry(input: CreateEntryInput): Promise<{ id: string }> {
    return this.prisma.swingEntry.create({
      data: {
        symbol: input.symbol,
        token: input.token,
        entryPrice: input.entryPrice,
        alertId: input.alertId,
        targetPct: 10,
        stopPct: 10,
        scoreBreakdown:
          input.scoreBreakdown == null
            ? Prisma.JsonNull
            : (input.scoreBreakdown as Prisma.InputJsonValue),
      },
      select: { id: true },
    });
  }

  async listWatchingIntraday() {
    return this.prisma.intradayEntry.findMany({
      where: { status: 'TRADED' },
      orderBy: { enteredAt: 'desc' },
    });
  }

  async listWatchingSwing() {
    return this.prisma.swingEntry.findMany({
      where: { status: 'TRADED' },
      orderBy: { enteredAt: 'desc' },
    });
  }

  async listIntradayEntries(filter: ListEntriesFilter = {}) {
    return this.prisma.intradayEntry.findMany({
      where: {
        // Intraday positions close same-day (EXPIRED/STOPPED/TARGET_HIT), so
        // there is NO persistent open ('TRADED') list across days — the page
        // shows all of today's trades, date-scoped, regardless of status.
        // (Unlike swing, which holds multi-day, so its open list IS TRADED-only.)
        ...(filter.status ? { status: filter.status } : {}),
        ...(filter.from || filter.to
          ? {
              enteredAt: {
                ...(filter.from ? { gte: filter.from } : {}),
                ...(filter.to ? { lte: filter.to } : {}),
              },
            }
          : {}),
      },
      orderBy: { enteredAt: 'desc' },
      take: 200,
    });
  }

  async listSwingEntries(filter: ListEntriesFilter = {}) {
    return this.prisma.swingEntry.findMany({
      where: {
        // No explicit status → show ONLY currently-open positions. Without this
        // default the list returned every terminal row (STOPPED/TARGET_HIT/…)
        // filtered by ENTRY date, polluting the "open" list with closed trades.
        status: filter.status ? filter.status : 'TRADED',
        ...(filter.from || filter.to
          ? {
              enteredAt: {
                ...(filter.from ? { gte: filter.from } : {}),
                ...(filter.to ? { lte: filter.to } : {}),
              },
            }
          : {}),
      },
      orderBy: { enteredAt: 'desc' },
      take: 200,
    });
  }

  /**
   * Exited ("closed") swing rows, filtered by EXIT date — the complement of
   * `listSwingEntries`, which filters by ENTRY date and therefore hides
   * multi-day positions entered earlier but cut/closed recently. A row counts
   * as exited when it has a terminal status (not 'TRADED') and a non-null
   * `exitedAt`. Mirrors `listSwingEntries`' date-window guard, but on `exitedAt`.
   */
  async listSwingExits(filter: { from?: Date; to?: Date; status?: string } = {}) {
    return this.prisma.swingEntry.findMany({
      where: {
        status: filter.status ? filter.status : { not: 'TRADED' },
        exitedAt: {
          not: null,
          ...(filter.from ? { gte: filter.from } : {}),
          ...(filter.to ? { lte: filter.to } : {}),
        },
      },
      orderBy: { exitedAt: 'desc' },
      take: 200,
    });
  }

  /**
   * DERIVED swing capital summary — computed live from `SwingEntry`, never from
   * the (buggy) `ReinvestmentPool` ledger. Models a recycling capital base: each
   * exit returns its engaged capital ± realized P&L. `available` = base capital
   * minus capital tied up in open positions, plus all realized P&L to date.
   *
   * Quantity uses the same `floor(NOTIONAL / entryPrice)` lot formula for both
   * invested and realized so the two are internally consistent.
   */
  async getSwingCapital(): Promise<{
    baseCapital: number;
    investedOpen: number;
    realizedPnl: number;
    available: number;
    openCount: number;
  }> {
    const open = await this.prisma.swingEntry.findMany({ where: { status: 'TRADED' } });
    let investedOpen = 0;
    for (const e of open) {
      const qty = e.entryPrice > 0 ? Math.floor(NOTIONAL / e.entryPrice) : 0;
      investedOpen += qty * e.entryPrice;
    }

    const exited = await this.prisma.swingEntry.findMany({
      where: { status: { not: 'TRADED' }, exitPrice: { not: null } },
    });
    let realizedPnl = 0;
    for (const e of exited) {
      const qty = Math.floor(NOTIONAL / e.entryPrice);
      realizedPnl += (e.exitPrice! - e.entryPrice) * qty;
    }

    const baseCapital = SWING_BASE_CAPITAL;
    const available = baseCapital - investedOpen + realizedPnl;
    return { baseCapital, investedOpen, realizedPnl, available, openCount: open.length };
  }

  async updateIntradayStatus(id: string, data: UpdateStatusInput): Promise<void> {
    await this.prisma.intradayEntry.update({ where: { id }, data });
  }

  async updateSwingStatus(id: string, data: UpdateStatusInput): Promise<void> {
    await this.prisma.swingEntry.update({ where: { id }, data });
  }

  async setIntradayTrailing(id: string, data: { trailing: boolean; peakPrice: number }): Promise<void> {
    await this.prisma.intradayEntry.update({ where: { id }, data });
  }

  async recordIntradayPartial(
    id: string,
    data: { partialExitPrice: number; partialFraction: number; partialBookedAt: Date; stopMovedToBE: boolean },
  ): Promise<void> {
    await this.prisma.intradayEntry.update({ where: { id }, data });
  }

  async findActiveTradedBySymbol(
    track: 'intraday' | 'swing',
    symbol: string,
  ): Promise<{ id: string } | null> {
    const model = track === 'intraday' ? this.prisma.intradayEntry : this.prisma.swingEntry;
    return (model as any).findFirst({
      where: { symbol, status: 'TRADED' },
      select: { id: true },
    });
  }

  /** IST midnight of the current day, returned as a UTC Date. */
  private istMidnightTodayUtc(): Date {
    const now = new Date();
    const istNow = new Date(now.getTime() + 5.5 * 60 * 60 * 1000);
    istNow.setUTCHours(0, 0, 0, 0);
    return new Date(istNow.getTime() - 5.5 * 60 * 60 * 1000);
  }

  /** True if the symbol already hit its target today (IST) on the given track. */
  async hasTargetHitTodayBySymbol(
    track: 'intraday' | 'swing',
    symbol: string,
  ): Promise<boolean> {
    const model = track === 'intraday' ? this.prisma.intradayEntry : this.prisma.swingEntry;
    const hit = await (model as any).findFirst({
      where: { symbol, status: 'TARGET_HIT', exitedAt: { gte: this.istMidnightTodayUtc() } },
      select: { id: true },
    });
    return hit != null;
  }

  /**
   * True if the symbol had a LOSING exit today (IST) on the given track — a
   * closed entry whose exitPrice is below its entryPrice. Used to block same-day
   * re-entry after a loss. Prisma can't compare two columns in a `where`, so we
   * fetch today's closed exits for the symbol and test exitPrice < entryPrice.
   */
  async hasLossTodayBySymbol(
    track: 'intraday' | 'swing',
    symbol: string,
  ): Promise<boolean> {
    const model = track === 'intraday' ? this.prisma.intradayEntry : this.prisma.swingEntry;
    const rows = await (model as any).findMany({
      where: { symbol, exitedAt: { gte: this.istMidnightTodayUtc() }, exitPrice: { not: null } },
      select: { entryPrice: true, exitPrice: true },
    });
    return rows.some(
      (r: { entryPrice: number; exitPrice: number | null }) => r.exitPrice != null && r.exitPrice < r.entryPrice,
    );
  }

  /**
   * Record one "lead" occurrence for a symbol+track. Called on EVERY scanner
   * fire — even when no new entry is created.
   *
   * `count` is the AUTHORITATIVE lead frequency: it is incremented atomically
   * (`{ increment: 1 }`) and is always correct under concurrent fires.
   *
   * `dates` is a BEST-EFFORT day log built via read-modify-write, so under
   * concurrent same-symbol fires it may rarely drop a timestamp (last writer
   * wins on the array). Do not treat `dates.length` as the lead count — use
   * `count` for that.
   */
  async bumpLeadStat(track: 'swing' | 'intraday', symbol: string): Promise<void> {
    const nowIso = new Date().toISOString();
    const existing = await this.prisma.symbolLeadStat.findFirst({
      where: { symbol, track },
      select: { dates: true },
    });
    const dates = Array.isArray(existing?.dates) ? (existing!.dates as string[]) : [];
    await this.prisma.symbolLeadStat.upsert({
      where: { symbol_track: { symbol, track } },
      create: { symbol, track, count: 1, dates: [nowIso], lastLedAt: new Date() },
      update: { count: { increment: 1 }, dates: [...dates, nowIso], lastLedAt: new Date() },
    });
  }

  /** Map symbol → { count, dates } for the given symbols on a track. */
  async getLeadStats(
    track: 'swing' | 'intraday',
    symbols: string[],
  ): Promise<Map<string, { count: number; dates: string[] }>> {
    const out = new Map<string, { count: number; dates: string[] }>();
    if (symbols.length === 0) return out;
    const rows = await this.prisma.symbolLeadStat.findMany({
      where: { track, symbol: { in: [...new Set(symbols)] } },
      select: { symbol: true, count: true, dates: true },
    });
    for (const r of rows) {
      out.set(r.symbol, { count: r.count, dates: Array.isArray(r.dates) ? (r.dates as string[]) : [] });
    }
    return out;
  }

  // ── Reinvestment (Feature 4) ─────────────────────────────────────────────
  async createReinvestmentLot(input: {
    symbol: string;
    sourceSwingEntryId: string;
    capital: number;
    entryPrice: number;
  }): Promise<{ id: string } | null> {
    // sourceSwingEntryId is @unique — a duplicate create (re-poll) throws P2002;
    // swallow it so the lot is created at most once per swing target hit.
    try {
      return await this.prisma.reinvestmentLot.create({
        data: { ...input, targetPct: 10, stopPct: 10, status: 'OPEN' },
        select: { id: true },
      });
    } catch (err: any) {
      if (err?.code === 'P2002') return null;
      throw err;
    }
  }

  async listOpenReinvestmentLots() {
    return this.prisma.reinvestmentLot.findMany({ where: { status: 'OPEN' }, orderBy: { enteredAt: 'desc' } });
  }

  async listReinvestmentLots(status?: string) {
    return this.prisma.reinvestmentLot.findMany({
      where: status ? { status } : {},
      orderBy: { enteredAt: 'desc' },
      take: 200,
    });
  }

  /**
   * Guarded close: transitions the lot to a terminal status ONLY if it is still
   * OPEN. Uses `updateMany` with a status guard so two overlapping poll runs
   * cannot both close the same lot — exactly one wins. Returns whether THIS call
   * performed the transition, so the caller knows whether to apply the pool delta.
   */
  async closeReinvestmentLot(
    id: string,
    data: { status: string; exitPrice: number; exitedAt: Date; exitReason: string },
  ): Promise<{ transitioned: boolean }> {
    const res = await this.prisma.reinvestmentLot.updateMany({
      where: { id, status: 'OPEN' },
      data,
    });
    return { transitioned: res.count === 1 };
  }

  async getPool() {
    return this.prisma.reinvestmentPool.upsert({
      where: { id: 'singleton' },
      create: { id: 'singleton' },
      update: {},
    });
  }

  async applyPoolDelta(delta: {
    harvestedTotal?: number;
    deployedActive?: number;
    idleBalance?: number;
    realizedPnl?: number;
  }): Promise<void> {
    await this.prisma.reinvestmentPool.upsert({
      where: { id: 'singleton' },
      create: {
        id: 'singleton',
        harvestedTotal: delta.harvestedTotal ?? 0,
        deployedActive: delta.deployedActive ?? 0,
        idleBalance: delta.idleBalance ?? 0,
        realizedPnl: delta.realizedPnl ?? 0,
      },
      update: {
        harvestedTotal: { increment: delta.harvestedTotal ?? 0 },
        deployedActive: { increment: delta.deployedActive ?? 0 },
        idleBalance: { increment: delta.idleBalance ?? 0 },
        realizedPnl: { increment: delta.realizedPnl ?? 0 },
      },
    });
  }

  /** Resolve symbol → instrument token using the most recent swing entry token. */
  async resolveTokens(symbols: string[]): Promise<Map<string, string>> {
    const out = new Map<string, string>();
    if (symbols.length === 0) return out;
    const rows = await this.prisma.swingEntry.findMany({
      where: { symbol: { in: [...new Set(symbols)] }, token: { not: null } },
      select: { symbol: true, token: true },
      orderBy: { enteredAt: 'desc' },
    });
    for (const r of rows) {
      if (r.token && !out.has(r.symbol)) out.set(r.symbol, r.token);
    }
    return out;
  }

  async findScannerNamesByAlertIds(alertIds: string[]): Promise<Map<string, string>> {
    if (alertIds.length === 0) return new Map();
    const rows = await this.prisma.chartinkAlert.findMany({
      where: { id: { in: alertIds } },
      select: { id: true, scanner: { select: { scanName: true } } },
    });
    const map = new Map<string, string>();
    for (const row of rows) {
      if (row.scanner) map.set(row.id, row.scanner.scanName);
    }
    return map;
  }

  // ── Swing Daily OHLC ─────────────────────────────────────────────────────
  /** Fetch a single swing entry (or null) — used by the OHLC backfill + API. */
  async findSwingEntryById(id: string) {
    return this.prisma.swingEntry.findUnique({ where: { id } });
  }

  /**
   * Every swing entry (no date window) — the OHLC worker needs the full set so
   * it can keep recording up to 60 post-exit days for already-closed trades.
   */
  async listAllSwingEntries() {
    return this.prisma.swingEntry.findMany({
      select: { id: true, token: true, symbol: true, enteredAt: true, exitedAt: true, status: true },
      orderBy: { enteredAt: 'desc' },
    });
  }

  /** Idempotent upsert of one day's candle for a swing entry (unique [swingEntryId, date]). */
  async upsertSwingDailyOhlc(
    swingEntryId: string,
    date: Date,
    o: { open: number; high: number; low: number; close: number },
    phase: string,
  ): Promise<void> {
    await this.prisma.swingDailyOhlc.upsert({
      where: { swingEntryId_date: { swingEntryId, date } },
      create: { swingEntryId, date, ...o, phase },
      update: { ...o, phase },
    });
  }

  /** All recorded daily-OHLC rows for an entry, oldest → newest. */
  async listSwingDailyOhlc(swingEntryId: string) {
    return this.prisma.swingDailyOhlc.findMany({
      where: { swingEntryId },
      orderBy: { date: 'asc' },
    });
  }

  /** Most-recent recorded OHLC date for an entry, or null if none recorded yet. */
  async latestSwingOhlcDate(swingEntryId: string): Promise<Date | null> {
    const row = await this.prisma.swingDailyOhlc.findFirst({
      where: { swingEntryId },
      orderBy: { date: 'desc' },
      select: { date: true },
    });
    return row?.date ?? null;
  }

  /** Count of POST_EXIT rows recorded for an entry (drives the 60-day stop). */
  async countSwingPostExitRows(swingEntryId: string): Promise<number> {
    return this.prisma.swingDailyOhlc.count({
      where: { swingEntryId, phase: 'POST_EXIT' },
    });
  }

  async getPnlSummary(track: 'intraday' | 'swing'): Promise<PnlSummary> {
    // IST midnight N days ago. IST = UTC+05:30; this matches the pattern in
    // UngatedRejectionRepository which pins the offset rather than using the
    // process-local timezone (the server runs UTC in production).
    const istMidnightDaysAgo = (days: number): Date => {
      const now = new Date();
      const istNow = new Date(now.getTime() + 5.5 * 60 * 60 * 1000);
      istNow.setUTCHours(0, 0, 0, 0);
      istNow.setUTCDate(istNow.getUTCDate() - days);
      return new Date(istNow.getTime() - 5.5 * 60 * 60 * 1000);
    };

    // Fetch only the last year at the DB level — avoids loading the full
    // history into memory on mature datasets.
    const yearStart = istMidnightDaysAgo(365);
    const exitStatuses =
      track === 'intraday'
        ? ['TARGET_HIT', 'STOPPED', 'EXPIRED']
        : ['TARGET_HIT', 'STOPPED'];

    // Intraday rows additionally carry the partial-booking legs so realized P&L
    // can be blended across the booked partial + the final-exit leg. Swing rows
    // have no partial fields (and never partially book), so they keep the plain
    // (exitPrice - entryPrice) calculation.
    const exits = await (track === 'intraday'
      ? this.prisma.intradayEntry.findMany({
          where: { status: { in: exitStatuses }, exitedAt: { gte: yearStart }, exitPrice: { not: null } },
          select: {
            exitedAt: true,
            entryPrice: true,
            exitPrice: true,
            partialExitPrice: true,
            partialFraction: true,
          },
        })
      : this.prisma.swingEntry.findMany({
          where: { status: { in: exitStatuses }, exitedAt: { gte: yearStart }, exitPrice: { not: null } },
          select: { exitedAt: true, entryPrice: true, exitPrice: true },
        }));

    const compute = (rows: typeof exits): PnlSummaryPeriod => {
      if (rows.length === 0) return { avgExitPct: 0, count: 0, winCount: 0, totalPnlRs: 0 };
      let sum = 0;
      let wins = 0;
      let totalPnlRs = 0;
      for (const r of rows) {
        const blended = realizedIntradayPnlPct({
          entryPrice: r.entryPrice,
          exitPrice: r.exitPrice,
          partialExitPrice: (r as { partialExitPrice?: number | null }).partialExitPrice ?? null,
          partialFraction: (r as { partialFraction?: number | null }).partialFraction ?? null,
        });
        const pct = blended ?? ((r.exitPrice! - r.entryPrice) / r.entryPrice) * 100;
        sum += pct;
        if (pct > 0) wins++;
        totalPnlRs += (pct / 100) * NOTIONAL;
      }
      return { avgExitPct: sum / rows.length, count: rows.length, winCount: wins, totalPnlRs };
    };

    return {
      daily: compute(exits.filter(r => r.exitedAt! >= istMidnightDaysAgo(0))),
      weekly: compute(exits.filter(r => r.exitedAt! >= istMidnightDaysAgo(7))),
      monthly: compute(exits.filter(r => r.exitedAt! >= istMidnightDaysAgo(30))),
      yearly: compute(exits),
    };
  }
}
