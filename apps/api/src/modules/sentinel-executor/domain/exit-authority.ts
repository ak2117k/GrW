// apps/api/src/modules/sentinel-executor/domain/exit-authority.ts
import type { AlarmRule, AlarmUrgency } from '../../exit-authority/exit-authority.tokens';

/*
 * WIRE CONTRACT with trade-sentinel (plan R14: no sentinel-executor file may import trade-sentinel, so these
 * strings cannot be imported from there; sentinel-executor.structure.spec enforces it):
 * - PAPER_TRACKER_PREFIX = trade-sentinel/paper/paper-tracker.ts PAPER_TRACKER_PREFIX;
 * - FLOOR_HARD_EXIT_STAMP / TARGET_LADDER_STAMP = trade-sentinel/services/sentinel-cycle.service.ts exports.
 * Every code-rule stamp starts with 'rule:' (RULE_STAMP_PREFIX), so a renamed or new stamp is still never sold
 * by code under live; it only loses its specific alarm rule (FLOOR).
 */
export const PAPER_TRACKER_PREFIX = 'paper:';
export const FLOOR_HARD_EXIT_STAMP = 'rule:floor-hard/1';
export const TARGET_LADDER_STAMP = 'rule:target-ladder/1';
export const RULE_STAMP_PREFIX = 'rule:';

/** A paper sentinel tracker id (`paper:<tradeId>`): keeps today's rules under the exit authority. */
export const isPaperTrackerId = (trackerId: string | null | undefined): boolean =>
  typeof trackerId === 'string' && trackerId.startsWith(PAPER_TRACKER_PREFIX);

/** A verdict no prompt wrote (a code rule's EXIT_NOW). */
export const isRuleStamp = (promptVersion: string | null | undefined): boolean =>
  typeof promptVersion === 'string' && promptVersion.startsWith(RULE_STAMP_PREFIX);

/**
 * The alarm a code-rule EXIT_NOW becomes. `carryStamp` is intraday-carry's CARRY_EXIT_STAMP (passed in, so this
 * domain file imports no service). MAX_LOSS on the floor stamp = the hard loss (urgent).
 */
export function ruleAlarmFor(promptVersion: string, reason: string, carryStamp: string): { rule: AlarmRule; urgency: AlarmUrgency } {
  if (promptVersion === FLOOR_HARD_EXIT_STAMP) {
    return /\bMAX_LOSS\b/.test(reason) ? { rule: 'HARD_LOSS', urgency: 'urgent' } : { rule: 'FLOOR', urgency: 'normal' };
  }
  if (promptVersion === TARGET_LADDER_STAMP) return { rule: 'LADDER', urgency: 'normal' };
  // No deadline is known here (under live the carry engine raises its own deadline alarm); urgent so it escalates at 60 s.
  if (promptVersion === carryStamp) return { rule: 'CARRY', urgency: 'urgent' };
  return { rule: 'FLOOR', urgency: 'normal' };
}
