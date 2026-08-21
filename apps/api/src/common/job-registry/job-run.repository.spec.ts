import { JobRunRepository } from './job-run.repository';

function makePrisma() {
  return {
    jobRun: {
      create: jest.fn().mockResolvedValue({ id: 'row-1' }),
      update: jest.fn().mockResolvedValue({}),
      deleteMany: jest.fn().mockResolvedValue({ count: 7 }),
      findMany: jest.fn().mockResolvedValue([]),
      // recordEnd reads startedAt back to compute durationMs. Omitting this
      // makes the lookup throw, the catch swallow it, and `update` never run —
      // so the truncation assertion below would fail for the wrong reason.
      findUnique: jest.fn().mockResolvedValue({ startedAt: new Date('2026-08-21T09:59:00.000Z') }),
    },
  };
}

describe('JobRunRepository', () => {
  it('records a start and returns the row id', async () => {
    const prisma = makePrisma();
    const repo = new JobRunRepository(prisma as never);
    await expect(repo.recordStart('nightly-sweep')).resolves.toBe('row-1');
    expect(prisma.jobRun.create).toHaveBeenCalledWith({
      data: { jobName: 'nightly-sweep', outcome: 'RUNNING' },
      select: { id: true },
    });
  });

  it('truncates an error message to 200 chars', async () => {
    const prisma = makePrisma();
    const repo = new JobRunRepository(prisma as never);
    await repo.recordEnd('row-1', 'FAILED', 'x'.repeat(500));
    const arg = prisma.jobRun.update.mock.calls[0][0];
    expect(arg.data.error).toHaveLength(200);
  });

  it('never throws when the database write fails', async () => {
    const prisma = makePrisma();
    prisma.jobRun.create.mockRejectedValue(new Error('db down'));
    const repo = new JobRunRepository(prisma as never);
    await expect(repo.recordStart('nightly-sweep')).resolves.toBeNull();
  });

  it('prunes rows older than the cutoff', async () => {
    const prisma = makePrisma();
    const repo = new JobRunRepository(prisma as never);
    const cutoff = new Date('2026-07-22T00:00:00.000Z');
    await expect(repo.pruneOlderThan(cutoff)).resolves.toBe(7);
    expect(prisma.jobRun.deleteMany).toHaveBeenCalledWith({
      where: { startedAt: { lt: cutoff } },
    });
  });
});
