import { Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import { PrismaService } from '../../common/prisma/prisma.service';
import {
  isStale,
  normaliseStockSymbol,
  STOCK_MOVE_HORIZON_DAYS,
  STOCK_MOVE_MAX_AGE_DAYS,
  STOCK_MOVE_THRESHOLD_ATR,
  toReading,
  type StockMoveReading,
  type StockMoveRow,
} from './stock-move.logic';

/** The book is re-read at most this often (the writer runs nightly; contract: refreshed ≤ 30 min). */
export const STOCK_MOVE_REFRESH_MS = 30 * 60_000;
/** Names in the night report's "top of the day" list. */
export const BIG_MOVE_TOP_N = 10;

/** The synchronous, DB-free read every hot path codes against. Never throws. */
export interface StockMoveReader {
  /** The latest (non-stale) reading for an NSE cash symbol, or null. */
  get(symbol: string): StockMoveReading | null;
}

/** DI token (`@Optional()`): absent ⇒ every consumer shows "no stock-move score yet". */
export const STOCK_MOVE_READER = Symbol('STOCK_MOVE_READER');
/** DI token for the night report's "Big-move watch" section. */
export const STOCK_MOVE_WATCH = Symbol('STOCK_MOVE_WATCH');

export interface BigMoveWatchRow {
  symbol: string;
  /** Why the name is listed: held, a news idea, and/or among the day's top TOP20 names. */
  sources: Array<'HELD' | 'NEWS_IDEA' | 'TOP'>;
  /** Null when the model has no score for the name (yet). */
  reading: StockMoveReading | null;
  /** The newest resolved row for the name: did its 5-session window move big? */
  lastOutcome: { asOf: string; big: boolean; retBp: number | null } | null;
}

export interface BigMoveWatchView {
  /** The scored book's IST date; null when there is no (fresh) book yet. */
  asOf: string | null;
  modelId: string | null;
  /** Names scored that day. */
  scored: number;
  rows: BigMoveWatchRow[];
}

export interface BigMoveWatchSource {
  watch(input: { held: readonly string[]; newsIdeas: readonly string[] }): Promise<BigMoveWatchView>;
}

export interface StockMoveSource {
  /** Every row of the newest book dated on/after `since` (5-session, 1.5 × ATR). */
  latestBook(since: Date): Promise<StockMoveRow[]>;
  /** The newest resolved row per symbol. */
  lastOutcomes(symbols: readonly string[]): Promise<Array<{ symbol: string; asOf: Date; outcomeBig: boolean | null; outcomeRetBp: number | null }>>;
}

const KEY = { horizonDays: STOCK_MOVE_HORIZON_DAYS, thresholdAtr: STOCK_MOVE_THRESHOLD_ATR };
const SELECT = {
  asOf: true, symbol: true, horizonDays: true, pBig: true, rankPct: true, bucket: true,
  resultsDate: true, resultsInWindow: true, modelId: true,
} as const;

export function prismaStockMoveSource(prisma: PrismaService): StockMoveSource {
  return {
    latestBook: async (since) => {
      const newest = await prisma.stockMoveScore.findFirst({
        where: { ...KEY, asOf: { gte: since } },
        orderBy: { asOf: 'desc' },
        select: { asOf: true },
      });
      if (!newest) return [];
      return prisma.stockMoveScore.findMany({ where: { ...KEY, asOf: newest.asOf }, select: SELECT, take: 1000 });
    },
    lastOutcomes: async (symbols) => {
      if (symbols.length === 0) return [];
      const rows = await prisma.stockMoveScore.findMany({
        where: { ...KEY, symbol: { in: [...symbols] }, outcomeBig: { not: null } },
        orderBy: { asOf: 'desc' },
        select: { symbol: true, asOf: true, outcomeBig: true, outcomeRetBp: true },
        take: symbols.length * 10,
      });
      const newest = new Map<string, (typeof rows)[number]>();
      for (const r of rows) if (!newest.has(r.symbol)) newest.set(r.symbol, r);
      return [...newest.values()];
    },
  };
}

/**
 * The stock big-move book, cached in memory. `get` is synchronous and never touches the DB: it
 * answers from the cache and kicks a single-flight background refresh when the cache is older than
 * {@link STOCK_MOVE_REFRESH_MS}. A failed refresh keeps the last good book (it carries its own
 * as-of, and a stale book is never served). The table is empty until the writer ships: every read
 * is then null and consumers say "no stock-move score yet".
 */
@Injectable()
export class StockMoveService implements StockMoveReader, BigMoveWatchSource, OnModuleInit {
  private readonly logger = new Logger(StockMoveService.name);
  private book = new Map<string, StockMoveReading>();
  private bookAsOf: string | null = null;
  private loadedAt = Number.NEGATIVE_INFINITY;
  private inflight: Promise<void> | null = null;

  constructor(
    private readonly source: StockMoveSource,
    private readonly now: () => number = () => Date.now(),
  ) {}

  static fromPrisma(prisma: PrismaService): StockMoveService {
    return new StockMoveService(prismaStockMoveSource(prisma));
  }

  async onModuleInit(): Promise<void> {
    // refresh() never throws: a missing or empty table cannot fail the boot.
    await this.refresh();
  }

  get(symbol: string): StockMoveReading | null {
    if (this.now() - this.loadedAt >= STOCK_MOVE_REFRESH_MS) void this.refresh();
    if (!this.bookAsOf || isStale(this.bookAsOf, new Date(this.now()))) return null;
    return this.book.get(normaliseStockSymbol(symbol)) ?? null;
  }

  /** The cached book, best first (for the night report). */
  rows(): StockMoveReading[] {
    if (!this.bookAsOf || isStale(this.bookAsOf, new Date(this.now()))) return [];
    return [...this.book.values()].sort((a, b) => b.rankPct - a.rankPct);
  }

  /** Re-read now. Never throws. */
  refresh(): Promise<void> {
    if (this.inflight) return this.inflight;
    this.inflight = (async () => {
      try {
        const since = new Date(this.now() - (STOCK_MOVE_MAX_AGE_DAYS + 1) * 86_400_000);
        const rows = (await this.source.latestBook(since)).map(toReading);
        const next = new Map<string, StockMoveReading>();
        for (const r of rows) if (Number.isFinite(r.pBig)) next.set(r.symbol, r);
        this.book = next;
        this.bookAsOf = rows[0]?.asOf ?? null;
      } catch (e) {
        this.logger.warn(`[stock-move] book read failed — keeping the last good book: ${e instanceof Error ? e.message : String(e)}`);
      } finally {
        this.loadedAt = this.now();
        this.inflight = null;
      }
    })();
    return this.inflight;
  }

  /** Night report: held + news-idea stocks, then the day's top TOP20 names. Fresh read (not the hot path). */
  async watch(input: { held: readonly string[]; newsIdeas: readonly string[] }): Promise<BigMoveWatchView> {
    await this.refresh();
    const book = this.rows();
    const bySymbol = new Map(book.map((r) => [r.symbol, r]));
    const order: string[] = [];
    const sources = new Map<string, Set<BigMoveWatchRow['sources'][number]>>();
    const add = (sym: string, src: BigMoveWatchRow['sources'][number]) => {
      const s = normaliseStockSymbol(sym);
      if (!s) return;
      if (!sources.has(s)) {
        sources.set(s, new Set());
        order.push(s);
      }
      sources.get(s)!.add(src);
    };
    for (const s of input.held) add(s, 'HELD');
    for (const s of input.newsIdeas) add(s, 'NEWS_IDEA');
    for (const r of book.filter((x) => x.bucket === 'TOP20').slice(0, BIG_MOVE_TOP_N)) add(r.symbol, 'TOP');

    const outcomes = new Map<string, BigMoveWatchRow['lastOutcome']>();
    try {
      for (const o of await this.source.lastOutcomes(order)) {
        if (o.outcomeBig === null) continue;
        outcomes.set(normaliseStockSymbol(o.symbol), { asOf: o.asOf.toISOString().slice(0, 10), big: o.outcomeBig, retBp: o.outcomeRetBp });
      }
    } catch (e) {
      this.logger.warn(`[stock-move] last-outcome read failed: ${e instanceof Error ? e.message : String(e)}`);
    }
    return {
      asOf: book[0]?.asOf ?? null,
      modelId: book[0]?.modelId ?? null,
      scored: book.length,
      rows: order.map((symbol) => ({
        symbol,
        sources: [...(sources.get(symbol) ?? [])],
        reading: bySymbol.get(symbol) ?? null,
        lastOutcome: outcomes.get(symbol) ?? null,
      })),
    };
  }
}
