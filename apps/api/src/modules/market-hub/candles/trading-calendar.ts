import type { SessionClock } from '../session-clock';
import { TABLE_BAR_MIN, type CandleTable } from './candle.types';

/**
 * The CandleStore's notion of "which bars should exist". All IST arithmetic
 * for candles lives here; everything else passes ms epoch instants.
 */
const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;
const MINUTE_MS = 60_000;

/** IST calendar date (YYYY-MM-DD) of an instant. */
export function istDay(ms: number): string {
  return new Date(ms + IST_OFFSET_MS).toISOString().slice(0, 10);
}

/** The instant of IST midnight that starts `ymd`. */
export function istMidnight(ymd: string): number {
  return Date.parse(`${ymd}T00:00:00.000Z`) - IST_OFFSET_MS;
}

export function addDays(ymd: string, n: number): string {
  return istDay(istMidnight(ymd) + n * DAY_MS);
}

/**
 * Per IST day in [from, to): how many COMPLETED bars (end ≤ asOf) the exchange
 * should have produced for `table`. Days with none (weekend, holiday, not yet
 * closed) are omitted. A bar's end is clipped to the session close (NSE's last
 * hourly bar is 15:15–15:30).
 */
export function expectedPerDay(
  clock: SessionClock,
  exchange: string,
  table: CandleTable,
  from: number,
  to: number,
  asOf: number,
): Map<string, number> {
  const out = new Map<string, number>();
  if (to <= from) return out;
  for (let ymd = istDay(from); istMidnight(ymd) < to; ymd = addDays(ymd, 1)) {
    const midnight = istMidnight(ymd);
    const w = clock.tradingWindow(exchange, new Date(midnight));
    if (!w) continue;
    const close = midnight + w.closeMin * MINUTE_MS;
    let n = 0;
    if (table === '1d') {
      if (midnight >= from && midnight < to && close <= asOf) n = 1;
    } else {
      const step = TABLE_BAR_MIN[table];
      for (let m = w.openMin; m < w.closeMin; m += step) {
        const start = midnight + m * MINUTE_MS;
        if (start < from || start >= to) continue;
        if (Math.min(start + step * MINUTE_MS, close) <= asOf) n++;
      }
    }
    if (n > 0) out.set(ymd, n);
  }
  return out;
}

/** When the bar starting at `start` is complete. Off-session bars end after their nominal width. */
export function barEnd(clock: SessionClock, exchange: string, table: CandleTable, start: number): number {
  const midnight = istMidnight(istDay(start));
  const w = clock.tradingWindow(exchange, new Date(midnight));
  const nominal = table === '1d' ? midnight + DAY_MS : start + TABLE_BAR_MIN[table] * MINUTE_MS;
  if (!w) return nominal;
  const close = midnight + w.closeMin * MINUTE_MS;
  return table === '1d' ? close : Math.min(nominal, close);
}
