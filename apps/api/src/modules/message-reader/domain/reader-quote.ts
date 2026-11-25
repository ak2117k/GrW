import type { DailyBar } from '../../signal-intake/domain/info-outcome';

/** Closed 15-minute bars kept in the quote block (never anything finer than 15m). */
export const QUOTE_BARS_15M = 8;
const AVG_VOLUME_SESSIONS = 20;
const RANGE_SESSIONS = 60;
const BAR_15M_MS = 15 * 60_000;

export interface QuoteLtp {
  ltp: number;
  open: number;
  high: number;
  low: number;
  /** Angel's FULL quote `close` = the previous session's close. */
  close: number;
  volume: number;
  timestamp: Date;
}

export interface Bar15m {
  ts: number;
  open: number;
  high: number;
  low: number;
  close: number;
}

export interface ReaderQuote {
  exchange: string;
  ltp: number;
  open: number;
  dayHigh: number;
  dayLow: number;
  /** Today's volume so far. */
  volume: number;
  prevClose: number | null;
  prevHigh: number | null;
  prevLow: number | null;
  /** Mean daily volume of the 20 sessions before today; null with fewer than 20. */
  avgVolume20d: number | null;
  /** Highest high / lowest low of the 60 sessions before today; null with fewer than 60. */
  high60d: number | null;
  low60d: number | null;
  /** The last closed 15m bars, oldest first (`at` = bar start, ISO). */
  bars15m: Array<{ at: string; open: number; high: number; low: number; close: number }>;
  at: string;
  /** Why a part is null (daily / 15m bars that did not arrive). */
  missing?: string[];
}

const pos = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n) && n > 0;

/**
 * The reader's quote block for one instrument: today's numbers from the live quote, the previous-session
 * and 20 / 60-session stats from daily bars dated before `today` (IST 'YYYY-MM-DD'; today's forming daily
 * bar is ignored), and the last closed 15m bars (a bar still forming at `now` is left out).
 * `daily` / `bars15m` are null when they did not arrive; `missing` then says why.
 */
export function readerQuote(i: {
  exchange: string;
  q: QuoteLtp;
  daily: readonly DailyBar[] | null;
  bars15m: readonly Bar15m[] | null;
  today: string;
  now: Date;
  missing?: string[];
}): ReaderQuote {
  const prior = (i.daily ?? []).filter((b) => b.day < i.today).sort((a, b) => (a.day < b.day ? -1 : a.day > b.day ? 1 : 0));
  const prev = prior.length ? prior[prior.length - 1] : null;
  const vols = prior.slice(-AVG_VOLUME_SESSIONS).map((b) => b.volume);
  const avgVolume20d = vols.length === AVG_VOLUME_SESSIONS && vols.every(pos) ? Math.round((vols as number[]).reduce((a, b) => a + b, 0) / vols.length) : null;
  const range = prior.slice(-RANGE_SESSIONS);
  const full = range.length === RANGE_SESSIONS;
  const closed = (i.bars15m ?? [])
    .filter((b) => b.ts + BAR_15M_MS <= i.now.getTime())
    .sort((a, b) => a.ts - b.ts)
    .slice(-QUOTE_BARS_15M)
    .map((b) => ({ at: new Date(b.ts).toISOString(), open: b.open, high: b.high, low: b.low, close: b.close }));
  const out: ReaderQuote = {
    exchange: i.exchange,
    ltp: i.q.ltp,
    open: i.q.open,
    dayHigh: i.q.high,
    dayLow: i.q.low,
    volume: i.q.volume,
    prevClose: pos(i.q.close) ? i.q.close : (prev?.close ?? null),
    prevHigh: prev?.high ?? null,
    prevLow: prev?.low ?? null,
    avgVolume20d,
    high60d: full ? Math.max(...range.map((b) => b.high)) : null,
    low60d: full ? Math.min(...range.map((b) => b.low)) : null,
    bars15m: closed,
    at: new Date(i.q.timestamp).toISOString(),
  };
  if (i.missing?.length) out.missing = i.missing;
  return out;
}
