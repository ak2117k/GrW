// apps/api/src/modules/mbm/domain/bar-window.ts
// Pure window math for the MBM 1m bar refresher (plan §4). All instants are UTC Dates; IST is
// derived by a fixed +05:30 shift (the API container runs in UTC).
import type { Candle } from '../../market-data/services/user-historical.util';

const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;
const MINUTE_MS = 60_000;

/** Ticks run between 09:15 and 15:35 IST inclusive (5 min after the close, to pick up the last bars). */
export const TICK_FROM_MIN = 9 * 60 + 15;
export const TICK_TO_MIN = 15 * 60 + 35;
/** Sessions re-fetched at boot. */
export const CATCH_UP_SESSIONS = 3;

/** The slice of SessionClock the refresher needs (NSE calendar, holidays included). */
export interface NseCalendar {
  isTradingDay(exchange: string, at?: Date): boolean;
  tradingWindow(exchange: string, at?: Date): { openMin: number; closeMin: number } | null;
}

const istMinutes = (at: Date): number => {
  const d = new Date(at.getTime() + IST_OFFSET_MS);
  return d.getUTCHours() * 60 + d.getUTCMinutes();
};

/** UTC instant of IST midnight `daysBack` days before `at`'s IST date. */
const istMidnight = (at: Date, daysBack: number): Date => {
  const d = new Date(at.getTime() + IST_OFFSET_MS);
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() - daysBack) - IST_OFFSET_MS);
};

/** True when a cron tick at `now` should fetch: an NSE trading day, 09:15–15:35 IST. Weekends/holidays: false. */
export function isRefreshTick(cal: NseCalendar, now: Date): boolean {
  if (!cal.isTradingDay('NSE', now)) return false;
  const m = istMinutes(now);
  return m >= TICK_FROM_MIN && m <= TICK_TO_MIN;
}

/**
 * Opens of the most recent `n` NSE sessions that have started by `now`, newest first
 * (today counts once it has opened). Searches 30 days back.
 */
export function recentSessionOpens(cal: NseCalendar, now: Date, n: number): Date[] {
  const opens: Date[] = [];
  for (let d = 0; d <= 30 && opens.length < n; d++) {
    const midnight = istMidnight(now, d);
    const w = cal.tradingWindow('NSE', midnight);
    if (!w) continue;
    const open = new Date(midnight.getTime() + w.openMin * MINUTE_MS);
    if (open.getTime() <= now.getTime()) opens.push(open);
  }
  return opens;
}

/** Floor for a regular tick: today's session open (null when NSE has not opened today). */
export function tickFloor(cal: NseCalendar, now: Date): Date | null {
  const [latest] = recentSessionOpens(cal, now, 1);
  return latest && istMidnight(latest, 0).getTime() === istMidnight(now, 0).getTime() ? latest : null;
}

/** Floor for the boot catch-up: the open of the `CATCH_UP_SESSIONS`-th most recent session. */
export function catchUpFloor(cal: NseCalendar, now: Date, sessions = CATCH_UP_SESSIONS): Date | null {
  const opens = recentSessionOpens(cal, now, sessions);
  return opens.length ? opens[opens.length - 1] : null;
}

/**
 * Where a series' fetch starts: its last stored bar (re-fetched, so a bar stored while still forming
 * is corrected) when that is at/after the floor, else the floor. Never earlier than the floor, so a
 * long outage cannot turn into a months-long fetch.
 */
export function fetchFrom(lastTs: Date | null, floor: Date): Date {
  return lastTs && lastTs.getTime() >= floor.getTime() ? lastTs : floor;
}

/** Bars that are complete at `now` (start + 1 min ≤ now), at/after `from`, with finite OHLC. */
export function completedBars(candles: readonly Candle[], from: Date, now: Date): Candle[] {
  return candles.filter((c) => {
    const t = c.timestamp?.getTime();
    return (
      Number.isFinite(t) &&
      t >= from.getTime() &&
      t + MINUTE_MS <= now.getTime() &&
      [c.open, c.high, c.low, c.close].every(Number.isFinite)
    );
  });
}
