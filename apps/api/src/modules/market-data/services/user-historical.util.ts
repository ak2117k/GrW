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
