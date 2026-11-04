import { TUNABLES, type NumberTunable } from '../tuning/tunables';
import { AFFECTED_DECISIONS, changeBlock, evidenceDirection, mayChange, rollbackDue, stepLimit, type Change } from './policy';

const num = (t: string) => TUNABLES[t] as NumberTunable;
/** 30 consecutive "sessions", oldest first. */
const S = Array.from({ length: 30 }, (_, i) => `2026-10-${String(i + 1).padStart(2, '0')}`);
const change = (c: Partial<Change>): Change => ({ id: 'p1', target: 'exit.floorTrailN', kind: 'APPLY', from: 2, to: 2.5, session: S[0], at: `${S[0]}T14:00:00.000Z`, reason: '', ...c });

describe('auto-apply policy', () => {
  it('step limited to 25% of range', () => {
    // floorTrailN 1.0–3.5 ⇒ step ≤ 0.625
    expect(stepLimit(num('exit.floorTrailN'), 2.0, 3.5)).toBe(2.625);
    expect(stepLimit(num('exit.floorTrailN'), 2.0, 1.0)).toBe(1.375);
    expect(stepLimit(num('exit.floorTrailN'), 2.0, 2.3)).toBe(2.3);
    // judgeMinConfidence 50–80 integer ⇒ step 7.5 → 7
    expect(stepLimit(num('signal.judgeMinConfidence'), 60, 80)).toBe(67);
    expect(stepLimit(num('signal.judgeMinConfidence'), 60, 50)).toBe(53);
    // carry 4–9 ⇒ 1.25 → 1
    expect(stepLimit(num('carry.decideByMin'), 6, 9)).toBe(7);
    // a 0–1 integer rounds to no move
    expect(stepLimit(num('scorecard.stockMove.points'), 0, 1)).toBe(0);
  });

  it('second change within 5 sessions blocked', () => {
    const h = [change({ session: S[0], watch: 'KEPT' })];
    expect(mayChange('exit.floorTrailN', h, S.slice(0, 5), 'up')).toBe(false); // 4 sessions after
    expect(changeBlock('exit.floorTrailN', 'up', h, S.slice(0, 5))).toMatch(/4 session/);
    expect(mayChange('exit.floorTrailN', h, S.slice(0, 6), 'up')).toBe(true); // 5 after
    expect(mayChange('exit.floorArmN', h, S.slice(0, 2), 'up')).toBe(true); // other target
  });

  it('a target whose last change is still watched is blocked', () => {
    const h = [change({ session: S[0], watch: 'WATCHING' })];
    expect(changeBlock('exit.floorTrailN', 'down', h, S.slice(0, 12))).toMatch(/still being watched/);
  });

  it('rollback blocks the same direction 20 sessions, not the other one', () => {
    const h = [
      change({ id: 'a', session: S[0], at: `${S[0]}T14:00:00.000Z`, watch: 'ROLLED_BACK' }),
      change({ id: 'b', kind: 'ROLLBACK', from: 2.5, to: 2, session: S[4], at: `${S[4]}T14:00:00.000Z`, rollbackOf: 'a', blockedDirection: 'up' }),
    ];
    expect(changeBlock('exit.floorTrailN', 'up', h, S.slice(0, 20))).toMatch(/rolled back 15/);
    expect(changeBlock('exit.floorTrailN', 'down', h, S.slice(0, 20))).toBeNull();
    expect(changeBlock('exit.floorTrailN', 'up', h, S.slice(0, 25))).toBeNull();
  });

  it('rollbackDue needs 3 sessions WITH the decision on each side and a worse after', () => {
    expect(rollbackDue({ perDecision: 100, sessions: 3 }, { perDecision: 50, sessions: 3 })).toBe(true);
    expect(rollbackDue({ perDecision: 100, sessions: 3 }, { perDecision: 150, sessions: 3 })).toBe(false);
    expect(rollbackDue({ perDecision: 100, sessions: 3 }, { perDecision: -500, sessions: 2 })).toBe(false);
    expect(rollbackDue({ perDecision: 100, sessions: 2 }, { perDecision: -500, sessions: 3 })).toBe(false);
    expect(rollbackDue({ perDecision: null, sessions: 3 }, { perDecision: -500, sessions: 3 })).toBe(false);
  });
});

describe('evidenceDirection (spec S2: the graded evidence, not the LLM, picks the way a knob moves)', () => {
  const rows = (n: number, decisionType: string, alternative: string) => Array.from({ length: n }, () => ({ decisionType, alternative }));
  it('wrong skips outnumber wrong takes ⇒ lower the judge bar, default to take', () => {
    const w = [...rows(6, 'ENTRY_SKIP', 'take'), ...rows(2, 'ENTRY_TAKE', 'skip')];
    expect(evidenceDirection('signal.judgeMinConfidence', w)).toBe('down');
    expect(evidenceDirection('signal.judgeDefaultTake', w)).toBe('true');
  });
  it('early exits ⇒ widen the floor; late holds ⇒ tighten it; a close split ⇒ no direction', () => {
    expect(evidenceDirection('exit.floorTrailN', rows(3, 'EXIT', 'hold'))).toBe('up');
    expect(evidenceDirection('exit.floorTrailN', rows(3, 'HOLD', 'exit'))).toBe('down');
    expect(evidenceDirection('exit.floorTrailN', [...rows(3, 'EXIT', 'hold'), ...rows(3, 'HOLD', 'exit')])).toBeNull();
    expect(evidenceDirection('exit.floorTrailN', [])).toBeNull();
  });
  it('targets read live mid-session are not auto-applied', () => {
    expect(AFFECTED_DECISIONS['exit.persistMinSec']).toBeUndefined();
    expect(AFFECTED_DECISIONS['exit.openingGuardMin']).toBeUndefined();
  });
});
