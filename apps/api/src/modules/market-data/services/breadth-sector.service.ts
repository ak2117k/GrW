import { Inject, Injectable, Logger } from '@nestjs/common';
import { MAJOR_STOCKS, SECTOR_INDICES } from '@td/shared/constants';
import type { QuoteResponse } from '../utils/tick-to-quote';

/**
 * A quote request for one instrument. Structurally identical to
 * `QuoteRequestRef` in `market-quote-resolver.service.ts` — declared here so
 * this service (and its unit test) has no compile-time dependency on the
 * resolver module.
 */
export interface BreadthQuoteRef {
  token: string;
  exchange: string;
  symbol?: string;
}

/**
 * The slice of `MarketQuoteResolver` this service needs. Tokens the broker
 * refuses to quote are simply ABSENT from the returned map — never an entry
 * with zeroed numbers — so "no data" can be told apart from "flat".
 */
export interface BreadthQuoteResolver {
  resolveQuotes(
    userId: string,
    refs: BreadthQuoteRef[],
  ): Promise<Map<string, QuoteResponse>>;
}

/**
 * DI token for the resolver dependency. The module must alias it onto the real
 * resolver, e.g.
 *
 *   { provide: BREADTH_QUOTE_RESOLVER, useExisting: MarketQuoteResolver }
 */
export const BREADTH_QUOTE_RESOLVER = 'BREADTH_QUOTE_RESOLVER';

export interface BreadthResult {
  advances: number;
  declines: number;
  unchanged: number;
  adRatio: number;
  total: number;
}

export interface SectorPerformanceEntry {
  sector: string;
  symbol: string;
  token: string;
  changePercent: number;
  ltp: number;
}

/**
 * Market breadth and sector performance, computed per request user.
 *
 * These two numbers used to be derived from `MarketFeedService`'s in-memory
 * tick cache, which was filled by a single SHARED Angel One feed account. That
 * account no longer exists — the cache is permanently empty, so both endpoints
 * returned zeros / an empty array in production. Everything here now goes
 * through the REQUEST USER'S own broker session via `MarketQuoteResolver`.
 *
 * Return shapes are byte-for-byte the ones `MarketFeedService.getBreadth()` /
 * `.getSectorPerformance()` produced (plus an additive `token` on sector rows,
 * which the frontend's `SectorData` interface already declares), so no client
 * change is required.
 */
@Injectable()
export class BreadthSectorService {
  private readonly logger = new Logger(BreadthSectorService.name);

  /**
   * Symbols that are broad-market indices rather than sectors. Mirrors
   * `MarketFeedService.MAIN_INDEX_SYMBOLS` — note this drops `NIFTY BANK`
   * (whose "Banking" row the old endpoint never emitted either).
   */
  private static readonly MAIN_INDEX_SYMBOLS = new Set([
    'NIFTY',
    'BANKNIFTY',
    'FINNIFTY',
    'SENSEX',
    'NIFTY 50',
    'NIFTY BANK',
  ]);

  constructor(
    @Inject(BREADTH_QUOTE_RESOLVER)
    private readonly quoteResolver: BreadthQuoteResolver,
  ) {}

  /**
   * The breadth universe: the major stocks plus the sector indices — the
   * equity-side subset of what the old shared feed happened to have cached
   * (commodities excluded; a gold future is not market breadth).
   */
  private breadthUniverse(): BreadthQuoteRef[] {
    const refs: BreadthQuoteRef[] = [
      ...Object.values(MAJOR_STOCKS),
      ...Object.values(SECTOR_INDICES),
    ].map((entry) => ({
      token: entry.token,
      exchange: entry.exchange,
      symbol: entry.symbol,
    }));

    // Some sector tokens duplicate index tokens; count each instrument once.
    const seen = new Set<string>();
    return refs.filter((ref) => {
      if (!ref.token || ref.token === '0') return false;
      const key = `${ref.exchange}:${ref.token}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }

  private sectorUniverse(): Array<BreadthQuoteRef & { sector: string }> {
    return Object.values(SECTOR_INDICES)
      .filter((s) => !BreadthSectorService.MAIN_INDEX_SYMBOLS.has(s.symbol))
      .map((s) => ({
        token: s.token,
        exchange: s.exchange,
        symbol: s.symbol,
        sector: s.sector,
      }));
  }

  /**
   * Advances / declines / unchanged across the breadth universe.
   *
   * A token the resolver could not price is SKIPPED, not counted as unchanged
   * — otherwise an outage would render as a perfectly flat market. A quote
   * that resolves with exactly `changePercent === 0` IS unchanged.
   */
  async getBreadth(userId: string): Promise<BreadthResult> {
    const refs = this.breadthUniverse();

    let quotes: Map<string, QuoteResponse>;
    try {
      quotes = await this.quoteResolver.resolveQuotes(userId, refs);
    } catch (err) {
      // The market page polls this every 30s; a broker hiccup should render as
      // "no data" rather than a 500 that blanks the whole panel.
      this.logger.warn(
        `Breadth quote resolution failed: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
      quotes = new Map();
    }

    let advances = 0;
    let declines = 0;
    let unchanged = 0;

    for (const ref of refs) {
      const quote = quotes.get(ref.token);
      if (!quote) continue;
      const changePercent = Number.isFinite(quote.changePercent)
        ? quote.changePercent
        : 0;
      if (changePercent > 0) advances++;
      else if (changePercent < 0) declines++;
      else unchanged++;
    }

    const total = advances + declines + unchanged;
    const adRatio =
      declines > 0
        ? Math.round((advances / declines) * 100) / 100
        : advances > 0
          ? advances
          : 0;

    return { advances, declines, unchanged, adRatio, total };
  }

  /**
   * Per-sector change%, best performer first. Sectors the resolver could not
   * price are omitted (the heatmap renders whatever it gets, and a fabricated
   * 0.00% tile is worse than a missing one).
   */
  async getSectorPerformance(userId: string): Promise<SectorPerformanceEntry[]> {
    const universe = this.sectorUniverse();

    let quotes: Map<string, QuoteResponse>;
    try {
      quotes = await this.quoteResolver.resolveQuotes(
        userId,
        universe.map(({ token, exchange, symbol }) => ({
          token,
          exchange,
          symbol,
        })),
      );
    } catch (err) {
      this.logger.warn(
        `Sector quote resolution failed: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
      quotes = new Map();
    }

    const sectors: SectorPerformanceEntry[] = [];
    for (const entry of universe) {
      const quote = quotes.get(entry.token);
      if (!quote) continue;
      sectors.push({
        sector: entry.sector,
        symbol: entry.symbol ?? quote.symbol,
        token: entry.token,
        changePercent: Number.isFinite(quote.changePercent)
          ? quote.changePercent
          : 0,
        ltp: Number.isFinite(quote.ltp) ? quote.ltp : 0,
      });
    }

    // Best performing sector first — same ordering the old endpoint used.
    sectors.sort((a, b) => b.changePercent - a.changePercent);

    return sectors;
  }
}
