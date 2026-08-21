import { JobRunRepository } from './job-run.repository';

/** The row `findUnique` hands back — exactly 60s before FROZEN_NOW. */
const ROW_STARTED_AT = new Date('2026-08-21T09:59:00.000Z');
const FROZEN_NOW = new Date('2026-08-21T10:00:00.000Z');

function makePrisma() {
  return {
    jobRun: {
      create: jest.fn().mockResolvedValue({ id: 'row-1' }),
      update: jest.fn().mockResolvedValue({}),
      deleteMany: jest.fn().mockResolvedValue({ count: 7 }),
      // recordEnd reads startedAt back to compute durationMs. Omitting this
      // makes the lookup throw, the catch swallow it, and `update` never run —
      // so the truncation assertion below would fail for the wrong reason.
      findUnique: jest.fn().mockResolvedValue({ startedAt: ROW_STARTED_AT }),
    },
    // lastRunPerJob goes through raw SQL, not a model delegate.
    $queryRaw: jest.fn().mockResolvedValue([]),
  };
}

/** Pins `new Date()` inside the method under test to FROZEN_NOW. */
function freezeClock(): void {
  beforeEach(() => {
    jest.useFakeTimers().setSystemTime(FROZEN_NOW);
  });
  afterEach(() => {
    jest.useRealTimers();
  });
}

describe('JobRunRepository', () => {
  describe('recordStart', () => {
    freezeClock();

    it('records a start and returns the row id', async () => {
      const prisma = makePrisma();
      const repo = new JobRunRepository(prisma as never);
      await expect(repo.recordStart('nightly-sweep')).resolves.toBe('row-1');
      expect(prisma.jobRun.create).toHaveBeenCalledWith({
        // startedAt is asserted against the frozen instant, not expect.any(Date):
        // the property Fix 7 establishes is that it comes from the NODE clock,
        // and expect.any(Date) would accept new Date(0) or a database-clock
        // value just as happily. recordEnd subtracts this from a Node-clock
        // finishedAt, so mixing the two imports Render/Neon skew.
        data: { jobName: 'nightly-sweep', startedAt: FROZEN_NOW, outcome: 'RUNNING' },
        select: { id: true },
      });
    });

    it('never throws when the database write fails', async () => {
      const prisma = makePrisma();
      prisma.jobRun.create.mockRejectedValue(new Error('db down'));
      const repo = new JobRunRepository(prisma as never);
      await expect(repo.recordStart('nightly-sweep')).resolves.toBeNull();
    });
  });

  describe('recordEnd', () => {
    // finishedAt comes from `new Date()` inside the method; freezing the clock
    // makes the 60s duration exact rather than merely positive.
    freezeClock();

    it('closes the identified row with its outcome, finish time and duration', async () => {
      const prisma = makePrisma();
      const repo = new JobRunRepository(prisma as never);
      await repo.recordEnd('row-1', 'SUCCESS');
      const arg = prisma.jobRun.update.mock.calls[0][0];
      expect(arg.where).toEqual({ id: 'row-1' });
      expect(arg.data.outcome).toBe('SUCCESS');
      expect(arg.data.finishedAt).toEqual(FROZEN_NOW);
      expect(arg.data.durationMs).toBe(60_000);
      expect(arg.data.error).toBeNull();
    });

    it('truncates an error message to 200 chars', async () => {
      const prisma = makePrisma();
      const repo = new JobRunRepository(prisma as never);
      await repo.recordEnd('row-1', 'FAILED', 'x'.repeat(500));
      const arg = prisma.jobRun.update.mock.calls[0][0];
      expect(arg.data.error).toHaveLength(200);
      expect(arg.data.outcome).toBe('FAILED');
    });

    it('collapses whitespace in an error message', async () => {
      const prisma = makePrisma();
      const repo = new JobRunRepository(prisma as never);
      await repo.recordEnd('row-1', 'FAILED', new Error('a\n\n  b'));
      const arg = prisma.jobRun.update.mock.calls[0][0];
      expect(arg.data.error).toBe('a b');
    });

    it('is a no-op when the id is null', async () => {
      const prisma = makePrisma();
      const repo = new JobRunRepository(prisma as never);
      await repo.recordEnd(null, 'SUCCESS');
      expect(prisma.jobRun.update).not.toHaveBeenCalled();
      expect(prisma.jobRun.findUnique).not.toHaveBeenCalled();
    });

    it('never throws when the database write fails', async () => {
      const prisma = makePrisma();
      prisma.jobRun.update.mockRejectedValue(new Error('db down'));
      const repo = new JobRunRepository(prisma as never);
      // recordEnd runs in a finally; a throw here would abort the job it observes.
      await expect(repo.recordEnd('row-1', 'SUCCESS')).resolves.toBeUndefined();
    });
  });

  describe('recordSkipped', () => {
    freezeClock();

    it('records a lease deferral as a closed SKIPPED_LEASE row', async () => {
      const prisma = makePrisma();
      const repo = new JobRunRepository(prisma as never);
      await repo.recordSkipped('nightly-sweep');
      const arg = prisma.jobRun.create.mock.calls[0][0];
      expect(arg.data.jobName).toBe('nightly-sweep');
      expect(arg.data.outcome).toBe('SKIPPED_LEASE');
      expect(arg.data.durationMs).toBe(0);
      // Closed on write: a deferral has no in-flight period to observe. Both
      // timestamps are asserted against the frozen instant rather than against
      // each other — `finishedAt === startedAt` also holds when a mutant drops
      // BOTH fields and compares undefined to undefined.
      expect(arg.data.startedAt).toEqual(FROZEN_NOW);
      expect(arg.data.finishedAt).toEqual(FROZEN_NOW);
    });

    it('never throws when the database write fails', async () => {
      const prisma = makePrisma();
      prisma.jobRun.create.mockRejectedValue(new Error('db down'));
      const repo = new JobRunRepository(prisma as never);
      await expect(repo.recordSkipped('nightly-sweep')).resolves.toBeUndefined();
    });
  });

  describe('pruneOlderThan', () => {
    it('prunes rows older than the cutoff', async () => {
      const prisma = makePrisma();
      const repo = new JobRunRepository(prisma as never);
      const cutoff = new Date('2026-07-22T00:00:00.000Z');
      await expect(repo.pruneOlderThan(cutoff)).resolves.toBe(7);
      expect(prisma.jobRun.deleteMany).toHaveBeenCalledWith({
        where: { startedAt: { lt: cutoff } },
      });
    });

    it('never throws when the database write fails', async () => {
      const prisma = makePrisma();
      prisma.jobRun.deleteMany.mockRejectedValue(new Error('db down'));
      const repo = new JobRunRepository(prisma as never);
      await expect(repo.pruneOlderThan(new Date())).resolves.toBe(0);
    });
  });

  describe('lastRunPerJob', () => {
    it('propagates a read failure instead of reporting an empty registry', async () => {
      const prisma = makePrisma();
      prisma.$queryRaw.mockRejectedValue(new Error('db down'));
      const repo = new JobRunRepository(prisma as never);
      // Swallowing here would return [], which reads as "no jobs have ever
      // run" — the exact condition this table exists to detect. The caller
      // must be able to say the registry is unavailable, and why.
      await expect(repo.lastRunPerJob()).rejects.toThrow('db down');
    });
  });
});
