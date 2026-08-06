import type { TickData } from '../../../common/interfaces/broker-adapter.interface';

/**
 * Pure helpers for fetching per-user historical candles + quotes from a user's
 * OWN already-authenticated Angel One session (see `UserFeedSession`).
 *
 * The Angel call SHAPES and the const maps below are duplicated from
 * `angel-one-adapter.service.ts` on purpose: this path deliberately does NOT
 * reach into the shared-feed adapter (which is bound to the dead shared
 * account). Keep these small maps + mappers in sync with the adapter if the
 * broker's interval limits or response shapes ever change.
 */

/** A single OHLCV candle. Mirrors the adapter's candle row shape. */
export interface Candle {
  timestamp: Date;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

/**
 * Timeframe → Angel One interval.
 * Keep in sync with `TIMEFRAME_MAP` in angel-one-adapter.service.ts.
 */
export const TIMEFRAME_MAP: Record<string, string> = {
  '1m': 'ONE_MINUTE',
  '3m': 'THREE_MINUTE',
  '5m': 'FIVE_MINUTE',
  '10m': 'TEN_MINUTE',
  '15m': 'FIFTEEN_MINUTE',
  '30m': 'THIRTY_MINUTE',
  '1h': 'ONE_HOUR',
  '1d': 'ONE_DAY',
};

/** Bucket sizes `aggregateCandles` can roll daily bars up into. */
export type AggregateBucket = 'week' | 'month';

/**
 * Timeframes Angel One cannot serve at all — its widest interval is ONE_DAY —
 * so they are fetched as daily bars and rolled up locally. Deliberately NOT in
 * `TIMEFRAME_MAP`: that map means "the Angel interval for this timeframe", and
 * an entry saying `'1w' -> 'ONE_DAY'` there would read as a lie to anyone
 * syncing it against the adapter.
 */
export const AGGREGATED_TIMEFRAMES: Record<string, AggregateBucket> = {
  '1w': 'week',
  '1mo': 'month',
};

/**
 * Minimum daily history to pull before rolling up, per aggregated timeframe.
 *
 * The caller's window is sized for the timeframe it *thinks* it is asking for
 * (the chart asks ~730 days for `1w`, and nothing at all for `1mo`), which
 * yields a chart of a hundred-odd weekly bars and an all-but-empty monthly one.
 * A floor here is what makes the higher timeframes worth showing; the caller's
 * own [from,to] is still honoured whenever it reaches further back.
 */
export const AGGREGATED_MIN_LOOKBACK_DAYS: Record<string, number> = {
  '1w': 5 * 365,
  '1mo': 15 * 365,
};

/**
 * Angel One interval → maximum date-range (days) accepted in a single
 * getCandleData call. Sub-hour intervals are capped to 1 day (Angel silently
 * truncates wider stock windows); hour/day keep their wider caps.
 * Keep in sync with `TIMEFRAME_MAX_RANGE_DAYS` in angel-one-adapter.service.ts.
 */
export const TIMEFRAME_MAX_RANGE_DAYS: Record<string, number> = {
  ONE_MINUTE: 1,
  THREE_MINUTE: 1,
  FIVE_MINUTE: 1,
  TEN_MINUTE: 1,
  FIFTEEN_MINUTE: 1,
  THIRTY_MINUTE: 1,
  ONE_HOUR: 365,
  ONE_DAY: 1800,
};

/** Fixed IST offset (no DST in India). */
const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;

/**
 * Format an absolute instant as IST wall-clock 'YYYY-MM-DD HH:mm' — the shape
 * Angel One's getCandleData expects for fromdate/todate. Must NOT use local
 * getHours()/getDate() (the API runs in UTC on Render); shift by +5:30 and read
 * UTC parts so the result is IST on any server timezone.
 * Copied from angel-one-adapter.service.ts formatDateTime.
 */
export function formatAngelDateTime(date: Date): string {
  const ist = new Date(date.getTime() + IST_OFFSET_MS);
  const y = ist.getUTCFullYear();
  const m = String(ist.getUTCMonth() + 1).padStart(2, '0');
  const d = String(ist.getUTCDate()).padStart(2, '0');
  const hh = String(ist.getUTCHours()).padStart(2, '0');
  const mm = String(ist.getUTCMinutes()).padStart(2, '0');
  return `${y}-${m}-${d} ${hh}:${mm}`;
}

/**
 * Map Angel One's getCandleData `data` array — rows of
 * `[timestamp, open, high, low, close, volume]` — to Candle objects.
 * Tolerates null / non-array (throttle / no-data) by returning [].
 */
export function mapCandleRows(rows: any[]): Candle[] {
  if (!Array.isArray(rows)) return [];
  return rows.map((c: any[]) => ({
    timestamp: new Date(c[0]),
    open: Number(c[1]),
    high: Number(c[2]),
    low: Number(c[3]),
    close: Number(c[4]),
    volume: Number(c[5]),
  }));
}

/**
 * Absolute instant at which the IST calendar week (Monday-start) or month
 * containing `instant` begins.
 *
 * Must NOT use local getDay()/getDate(): the API runs in UTC on Render, where
 * every IST evening bar (after 18:30 UTC) belongs to the *previous* UTC day and
 * would be bucketed a week or a month early around boundaries. Shift by +5:30
 * and read UTC parts — the same convention as `formatAngelDateTime`.
 */
export function istBucketStart(instant: Date, bucket: AggregateBucket): number {
  const ist = new Date(instant.getTime() + IST_OFFSET_MS);
  const y = ist.getUTCFullYear();
  const m = ist.getUTCMonth();

  if (bucket === 'month') return Date.UTC(y, m, 1) - IST_OFFSET_MS;

  // getUTCDay() is 0=Sun..6=Sat; we want 0=Mon..6=Sun. Date.UTC normalises a
  // day-of-month that goes <= 0, so a Monday in the previous month is fine.
  const daysSinceMonday = (ist.getUTCDay() + 6) % 7;
  return Date.UTC(y, m, ist.getUTCDate() - daysSinceMonday) - IST_OFFSET_MS;
}

/**
 * Roll daily bars up into IST-calendar weekly or monthly bars.
 *
 * Angel One's widest interval is ONE_DAY, so this is the only source of 1W/1M
 * candles — asking the broker for interval `"1w"` comes back `data: null`.
 *
 * The trailing bucket IS emitted even when the week/month is still running: the
 * chart has to show the forming bar, and suppressing it would make every live
 * weekly chart look a week stale. Buckets with no trading days (holidays, a
 * suspended scrip) are simply absent rather than zero-filled — a flat bar at
 * zero would be read as a real print by everything downstream.
 */
export function aggregateCandles(daily: Candle[], bucket: AggregateBucket): Candle[] {
  if (!Array.isArray(daily) || daily.length === 0) return [];

  // Copy before sorting: callers pass their own arrays and chunked fetches can
  // arrive out of order (windows are fetched newest-first).
  const sorted = [...daily].sort((a, b) => a.timestamp.getTime() - b.timestamp.getTime());

  const out: Candle[] = [];
  let current: Candle | null = null;
  let currentKey = Number.NaN;

  for (const bar of sorted) {
    const key = istBucketStart(bar.timestamp, bucket);
    if (!current || key !== currentKey) {
      current = {
        timestamp: new Date(key),
        open: bar.open,
        high: bar.high,
        low: bar.low,
        close: bar.close,
        volume: bar.volume,
      };
      currentKey = key;
      out.push(current);
      continue;
    }
    current.high = Math.max(current.high, bar.high);
    current.low = Math.min(current.low, bar.low);
    current.close = bar.close;
    current.volume += bar.volume;
  }

  return out;
}

/**
 * Map Angel One's `marketData({ mode: 'FULL' })` `data.fetched` array to a
 * quote. Uses the first fetched entry; returns null when nothing was fetched.
 * Mirrors angel-one-adapter.service.ts:712-731.
 */
export function mapFullQuote(fetched: any, token: string): TickData | null {
  if (!Array.isArray(fetched) || fetched.length === 0) return null;
  const d = fetched[0];
  return {
    token: String(d.symbolToken ?? d.symboltoken ?? token),
    symbol: d.tradingSymbol ?? d.tradingsymbol ?? '',
    ltp: Number(d.ltp),
    open: Number(d.open ?? 0),
    high: Number(d.high ?? 0),
    low: Number(d.low ?? 0),
    close: Number(d.close ?? 0),
    volume: Number(d.tradeVolume ?? d.volume),
    oi: d.opnInterest != null ? Number(d.opnInterest) : undefined,
    timestamp: new Date(),
  };
}

/**
 * Slice [fromMs, toMs) into contiguous windows of at most `maxRangeMs`, built
 * oldest→newest. Callers that fetch newest-first (to protect the live edge on
 * throttling) should `.reverse()` the result. Mirrors the window-building loop
 * in angel-one-adapter.service.ts getHistoricalDataUncached.
 */
export function buildChunkWindows(
  fromMs: number,
  toMs: number,
  maxRangeMs: number,
): { start: number; end: number }[] {
  const windows: { start: number; end: number }[] = [];
  for (let cursor = fromMs; cursor < toMs; ) {
    const end = Math.min(cursor + maxRangeMs, toMs);
    windows.push({ start: cursor, end });
    cursor = end;
  }
  return windows;
}
