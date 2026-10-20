/**
 * The outcome filler (design §5): a row's outcome is the underlying's open→close move on the first
 * NSE session that opens after the row was computed. Gross, in basis points, not side-adjusted (the
 * monthly report compares each factor's sign with it).
 */
import type { SessionClock } from '../../market-hub/session-clock';
import { outcomeSession } from './windows';

export interface DailyBar {
  /** IST session date 'YYYY-MM-DD'. */
  day: string;
  open: number;
  close: number;
}

export interface Outcome {
  nextOpen: number;
  nextClose: number;
  moveBp: number;
}

/** Rows older than this without a bar are given up on (the filler stops retrying them). */
export const OUTCOME_GIVE_UP_DAYS = 10;

/**
 * `null` = not fillable yet: the outcome session has not closed by `now`, or its daily bar is
 * missing (the next run retries).
 */
export function outcomeFor(at: Date, bars: readonly DailyBar[], now: Date, clock: SessionClock): Outcome | null {
  const day = outcomeSession(at, clock);
  if (!day) return null;
  const w = clock.tradingWindow('NSE', new Date(`${day}T12:00:00+05:30`));
  if (!w) return null;
  const closeAt = new Date(`${day}T00:00:00+05:30`).getTime() + w.closeMin * 60_000;
  if (now.getTime() < closeAt) return null;
  const bar = bars.find((b) => b.day === day);
  if (!bar || !(bar.open > 0) || !Number.isFinite(bar.close)) return null;
  return { nextOpen: bar.open, nextClose: bar.close, moveBp: Math.round(((bar.close - bar.open) / bar.open) * 1e4 * 10) / 10 };
}
