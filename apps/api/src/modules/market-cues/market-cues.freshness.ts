/**
 * The status rules: when a stored cue is `ok`, `stale` or `unavailable`.
 * Evaluated at READ time against `now`, so a record fetched fresh goes stale on
 * its own as the clock moves. Pure — the session clock is passed in.
 */
import type { SessionClock } from '../market-hub/session-clock';
import type { CueStatus } from './market-cues.types';
import { istAt, istMinutes, istYmd } from './fetchers/ist-dates';

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

export interface Freshness {
  status: Exclude<CueStatus, 'unavailable'>;
  reason?: string;
}

/** A quote with its own time: stale past `maxAgeMs`. */
export function quoteAge(sourceTime: string, now: Date, maxAgeMs: number, what: string): Freshness {
  const t = Date.parse(sourceTime);
  if (!Number.isFinite(t)) return { status: 'stale', reason: `${what}: source time unreadable` };
  const age = now.getTime() - t;
  if (age > maxAgeMs) {
    return { status: 'stale', reason: `${what} is ${Math.round(age / 60_000)} minutes old (limit ${Math.round(maxAgeMs / 60_000)})` };
  }
  return { status: 'ok' };
}

/**
 * The US session date a US index close should describe at `now`: the latest
 * weekday whose 16:00 ET close (taken as 21:00 UTC, the later of EDT/EST) has
 * passed. US market holidays are NOT modelled — on the day after one the close
 * reads stale, and the reason says a holiday also reads that way.
 */
export function expectedUsSession(now: Date): string {
  for (let d = 0; d <= 7; d++) {
    const day = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - d, 21));
    const dow = day.getUTCDay();
    if (dow === 0 || dow === 6) continue;
    if (day.getTime() <= now.getTime()) return day.toISOString().slice(0, 10);
  }
  return now.toISOString().slice(0, 10);
}

export function usCloseFreshness(sourceTime: string, now: Date): Freshness {
  const session = sourceTime.slice(0, 10);
  const expected = expectedUsSession(now);
  if (session < expected) {
    return {
      status: 'stale',
      reason: `the close is from the ${session} US session; the last US weekday session was ${expected} (a US market holiday also reads this way)`,
    };
  }
  return { status: 'ok' };
}

/**
 * The latest NSE session whose evening publication should exist by `now`:
 * today once `publishMin` (IST minutes) has passed on a trading day, else the
 * trading day before. Holidays come from the clock.
 */
export function expectedPublishedSession(now: Date, clock: SessionClock, publishMin: number): string | null {
  const today = istYmd(now);
  for (let d = 0; d <= 14; d++) {
    const ymd = istYmd(new Date(istAt(today, 12).getTime() - d * DAY_MS));
    if (!clock.isTradingDay('NSE', istAt(ymd, 12))) continue;
    if (d === 0 && istMinutes(now) < publishMin) continue;
    return ymd;
  }
  return null;
}

/**
 * An end-of-day NSE publication (FII/DII, participant OI) dated `date`.
 * Stale when a later session's figure should be out by now. When today's is
 * simply not due yet, the record is ok and the reason says today's is pending.
 */
export function publishedFreshness(
  date: string,
  now: Date,
  clock: SessionClock,
  publishMin: number,
  pendingNote: string,
): Freshness {
  const expected = expectedPublishedSession(now, clock, publishMin);
  if (expected && date < expected) {
    return { status: 'stale', reason: `this is the ${date} figure; the ${expected} figure should be published by now` };
  }
  const today = istYmd(now);
  if (date < today && clock.isTradingDay('NSE', now) && istMinutes(now) < publishMin) {
    return { status: 'ok', reason: `today's (${today}) figure is not yet published (${pendingNote}); this is the ${date} session's` };
  }
  return { status: 'ok' };
}

/** A pre-open book is only today's or it is stale. */
export function preOpenFreshness(date: string, now: Date): Freshness {
  const today = istYmd(now);
  return date === today ? { status: 'ok' } : { status: 'stale', reason: `the pre-open book is from ${date}, not today (${today})` };
}

export const US_FUTURES_MAX_AGE_MS = 6 * HOUR_MS;
/** A mid-session US index value is only current for this long. */
export const US_INTRADAY_MAX_AGE_MS = 2 * HOUR_MS;

const NY_PARTS = new Intl.DateTimeFormat('en-US', {
  timeZone: 'America/New_York',
  weekday: 'short',
  hour: '2-digit',
  minute: '2-digit',
  hourCycle: 'h23',
});

/**
 * Whether a US index value timed `sourceTime` is mid-session ('intraday') or a
 * completed close: intraday when New York time is 09:30–16:00 on a weekday.
 * US market holidays and early closes are NOT modelled. A bare session date
 * ('YYYY-MM-DD', the CNBC fallback's index time) is a close.
 */
export function usPhaseAt(sourceTime: string): 'intraday' | 'close' {
  if (/^\d{4}-\d{2}-\d{2}$/.test(sourceTime)) return 'close';
  const t = Date.parse(sourceTime);
  if (!Number.isFinite(t)) return 'close';
  const parts = Object.fromEntries(NY_PARTS.formatToParts(new Date(t)).map((p) => [p.type, p.value]));
  if (parts.weekday === 'Sat' || parts.weekday === 'Sun') return 'close';
  const min = Number(parts.hour) * 60 + Number(parts.minute);
  return min >= 9 * 60 + 30 && min < 16 * 60 ? 'intraday' : 'close';
}
/** GIFT's night session ends ~02:45 IST; 08:25 is under six hours later. */
export const GIFT_MAX_AGE_MS = 8 * HOUR_MS;
/** NSE publishes FII/DII ~18:00–20:00 IST. */
export const FII_DII_PUBLISH_MIN = 20 * 60;
/** The participant-OI archive appears in the evening; treated as due by 21:00 IST. */
export const FII_OI_PUBLISH_MIN = 21 * 60;
