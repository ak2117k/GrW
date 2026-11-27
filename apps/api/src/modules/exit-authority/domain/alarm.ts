import type { AlarmRow, AlarmUrgency, RaiseAlarm } from '../exit-authority.tokens';
import {
  BACKSTOP_OWNER_SILENT_MS,
  DEADLINE_EXIT_LEAD_MS,
  DEADLINE_WARN_MS,
  ESCALATE_AFTER_MS,
  ESCALATE_URGENT_AFTER_MS,
  REALARM_EVERY_MS,
  REALARM_URGENT_EVERY_MS,
  REALERT_EVERY_MS,
} from './timings';

/** Pure alarm lifecycle rules. No IO, no clock: `now` is always passed in. */

const HARD_LOSS_RULES = new Set(['HARD_LOSS', 'HARD_LOSS_FAST']);

/** An owner Hold (SNOOZED) silences the alarm until snoozedUntil; an expired snooze counts as open again. */
export function isSnoozed(a: Pick<AlarmRow, 'status' | 'snoozedUntil'>, now: Date): boolean {
  return a.status === 'SNOOZED' && a.snoozedUntil != null && a.snoozedUntil.getTime() > now.getTime();
}

/** OPEN, or SNOOZED with the snooze run out, and no agent answer yet. */
function isUnansweredActive(a: AlarmRow, now: Date): boolean {
  if (a.answeredAt != null) return false;
  if (a.status === 'OPEN') return true;
  return a.status === 'SNOOZED' && !isSnoozed(a, now);
}

const isUrgent = (...u: AlarmUrgency[]): boolean => u.includes('urgent');

/**
 * The rule is still true and fired again: does it deserve a fresh alarm (re-raise + wake), or does the
 * existing one already cover it? Re-raise at ≥1 N15 worse, or after REALARM_EVERY_MS (urgent: REALARM_URGENT_EVERY_MS)
 * since the last raise. Never while the owner's Hold snooze runs.
 */
export function shouldReRaise(open: AlarmRow, next: RaiseAlarm, now: Date): boolean {
  if (isSnoozed(open, now)) return false;
  const nextN = next.severityN;
  const openN = open.severityN;
  if (nextN != null && openN != null && Number.isFinite(nextN) && Number.isFinite(openN) && nextN - openN >= 1) {
    return true;
  }
  const every = isUrgent(open.urgency, next.urgency) ? REALARM_URGENT_EVERY_MS : REALARM_EVERY_MS;
  return now.getTime() - open.lastRaisedAt.getTime() >= every;
}

/** What the owner should be told about an alarm now, if anything. */
export function escalationDue(a: AlarmRow, now: Date): 'ALERT' | 'REALERT' | 'DEADLINE_WARN' | null {
  if (!isUnansweredActive(a, now)) return null;
  const t = now.getTime();
  if (a.alertedAt == null) {
    if (a.urgency === 'deadline' && a.deadline != null && a.deadline.getTime() - t <= DEADLINE_WARN_MS) {
      return 'DEADLINE_WARN';
    }
    const after = a.urgency === 'urgent' ? ESCALATE_URGENT_AFTER_MS : ESCALATE_AFTER_MS;
    return t - a.raisedAt.getTime() >= after ? 'ALERT' : null;
  }
  return t - a.alertedAt.getTime() >= REALERT_EVERY_MS ? 'REALERT' : null;
}

/**
 * The only two code sells left (design §4.5a):
 * - DEADLINE: a `deadline` alarm with no agent answer by deadline − DEADLINE_EXIT_LEAD_MS;
 * - HARD_LOSS: a hard-loss alarm, the AI down (or the agent silent ≥ ESCALATE_URGENT_AFTER_MS), the owner
 *   silent ≥ BACKSTOP_OWNER_SILENT_MS after the alert, and the trade still past its limit.
 */
export function backstopDue(
  a: AlarmRow,
  ctx: { aiDown: boolean; stillPastLimit: boolean },
  now: Date,
): 'DEADLINE' | 'HARD_LOSS' | null {
  if (!isUnansweredActive(a, now)) return null;
  const t = now.getTime();
  if (a.urgency === 'deadline' && a.deadline != null && t >= a.deadline.getTime() - DEADLINE_EXIT_LEAD_MS) {
    return 'DEADLINE';
  }
  if (!HARD_LOSS_RULES.has(a.rule)) return null;
  const agentSilent = ctx.aiDown || t - a.raisedAt.getTime() >= ESCALATE_URGENT_AFTER_MS;
  const ownerSilent = a.alertedAt != null && a.alertedAt.getTime() <= t - BACKSTOP_OWNER_SILENT_MS;
  return agentSilent && ownerSilent && ctx.stillPastLimit ? 'HARD_LOSS' : null;
}
