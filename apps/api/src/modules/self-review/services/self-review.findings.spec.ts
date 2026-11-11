import { SelfReviewService } from './self-review.service';

const ticket = { title: 'Live orders never placed', proposedChange: 'p', files: ['apps/api/src/modules/risk-manager/risk-manager.service.ts'], testDescription: 't' };
const diagnosis = {
  misses: [
    { refIds: ['dg:g1', 'dg:g2'], cause: 'blocked by the paper count', category: 'OTHER', causeType: 'CODE_BUG', ticket },
    { refIds: ['v1'], cause: 'exit on noise', category: 'TIMING', causeType: 'REASONING', lessonKey: 'hold-on-noise' },
    { refIds: ['v2'], cause: 'random', category: 'NOISE', causeType: 'NOISE' },
    { refIds: ['dg:g3'], cause: 'late entry', category: 'TIMING', causeType: 'REASONING' },
  ],
  engineAssessment: 'engine ok',
};
const run = { id: 'r1', sessionDate: '2026-11-09', startedAt: new Date('2026-11-09T19:00:00Z'), finishedAt: null, status: 'DONE', summary: null, error: null, diagnosis };

function service() {
  const repo = {
    latestDoneRun: async () => run,
    latestRun: async () => run,
    countPending: async () => 0,
    doneRunsFor: async () => [run],
    results: async () => [{ refId: 'v1', kind: 'LIVE_EXIT', symbol: 'NIFTY' }],
    lessonsFromRun: async () => [],
    decisionGradesByIds: async (ids: string[]) =>
      [
        { id: 'g1', sessionDate: '2026-11-09', deltaRupees: 4000, decisionType: 'ENTRY_BLOCKED', symbol: 'GOLD' },
        { id: 'g2', sessionDate: '2026-11-06', deltaRupees: -1500, decisionType: 'ENTRY_BLOCKED', symbol: 'GOLD' },
        { id: 'g3', sessionDate: '2026-11-09', deltaRupees: null, decisionType: 'ENTRY_TAKE', symbol: 'SILVER' },
      ].filter((g) => ids.includes(g.id)),
    lessonsByKeys: async () => [{ key: 'hold-on-noise', status: 'ACTIVE' }],
    ticketsByKeys: async (keys: string[]) => keys.map((key) => ({ key, title: 'Live orders never placed', status: 'OPEN' })),
    diagnosedRuns: async () => [{ sessionDate: '2026-11-09', diagnosis }],
    scorecardLessons: async () => [{ id: 'l1', key: 'hold-on-noise', text: 't', scope: 'SENTINEL_LIVE', status: 'ACTIVE', firstSeen: new Date('2026-11-09T19:00:00Z'), rightCount: 1, wrongCount: 0 }],
    resultSessionsByRefIds: async () => [{ refId: 'v1', sessionDate: '2026-11-09' }],
  };
  return new SelfReviewService(repo as never, {} as never, {} as never);
}

describe('SelfReviewService: last night findings', () => {
  it('each diagnosed miss says what it became and its ₹ cost when known', async () => {
    const v = await service().latest();
    expect(v.engineAssessment).toBe('engine ok');
    const [bug, lesson, noise, oneOff] = v.misses;
    expect(bug).toMatchObject({ kind: 'DECISION:ENTRY_BLOCKED', symbol: 'GOLD', costRupees: 5500, outcome: { type: 'TICKET', label: 'Fix ticket: Live orders never placed (OPEN)' } });
    expect(lesson).toMatchObject({ kind: 'LIVE_EXIT', symbol: 'NIFTY', costRupees: null, outcome: { type: 'LESSON', label: 'Lesson: hold-on-noise (active)' } });
    expect(noise.outcome?.type).toBe('NOISE');
    expect(oneOff).toMatchObject({ symbol: 'SILVER', costRupees: null, outcome: { type: 'ONE_OFF' } });
  });

  it('the lesson scorecard reads the diagnosed runs', async () => {
    const card = await service().lessonScorecard();
    expect(card.reviewedSessions).toBe(1);
    expect(card.lessons[0]).toMatchObject({ key: 'hold-on-noise', activeSince: '2026-11-10', verdict: 'TOO_EARLY' });
    expect(card.lessons[0].before).toMatchObject({ sessions: 1, mistakes: 1, costUnknown: 1 });
  });
});
