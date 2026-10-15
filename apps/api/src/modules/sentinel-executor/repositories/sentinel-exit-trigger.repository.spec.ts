// apps/api/src/modules/sentinel-executor/repositories/sentinel-exit-trigger.repository.spec.ts
import { Prisma } from '@prisma/client';
import { SentinelExitTriggerRepository, type ProposalRow } from './sentinel-exit-trigger.repository';

const P: ProposalRow = { id: 'v1', userId: 'owner', trackerId: 't1', symbol: 'CRUDEOIL19NOV268950CE', verdict: 'HOLD', exitTrigger: {}, createdAt: new Date(0) };
const NOW = new Date('2026-10-13T17:00:00Z');
const p2002 = () => new Prisma.PrismaClientKnownRequestError('unique', { code: 'P2002', clientVersion: 'x' });

describe('SentinelExitTriggerRepository', () => {
  it('the arming query: HOLD/EXIT_ARMED with a non-null exitTrigger and no trigger row yet (null never disarms)', async () => {
    const $queryRaw = jest.fn().mockResolvedValue([]);
    const repo = new SentinelExitTriggerRepository({ $queryRaw } as never);
    await repo.pendingProposals(['owner'], NOW, 10);
    const sql = ($queryRaw.mock.calls[0][0] as Prisma.Sql).sql;
    expect(sql).toMatch(/"verdict" IN \('HOLD', 'EXIT_ARMED'\)/);
    expect(sql).toMatch(/"exitTrigger" IS NOT NULL/);
    expect(sql).toMatch(/NOT EXISTS \(SELECT 1 FROM "sentinel_exit_triggers" t WHERE t\."verdictId" = v\."id"\)/);
    expect(await repo.pendingProposals([], NOW, 10)).toEqual([]);
    expect($queryRaw).toHaveBeenCalledTimes(1);
  });

  it('reject: one REJECTED row; a duplicate verdict is false, not a throw', async () => {
    const create = jest.fn().mockResolvedValueOnce({}).mockRejectedValueOnce(p2002());
    const repo = new SentinelExitTriggerRepository({ sentinelExitTrigger: { create } } as never);
    await expect(repo.reject(P, { instrument: 'PREMIUM' }, 'NOT_PROTECTIVE')).resolves.toBe(true);
    expect(create.mock.calls[0][0].data).toMatchObject({ verdictId: 'v1', status: 'REJECTED', reason: 'NOT_PROTECTIVE', instrument: 'PREMIUM' });
    await expect(repo.reject(P, {}, 'X')).resolves.toBe(false);
  });

  it('arm: supersedes the tracker’s ARMED row and inserts the new one in ONE transaction', async () => {
    const tx = {
      sentinelExitTrigger: {
        findMany: jest.fn().mockResolvedValue([{ id: 'old' }]),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
        create: jest.fn().mockResolvedValue({ id: 'new' }),
      },
    };
    const $transaction = jest.fn(async (fn: (t: typeof tx) => unknown) => fn(tx));
    const repo = new SentinelExitTriggerRepository({ $transaction } as never);
    const f = { instrument: 'UNDERLYING', op: 'BELOW', price: 8930, watchExchange: 'MCX', watchToken: '472789', watchSymbol: 'F', refPrice: 8951 } as const;
    await expect(repo.arm(P, f, NOW)).resolves.toEqual({ id: 'new', superseded: ['old'] });
    expect(tx.sentinelExitTrigger.updateMany.mock.calls[0][0]).toEqual({
      where: { id: { in: ['old'] }, status: 'ARMED' },
      data: { status: 'SUPERSEDED', endedAt: NOW, reason: 'SUPERSEDED_BY:v1' },
    });
    expect(tx.sentinelExitTrigger.create.mock.calls[0][0].data).toMatchObject({ ...f, status: 'ARMED', armedAt: NOW, verdictId: 'v1' });
  });

  it('arm: a unique violation (verdict handled, or a second ARMED row raced in) is null', async () => {
    const $transaction = jest.fn().mockRejectedValue(p2002());
    const repo = new SentinelExitTriggerRepository({ $transaction } as never);
    await expect(repo.arm(P, {} as never, NOW)).resolves.toBeNull();
  });

  it('claimFire is the conditional ARMED → FIRED update (R7 layer 2)', async () => {
    const updateMany = jest.fn().mockResolvedValueOnce({ count: 1 }).mockResolvedValueOnce({ count: 0 });
    const repo = new SentinelExitTriggerRepository({ sentinelExitTrigger: { updateMany } } as never);
    const tick = { price: 8927.5, at: new Date(NOW.getTime() - 100) };
    await expect(repo.claimFire('trg1', tick, NOW)).resolves.toBe(true);
    await expect(repo.claimFire('trg1', tick, NOW)).resolves.toBe(false);
    expect(updateMany.mock.calls[0][0]).toEqual({
      where: { id: 'trg1', status: 'ARMED' },
      data: { status: 'FIRED', firedAt: NOW, firedPrice: 8927.5, firedTickAt: tick.at },
    });
  });

  it('expire only touches ARMED rows; nothing to expire = no query', async () => {
    const updateMany = jest.fn().mockResolvedValue({ count: 2 });
    const repo = new SentinelExitTriggerRepository({ sentinelExitTrigger: { updateMany } } as never);
    await expect(repo.expire([], 'MAX_AGE', NOW)).resolves.toBe(0);
    expect(updateMany).not.toHaveBeenCalled();
    await repo.expire(['a', 'b'], 'MAX_AGE', NOW);
    expect(updateMany.mock.calls[0][0]).toEqual({
      where: { id: { in: ['a', 'b'] }, status: 'ARMED' },
      data: { status: 'EXPIRED', endedAt: NOW, reason: 'MAX_AGE' },
    });
  });

  it('trackerExchanges: the POSITION exchange by tracker id, upper-cased; nothing asked = no query', async () => {
    const findMany = jest.fn().mockResolvedValue([{ id: 't1', exchange: 'nfo' }]);
    const repo = new SentinelExitTriggerRepository({ tradeTracker: { findMany } } as never);
    await expect(repo.trackerExchanges(['t1'])).resolves.toEqual(new Map([['t1', 'NFO']]));
    await expect(repo.trackerExchanges([])).resolves.toEqual(new Map());
    expect(findMany).toHaveBeenCalledTimes(1);
  });

  it('closedTrackerIds: not OPEN, or gone', async () => {
    const findMany = jest.fn().mockResolvedValue([{ id: 't1', status: 'OPEN' }, { id: 't2', status: 'CLOSED' }]);
    const repo = new SentinelExitTriggerRepository({ tradeTracker: { findMany } } as never);
    await expect(repo.closedTrackerIds(['t1', 't2', 't3'])).resolves.toEqual(['t2', 't3']);
    await expect(repo.closedTrackerIds([])).resolves.toEqual([]);
    expect(findMany).toHaveBeenCalledTimes(1);
  });
});
