/**
 * Resolving "the most recent session that actually traded".
 *
 * Pure and dependency-free so the overnight/weekend behaviour is testable
 * without a Nest container, a clock, or a DB.
 *
 * Why this exists: a 5m replay window pinned to `[today 09:15 IST, now]` is
 * EMPTY whenever `now` is before today's open — every night, every weekend,
 * every holiday. The book's intraday state (spot, VWAP, today's high/low, the
 * opening range) then stays at its 0 seed, and consumers read a book that
 * looks like a symbol which has never traded.
 *
 * Walking back a fixed 24h doesn't fix it either: from 03:00 on a Monday that
 * lands on Sunday. Rather than carry a trading calendar, fetch a few days and
 * keep the bars belonging to the newest session present — which is correct
 * across weekends and holidays alike, because a day that didn't trade
 * contributes no bars to group.
 */

const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;

/**
 * Calendar days to reach back when today's window came up empty. Five clears a
 * Friday→Tuesday gap (weekend plus a Monday holiday), which is the longest
 * ordinary break on the NSE calendar.
 */
export const SESSION_LOOKBACK_DAYS = 5;

/**
 * The IST calendar date a bar belongs to, as `YYYY-MM-DD`.
 *
 * IST is UTC+5:30 and the NSE session (09:15–15:30 IST) sits inside one IST
 * day, so the IST date is a safe session key. The UTC date is NOT: the session
 * spans 03:45–10:00 UTC, and a naive UTC grouping would still work today but
 * breaks the moment a pre-open or commodities bar crosses midnight UTC.
 */
export function istSessionDate(timestamp: Date): string | null {
  const ms = timestamp?.getTime?.();
  if (typeof ms !== 'number' || !Number.isFinite(ms)) return null;
  return new Date(ms + IST_OFFSET_MS).toISOString().slice(0, 10);
}

/**
 * The bars of the newest session in `bars`, in chronological order.
 *
 * Order matters: the caller replays these through `updateFromTick`, which
 * accumulates VWAP and takes the FIRST three bars as the opening range, so a
 * shuffled series would produce a wrong OR and a wrong VWAP.
 *
 * Bars with an unusable timestamp are dropped rather than bucketed together —
 * one NaN date must not become a "session" of its own and shadow the real one.
 */
export function mostRecentSessionBars<T extends { timestamp: Date }>(bars: T[]): T[] {
  if (!Array.isArray(bars) || bars.length === 0) return [];

  const dated = bars
    .map((bar) => ({ bar, date: istSessionDate(bar.timestamp) }))
    .filter((entry): entry is { bar: T; date: string } => entry.date !== null);
  if (dated.length === 0) return [];

  let newest = dated[0].date;
  for (const { date } of dated) if (date > newest) newest = date;

  return dated
    .filter(({ date }) => date === newest)
    .sort((a, b) => a.bar.timestamp.getTime() - b.bar.timestamp.getTime())
    .map(({ bar }) => bar);
}
