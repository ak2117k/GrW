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
 *   pre-open     08:30 IST — every open F&O position, before MCX opens at
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
import { SessionClock, parseLateClose } from '../../market-hub/session-clock';
import { MARKET_HOLIDAYS } from '../../market-data/services/market-holidays.service';
import { isDerivativeSegment, segmentFor } from '../charges';
import type { RosterEntry } from '../services/roster.service';

export type ReviewKind = 'OVERNIGHT_REVIEW' | 'PRE_OPEN_REVIEW' | 'PRE_OPEN_CHECK';
export type ReviewVenue = 'EQUITY' | 'MCX' | 'ALL';

export interface ReviewWindow {
  kind: ReviewKind;
  venue: ReviewVenue;
}

export const AFTER_CLOSE_EQUITY: ReviewWindow = { kind: 'OVERNIGHT_REVIEW', venue: 'EQUITY' };
export const AFTER_CLOSE_MCX: ReviewWindow = { kind: 'OVERNIGHT_REVIEW', venue: 'MCX' };
export const PRE_OPEN: ReviewWindow = { kind: 'PRE_OPEN_REVIEW', venue: 'ALL' };
/**
 * The 09:10 pre-open CHECK: a light second look at NSE F&O positions once the
 * NSE pre-open has matched (09:08) and before the 09:15 open, on the pre-open
 * IEP. Equity venues only — MCX has no price-discovery pre-open.
 */
export const PRE_OPEN_CHECK: ReviewWindow = { kind: 'PRE_OPEN_CHECK', venue: 'EQUITY' };

/**
 * The crons, six-field (seconds first), weekdays only, evaluated in IST.
 *
 * EVERY FIRE IS GATED ON THE CLOCK saying the venue's session is closed (see
 * {@link reviewWindowIsClosed}), so a fire that lands while the venue still
 * trades reviews nothing. MCX closes at 23:30 normally and 23:55 while the US is OFF DST
 * season (`HUB_MCX_LATE_CLOSE`): the 23:45/23:50 fires serve the normal season,
 * 23:55/23:58 and the after-midnight fires (Tue–Sat 00:03/00:08) serve the late
 * season. A fire after midnight is tagged with the session that just closed.
 *
 * Each fires SEVERAL times a few minutes apart. That is not a cadence — the run is
 * idempotent per position per window, so the second and third fires judge
 * nothing that is already recorded. They exist so that a deploy or crash at
 * 15:44 does not cost the whole night's review: whichever fire lands first after
 * the restart does the work. The pre-open repeats stop at 08:40, before MCX's
 * 09:00 open, so a pre-open verdict is never written against a live market.
 */
export const OVERNIGHT_CRON_EQUITY = '0 45,50,55 15 * * 1-5';
export const OVERNIGHT_CRON_MCX = '0 45,50,55,58 23 * * 1-5';
export const OVERNIGHT_CRON_MCX_LATE = '0 3,8 0 * * 2-6';
export const PRE_OPEN_CRON = '0 30,35,40 8 * * 1-5';
/**
 * 09:10 (the market-cues pre-open snapshot's minute), repeated at 09:11. Not later: no
 * judge job may START within CLI_TIMEOUT_MS (180 s) of the 09:15 open, so 09:12:00
 * is the last possible start.
 */
export const PRE_OPEN_CHECK_CRON = '0 10,11 9 * * 1-5';

/**
 * The default clock: the shipped holiday calendar, NO late-close season. The
 * overnight service builds its own with {@link makeSentinelClock} from
 * `hub.mcxLateClose`; this default is for pure callers and tests. DO NOT use it
 * for anything that decides whether an MCX position is live after 23:30 — the
 * live runner uses {@link makeSentinelClock} and the packet {@link liveSessionClock}.
 */
export const SENTINEL_CLOCK = new SessionClock({ holidays: MARKET_HOLIDAYS });

/** A clock over the holiday calendar AND the MCX late-close season (HUB_MCX_LATE_CLOSE syntax). */
export function makeSentinelClock(mcxLateCloseRaw?: string): SessionClock {
  return new SessionClock({ holidays: MARKET_HOLIDAYS, mcxLateClose: parseLateClose(mcxLateCloseRaw) });
}

let liveClock: { raw: string; clock: SessionClock } | null = null;

/**
 * The clock the LIVE sentinel's pure helpers use when no clock is handed to them
 * (the packet's `session.minutesToClose`): holidays plus the late-close season
 * from `HUB_MCX_LATE_CLOSE` — the same env var `configuration.ts` maps to
 * `hub.mcxLateClose`. Read at CALL time, never at import (so a .env loaded by
 * ConfigModule is seen), and rebuilt only when the raw value changes.
 *
 * Without the season, every live MCX position from 2026-11-02 was declared
 * "closed" at 23:31 while MCX trades to 23:55.
 */
export function liveSessionClock(): SessionClock {
  const raw = process.env.HUB_MCX_LATE_CLOSE ?? '';
  if (!liveClock || liveClock.raw !== raw) liveClock = { raw, clock: makeSentinelClock(raw) };
  return liveClock.clock;
}

/** The venues the live tick's clock-only pre-gate asks about — the widest windows any holding keeps. */
const PRE_GATE_VENUES = ['NSE', 'BSE', 'MCX'] as const;

/**
 * Could ANY venue be trading now, by the holiday- and late-close-aware clock?
 * The runner's cheap pre-gate before it queries what anyone holds.
 */
export function isAnyVenueOpen(clock: SessionClock, now: Date): boolean {
  return PRE_GATE_VENUES.some((venue) => clock.isOpen(venue, now));
}

/** Whether any of the exchanges a user holds is trading now. Empty = closed. */
export function isAnyHeldVenueOpen(
  clock: SessionClock,
  exchanges: readonly string[],
  now: Date,
): boolean {
  return exchanges.some((exchange) => clock.isOpen(String(exchange ?? '').trim().toUpperCase(), now));
}

/**
 * How long after a session close an after-close review still belongs to it.
 * Covers the after-midnight MCX fires; short enough that a holiday or a weekend
 * (whose last close is a day or more old) reviews nothing.
 */
export const AFTER_CLOSE_GRACE_MS = 3 * 60 * 60 * 1000;

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
 * Filters, each for its own reason:
 *  - a POSITION, never a holding — holdings are outside the sentinel's remit
 *    (the roster already drops them; repeated here because an overnight Opus
 *    call on long-term equity is exactly the spend that filter exists to stop);
 *  - an F&O contract (OPT/FUT) — cash has no expiry and no overnight decay;
 *  - on this window's venue, and the venue's clock agrees the window applies
 *    ({@link reviewWindowIsClosed}): after-close only once the session has
 *    actually closed (and closed recently), pre-open only on a trading day
 *    before the venue's first print. A holiday or a weekend yields nothing.
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
    return reviewWindowIsClosed(window, e.exchange, now, clock);
  });
}

/**
 * Whether `window` may judge a position on `exchange` at `now`: the venue's
 * session must be CLOSED and the window must be the right side of it.
 *
 *  - after-close: the clock says closed (so a 23:45 fire in the 23:55 season
 *    is refused) and the last close is within {@link AFTER_CLOSE_GRACE_MS};
 *  - pre-open: a trading day, before the venue's first print — 09:00 for MCX
 *    (its open) and for NSE/BSE and their F&O (the cash pre-open begins then);
 *  - pre-open check: an equity venue on a trading day, 09:08–09:15.
 */
export function reviewWindowIsClosed(
  window: ReviewWindow,
  exchange: string,
  now: Date,
  clock: SessionClock = SENTINEL_CLOCK,
): boolean {
  if (clock.phase(exchange, now) !== 'closed') return false;
  if (window.kind === 'OVERNIGHT_REVIEW') {
    const close = lastSessionClose(exchange, now, clock);
    return close !== null && now.getTime() - close.getTime() <= AFTER_CLOSE_GRACE_MS;
  }
  if (!clock.isTradingDay(exchange, now)) return false;
  const minutes = Math.floor((now.getTime() - istMidnightOf(istYmd(now))) / 60_000);
  if (window.kind === 'PRE_OPEN_CHECK') {
    return venueOf(exchange) === 'EQUITY' && minutes >= PRE_OPEN_MATCHED_MIN && minutes < EQUITY_OPEN_MIN;
  }
  return minutes < PRE_OPEN_FIRST_PRINT_MIN;
}

/** 09:08 IST: the NSE pre-open order entry has closed and the IEP is set. */
const PRE_OPEN_MATCHED_MIN = 9 * 60 + 8;
/** 09:15 IST: the NSE/BSE normal session opens — the pre-open check is dropped from here. */
const EQUITY_OPEN_MIN = 9 * 60 + 15;

/** 09:00 IST: MCX opens, and the NSE/BSE pre-open order collection begins. */
const PRE_OPEN_FIRST_PRINT_MIN = 9 * 60;

/**
 * The idempotency tag: one per window per IST session date. Stored in the
 * verdict row's `triggeredBy` beside the window kind, and looked up before a
 * position is judged.
 *
 * After-close: the date of the session that JUST CLOSED on the window's venue —
 * so a 00:03 MCX fire carries the same tag as the 23:45 one. Pre-open: today.
 */
export function windowTag(window: ReviewWindow, now: Date, clock: SessionClock = SENTINEL_CLOCK): string {
  let ymd = istYmd(now);
  if (window.kind === 'OVERNIGHT_REVIEW') {
    const close = lastSessionClose(window.venue === 'MCX' ? 'MCX' : 'NSE', now, clock);
    if (close) ymd = istYmd(close);
  }
  return `window:${window.kind}:${window.venue}:${ymd}`;
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
