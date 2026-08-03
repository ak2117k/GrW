import { Inject, Injectable } from '@nestjs/common';
import type { QuoteResponse } from '../utils/tick-to-quote';

/**
 * DI token for the per-user quote resolver this service delegates to.
 *
 * Bound to a token rather than the concrete `MarketQuoteResolver` class so this
 * service (and its unit tests) depend only on the STRUCTURAL contract below —
 * no import cycle, no Nest TestingModule needed to exercise it. Wire it in the
 * market-data module as:
 *
 *   { provide: MARKET_QUOTE_RESOLVER, useExisting: MarketQuoteResolver }
 */
export const MARKET_QUOTE_RESOLVER = 'MARKET_QUOTE_RESOLVER';

/** One instrument to quote. Mirrors `QuoteRequestRef` on the resolver. */
export interface QuoteRequestRef {
  token: string;
  exchange: string;
  symbol?: string;
}

/**
 * The slice of `MarketQuoteResolver` this service uses: per-user batched
 * FULL-mode quotes over the REQUEST USER'S own Angel session, keyed by token.
 * Tokens the broker refuses to quote are ABSENT from the returned map.
 */
export interface QuoteResolverLike {
  resolveQuotes(userId: string, refs: QuoteRequestRef[]): Promise<Map<string, QuoteResponse>>;
}

/**
 * One row of `POST /api/market-data/quotes`.
 *
 * Byte-for-byte the shape the controller used to build inline and the shape
 * `apps/web/src/hooks/useWatchlistQuotes.ts` declares — deliberately NOT a
 * `QuoteResponse` (no `symbol` / `timestamp` / `vwap` / `oi`), so the frontend
 * needs no change.
 */
export interface QuoteRow {
  token: string;
  exchange: string;
  ltp: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  change: number;
  changePercent: number;
}

/** Broker numbers can arrive NaN/Infinity/null; the client calls toFixed() on
 *  every one of them, so coerce anything non-finite to 0 at the boundary. */
function finite(value: number | undefined | null): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

/** Match the 2-decimal rounding the old direct-Angel branch applied. */
function round2(value: number): number {
  return Number(finite(value).toFixed(2));
}

/**
 * Builds the watchlist quote snapshot for `POST /api/market-data/quotes`.
 *
 * Replaces the old cache-FIRST handler, which read `MarketFeedService`'s quote
 * cache and fell back to `AngelOneAdapterService` — both bound to the retired
 * SHARED feed account, so the cache was permanently empty and the fallback
 * dead. Everything now resolves over the REQUEST USER'S own Angel session via
 * `MarketQuoteResolver`.
 *
 * Contract preserved from the old handler: tokens that resolve to nothing are
 * simply ABSENT from `quotes` (the frontend keys a Map by token and skips
 * misses), and row order follows request order.
 */
@Injectable()
export class BatchQuotesService {
  constructor(
    @Inject(MARKET_QUOTE_RESOLVER) private readonly resolver: QuoteResolverLike,
  ) {}

  /**
   * @param userId  owner of the Angel session the quotes are fetched over
   * @param items   instruments to quote; malformed entries are dropped
   * @returns `{ quotes, count }` — `count` is `quotes.length`, kept because the
   *          old handler returned it (harmless for the frontend, which reads
   *          only `quotes`).
   */
  async getQuotes(
    userId: string,
    items?: { token: string; exchange: string }[] | null,
  ): Promise<{ quotes: QuoteRow[]; count: number }> {
    const refs = normalizeRefs(items);
    // Short-circuit: an empty watchlist must never reach the broker.
    if (refs.length === 0) return { quotes: [], count: 0 };

    const resolved = await this.resolver.resolveQuotes(userId, refs);
    const quotes: QuoteRow[] = [];

    for (const ref of refs) {
      const q = resolved?.get(ref.token);
      if (!q) continue; // unquotable token — omit the row, per the contract
      quotes.push({
        token: ref.token,
        // Echo the exchange the CALLER asked for, not the resolver's, so the
        // row always lines up with the watchlist entry that requested it.
        exchange: ref.exchange,
        ltp: finite(q.ltp),
        open: finite(q.open),
        high: finite(q.high),
        low: finite(q.low),
        close: finite(q.close),
        volume: finite(q.volume),
        change: round2(q.change),
        changePercent: round2(q.changePercent),
      });
    }

    return { quotes, count: quotes.length };
  }
}

/**
 * Drop malformed entries, upper-case the exchange, and de-duplicate.
 *
 * De-dup key is `exchange:token`, NOT token alone: the same numeric token means
 * different instruments on different exchanges, and the resolver batches per
 * exchange. Order of first appearance is preserved so response rows track the
 * caller's list.
 */
function normalizeRefs(
  items?: { token: string; exchange: string }[] | null,
): QuoteRequestRef[] {
  const out: QuoteRequestRef[] = [];
  const seen = new Set<string>();
  for (const it of items ?? []) {
    if (!it?.token || !it?.exchange) continue;
    const token = String(it.token);
    const exchange = String(it.exchange).toUpperCase();
    const key = `${exchange}:${token}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ token, exchange });
  }
  return out;
}
