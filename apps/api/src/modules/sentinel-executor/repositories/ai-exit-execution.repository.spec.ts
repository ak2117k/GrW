// apps/api/src/modules/sentinel-executor/repositories/ai-exit-execution.repository.spec.ts
import { Prisma } from '@prisma/client';
import { AiExitExecutionRepository, type PendingVerdict } from './ai-exit-execution.repository';

function fakePrisma() {
  return {
    $queryRaw: jest.fn().mockResolvedValue([]),
    aiExitExecution: {
      create: jest.fn().mockResolvedValue({ id: 'row1' }),
      update: jest.fn().mockResolvedValue({}),
      count: jest.fn().mockResolvedValue(0),
      updateMany: jest.fn().mockResolvedValue({ count: 0 }),
      findMany: jest.fn().mockResolvedValue([]),
    },
  };
}
const V: PendingVerdict = {
  id: 'v1', userId: 'owner', trackerId: 't1', symbol: 'CRUDEOIL15OCT268950CE',
  reason: 'thesis broken', createdAt: new Date('2026-10-12T10:00:00Z'),
};

describe('AiExitExecutionRepository', () => {
  it('claim inserts a CLAIMED row carrying the verdict reason and mode', async () => {
    const p = fakePrisma();
    const repo = new AiExitExecutionRepository(p as never);
    await expect(repo.claim(V, 'dry-run')).resolves.toBe('row1');
    expect(p.aiExitExecution.create).toHaveBeenCalledWith({
      data: {
        userId: 'owner', verdictId: 'v1', trackerId: 't1', symbol: 'CRUDEOIL15OCT268950CE',
        mode: 'dry-run', status: 'CLAIMED', verdictReason: 'thesis broken',
      },
      select: { id: true },
    });
  });

  it('claim returns null on a unique violation (someone else has it) and rethrows anything else', async () => {
    const p = fakePrisma();
    const repo = new AiExitExecutionRepository(p as never);
    p.aiExitExecution.create.mockRejectedValueOnce(
      new Prisma.PrismaClientKnownRequestError('dup', { code: 'P2002', clientVersion: 'x' }),
    );
    await expect(repo.claim(V, 'live')).resolves.toBeNull();
    p.aiExitExecution.create.mockRejectedValueOnce(new Error('db down'));
    await expect(repo.claim(V, 'live')).rejects.toThrow('db down');
  });

  it('claim rethrows a known request error that is not P2002', async () => {
    const p = fakePrisma();
    p.aiExitExecution.create.mockRejectedValueOnce(
      new Prisma.PrismaClientKnownRequestError('check', { code: 'P2004', clientVersion: 'x' }),
    );
    await expect(new AiExitExecutionRepository(p as never).claim(V, 'live')).rejects.toThrow('check');
  });

  it('update patches the row by id', async () => {
    const p = fakePrisma();
    await new AiExitExecutionRepository(p as never).update('row1', { status: 'SKIPPED', reason: 'DAILY_CAP' });
    expect(p.aiExitExecution.update).toHaveBeenCalledWith({
      where: { id: 'row1' }, data: { status: 'SKIPPED', reason: 'DAILY_CAP' },
    });
  });

  it('countCountedSince counts PLACED/FILLED/DRY_RUN since the instant', async () => {
    const p = fakePrisma();
    const since = new Date('2026-10-11T18:30:00Z');
    await new AiExitExecutionRepository(p as never).countCountedSince('owner', since);
    expect(p.aiExitExecution.count).toHaveBeenCalledWith({
      where: { userId: 'owner', createdAt: { gte: since }, status: { in: ['PLACED', 'FILLED', 'DRY_RUN'] } },
    });
  });

  it('hasInFlight: another CLAIMED row, or a PLACED row in the last 60 s, for the same tracker', async () => {
    const p = fakePrisma();
    const now = new Date('2026-10-12T10:00:00Z');
    p.aiExitExecution.count.mockResolvedValueOnce(1);
    await expect(new AiExitExecutionRepository(p as never).hasInFlight('t1', 'row1', now)).resolves.toBe(true);
    expect(p.aiExitExecution.count).toHaveBeenCalledWith({
      where: {
        trackerId: 't1',
        id: { not: 'row1' },
        OR: [
          { status: 'CLAIMED' },
          { status: 'PLACED', createdAt: { gte: new Date('2026-10-12T09:59:00Z') } },
        ],
      },
    });
    await expect(new AiExitExecutionRepository(p as never).hasInFlight('t1', 'row1', now)).resolves.toBe(false);
  });

  it('sweepInterrupted turns old CLAIMED rows into FAILED: INTERRUPTED', async () => {
    const p = fakePrisma();
    p.aiExitExecution.updateMany.mockResolvedValueOnce({ count: 2 });
    const cutoff = new Date('2026-10-12T09:59:00Z');
    await expect(new AiExitExecutionRepository(p as never).sweepInterrupted(cutoff)).resolves.toBe(2);
    expect(p.aiExitExecution.updateMany).toHaveBeenCalledWith({
      where: { status: 'CLAIMED', createdAt: { lt: cutoff } },
      data: { status: 'FAILED', reason: 'INTERRUPTED' },
    });
  });

  it('pendingVerdicts is ONE raw anti-join query; an empty allow-list makes no query', async () => {
    const p = fakePrisma();
    const repo = new AiExitExecutionRepository(p as never);
    await expect(repo.pendingVerdicts([], new Date())).resolves.toEqual([]);
    expect(p.$queryRaw).not.toHaveBeenCalled();
    const since = new Date('2026-10-12T09:57:00Z');
    await repo.pendingVerdicts(['owner', 'u2'], since);
    expect(p.$queryRaw).toHaveBeenCalledTimes(1);
    const q = p.$queryRaw.mock.calls[0][0] as Prisma.Sql;
    expect(q.sql).toContain('"sentinel_verdicts"');
    expect(q.sql).toContain(`"verdict" = 'EXIT_NOW'`);
    expect(q.sql).toContain('NOT EXISTS');
    expect(q.sql).toContain('"ai_exit_executions"');
    expect(q.sql).toContain('ORDER BY v."createdAt" ASC');
    // user ids, the window and the limit are bound parameters, never spliced into the SQL
    expect(q.values).toEqual(['owner', 'u2', since, 5]);
  });

  it('listForUser is scoped and newest first', async () => {
    const p = fakePrisma();
    await new AiExitExecutionRepository(p as never).listForUser('owner', 20);
    expect(p.aiExitExecution.findMany).toHaveBeenCalledWith({
      where: { userId: 'owner' }, orderBy: { createdAt: 'desc' }, take: 20,
    });
  });
});
