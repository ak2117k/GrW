import { Injectable, Logger } from '@nestjs/common';
import { UserFeedManager } from './user-feed-manager.service';
import { tickToQuote, type QuoteResponse } from '../utils/tick-to-quote';
import { quoteFromDailyCandles } from '../utils/quote-from-candles';

/** One instrument to quote. `symbol` seeds the response when the broker sends a blank one. */
export interface QuoteRequestRef {
  token: string;
  exchange: string;
  symbol?: string;
}

/** Candle-derived quotes are cached this long — see `resolveQuotes`. */
const FALLBACK_CACHE_TTL_MS = 60_000;

/** Days of history requested for the fallback: enough to span a long weekend + holidays. */
const FALLBACK_LOOKBACK_DAYS = 10;

interface CacheEntry {
  promise: Promise<QuoteResponse | null>;
  expiresAt: number;
}

/**
 * The single quote path behind every market-page section (indices, commodities,
 * breadth, sector performance, watchlist).
 *
 * It exists because those sections were each reaching for market data their own
 * way, and every one of those ways went through the SHARED Angel One feed
 * account — which no longer exists. Consolidating them means the next broker
 * quirk gets handled once instead of five times.
 *
 * Two broker realities it reconciles:
 *
 *  1. `marketData({ mode: 'FULL' })` quotes most instruments in ONE call and is
 *     the cheap path — but it REFUSES NSE index tokens (`999260xx`) for most API
 *     keys, returning them under `data.unfetched`. SENSEX (BSE) is quotable,
 *     which is exactly why it was the only index tile showing numbers.
 *  2. `getCandleData` DOES serve those tokens — it is what draws the charts — so
 *     the last two daily candles yield a real LTP (today's close tracks
 *     intraday) and a real previous close for change/changePercent.
 *
 * A token that resolves by NEITHER path is simply absent from the returned map:
 * one unquotable instrument must never blank an entire section.
 */
@Injectable()
export class MarketQuoteResolver {
  private readonly logger = new Logger(MarketQuoteResolver.name);

  /**
   * Candle-derived quotes, keyed `userId:exchange:token`. Keyed BY USER because
   * each user quotes through their own broker session — sharing entries across
   * users would leak one account's entitlements into another's page.
   */
  private readonly fallbackCache = new Map<string, CacheEntry>();

  constructor(private readonly userFeedManager: UserFeedManager) {}

  /**
   * Resolve quotes for `refs` over the request user's own broker session.
   * Returns a map keyed by token; unresolvable tokens are omitted.
   */
  async resolveQuotes(
    userId: string,
    refs: QuoteRequestRef[],
  ): Promise<Map<string, QuoteResponse>> {
    const out = new Map<string, QuoteResponse>();
    if (refs.length === 0) return out;

    // Cheap path first: one batched call for everything.
    let fetched = new Map<string, Awaited<ReturnType<UserFeedManager['fetchQuote']>>>();
    try {
      fetched = await this.userFeedManager.fetchQuotes(
        userId,
        refs.map((r) => ({ token: r.token, exchange: r.exchange })),
      );
    } catch (err) {
      // No broker creds / session down. Not fatal — the candle path may still
      // serve every token, so degrade rather than blank the section.
      this.logger.warn(
        `Batched quote fetch failed for user ${userId}: ${
          err instanceof Error ? err.message : err
        }. Falling back to candles.`,
      );
    }

    const needsFallback: QuoteRequestRef[] = [];
    for (const ref of refs) {
      const tick = fetched.get(ref.token);
      if (tick) {
        out.set(
          ref.token,
          tickToQuote(tick, { exchange: ref.exchange, symbol: ref.symbol }),
        );
      } else {
        needsFallback.push(ref);
      }
    }

    if (needsFallback.length === 0) return out;

    // Fallbacks run concurrently; each is independently cached and independently
    // failable so one dead token can't take the rest of the section with it.
    const derived = await Promise.all(
      needsFallback.map((ref) => this.fallbackQuote(userId, ref)),
    );
    needsFallback.forEach((ref, i) => {
      const quote = derived[i];
      if (quote) out.set(ref.token, quote);
    });

    return out;
  }

  /**
   * Daily-candle-derived quote for one instrument, coalesced and cached.
   *
   * The sections that need this are polled every 5s per open page; a historical
   * call per token per poll would blow Angel's 3 req/sec limit immediately. A
   * daily candle only moves as fast as the last trade rolls into it, so a minute
   * of staleness is invisible while cutting the call rate ~12x.
   */
  private fallbackQuote(
    userId: string,
    ref: QuoteRequestRef,
  ): Promise<QuoteResponse | null> {
    const key = `${userId}:${ref.exchange}:${ref.token}`;
    const cached = this.fallbackCache.get(key);
    if (cached && cached.expiresAt > Date.now()) return cached.promise;

    const promise = (async () => {
      try {
        const to = new Date();
        const from = new Date(
          to.getTime() - FALLBACK_LOOKBACK_DAYS * 24 * 60 * 60 * 1000,
        );
        const candles = await this.userFeedManager.fetchCandles(
          userId,
          ref.token,
          ref.exchange,
          '1d',
          from,
          to,
        );
        return quoteFromDailyCandles(candles, {
          token: ref.token,
          symbol: ref.symbol ?? '',
          exchange: ref.exchange,
        });
      } catch (err) {
        this.logger.debug(
          `Candle fallback failed for ${ref.exchange}:${ref.token}: ${
            err instanceof Error ? err.message : err
          }`,
        );
        return null;
      }
    })();

    this.fallbackCache.set(key, {
      promise,
      expiresAt: Date.now() + FALLBACK_CACHE_TTL_MS,
    });
    return promise;
  }
}
