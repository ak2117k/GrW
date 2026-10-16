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
      findUnique: jest.fn().mockResolvedValue(null),
      findFirst: jest.fn().mockResolvedValue(null),
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

  it('update writes the gate record (E7) and the order LTP (E5) in the SAME call as the plan', async () => {
    const p = fakePrisma();
    const gate = { v: 1, outcome: 'GATED_THESIS_INTACT', justification: null, clauses: [], persistence: null, facts: null,
      cfg: { floorArmN: 1.5, floorTrailN: 2, gateCloseMin: 10, gateUnderlyingN: 1, persistWindowSec: 300, persistMinSec: 120 },
      evaluatedAt: '2026-10-14T11:01:30.000Z' } as const;
    await new AiExitExecutionRepository(p as never).update('row1', { quantity: 100, orderLtp: 527.1, gate: gate as never });
    expect(p.aiExitExecution.update).toHaveBeenCalledTimes(1);
    expect(p.aiExitExecution.update).toHaveBeenCalledWith({ where: { id: 'row1' }, data: { quantity: 100, orderLtp: 527.1, gate } });
  });

  it('countCountedSince counts every row where an order may have been sent (PLACED, FILLED, ORDER_UNCERTAIN, INTERRUPTED) plus DRY_RUN', async () => {
    const p = fakePrisma();
    const since = new Date('2026-10-11T18:30:00Z');
    await new AiExitExecutionRepository(p as never).countCountedSince('owner', since, 'live');
    expect(p.aiExitExecution.count).toHaveBeenCalledWith({
      where: {
        userId: 'owner',
        mode: 'live',
        createdAt: { gte: since },
        OR: [
          { status: { in: ['PLACED', 'FILLED', 'DRY_RUN'] } },
          { status: 'FAILED', reason: { in: ['ORDER_UNCERTAIN', 'INTERRUPTED'] } },
        ],
        // Owner-triggered manual exits never use up the AI's daily cap.
        NOT: { verdictId: { startsWith: 'man_' } },
      },
    });
  });

  it('hasInFlight (review fix 2): CLAIMED, or — for the rest of the IST day — PLACED (any age), ORDER_UNCERTAIN or INTERRUPTED, on the same tracker OR the same user+contract', async () => {
    const p = fakePrisma();
    const now = new Date('2026-10-12T10:00:00Z'); // 15:30 IST; the IST day began 2026-10-11T18:30Z
    p.aiExitExecution.count.mockResolvedValueOnce(1);
    const repo = new AiExitExecutionRepository(p as never);
    await expect(repo.hasInFlight('t1', 'row1', now, { userId: 'owner', exchange: 'mcx', token: '445566' })).resolves.toBe(true);
    expect(p.aiExitExecution.count).toHaveBeenCalledWith({
      where: {
        id: { not: 'row1' },
        AND: [
          { OR: [{ trackerId: 't1' }, { userId: 'owner', exchange: 'MCX', token: '445566' }] },
          {
            OR: [
              { status: 'CLAIMED' },
              {
                createdAt: { gte: new Date('2026-10-11T18:30:00Z') },
                OR: [
                  { status: 'PLACED' },
                  { status: 'FAILED', reason: { in: ['ORDER_UNCERTAIN', 'INTERRUPTED'] } },
                ],
              },
            ],
          },
        ],
      },
    });
    await expect(repo.hasInFlight('t1', 'row1', now, { userId: 'owner', exchange: 'MCX', token: '445566' })).resolves.toBe(false);
  });

  it('hasInFlight without a known contract scopes by tracker only', async () => {
    const p = fakePrisma();
    await new AiExitExecutionRepository(p as never).hasInFlight('t1', 'row1', new Date('2026-10-12T10:00:00Z'));
    expect(p.aiExitExecution.count.mock.calls[0][0].where.AND[0]).toEqual({ OR: [{ trackerId: 't1' }] });
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

describe('cap is counted per mode (review fix 4)', () => {
  it('a live count never includes dry-run rows, and vice versa', async () => {
    const p = fakePrisma();
    const repo = new AiExitExecutionRepository(p as never);
    const since = new Date('2026-10-11T18:30:00Z');
    await repo.countCountedSince('owner', since, 'live');
    await repo.countCountedSince('owner', since, 'dry-run');
    expect(p.aiExitExecution.count.mock.calls[0][0].where).toEqual(expect.objectContaining({ userId: 'owner', mode: 'live' }));
    expect(p.aiExitExecution.count.mock.calls[1][0].where).toEqual(expect.objectContaining({ userId: 'owner', mode: 'dry-run' }));
  });
});

describe('manual exits (owner Exit button)', () => {
  it('claim of a manual attempt inserts a live CLAIMED row with the synthetic id and the MANUAL reason', async () => {
    const p = fakePrisma();
    const repo = new AiExitExecutionRepository(p as never);
    const v = { ...V, id: 'man_t1_1', reason: 'MANUAL: owner exit' };
    await expect(repo.claim(v, 'live')).resolves.toBe('row1');
    expect(p.aiExitExecution.create.mock.calls[0][0].data).toEqual(expect.objectContaining({
      verdictId: 'man_t1_1', mode: 'live', status: 'CLAIMED', verdictReason: 'MANUAL: owner exit',
    }));
  });

  it('countManualForTracker counts every manual row ever made for the tracker', async () => {
    const p = fakePrisma();
    p.aiExitExecution.count.mockResolvedValueOnce(2);
    await expect(new AiExitExecutionRepository(p as never).countManualForTracker('t1')).resolves.toBe(2);
    expect(p.aiExitExecution.count).toHaveBeenCalledWith({
      where: { trackerId: 't1', verdictId: { startsWith: 'man_' } },
    });
  });

  it('findActiveManual returns the newest CLAIMED, or PLACED today, manual row of the tracker', async () => {
    const p = fakePrisma();
    const now = new Date('2026-10-12T10:00:00Z');
    await new AiExitExecutionRepository(p as never).findActiveManual('t1', 'owner', now);
    expect(p.aiExitExecution.findFirst).toHaveBeenCalledWith({
      where: {
        trackerId: 't1',
        userId: 'owner',
        verdictId: { startsWith: 'man_' },
        OR: [
          { status: 'CLAIMED' },
          { status: 'PLACED', createdAt: { gte: new Date('2026-10-11T18:30:00Z') } },
        ],
      },
      orderBy: { createdAt: 'desc' },
    });
  });

  it('findByVerdictId / findById read one row', async () => {
    const p = fakePrisma();
    const repo = new AiExitExecutionRepository(p as never);
    await repo.findByVerdictId('man_t1_1');
    expect(p.aiExitExecution.findUnique).toHaveBeenLastCalledWith({ where: { verdictId: 'man_t1_1' } });
    await repo.findById('row1');
    expect(p.aiExitExecution.findUnique).toHaveBeenLastCalledWith({ where: { id: 'row1' } });
  });

  it('placedAwaitingFill (E5): live PLACED rows with a broker order id since the given time, oldest first', async () => {
    const p = fakePrisma();
    const since = new Date('2026-10-13T18:30:00Z');
    await new AiExitExecutionRepository(p as never).placedAwaitingFill(since);
    expect(p.aiExitExecution.findMany).toHaveBeenCalledWith({
      where: { status: 'PLACED', mode: 'live', createdAt: { gte: since }, brokerOrderId: { not: null } },
      orderBy: { createdAt: 'asc' },
      take: 20,
      select: { id: true, userId: true, verdictId: true, symbol: true, brokerOrderId: true, createdAt: true },
    });
  });

  it('settlePlaced (E5) only moves a row that is STILL PLACED, and says whether it did', async () => {
    const p = fakePrisma();
    const repo = new AiExitExecutionRepository(p as never);
    p.aiExitExecution.updateMany.mockResolvedValueOnce({ count: 1 }).mockResolvedValueOnce({ count: 0 });
    await expect(repo.settlePlaced('r1', { status: 'FILLED', fillPrice: 1 })).resolves.toBe(true);
    await expect(repo.settlePlaced('r1', { status: 'FILLED', fillPrice: 1 })).resolves.toBe(false);
    expect(p.aiExitExecution.updateMany).toHaveBeenCalledWith({ where: { id: 'r1', status: 'PLACED' }, data: { status: 'FILLED', fillPrice: 1 } });
  });

  it('scoringCandidates (exit discipline R10): ONE raw anti-join over executed, dry-run, late PLACED and gated/awaiting skips; never MANUAL', async () => {
    const p = fakePrisma();
    const now = new Date('2026-10-14T12:10:00Z');
    const since = new Date('2026-10-12T12:10:00Z');
    await new AiExitExecutionRepository(p as never).scoringCandidates(now, since, 60);
    expect(p.$queryRaw).toHaveBeenCalledTimes(1);
    const q = p.$queryRaw.mock.calls[0][0] as { strings: string[]; values: unknown[] };
    const sql = q.strings.join('?').replace(/\s+/g, ' ');
    expect(sql).toMatch(/FROM "ai_exit_executions" e/);
    // Prisma binds a JS number as bigint; Postgres has no left(text, bigint) — the cast is required
    // (prod 2026-10-16: "function left(text, bigint) does not exist" stopped every outcome from scoring).
    expect(sql).toMatch(/left\(e\."verdictId", \?::int\) <> \?/);
    expect(sql).toMatch(/e\."exchange" IS NOT NULL AND e\."token" IS NOT NULL/);
    expect(sql).toMatch(/e\."status" IN \('FILLED', 'DRY_RUN'\)/);
    expect(sql).toMatch(/e\."status" = 'PLACED' AND e\."createdAt" < \?/);
    expect(sql).toMatch(/e\."status" = 'SKIPPED' AND e\."reason" IN \('GATED_THESIS_INTACT', 'AWAITING_CONFIRMATION'\)/);
    expect(sql).toMatch(/NOT EXISTS \(SELECT 1 FROM "ai_exit_outcomes" o WHERE o\."executionId" = e\."id"\)/);
    expect(q.values).toEqual(expect.arrayContaining([since, 'man_'.length, 'man_', new Date(now.getTime() - 60 * 60_000)]));
  });

  it('qualityBackfillCandidates (E5): filled rows whose slippage is not yet computed', async () => {
    const p = fakePrisma();
    const since = new Date('2026-10-12T12:10:00Z');
    await new AiExitExecutionRepository(p as never).qualityBackfillCandidates(since);
    expect(p.aiExitExecution.findMany).toHaveBeenCalledWith({
      where: { fillPrice: { not: null }, slippage: null, createdAt: { gte: since } },
      orderBy: { createdAt: 'asc' },
      take: 20,
    });
  });
});

describe('price-trigger fires and the AI cap (sentinel price triggers R13)', () => {
  it('price-trigger rows count toward the AI cap (only man_ is excluded)', async () => {
    const count = jest.fn().mockResolvedValue(0);
    const repo = new AiExitExecutionRepository({ aiExitExecution: { count } } as never);
    await repo.countCountedSince('owner', new Date(0), 'live');
    const where = count.mock.calls[0][0].where;
    expect(JSON.stringify(where)).not.toContain('trg_');
    expect(where.NOT).toEqual({ verdictId: { startsWith: 'man_' } });
  });
});
