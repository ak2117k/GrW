import type { VerificationDraft } from '../self-review.types';
import { buildSummary, kindStats, topMisses } from './summary';

const d = (o: Partial<VerificationDraft>): VerificationDraft => ({
  sessionDate: '2026-10-21', kind: 'SCORECARD_TOTAL', refId: 'r', subject: null, symbol: 'X', predicted: 'p', actual: 'a',
  correct: null, score: null, details: null, ...o,
});

describe('summary', () => {
  it('kindStats counts right / wrong / null and the hit rate over judged', () => {
    expect(kindStats([d({ correct: true }), d({ correct: false }), d({ correct: true }), d({})])).toEqual({ n: 4, right: 2, wrong: 1, nullCount: 1, hitRate: 0.667 });
    expect(kindStats([d({})]).hitRate).toBeNull();
  });

  it('builds byKind, byFactor with rolling 5 / 20 and notable misses', () => {
    const sessions = Array.from({ length: 20 }, (_, i) => `2026-09-${String(30 - i).padStart(2, '0')}`);
    sessions[0] = '2026-10-21';
    const results = [
      d({ kind: 'SCORECARD_TOTAL', refId: 'a', correct: false, score: -50 }),
      d({ kind: 'SCORECARD_TOTAL', refId: 'b', correct: false, score: -5 }),
      d({ kind: 'SCORECARD_FACTOR', refId: 'a:oi', subject: 'oi', correct: true }),
      d({ kind: 'MBM_PREDICTION', refId: 'm', correct: false }),
    ];
    const history = [
      { sessionDate: '2026-10-21', subject: 'oi', correct: true },
      ...sessions.slice(1, 5).map((s) => ({ sessionDate: s, subject: 'oi', correct: false })),
      ...sessions.slice(5).map((s) => ({ sessionDate: s, subject: 'oi', correct: true })),
      { sessionDate: '2025-01-01', subject: 'oi', correct: false },
    ];
    const s = buildSummary('2026-10-21', results, history, sessions);
    expect(s.session).toBe('2026-10-21');
    expect(s.byKind.SCORECARD_TOTAL).toMatchObject({ n: 2, wrong: 2, hitRate: 0 });
    expect(s.byFactor.oi).toMatchObject({ n: 1, right: 1, hitRate: 1, rolling5: 0.2, rolling20: 0.8 });
    expect(s.notable.map((n) => n.refId)).toEqual(['a', 'b']); // MBM excluded, biggest |score| first
  });

  it('topMisses caps and orders by |score|, unscored last', () => {
    const out = topMisses(
      [d({ refId: 'x', correct: false }), d({ refId: 'y', correct: false, score: 3 }), d({ refId: 'z', correct: false, score: -9 }), d({ refId: 'w', correct: true, score: 99 })],
      2,
    );
    expect(out.map((r) => r.refId)).toEqual(['z', 'y']);
  });
});
