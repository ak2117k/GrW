import { MarketEventsRepository } from './market-events.repository';

it('syncSource: upserts by (kind,key,startsAt) and deletes this source\'s rows in the window that vanished', async () => {
  const tx = {
    marketEvent: {
      findMany: jest.fn().mockResolvedValue([
        { id: 'keep', kind: 'results', key: 'INFY', startsAt: new Date('2026-10-16T03:45:00Z') },
        { id: 'gone', kind: 'results', key: 'TCS', startsAt: new Date('2026-10-17T03:45:00Z') },
      ]),
      deleteMany: jest.fn().mockResolvedValue({ count: 1 }),
      upsert: jest.fn().mockResolvedValue({}),
    },
  };
  const prisma = { $transaction: jest.fn(async (fn: (t: typeof tx) => unknown) => fn(tx)) };
  const repo = new MarketEventsRepository(prisma as never);
  const now = new Date('2026-10-16T02:00:00Z');
  const row = { scope: 'company' as const, kind: 'results', key: 'INFY', title: 'INFY results', startsAt: new Date('2026-10-16T03:45:00Z'), allDay: true, impact: 'high' as const, source: 'NSE event calendar', sourceRef: 'r' };
  await expect(repo.syncSource('NSE event calendar', now, new Date('2026-12-01'), [row], now)).resolves.toEqual({ upserted: 1, removed: 1 });
  expect(tx.marketEvent.deleteMany).toHaveBeenCalledWith({ where: { id: { in: ['gone'] } } });
  expect(tx.marketEvent.upsert.mock.calls[0][0].where).toEqual({ kind_key_startsAt: { kind: 'results', key: 'INFY', startsAt: row.startsAt } });
});
