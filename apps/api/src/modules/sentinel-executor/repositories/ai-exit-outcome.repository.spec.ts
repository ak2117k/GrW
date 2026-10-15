import { Prisma } from '@prisma/client';
import { AiExitOutcomeRepository, type PendingOutcome } from './ai-exit-outcome.repository';

function fakePrisma() {
  return {
    aiExitOutcome: {
      create: jest.fn().mockResolvedValue({ id: 'o1' }),
      update: jest.fn().mockResolvedValue({}),
      findMany: jest.fn().mockResolvedValue([]),
    },
  };
}
const ROW: PendingOutcome = {
  executionId: 'e1', userId: 'owner', verdictId: 'v1', trackerId: 't1', symbol: 'X', exchange: 'MCX', token: '1',
  kind: 'EXECUTED', positionSide: 'LONG', qty: 100, decisionPrice: 527.1,
  decisionAt: new Date('2026-10-14T11:00:30Z'), windowEnd: new Date('2026-10-14T12:00:30Z'), status: 'PENDING',
};
const NOW = new Date('2026-10-14T12:10:00Z');

describe('AiExitOutcomeRepository', () => {
  it('createPending inserts the row; a duplicate (P2002) is a no-op; anything else rethrows', async () => {
    const p = fakePrisma();
    const repo = new AiExitOutcomeRepository(p as never);
    await repo.createPending(ROW);
    expect(p.aiExitOutcome.create).toHaveBeenCalledWith({ data: ROW });
    p.aiExitOutcome.create.mockRejectedValueOnce(new Prisma.PrismaClientKnownRequestError('dup', { code: 'P2002', clientVersion: 'x' }));
    await expect(repo.createPending(ROW)).resolves.toBeUndefined();
    p.aiExitOutcome.create.mockRejectedValueOnce(new Error('db down'));
    await expect(repo.createPending(ROW)).rejects.toThrow('db down');
  });

  it('due = PENDING whose window ended at least 2 min ago, fewest attempts first, then oldest window', async () => {
    // Fewest attempts first: rows stuck retrying (no bars for 24 h) can never
    // starve a fresh row out of the per-pass limit.
    const p = fakePrisma();
    await new AiExitOutcomeRepository(p as never).due(NOW, 10);
    expect(p.aiExitOutcome.findMany).toHaveBeenCalledWith({
      where: { status: 'PENDING', windowEnd: { lte: new Date(NOW.getTime() - 120_000) } },
      orderBy: [{ attempts: 'asc' }, { windowEnd: 'asc' }],
      take: 10,
    });
  });

  it('markDone / markRetry / markNoData / markCorpus shapes', async () => {
    const p = fakePrisma();
    const repo = new AiExitOutcomeRepository(p as never);
    const values = { barsUsed: 1, maxAfter: 2, minAfter: 1, closeAt15: null, closeAt30: null, closeAt60: null, closeAtEnd: 2, missedPnl: 1, savedPnl: 0, netAtEnd: 1 };
    await repo.markDone('o1', values, 'candles_1m', 'partial', NOW);
    expect(p.aiExitOutcome.update).toHaveBeenLastCalledWith({
      where: { id: 'o1' }, data: { ...values, status: 'DONE', dataSource: 'candles_1m', note: 'partial', computedAt: NOW, attempts: { increment: 1 } },
    });
    await repo.markRetry('o1', 'not covered');
    expect(p.aiExitOutcome.update).toHaveBeenLastCalledWith({ where: { id: 'o1' }, data: { attempts: { increment: 1 }, note: 'not covered' } });
    await repo.markNoData('o1', 'no bars', NOW);
    expect(p.aiExitOutcome.update).toHaveBeenLastCalledWith({
      where: { id: 'o1' }, data: { status: 'NO_DATA', note: 'no bars', computedAt: NOW, attempts: { increment: 1 } },
    });
    await repo.markCorpus('o1', NOW);
    expect(p.aiExitOutcome.update).toHaveBeenLastCalledWith({ where: { id: 'o1' }, data: { corpusAt: NOW } });
  });

  it('corpusPending = DONE, not yet in the corpus, recent, plain AI verdicts only', async () => {
    const p = fakePrisma();
    const since = new Date('2026-10-07T12:10:00Z');
    await new AiExitOutcomeRepository(p as never).corpusPending(since, 20);
    expect(p.aiExitOutcome.findMany).toHaveBeenCalledWith({
      where: {
        status: 'DONE', corpusAt: null, decisionAt: { gte: since },
        NOT: [{ verdictId: { startsWith: 'man_' } }, { verdictId: { startsWith: 'trg_' } }],
      },
      orderBy: { decisionAt: 'asc' },
      take: 20,
    });
  });

  it('forDay = the user DONE rows decided in that IST day', async () => {
    const p = fakePrisma();
    await new AiExitOutcomeRepository(p as never).forDay('owner', '2026-10-14');
    expect(p.aiExitOutcome.findMany).toHaveBeenCalledWith({
      where: { userId: 'owner', status: 'DONE', decisionAt: { gte: new Date('2026-10-13T18:30:00Z'), lt: new Date('2026-10-14T18:30:00Z') } },
      orderBy: { decisionAt: 'asc' },
    });
  });

  it('byExecutionIds reads a page in one query; an empty page makes none', async () => {
    const p = fakePrisma();
    const repo = new AiExitOutcomeRepository(p as never);
    await expect(repo.byExecutionIds([])).resolves.toEqual([]);
    expect(p.aiExitOutcome.findMany).not.toHaveBeenCalled();
    await repo.byExecutionIds(['e1', 'e2']);
    expect(p.aiExitOutcome.findMany).toHaveBeenCalledWith({ where: { executionId: { in: ['e1', 'e2'] } } });
  });
});
