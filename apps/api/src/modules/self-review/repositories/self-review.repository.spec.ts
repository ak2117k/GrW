import { SELF_REVIEW_SCORED_STATUSES, SelfReviewRepository } from './self-review.repository';

/**
 * 2026-11-28 (Fix 6): a run whose AI diagnosis failed (e.g. cut off at max_tokens) finishes PARTIAL, not DONE.
 * Its scoring summary is complete, so the readers of "the latest scored run" must still see it; only the
 * diagnosis reuse (`doneRunsFor`) wants DONE runs that carry one.
 */
describe('SelfReviewRepository run status readers', () => {
  const make = () => {
    const selfReviewRun = { findFirst: jest.fn(async () => null), findMany: jest.fn(async () => []), update: jest.fn(async () => ({})) };
    return { repo: new SelfReviewRepository({ selfReviewRun } as never), selfReviewRun };
  };

  it('the scored statuses are DONE and PARTIAL', () => {
    expect([...SELF_REVIEW_SCORED_STATUSES]).toEqual(['DONE', 'PARTIAL']);
  });

  it('latestDoneRun and previousDoneRun read DONE or PARTIAL runs', async () => {
    const { repo, selfReviewRun } = make();
    await repo.latestDoneRun();
    await repo.previousDoneRun('2026-11-27');
    for (const call of selfReviewRun.findFirst.mock.calls as unknown as Array<[{ where: { status: unknown } }]>) {
      expect(call[0].where.status).toEqual({ in: ['DONE', 'PARTIAL'] });
    }
    expect(selfReviewRun.findFirst).toHaveBeenCalledTimes(2);
  });

  it('doneRunsFor (diagnosis reuse) stays DONE-only: a PARTIAL run has no diagnosis to reuse, so a catch-up retries it', async () => {
    const { repo, selfReviewRun } = make();
    await repo.doneRunsFor('2026-11-27');
    expect(selfReviewRun.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: { sessionDate: '2026-11-27', status: 'DONE' } }));
  });

  it('finishRun accepts PARTIAL', async () => {
    const { repo, selfReviewRun } = make();
    await repo.finishRun('r1', { status: 'PARTIAL', error: 'diagnosis: reply stopped: max_tokens' });
    expect(selfReviewRun.update).toHaveBeenCalledWith(expect.objectContaining({ where: { id: 'r1' }, data: expect.objectContaining({ status: 'PARTIAL' }) }));
  });
});
