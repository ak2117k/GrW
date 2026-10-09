import type { MarketDepth } from '@td/shared/types';
import type { TickData } from '../../common/interfaces/broker-adapter.interface';
import { tickToQuote, type QuoteResponse } from '../market-data/utils/tick-to-quote';
import { isHubExchange, type InstrumentRef, type Price, type Priority } from './hub.types';

/**
 * SP1 M4: what the owner's browser sees of the hub. Pure (no Nest, no I/O), so
 * the market-data gateway and controller can import it without a module cycle.
 */

/** Spec §3.1: screen watches expire unless renewed (2 min). */
export const BROWSER_WATCH_TTL_MS = 120_000;
/** A socket renews its watches at half the TTL. */
export const BROWSER_RENEW_MS = 60_000;
/** Spec §5.3: standard maxAge for screens. */
export const SCREEN_MAX_AGE_MS = 15_000;
/** Bounded memory and slot pressure per browser socket. */
export const MAX_BROWSER_REFS_PER_SOCKET = 100;

/** Why the browser wants an instrument; decides its hub priority (spec §5.1). */
export type FeedPurpose = 'chart' | 'watchlist' | 'context';

const PURPOSE_PRIORITY: Readonly<Record<FeedPurpose, Priority>> = { context: 2, watchlist: 3, chart: 4 };

/** context 2 · watchlist 3 · chart (and anything unknown) 4. A browser can never claim 0 or 1. */
export function browserPriority(purpose: unknown): Priority {
  return typeof purpose === 'string' && Object.prototype.hasOwnProperty.call(PURPOSE_PRIORITY, purpose)
    ? PURPOSE_PRIORITY[purpose as FeedPurpose]
    : 4;
}

/** One watch owner per socket, so one tab's release never drops another tab's watch. */
export function browserOwner(socketId: string): string {
  return `browser:${socketId}`;
}

/** The `/ws` subscribe / unsubscribe body. `refs` (M4 client) win over `tokens` (old client). */
export interface SubscribeBody {
  tokens?: unknown;
  refs?: unknown;
  purpose?: unknown;
}

export interface ParsedRefs {
  refs: InstrumentRef[];
  /** Tokens that came without an exchange (an old client bundle) and were taken as NSE. */
  bareTokens: number;
}

/**
 * The gateway's exchange fix (spec §1.7): every ref carries the exchange the
 * client sent. Accepted: `refs: [{ token, exchange, symbol? }]`, or `tokens`
 * as `EXCHANGE:token` strings; a bare token still means NSE so a stale tab keeps
 * working, and is counted. Unknown exchanges, non-numeric and zero tokens are
 * dropped. De-duplicated by EXCHANGE:token (never the token alone), capped.
 */
export function parseFeedRefs(body: SubscribeBody | null | undefined, cap = MAX_BROWSER_REFS_PER_SOCKET): ParsedRefs {
  const out = new Map<string, InstrumentRef>();
  let bareTokens = 0;
  const add = (exchange: string, token: string, symbol?: string): void => {
    const ex = exchange.trim().toUpperCase();
    const tk = token.trim();
    if (!isHubExchange(ex) || !/^\d+$/.test(tk) || /^0+$/.test(tk)) return;
    const key = `${ex}:${tk}`;
    if (out.has(key) || out.size >= cap) return;
    out.set(key, { exchange: ex, token: tk, symbol: symbol?.trim() || tk });
  };
  if (Array.isArray(body?.refs)) {
    for (const r of body.refs as unknown[]) {
      const ref = r as { token?: unknown; exchange?: unknown; symbol?: unknown } | null;
      if (!ref || typeof ref.token !== 'string' || typeof ref.exchange !== 'string') continue;
      add(ref.exchange, ref.token, typeof ref.symbol === 'string' ? ref.symbol : undefined);
    }
  } else if (Array.isArray(body?.tokens)) {
    for (const t of body.tokens as unknown[]) {
      if (typeof t !== 'string') continue;
      const i = t.indexOf(':');
      if (i > 0) {
        add(t.slice(0, i), t.slice(i + 1));
      } else {
        bareTokens++;
        add('NSE', t);
      }
    }
  }
  return { refs: [...out.values()], bareTokens };
}

/**
 * The `/ws` `tick` payload for a hub price: the legacy `TickData` fields (so
 * every existing consumer keeps working) plus `exchange`, `at`, `source`, and
 * `change` / `changePercent` when the broker reported the previous close. With
 * those, a tick is also a `Quote`, which the market store accepts as-is.
 */
export interface BrowserTick extends TickData {
  exchange: string;
  /** Receipt time (ms epoch); `timestamp` is the same instant. */
  at: number;
  source: Price['source'];
  change?: number;
  changePercent?: number;
}

/** A hub price as the legacy TickData shape (zeros where the broker reported no day bar). */
export function priceToTickData(p: Price, symbol?: string): TickData {
  return {
    token: p.ref.token,
    symbol: symbol || p.ref.symbol,
    exchange: p.ref.exchange,
    ltp: p.ltp,
    open: p.day?.open ?? 0,
    high: p.day?.high ?? 0,
    low: p.day?.low ?? 0,
    close: p.day?.close ?? 0,
    volume: p.volume ?? 0,
    oi: p.oi,
    timestamp: new Date(p.at),
    ...(p.depth ? { depth: p.depth } : {}),
  };
}

export function priceToBrowserTick(p: Price): BrowserTick {
  const t = priceToTickData(p);
  const out: BrowserTick = { ...t, exchange: p.ref.exchange, at: p.at, source: p.source };
  if (p.day && p.day.close > 0) {
    const q = tickToQuote(t, { exchange: p.ref.exchange });
    out.change = q.change;
    out.changePercent = q.changePercent;
  }
  return out;
}

/** The `/quote` Quote for a hub price; its `timestamp` is the price's own receipt time (the age label). */
export function priceToQuote(p: Price, symbol?: string): QuoteResponse {
  return tickToQuote(priceToTickData(p, symbol), { exchange: p.ref.exchange, symbol });
}

/** The `/depth` MarketDepth for a hub price; null when the price carries no book. */
export function priceToDepth(p: Price): MarketDepth | null {
  if (!p.depth) return null;
  const sum = (levels: { qty: number }[]) => levels.reduce((s, l) => s + l.qty, 0);
  return {
    token: p.ref.token,
    exchange: p.ref.exchange,
    bids: p.depth.bids.map((l) => ({ ...l })),
    asks: p.depth.asks.map((l) => ({ ...l })),
    totalBidQty: sum(p.depth.bids),
    totalAskQty: sum(p.depth.asks),
    ts: p.at,
  };
}
