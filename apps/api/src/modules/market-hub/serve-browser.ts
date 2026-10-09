import type { MarketDepth } from '@td/shared/types';
import type { QuoteResponse } from '../market-data/utils/tick-to-quote';
import { BROWSER_WATCH_TTL_MS, SCREEN_MAX_AGE_MS, priceToDepth, priceToQuote } from './browser-feed';
import type { HubPriceSource } from './hub-prices';
import { isHubExchange, refKey, type InstrumentRef, type Priority } from './hub.types';

/** What a REST caller asks for: the controller's own ref shape. */
export interface BrowserQuoteRef {
  token: string;
  exchange: string;
  symbol?: string;
}

export interface HubQuotesServed<R extends BrowserQuoteRef> {
  /** Keyed EXCHANGE:token (hubQuoteKey), never the token alone. */
  quotes: Map<string, QuoteResponse>;
  /** Everything the hub did not answer: the caller's legacy path prices these. */
  missing: R[];
}

/** Watch owners for REST reads (one per endpoint; each read renews the 2-minute TTL). */
export const REST_OWNER = {
  quote: 'rest:quote',
  depth: 'rest:depth',
  indices: 'rest:indices',
  watchlist: 'rest:watchlist',
} as const;

export function hubQuoteKey(token: string, exchange: string): string {
  return `${exchange.toUpperCase()}:${token}`;
}

function toRef(req: BrowserQuoteRef): InstrumentRef | null {
  const exchange = req.exchange.toUpperCase();
  return isHubExchange(exchange) ? { exchange, token: req.token, symbol: req.symbol || req.token } : null;
}

/**
 * SP1 M4 hub tier for /quote, /indices and /quotes (the M2 serveChartFromHub
 * pattern). Only when hubFor(userId, 'browser') serves this user: watch every
 * ref (not awaited), then answer ONLY the ones the PriceBook has fresh within
 * 15 s. A market-closed answer is `missing` too: the PriceBook returns
 * market-closed for a price of any age once the exchange shuts (a lapsed watch
 * can leave it hours old, and QuoteRow carries no timestamp label), while the
 * legacy fetch gives the true close. Everything not fresh is `missing`, for the
 * caller's legacy path. Synchronous; never throws.
 */
export function serveQuotesFromHub<R extends BrowserQuoteRef>(
  source: HubPriceSource | null,
  userId: string,
  refs: readonly R[],
  watch: { priority: Priority; owner: string },
): HubQuotesServed<R> {
  const none = (): HubQuotesServed<R> => ({ quotes: new Map(), missing: [...refs] });
  try {
    const hub = source?.hubFor(userId, 'browser') ?? null;
    if (!source || !hub) return none();
    const valid: Array<{ req: R; ref: InstrumentRef }> = [];
    const missing: R[] = [];
    for (const req of refs) {
      const ref = toRef(req);
      if (ref) valid.push({ req, ref });
      else missing.push(req);
    }
    if (valid.length > 0) {
      void Promise.resolve(hub.watch(valid.map((v) => v.ref), watch.priority, watch.owner, BROWSER_WATCH_TTL_MS)).catch(() => undefined);
    }
    const quotes = new Map<string, QuoteResponse>();
    for (const { req, ref } of valid) {
      const r = hub.price(ref, { maxAgeMs: SCREEN_MAX_AGE_MS });
      if (r.kind === 'fresh') quotes.set(refKey(ref), priceToQuote(r.price, req.symbol));
      else missing.push(req);
    }
    source.record('browser', 'hub', quotes.size);
    source.record('browser', 'legacy', missing.length);
    return { quotes, missing };
  } catch {
    return none();
  }
}

/** Hub tier for /depth: a FRESH price's book only (a closed market's book is meaningless). Null = legacy path. */
export function serveDepthFromHub(source: HubPriceSource | null, userId: string, req: BrowserQuoteRef): MarketDepth | null {
  try {
    const hub = source?.hubFor(userId, 'browser') ?? null;
    const ref = toRef(req);
    if (!source || !hub || !ref) return null;
    void Promise.resolve(hub.watch([ref], 4, REST_OWNER.depth, BROWSER_WATCH_TTL_MS)).catch(() => undefined);
    const r = hub.price(ref, { maxAgeMs: SCREEN_MAX_AGE_MS });
    const depth = r.kind === 'fresh' ? priceToDepth(r.price) : null;
    source.record('browser', depth ? 'hub' : 'legacy');
    return depth;
  } catch {
    return null;
  }
}
