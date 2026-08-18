import { readFileSync } from 'fs';
import { join } from 'path';
import { OpenPositionsRepository } from './open-positions.repository';

describe('OpenPositionsRepository', () => {
  const findMany = jest.fn().mockResolvedValue([]);
  const prisma = { tradeTracker: { findMany } } as never;
  const repo = new OpenPositionsRepository(prisma);

  beforeEach(() => jest.clearAllMocks());

  it('reads only this tenant’s OPEN trades, oldest first', async () => {
    await repo.listOpen('u1');

    expect(findMany).toHaveBeenCalledWith({
      where: { userId: 'u1', status: 'OPEN' },
      orderBy: { entryTime: 'asc' },
      select: { id: true, symbol: true, exchange: true, kind: true, entryTime: true },
    });
  });

  it('projects five columns, so a new TradeTracker column cannot leak into a packet', async () => {
    await repo.listOpen('u1');
    const arg = findMany.mock.calls[0][0];
    // A bare findMany would return every column, and the roster's rows feed a
    // context packet that is persisted verbatim and replayed forever.
    expect(Object.keys(arg.select)).toEqual([
      'id',
      'symbol',
      // The roster's F&O-only remit is decided from this — see OpenPosition.
      'exchange',
      'kind',
      'entryTime',
    ]);
  });

  it('returns whatever Prisma returns, unmapped', async () => {
    const rows = [{ id: 't1', symbol: 'INFY', kind: 'POSITION', entryTime: new Date() }];
    findMany.mockResolvedValue(rows);
    await expect(repo.listOpen('u1')).resolves.toBe(rows);
  });

  it('does not reach the trade-tracker service — that is the whole point of it existing', () => {
    const source = readFileSync(join(__dirname, 'open-positions.repository.ts'), 'utf8');
    // Delegating to TradeTrackerService would make the Angel One adapter
    // reachable from the sentinel cycle again, one hop further away. The four
    // duplicated lines of query are the price of the property.
    expect(source).not.toMatch(/trade-tracker/i);
  });
});
