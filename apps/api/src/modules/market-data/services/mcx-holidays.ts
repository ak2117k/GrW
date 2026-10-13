/**
 * MCX's OWN holiday calendar — the single place MCX holiday data lives.
 *
 * MCX does not simply follow NSE. On most NSE trading holidays MCX still runs
 * an EVENING session (from 17:00 IST to its normal close: 23:30, or 23:55 in
 * the US-off-DST late-close season); on a few days it is shut all day. The old
 * calendar marked MCX fully closed on every NSE holiday, which left every MCX
 * position unwatched (sentinel, auto-exit, hub) through a live evening session.
 *
 * HOW A DATE RESOLVES FOR MCX (SessionClock.mcxDay):
 *   1. listed here            → its `session` ('CLOSED' all day, or 'EVENING');
 *   2. else an NSE holiday    → MCX_DEFAULT_ON_NSE_HOLIDAY ('EVENING');
 *   3. else                   → a normal 09:00 → close day.
 * A generic MARKET_HOLIDAYS entry that explicitly lists 'MCX' in `exchanges` is
 * still honoured as a full MCX close.
 *
 * DATA STATUS — OWNER ACTION REQUIRED: the repo has NO sourced MCX 2026 holiday
 * list, so this table is intentionally EMPTY and every NSE holiday defaults to
 * an MCX evening session (the sentinel keeps watching — the safe direction:
 * watching a shut market costs a few polls, not watching an open one costs an
 * unmanaged position). Load the official MCX 2026 (and 2027) trading-holiday
 * circular here: each date MCX is closed for BOTH sessions as 'CLOSED', and any
 * MCX-only morning closure on an NSE trading day as 'EVENING'. Do not invent
 * dates.
 */
export type McxHolidaySession = 'CLOSED' | 'EVENING';

export interface McxHoliday {
  date: string; // YYYY-MM-DD (IST)
  name: string;
  session: McxHolidaySession;
}

/** 17:00 IST — when MCX's evening session opens on a holiday. */
export const MCX_EVENING_OPEN_MIN = 17 * 60;

/** What an NSE holiday means for MCX when the MCX list says nothing about it. */
export const MCX_DEFAULT_ON_NSE_HOLIDAY: McxHolidaySession = 'EVENING';

/** MCX holiday overrides by calendar year. EMPTY until the owner loads the official list (see above). */
export const MCX_HOLIDAYS: Readonly<Record<number, readonly McxHoliday[]>> = {
  2026: [],
};
