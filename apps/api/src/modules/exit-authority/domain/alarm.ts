import type { AlarmRow, AlarmUrgency, RaiseAlarm } from '../exit-authority.tokens';
import {
  BACKSTOP_OWNER_SILENT_MS,
  DEADLINE_BACKSTOP_GRACE_MS,
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
  // Counted from the later of the last raise and the agent's answer: an alarm the agent just answered (HOLD) is
  // not re-raised at once because its raise is old.
  const since = Math.max(open.lastRaisedAt.getTime(), open.answeredAt?.getTime() ?? Number.NEGATIVE_INFINITY);
  return now.getTime() - since >= every;
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

/** A `deadline` alarm more than DEADLINE_BACKSTOP_GRACE_MS past its deadline: the backstop no longer acts on it. */
export function deadlinePassed(a: Pick<AlarmRow, 'urgency' | 'deadline'>, now: Date): boolean {
  return a.urgency === 'deadline' && a.deadline != null && now.getTime() > a.deadline.getTime() + DEADLINE_BACKSTOP_GRACE_MS;
}

/**
 * The only two code sells left (design §4.5a):
 * - DEADLINE: a `deadline` alarm still on the trade at deadline − DEADLINE_EXIT_LEAD_MS. Owner ruling 2026-11-27
 *   ("code exits a couple of minutes before the broker deadline so Angel never squares off at the bell"): an agent
 *   HOLD (ANSWERED) does NOT disarm it. Only a running owner Hold snooze (capped at this time), a position converted
 *   to carry (`ctx.stillIntraday === false`: the product is no longer intraday) or a closed tracker (the runner closes
 *   the alarm) stop it;
 * - HARD_LOSS: a hard-loss alarm, the AI down (or the agent silent ≥ ESCALATE_URGENT_AFTER_MS), the owner
 *   silent ≥ BACKSTOP_OWNER_SILENT_MS after the alert, and the trade still past its limit.
 */
export function backstopDue(
  a: AlarmRow,
  ctx: { aiDown: boolean; stillPastLimit: boolean; stillIntraday?: boolean },
  now: Date,
): 'DEADLINE' | 'HARD_LOSS' | null {
  const t = now.getTime();
  if (a.urgency === 'deadline' && a.deadline != null && t >= a.deadline.getTime() - DEADLINE_EXIT_LEAD_MS) {
    // Never later than deadline + DEADLINE_BACKSTOP_GRACE_MS (a past session's alarm must not sell a position the owner
    // may have converted by hand): the runner closes such an alarm instead (deadlinePassed).
    if (deadlinePassed(a, now)) return null;
    const onTrade = isUnansweredActive(a, now) || a.status === 'ANSWERED';
    return onTrade && ctx.stillIntraday !== false ? 'DEADLINE' : null;
  }
  if (!isUnansweredActive(a, now)) return null;
  if (!HARD_LOSS_RULES.has(a.rule)) return null;
  const agentSilent = ctx.aiDown || t - a.raisedAt.getTime() >= ESCALATE_URGENT_AFTER_MS;
  const ownerSilent = a.alertedAt != null && a.alertedAt.getTime() <= t - BACKSTOP_OWNER_SILENT_MS;
  return agentSilent && ownerSilent && ctx.stillPastLimit ? 'HARD_LOSS' : null;
}
