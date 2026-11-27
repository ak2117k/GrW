/**
 * Cross-module wire contract (Task 4 → Task 7). sentinel-executor/domain/exit-authority.ts COPIES the trade-sentinel
 * stamps and the paper prefix as literals, because plan R14 (sentinel-executor.structure.spec) forbids any executor
 * file — specs included — to import trade-sentinel. This spec lives outside both modules so it may import both: a
 * renamed stamp on either side fails here instead of letting a code-rule EXIT_NOW be misrouted under live.
 */
import { CARRY_EXIT_STAMP } from '../intraday-carry/intraday-carry.service';
import * as executor from '../sentinel-executor/domain/exit-authority';
import { isPaperTracker, PAPER_TRACKER_PREFIX } from '../trade-sentinel/paper/paper-tracker';
import { FLOOR_HARD_EXIT_STAMP, TARGET_LADDER_STAMP } from '../trade-sentinel/services/sentinel-cycle.service';

describe('exit-authority stamp contract: executor copies == trade-sentinel exports', () => {
  it('FLOOR_HARD_EXIT_STAMP', () => expect(executor.FLOOR_HARD_EXIT_STAMP).toBe(FLOOR_HARD_EXIT_STAMP));
  it('TARGET_LADDER_STAMP', () => expect(executor.TARGET_LADDER_STAMP).toBe(TARGET_LADDER_STAMP));
  it("the paper prefix ('paper:')", () => {
    expect(executor.PAPER_TRACKER_PREFIX).toBe(PAPER_TRACKER_PREFIX);
    for (const id of ['paper:t1', 'ckabc', '', 'xpaper:1']) expect(executor.isPaperTrackerId(id)).toBe(isPaperTracker(id));
  });
  it('every code-rule stamp (floor, ladder, carry) is a rule stamp and maps to its rule', () => {
    for (const s of [FLOOR_HARD_EXIT_STAMP, TARGET_LADDER_STAMP, CARRY_EXIT_STAMP]) expect(executor.isRuleStamp(s)).toBe(true);
    expect(executor.ruleAlarmFor(FLOOR_HARD_EXIT_STAMP, 'FLOOR_HARD_EXIT MAX_LOSS: x', CARRY_EXIT_STAMP).rule).toBe('HARD_LOSS');
    expect(executor.ruleAlarmFor(FLOOR_HARD_EXIT_STAMP, 'FLOOR_HARD_EXIT GREEN_TO_RED: x', CARRY_EXIT_STAMP).rule).toBe('FLOOR');
    expect(executor.ruleAlarmFor(TARGET_LADDER_STAMP, 'TARGET_LADDER: x', CARRY_EXIT_STAMP).rule).toBe('LADDER');
    expect(executor.ruleAlarmFor(CARRY_EXIT_STAMP, 'INTRADAY_CARRY: x', CARRY_EXIT_STAMP).rule).toBe('CARRY');
  });
});
