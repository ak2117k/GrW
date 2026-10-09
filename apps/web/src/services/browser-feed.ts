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
