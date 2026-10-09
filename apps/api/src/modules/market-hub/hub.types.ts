/** Exchanges the hub speaks, as Angel One names them in REST calls. */
export type HubExchange = 'NSE' | 'BSE' | 'NFO' | 'BFO' | 'MCX';

export interface InstrumentRef {
  exchange: HubExchange;
  token: string;
  symbol: string;
}

/** EXCHANGE:token — never the token alone (tokens collide across exchanges). */
export function refKey(ref: Pick<InstrumentRef, 'exchange' | 'token'>): string {
  return `${ref.exchange}:${ref.token}`;
}

/** 0 open-position contract · 1 its underlying · 2 market context · 3 candidates/watchlist · 4 viewed chart */
export type Priority = 0 | 1 | 2 | 3 | 4;

export const LANE = { CRITICAL: 0, INTERACTIVE: 1, ROUTINE: 2, BACKGROUND: 3 } as const;
export type Lane = (typeof LANE)[keyof typeof LANE];

export type Endpoint = 'quote' | 'candles' | 'search' | 'greek';

/** The session's day bar as the broker reports it. `close` is the PREVIOUS session's close. */
export interface DayBar {
  open: number;
  high: number;
  low: number;
  close: number;
}

export interface DepthLevel {
  price: number;
  qty: number;
  orders: number;
}

/** Up to five levels a side, best first, in rupees. */
export interface PriceDepth {
  bids: DepthLevel[];
  asks: DepthLevel[];
}

export interface Price {
  ref: InstrumentRef;
  ltp: number;
  /** Receipt time (ms epoch): when the hub learned this price is current. */
  at: number;
  source: 'ws' | 'quote' | 'db';
  volume?: number;
  oi?: number;
  /** M4: day bar (for change vs the previous close). Absent when the broker reported none. */
  day?: DayBar;
  /** M4: best-five book. Absent when the broker reported no level. */
  depth?: PriceDepth;
}

export type UnavailableReason = 'not-watched' | 'never-priced' | 'throttled' | 'no-session';

export type PriceResult =
  | { kind: 'fresh'; price: Price }
  | { kind: 'market-closed'; price: Price }
  | { kind: 'stale'; price: Price; ageMs: number }
  | { kind: 'unavailable'; reason: UnavailableReason };

const HUB_EXCHANGES: ReadonlySet<string> = new Set<HubExchange>(['NSE', 'BSE', 'NFO', 'BFO', 'MCX']);

export function isHubExchange(x: string): x is HubExchange {
  return HUB_EXCHANGES.has(x);
}
