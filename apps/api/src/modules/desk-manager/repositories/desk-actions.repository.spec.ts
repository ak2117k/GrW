import { DeskActionsRepository } from './desk-actions.repository';

const NOW = new Date('2026-11-26T05:30:00.000Z');

function prismaWith(o: { trackers?: unknown[]; orders?: unknown[]; pending?: unknown[]; filled?: unknown[]; trades?: unknown[]; instruments?: unknown[] }) {
  return {
    tradeTracker: { findMany: jest.fn(async () => o.trackers ?? []) },
    signalOrder: { findMany: jest.fn(async () => o.orders ?? []) },
    deskManagerPendingEntry: {
      findMany: jest.fn(async (args: { where: { status: string } }) => (args.where.status === 'PENDING' ? o.pending ?? [] : o.filled ?? [])),
      count: jest.fn(async () => 2),
    },
    trade: { findMany: jest.fn(async () => o.trades ?? []) },
    instrument: { findMany: jest.fn(async () => o.instruments ?? []) },
  };
}

const inst = (token: string, name: string, symbol: string) => ({
  id: `i-${token}`, symbol, name, exchange: 'NFO', token, lotSize: 75, tickSize: 0.05, expiry: new Date('2026-12-02T00:00:00+05:30'), strike: 26000, optionType: 'CE', isActive: true, createdAt: new Date('2026-11-01'), updatedAt: new Date('2026-11-01'),
});

describe('DeskActionsRepository.busyUnderlyings', () => {
  it('names the underlying of an open tracker of any source (via the contract resolver)', async () => {
    const prisma = prismaWith({ trackers: [{ id: 't1', symbol: 'NIFTY02DEC2626000CE', exchange: 'NFO', token: '502' }], instruments: [inst('502', 'NIFTY', 'NIFTY02DEC2626000CE')] });
    const busy = await new DeskActionsRepository(prisma as never).busyUnderlyings('u', NOW);
    expect(busy.get('NIFTY')).toContain('tracker t1');
  });

  it('counts in-flight orders, pending entries (own excluded) and open manager paper trades', async () => {
    const prisma = prismaWith({
      orders: [{ id: 'o1', tradingsymbol: 'BANKNIFTY30DEC2659000PE', exchange: 'NFO', token: '900', source: 'signal' }],
      pending: [{ decisionId: 'd2', underlying: 'SENSEX' }],
      filled: [{ underlying: 'GOLD', tradeId: 'tr1' }, { underlying: 'SILVER', tradeId: 'tr2' }],
      trades: [{ id: 'tr1' }],
    });
    const busy = await new DeskActionsRepository(prisma as never).busyUnderlyings('u', NOW, 'd1');
    expect([...busy.keys()].sort()).toEqual(['BANKNIFTY', 'GOLD', 'SENSEX']);
    const pendingWhere = (prisma.deskManagerPendingEntry.findMany.mock.calls[0] as any[])[0].where;
    expect(pendingWhere.decisionId).toEqual({ not: 'd1' });
  });

  it('entriesToday counts PENDING and FILLED rows from the IST day start', async () => {
    const prisma = prismaWith({});
    expect(await new DeskActionsRepository(prisma as never).entriesToday('u', NOW, 'd1')).toBe(2);
    const where = (prisma.deskManagerPendingEntry.count.mock.calls[0] as any[])[0].where;
    expect(where).toMatchObject({ userId: 'u', status: { in: ['PENDING', 'FILLED'] }, decisionId: { not: 'd1' } });
    expect(where.createdAt.gte.toISOString()).toBe('2026-11-25T18:30:00.000Z');
  });
});
