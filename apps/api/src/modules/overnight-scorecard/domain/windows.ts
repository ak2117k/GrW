/**
 * When each job may run. The crons fire on the clock; these gates decide on the NSE calendar, so a
 * holiday (Dussehra, Tue 2026-10-20) or a weekend produces nothing rather than a stale row.
 *
 *  - OVERNIGHT scorecards (15:40 IST): only on an NSE trading day, after the 15:30 close.
 *  - PRE_OPEN scorecards (08:50 IST): only on an NSE trading day, before the 09:15 open.
 *  - News ideas NIGHT batch (23:30 IST): only when the next NSE open is TOMORROW (IST) — the news
 *    of a night before a holiday is picked up by the next qualifying night (its window starts at the
 *    last close, so nothing is lost).
 *  - News ideas MORNING batch (08:40 IST): only on an NSE trading day.
 */
import type { SessionClock } from '../../market-hub/session-clock';

const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

export function istYmd(at: Date): string {
  return new Date(at.getTime() + IST_OFFSET_MS).toISOString().slice(0, 10);
}
function istMinutes(at: Date): number {
  const d = new Date(at.getTime() + IST_OFFSET_MS);
  return d.getUTCHours() * 60 + d.getUTCMinutes();
}

export type ScorecardJob = 'OVERNIGHT' | 'PRE_OPEN';
export type NewsBatch = 'NIGHT' | 'MORNING';

export function scorecardJobDue(job: ScorecardJob, now: Date, clock: SessionClock): boolean {
  if (!clock.isTradingDay('NSE', now)) return false;
  const m = istMinutes(now);
  return job === 'OVERNIGHT' ? m >= 15 * 60 + 30 : m < 9 * 60 + 15;
}

export function newsBatchDue(batch: NewsBatch, now: Date, clock: SessionClock): boolean {
  if (batch === 'MORNING') return clock.isTradingDay('NSE', now) && istMinutes(now) < 9 * 60 + 15;
  const next = clock.nextOpen('NSE', now);
  if (!next) return false;
  return istYmd(next) === istYmd(new Date(now.getTime() + DAY_MS));
}

/** The NSE session (IST 'YYYY-MM-DD') whose open→close is a row's outcome: the first session opening after `at`. */
export function outcomeSession(at: Date, clock: SessionClock): string | null {
  const open = clock.nextOpen('NSE', at);
  return open ? istYmd(open) : null;
}
