/**
 * Entry-window time gate.
 *
 * New positions (a Chartink WATCHING entry, or a fresh buy from a WATCHING
 * entry) may only be OPENED during regular market entry hours. After 15:00 IST
 * no new entry/execution is permitted — the last 30 minutes of the session are
 * reserved for managing and exiting already-open positions, never for opening.
 *
 * This gate is for OPENING positions only. It deliberately does NOT cover the
 * full 15:30 session: the rescore loop (WatchMonitorService.isMarketHours) and
 * every exit path keep running until 15:30 / EOD so open positions are still
 * managed and squared off normally.
 *
 * IST = UTC + 5:30. The IST math here mirrors
 * WatchMonitorService.isMarketHours().
 */

/** Entry window opens at 09:15 IST — minutes since IST midnight. */
export const ENTRY_WINDOW_OPEN_MIN = 9 * 60 + 15;

/** Entry window closes at 15:00 IST (inclusive) — minutes since IST midnight. */
export const ENTRY_WINDOW_CLOSE_MIN = 15 * 60;

/** IST is UTC + 5:30. */
const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;

/**
 * Returns true iff `now` falls on a weekday (Mon–Fri) AND the IST wall-clock
 * time is within [09:15, 15:00] inclusive. Used as the gate for OPENING a new
 * position — never for rescoring or exiting an existing one.
 *
 * @param now defaults to the current time.
 */
export function isWithinEntryWindow(now: Date = new Date()): boolean {
  const ist = new Date(now.getTime() + IST_OFFSET_MS);
  const day = ist.getUTCDay();
  if (day === 0 || day === 6) return false; // Sunday / Saturday
  const totalMin = ist.getUTCHours() * 60 + ist.getUTCMinutes();
  return totalMin >= ENTRY_WINDOW_OPEN_MIN && totalMin <= ENTRY_WINDOW_CLOSE_MIN;
}
