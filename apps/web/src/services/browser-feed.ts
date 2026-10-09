import type { MarketDepth } from '@td/shared';
import type { Quote } from '@/types';
import type { FeedHealth } from './feed-health';

/**
 * SP1 M4: the browser side of the hub feed. Pure, so every rule a hook follows
 * (poll or not, which tick is mine) is asserted directly — the project's vitest
 * runs in node with no DOM renderer, so hooks are thin wiring of these.
 */

/** Why a screen wants an instrument. The server maps it to a hub priority (context 2, watchlist 3, chart 4). */
export type FeedPurpose = 'chart' | 'watchlist' | 'context';

/** Which path feeds this browser, as the /ws gateway says on connect. */
export type FeedSource = 'hub' | 'legacy';

/** One instrument on the feed. Exchange is required: tokens collide across exchanges. */
export interface FeedRef {
  token: string;
  exchange: string;
  symbol?: string;
}

/** Hub priority per purpose: lower is more urgent (mirrors the server mapping). */
const PURPOSE_RANK: Record<FeedPurpose, number> = { context: 2, watchlist: 3, chart: 4 };

/** Is purpose `a` strictly more urgent than `b`? (context > watchlist > chart) */
export function moreUrgent(a: FeedPurpose, b: FeedPurpose): boolean {
  return PURPOSE_RANK[a] < PURPOSE_RANK[b];
}

export function feedKey(r: Pick<FeedRef, 'token' | 'exchange'>): string {
  return `${r.exchange.toUpperCase()}:${r.token}`;
}

export function isFeedSource(x: unknown): x is FeedSource {
  return x === 'hub' || x === 'legacy';
}

export interface WireDepthLevel {
  price: number;
  qty: number;
  orders: number;
}

/**
 * The `/ws` `tick` payload. Legacy ticks are the server's `TickData`; hub ticks
 * add `exchange`, `at`, `source`, `depth`, and `change`/`changePercent` when the
 * broker reported the previous close. `timestamp` is an ISO string on the wire.
 */
export interface WireTick {
  token: string;
  symbol: string;
  exchange?: string;
  ltp: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  oi?: number;
  timestamp: string;
  at?: number;
  source?: 'ws' | 'quote' | 'db';
  change?: number;
  changePercent?: number;
  depth?: { bids: WireDepthLevel[]; asks: WireDepthLevel[] };
}

/** Is this tick for (token, exchange)? The exchange must agree whenever the tick carries one. */
export function tickMatches(tick: unknown, token: string, exchange: string): tick is WireTick {
  if (!tick || typeof tick !== 'object') return false;
  const t = tick as Partial<WireTick>;
  if (t.token !== token) return false;
  return !t.exchange || t.exchange.toUpperCase() === exchange.toUpperCase();
}

/**
 * The poll interval for a screen, or `false` for "do not poll".
 *
 * Off only while the hub feeds this browser AND the tick feed is Live: then
 * every number arrives as a tick. Any other state — the socket down, no tick
 * for 6 s, a legacy user, or the server not having said yet — keeps today's
 * cadence, so a stall can never freeze a screen.
 */
export function livePollMs(baseMs: number, feed: { source: FeedSource | null; health: FeedHealth }): number | false {
  return feed.source === 'hub' && feed.health === 'live' ? false : baseMs;
}

/** The quote fields a screen keeps; `changePct` is the order ticket's name for changePercent. */
export interface QuoteFields {
  ltp: number;
  open: number;
  high: number;
  low: number;
  close: number;
  change: number;
  changePct: number;
}

function positive(n: unknown, fallback: number): number {
  return typeof n === 'number' && Number.isFinite(n) && n > 0 ? n : fallback;
}

/**
 * Fold a tick into a screen's quote. A field the tick reports as 0 keeps the
 * previous value (the broker sends 0 for "not reported"); change comes from the
 * tick, else from the close. A tick without a usable LTP returns `prev` itself.
 */
export function quoteFromTick<T extends QuoteFields>(prev: T, tick: WireTick): T {
  if (!(typeof tick.ltp === 'number' && Number.isFinite(tick.ltp) && tick.ltp > 0)) return prev;
  const close = positive(tick.close, prev.close);
  const change = typeof tick.change === 'number' ? tick.change : close > 0 ? tick.ltp - close : prev.change;
  const changePct =
    typeof tick.changePercent === 'number'
      ? tick.changePercent
      : close > 0
        ? ((tick.ltp - close) / close) * 100
        : prev.changePct;
  return {
    ...prev,
    ltp: tick.ltp,
    open: positive(tick.open, prev.open),
    high: positive(tick.high, prev.high),
    low: positive(tick.low, prev.low),
    close,
    change,
    changePct,
  };
}

/** The depth card's MarketDepth from a tick's book; undefined when the tick carries none. */
export function depthFromTick(tick: WireTick): MarketDepth | undefined {
  const d = tick.depth;
  if (!d) return undefined;
  const sum = (levels: WireDepthLevel[]) => levels.reduce((s, l) => s + l.qty, 0);
  return {
    token: tick.token,
    exchange: tick.exchange ?? '',
    bids: d.bids,
    asks: d.asks,
    totalBidQty: sum(d.bids),
    totalAskQty: sum(d.asks),
    ts: tick.at ?? Date.parse(tick.timestamp),
  };
}

/**
 * A watchlist row's store Quote from a tick, under the ITEM's symbol (the hub's
 * symbol for the same instrument may differ). Null unless the tick is for this
 * exchange + token and carries a change: a partial tick would blank the row's %.
 */
export function quoteForItem(item: { symbol: string; token: string; exchange: string }, tick: WireTick): Quote | null {
  if (!tickMatches(tick, item.token, item.exchange)) return null;
  if (!(tick.ltp > 0) || typeof tick.change !== 'number') return null;
  return {
    symbol: item.symbol,
    token: item.token,
    exchange: item.exchange,
    ltp: tick.ltp,
    open: tick.open,
    high: tick.high,
    low: tick.low,
    close: tick.close,
    volume: tick.volume,
    change: tick.change,
    changePercent: tick.changePercent ?? 0,
    timestamp: new Date(tick.timestamp),
  } as unknown as Quote;
}

/** The index tiles' refs from the `/indices` response rows. */
export function indexRefs(indices: unknown): FeedRef[] {
  if (!Array.isArray(indices)) return [];
  const out: FeedRef[] = [];
  for (const row of indices as Array<{ token?: unknown; exchange?: unknown; symbol?: unknown } | null>) {
    if (!row || typeof row.token !== 'string' || typeof row.exchange !== 'string') continue;
    out.push({ token: row.token, exchange: row.exchange, ...(typeof row.symbol === 'string' ? { symbol: row.symbol } : {}) });
  }
  return out;
}
