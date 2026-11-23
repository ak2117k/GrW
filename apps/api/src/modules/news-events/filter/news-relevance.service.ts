import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../../common/prisma/prisma.service';
import {
  classifyNews,
  filterColumns,
  NSE_ANNOUNCEMENTS_SOURCE,
  parseNewsFilterMode,
  trackerUnderlying,
  universeKey,
  type NewsFilterInput,
  type NewsFilterMode,
  type NewsUniverse,
} from './news-relevance';

/** How long the owner's universe is reused before it is rebuilt from the DB. */
export const UNIVERSE_TTL_MS = 15 * 60_000;

/** NEWS_FILTER_WATCHLIST: the owner's watchlist (the app keeps it in the browser only), comma-separated. */
export function parseWatchlist(env: Record<string, string | undefined>): string[] {
  return (env.NEWS_FILTER_WATCHLIST ?? '').split(',').map((s) => universeKey(s)).filter(Boolean);
}

/**
 * The news relevance filter at ingest: the mode (NEWS_FILTER), the owner's universe (F&O underlyings with a
 * live NFO contract + the owner's OPEN trade_trackers — positions and holdings — + NEWS_FILTER_WATCHLIST) and
 * the columns to write on a new `news_articles` row. `off` touches nothing (no DB read, `{}` columns).
 *
 * Fail-open: when the universe cannot be loaded, or the F&O list is empty (a stale master), the universe rule
 * is skipped for that row — a broken lookup must never hide every filing.
 */
@Injectable()
export class NewsRelevanceService {
  private readonly logger = new Logger(NewsRelevanceService.name);
  private cache: { at: number; set: ReadonlySet<string> | null } | null = null;
  private inFlight: Promise<ReadonlySet<string> | null> | null = null;
  /** Test seams. */
  env: Record<string, string | undefined> = process.env;
  now: () => number = () => Date.now();

  constructor(private readonly prisma: PrismaService) {}

  get mode(): NewsFilterMode {
    return parseNewsFilterMode(this.env);
  }

  /** The columns for a new row (`{}` when off). Never throws: a failure is logged and the row is kept. */
  async columnsFor(input: NewsFilterInput): Promise<{ filtered?: boolean; filterReason?: string | null }> {
    const mode = this.mode;
    if (mode === 'off') return {};
    try {
      const universe = input.source === NSE_ANNOUNCEMENTS_SOURCE ? await this.universe() : null;
      return filterColumns(mode, classifyNews(input, universe));
    } catch (err) {
      this.logger.warn(`[news-filter] classify failed, row kept: ${err instanceof Error ? err.message : String(err)}`);
      return filterColumns(mode, { filtered: false, reason: null });
    }
  }

  /** The owner's universe, cached {@link UNIVERSE_TTL_MS}; null = unavailable (the universe rule is skipped). */
  async universe(): Promise<NewsUniverse> {
    if (this.cache && this.now() - this.cache.at < UNIVERSE_TTL_MS) return this.cache.set;
    if (this.inFlight) return this.inFlight;
    this.inFlight = this.load().finally(() => {
      this.inFlight = null;
    });
    return this.inFlight;
  }

  private async load(): Promise<ReadonlySet<string> | null> {
    try {
      const now = new Date(this.now());
      const day = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
      const fno = await this.prisma.instrument.findMany({
        where: { exchange: 'NFO', expiry: { gte: day } },
        select: { name: true },
        distinct: ['name'],
      });
      if (fno.length === 0) {
        this.logger.warn('[news-filter] no live NFO contracts in the instrument master — universe rule skipped (fail open)');
        this.cache = { at: this.now(), set: null };
        return null;
      }
      const set = new Set(fno.map((r) => universeKey(r.name)));
      const owner = (this.env.HUB_OWNER_USER_ID ?? '').trim();
      if (owner) {
        const trackers = await this.prisma.tradeTracker.findMany({ where: { userId: owner, status: 'OPEN' }, select: { symbol: true, exchange: true } });
        for (const t of trackers) set.add(trackerUnderlying(t.symbol, t.exchange));
      }
      for (const w of parseWatchlist(this.env)) set.add(w);
      this.cache = { at: this.now(), set };
      return set;
    } catch (err) {
      this.logger.warn(`[news-filter] universe load failed — universe rule skipped (fail open): ${err instanceof Error ? err.message : String(err)}`);
      // Keep a still-usable previous set rather than none; otherwise retry on the next row.
      return this.cache?.set ?? null;
    }
  }
}
