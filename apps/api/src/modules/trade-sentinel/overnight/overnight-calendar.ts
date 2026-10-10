/**
 * WHEN the sentinel's overnight review runs, and WHICH positions each window
 * judges. Pure: no I/O, no Nest.
 *
 * The live sentinel is silent outside the session, by design (its poll is
 * session-bounded). That left every open F&O position unjudged across the one
 * stretch where it cannot be exited: the night. Two windows close that gap:
 *
 *   after-close  15:45 IST for NSE/NFO/BFO, 23:45 IST for MCX — every open
 *                F&O position on that venue, judged on the finished session;
 *   pre-open     08:50 IST — every open F&O position, before MCX opens at
 *                09:00 and NSE at 09:15.
 *
 * Each window judges each position ONCE. The tag {@link windowTag} is what makes
 * that durable: it is written into the verdict row's `triggeredBy`, so a cron
 * that fires twice or a process that restarts mid-window finds the row and does
 * not judge again.
 *
 * HOLIDAYS ARE MODELLED HERE, unlike `market-sessions.ts`, through the market
 * hub's `SessionClock` over the `MARKET_HOLIDAYS` calendar. A wasted live poll
 * on a holiday costs nothing; a wasted overnight review costs an Opus call and
 * writes a plan for a session that is not going to happen.
 *
 * IMPORT DISCIPLINE: this file is reachable from the overnight service, which
 * `sentinel-cycle.service.spec.ts` walks for order-placing imports. Everything
 * here is pure — `session-clock.ts` imports only `market-sessions.ts` and a type,
 * `market-holidays.service.ts` only `@nestjs/common`.
 */
import { SessionClock } from '../../market-hub/session-clock';
import { MARKET_HOLIDAYS } from '../../market-data/services/market-holidays.service';
import { isDerivativeSegment, segmentFor } from '../charges';
import type { RosterEntry } from '../services/roster.service';

export type ReviewKind = 'OVERNIGHT_REVIEW' | 'PRE_OPEN_REVIEW';
export type ReviewVenue = 'EQUITY' | 'MCX' | 'ALL';

export interface ReviewWindow {
  kind: ReviewKind;
  venue: ReviewVenue;
}

export const AFTER_CLOSE_EQUITY: ReviewWindow = { kind: 'OVERNIGHT_REVIEW', venue: 'EQUITY' };
export const AFTER_CLOSE_MCX: ReviewWindow = { kind: 'OVERNIGHT_REVIEW', venue: 'MCX' };
export const PRE_OPEN: ReviewWindow = { kind: 'PRE_OPEN_REVIEW', venue: 'ALL' };

/**
 * The crons, six-field (seconds first), weekdays only, evaluated in IST.
 *
 * Each fires THREE times a few minutes apart. That is not a cadence — the run is
 * idempotent per position per window, so the second and third fires judge
 * nothing that is already recorded. They exist so that a deploy or crash at
 * 15:44 does not cost the whole night's review: whichever fire lands first after
 * the restart does the work. The pre-open repeats stop at 08:56, before MCX's
 * 09:00 open, so a pre-open verdict is never written against a live market.
 */
export const OVERNIGHT_CRON_EQUITY = '0 45,50,55 15 * * 1-5';
export const OVERNIGHT_CRON_MCX = '0 45,50,55 23 * * 1-5';
export const PRE_OPEN_CRON = '0 50,53,56 8 * * 1-5';

/** One clock over the shipped holiday calendar. Pure; shared by every caller. */
export const SENTINEL_CLOCK = new SessionClock({ holidays: MARKET_HOLIDAYS });

const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

/** IST calendar date of an instant, 'YYYY-MM-DD'. */
export function istYmd(at: Date): string {
  return new Date(at.getTime() + IST_OFFSET_MS).toISOString().slice(0, 10);
}

/** The UTC instant of IST midnight starting `ymd`. */
function istMidnightOf(ymd: string): number {
  return Date.parse(`${ymd}T00:00:00.000Z`) - IST_OFFSET_MS;
}

/** MCX keeps its own evening clock; every other F&O venue keeps the equity session. */
export function venueOf(exchange: string): 'EQUITY' | 'MCX' {
  return String(exchange ?? '').trim().toUpperCase() === 'MCX' ? 'MCX' : 'EQUITY';
}

/**
 * The positions `window` judges at `now`.
 *
 * Three filters, each for its own reason:
 *  - a POSITION, never a holding — holdings are outside the sentinel's remit
 *    (the roster already drops them; repeated here because an overnight Opus
 *    call on long-term equity is exactly the spend that filter exists to stop);
 *  - an F&O contract (OPT/FUT) — cash has no expiry and no overnight decay;
 *  - on this window's venue, and that venue TRADES TODAY. After-close: today's
 *    session happened. Pre-open: today's session will happen. A holiday or a
 *    weekend therefore yields nothing, per exchange.
 */
export function selectForWindow(
  entries: readonly RosterEntry[],
  window: ReviewWindow,
  now: Date,
  clock: SessionClock = SENTINEL_CLOCK,
): RosterEntry[] {
  return entries.filter((e) => {
    if (e.kind !== 'POSITION') return false;
    if (!isDerivativeSegment(segmentFor({ exchange: e.exchange, symbol: e.symbol, kind: e.kind }))) {
      return false;
    }
    if (window.venue !== 'ALL' && venueOf(e.exchange) !== window.venue) return false;
    return clock.isTradingDay(e.exchange, now);
  });
}

/**
 * The idempotency tag: one per window per IST session date. Stored in the
 * verdict row's `triggeredBy` beside the window kind, and looked up before a
 * position is judged.
 */
export function windowTag(window: ReviewWindow, now: Date): string {
  return `window:${window.kind}:${window.venue}:${istYmd(now)}`;
}

/** The most recent session close at or before `now` on `exchange`, holidays skipped. */
export function lastSessionClose(
  exchange: string,
  now: Date,
  clock: SessionClock = SENTINEL_CLOCK,
): Date | null {
  const today = istMidnightOf(istYmd(now));
  for (let d = 0; d <= 14; d++) {
    const midnight = today - d * DAY_MS;
    const w = clock.tradingWindow(exchange, new Date(midnight));
    if (!w) continue;
    const close = midnight + w.closeMin * 60_000;
    if (close <= now.getTime()) return new Date(close);
  }
  return null;
}

/** The next session open strictly after `now` on `exchange`, holidays skipped. */
export function nextSessionOpen(
  exchange: string,
  now: Date,
  clock: SessionClock = SENTINEL_CLOCK,
): Date | null {
  return clock.nextOpen(exchange, now);
}

/**
 * Calendar days from today to the expiry date, and the trading sessions still
 * ahead of the position (today's counts only while it has not closed yet).
 * Null — never 0 — when the expiry is missing or unreadable: zero days to expiry
 * is a real, alarming fact and must not be manufactured from a missing field.
 */
export function daysToExpiry(
  expiry: string | null,
  exchange: string,
  now: Date,
  clock: SessionClock = SENTINEL_CLOCK,
): { calendarDays: number; tradingSessionsLeft: number } | null {
  if (!expiry || !/^\d{4}-\d{2}-\d{2}$/.test(expiry)) return null;
  const expiryMidnight = istMidnightOf(expiry);
  if (!Number.isFinite(expiryMidnight)) return null;
  const todayYmd = istYmd(now);
  const today = istMidnightOf(todayYmd);
  const calendarDays = Math.round((expiryMidnight - today) / DAY_MS);

  let sessions = 0;
  for (let m = today; m <= expiryMidnight; m += DAY_MS) {
    const w = clock.tradingWindow(exchange, new Date(m));
    if (!w) continue;
    // Today's session counts only if it has not finished.
    if (m === today && now.getTime() >= m + w.closeMin * 60_000) continue;
    sessions += 1;
  }
  return { calendarDays, tradingSessionsLeft: sessions };
}
