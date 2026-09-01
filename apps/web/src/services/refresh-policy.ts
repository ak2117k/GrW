import type { MarketStatus } from '@/types';

/**
 * The one place that decides when the app is allowed to fetch.
 *
 * The audit behind this program counted 49 `setInterval` loops across 36 files,
 * zero `visibilitychange` listeners and zero `online` listeners. Every loop
 * re-decided cadence for itself and none of them decided recovery at all, which
 * is why a stall "sometimes" cleared on tab-return: nothing was catching up,
 * the user simply returned shortly before an interval happened to fire.
 *
 * These helpers are pure and take an explicit clock so the rules can be
 * asserted directly, rather than being reconstructed inside each call site.
 */

/** IST wall-clock minutes past midnight, plus the weekday, for a given instant. */
function istParts(now: Date): { minutes: number; weekday: string } {
  const parts = new Intl.DateTimeFormat('en-IN', {
    timeZone: 'Asia/Kolkata',
    hour: 'numeric',
    minute: 'numeric',
    weekday: 'short',
    hour12: false,
  }).formatToParts(now);

  const hour = Number(parts.find((p) => p.type === 'hour')?.value ?? 0);
  const minute = Number(parts.find((p) => p.type === 'minute')?.value ?? 0);
  return {
    minutes: hour * 60 + minute,
    weekday: parts.find((p) => p.type === 'weekday')?.value ?? '',
  };
}

const PRE_MARKET_OPEN = 9 * 60; // 09:00
const NSE_OPEN = 9 * 60 + 15; // 09:15
const NSE_CLOSE = 15 * 60 + 30; // 15:30
const MCX_OPEN = 9 * 60; // 09:00
const MCX_CLOSE = 23 * 60 + 30; // 23:30

/**
 * Which session the given instant falls in, in IST.
 *
 * Deliberately covers MCX as well as NSE: gating on the 15:30 equity close
 * alone would freeze the commodity screens for the eight hours MCX keeps
 * trading. Mirrors the backend's session rule in spirit — the backend reports
 * the NSE session for its freshness ages; this decides whether anything on the
 * client should be fetching at all.
 *
 * Takes `now` so the boundaries are testable without mocking the clock.
 */
export function marketPhase(now: Date = new Date()): MarketStatus {
  const { minutes, weekday } = istParts(now);

  if (weekday === 'Sat' || weekday === 'Sun') return 'closed';

  const nseOpen = minutes >= NSE_OPEN && minutes <= NSE_CLOSE;
  const mcxOpen = minutes >= MCX_OPEN && minutes <= MCX_CLOSE;
  if (nseOpen || mcxOpen) return 'open';
  if (minutes >= PRE_MARKET_OPEN && minutes < NSE_OPEN) return 'pre-market';
  return 'closed';
}

/**
 * The interval to poll at, or `false` for "do not poll".
 *
 * `false` rather than a long interval on purpose. A slow poll against a shut
 * market still wakes the serverless database on every tick, and that — not
 * query cost — is what is actually billed.
 */
export function pollIntervalMs(baseMs: number, phase: MarketStatus): number | false {
  return phase === 'closed' ? false : baseMs;
}

/** Longest gap between retries. Beyond this a failure is not transient. */
const MAX_RETRY_DELAY_MS = 30_000;

/** Exponential backoff from 1s, capped. Attempt is zero-based. */
export function retryDelayMs(attempt: number): number {
  return Math.min(MAX_RETRY_DELAY_MS, 1_000 * 2 ** attempt);
}

/**
 * A `refetchInterval` for TanStack Query that re-checks the session each time.
 *
 * Returned as a function, not a number, because TanStack re-evaluates it after
 * every fetch. A query mounted at 15:29 therefore stops on its own at the close
 * instead of polling into the night — the call site does not have to notice.
 */
export function marketAwareInterval(
  baseMs: number,
  now: () => Date = () => new Date(),
): () => number | false {
  return () => pollIntervalMs(baseMs, marketPhase(now()));
}

/**
 * Shortest gap between catch-up refreshes triggered by a tab or network return.
 *
 * Short on purpose. This is not the socket's re-arm cooldown — nothing is being
 * retried here, we are simply refetching data that may have gone stale while the
 * tab was hidden. A long floor would leave a returning user staring at an old
 * chart for no reason; this only exists so that flicking between two tabs cannot
 * hammer the API for data it fetched a moment ago.
 */
export const RETURN_REFRESH_COOLDOWN_MS = 2_000;

/**
 * Should a tab-return or `online` event trigger an immediate refresh?
 *
 * There is no catch-up anywhere in this app today, and that absence is the
 * reported "shows old data / graph doesn't update". A hidden tab's timers are
 * throttled by the browser — Chrome drops them to roughly one a minute and may
 * freeze them entirely — and `useChartData` additionally refuses to fetch while
 * `document.hidden`. So on return the chart holds whatever bar it had when the
 * user left, until an interval happens to fire. Sometimes that is soon, which is
 * why the bug looked intermittent.
 *
 * Gated on the market being open for the same reason polling is: returning to a
 * tab at 03:00 should cost nothing.
 */
export function shouldRefreshOnReturn(opts: {
  msSinceLastRefresh: number;
  phase: MarketStatus;
}): boolean {
  if (opts.phase === 'closed') return false;
  return opts.msSinceLastRefresh >= RETURN_REFRESH_COOLDOWN_MS;
}
