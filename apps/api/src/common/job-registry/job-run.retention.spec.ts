import { JobRunRepository } from './job-run.repository';
import { retentionCutoff } from './job-run.types';

const DAY_MS = 24 * 60 * 60 * 1000;
const T0 = new Date('2026-08-21T10:00:00.000Z');
const at = (offsetMs: number) => new Date(T0.getTime() + offsetMs);

function makePrisma() {
  return {
    jobRun: {
      create: jest.fn().mockResolvedValue({ id: 'row-1' }),
      update: jest.fn(),
      findUnique: jest.fn(),
      deleteMany: jest.fn().mockResolvedValue({ count: 3 }),
    },
  };
}

function makeRepo() {
  const prisma = makePrisma();
  return { prisma, repo: new JobRunRepository(prisma as never) };
}

describe('lazy retention', () => {
  it('prunes on the first call', async () => {
    const { prisma, repo } = makeRepo();
    await repo.maybePrune(T0);
    expect(prisma.jobRun.deleteMany).toHaveBeenCalledTimes(1);
  });

  /**
   * Pins WHICH rows go. A sweep that deleted on some other predicate — or on
   * `startedAt < now` — would satisfy every call-count assertion in this file
   * while emptying the evidence table on its first run.
   */
  it('deletes only rows older than the 30-day retention cutoff', async () => {
    const { prisma, repo } = makeRepo();
    await repo.maybePrune(T0);
    expect(prisma.jobRun.deleteMany).toHaveBeenCalledWith({
      where: { startedAt: { lt: retentionCutoff(T0) } },
    });
  });

  it('returns the number of rows deleted', async () => {
    const { repo } = makeRepo();
    await expect(repo.maybePrune(T0)).resolves.toBe(3);
  });

  it('does not prune again within the interval', async () => {
    const { prisma, repo } = makeRepo();
    await repo.maybePrune(T0);
    await repo.maybePrune(at(30 * 60 * 1000));
    expect(prisma.jobRun.deleteMany).toHaveBeenCalledTimes(1);
  });

  it('returns zero, not the previous count, when the sweep is gated', async () => {
    const { repo } = makeRepo();
    await repo.maybePrune(T0);
    await expect(repo.maybePrune(at(30 * 60 * 1000))).resolves.toBe(0);
  });

  it('prunes again after the interval elapses', async () => {
    const { prisma, repo } = makeRepo();
    await repo.maybePrune(T0);
    await repo.maybePrune(at(DAY_MS + 60 * 60 * 1000));
    expect(prisma.jobRun.deleteMany).toHaveBeenCalledTimes(2);
  });

  /**
   * The boundary pair. Together these pin the interval to exactly 24h and the
   * comparison to `<` (elapsed === interval sweeps). Either test alone is
   * satisfiable by a wrong constant; both together are not.
   */
  it('still gates one millisecond before the interval is up', async () => {
    const { prisma, repo } = makeRepo();
    await repo.maybePrune(T0);
    await repo.maybePrune(at(DAY_MS - 1));
    expect(prisma.jobRun.deleteMany).toHaveBeenCalledTimes(1);
  });

  it('sweeps exactly on the interval boundary', async () => {
    const { prisma, repo } = makeRepo();
    await repo.maybePrune(T0);
    await repo.maybePrune(at(DAY_MS));
    expect(prisma.jobRun.deleteMany).toHaveBeenCalledTimes(2);
  });

  /**
   * `maybePrune` is fire-and-forgotten by `JobRunnerService`, so a rejection
   * here becomes an unhandled rejection rather than a handled error. Write
   * paths in this repository swallow; this one must too.
   */
  it('resolves zero instead of rejecting when the delete fails', async () => {
    const { prisma, repo } = makeRepo();
    prisma.jobRun.deleteMany.mockRejectedValue(new Error('neon asleep'));
    await expect(repo.maybePrune(T0)).resolves.toBe(0);
  });

  /**
   * A failed sweep still consumes the interval. Retrying on the next job
   * completion would, with 41 job writers, turn one sick database into a storm
   * of failing deletes aimed at it.
   */
  it('does not retry immediately after a failed sweep', async () => {
    const { prisma, repo } = makeRepo();
    prisma.jobRun.deleteMany.mockRejectedValue(new Error('neon asleep'));
    await repo.maybePrune(T0);
    await repo.maybePrune(at(60 * 1000));
    expect(prisma.jobRun.deleteMany).toHaveBeenCalledTimes(1);
  });

  /** Each instance keeps its own clock; a fresh repository always sweeps first. */
  it('sweeps on a new instance even if another already swept at that instant', async () => {
    const { repo: first } = makeRepo();
    await first.maybePrune(T0);
    const { prisma, repo: second } = makeRepo();
    await second.maybePrune(T0);
    expect(prisma.jobRun.deleteMany).toHaveBeenCalledTimes(1);
  });
});
