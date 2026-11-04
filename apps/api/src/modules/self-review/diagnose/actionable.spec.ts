import { actionable, groupCostRupees, groupStats, type MissFacts } from './actionable';

describe('actionable (the pattern gate)', () => {
  it('NOISE never actionable', () => {
    expect(actionable({ occurrences: 9, sessions: 3, maxCostRupees: 20_000 }, 'NOISE')).toBe(false);
  });

  it('2 occurrences / ₹800 ⇒ not actionable', () => {
    expect(actionable({ occurrences: 2, sessions: 2, maxCostRupees: 800 }, 'REASONING')).toBe(false);
  });

  it('1 occurrence ₹5,200 ⇒ actionable', () => {
    expect(actionable({ occurrences: 1, sessions: 1, maxCostRupees: 5200 }, 'CODE_BUG')).toBe(true);
  });

  it('3 occurrences within 10 sessions ⇒ actionable; spread over 11 sessions ⇒ not', () => {
    expect(actionable({ occurrences: 3, sessions: 3, maxCostRupees: 600 })).toBe(true);
    expect(actionable({ occurrences: 12, sessions: 11, maxCostRupees: 600 })).toBe(false);
  });

  it('groupStats: distinct refIds and sessions; only DECISION:* scores count as ₹', () => {
    const facts = new Map<string, MissFacts>([
      ['dg:1', { kind: 'DECISION:EXIT', sessionDate: '2026-11-03', score: -5200 }],
      ['dg:2', { kind: 'DECISION:EXIT', sessionDate: '2026-11-04', score: 900 }],
      ['v1', { kind: 'TRADE_SETUP', sessionDate: '2026-11-04', score: -9000 }],
    ]);
    expect(groupStats(['dg:1', 'dg:1', 'dg:2', 'v1', 'ghost'], facts)).toEqual({ occurrences: 3, sessions: 2, maxCostRupees: 5200 });
    expect(groupCostRupees(['dg:1', 'dg:2', 'v1'], facts)).toBe(6100);
  });
});
