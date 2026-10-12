import { PrismaChainRepo } from './chain-repository';
import { localMidnight } from './chain-dates';

function prismaMock() {
  return {
    instrument: { findMany: jest.fn().mockResolvedValue([]), findFirst: jest.fn().mockResolvedValue(null) },
    oISnapshot: { createMany: jest.fn().mockResolvedValue({ count: 2 }), deleteMany: jest.fn().mockResolvedValue({ count: 5 }) },
    optionChainSnapshot: { create: jest.fn().mockResolvedValue({}), findFirst: jest.fn().mockResolvedValue(null) },
    $queryRaw: jest.fn().mockResolvedValue([]),
  };
}

describe('PrismaChainRepo', () => {
  it('contracts match the underlying name exactly, NFO/MCX CE/PE, one expiry day with the master convention', async () => {
    const prisma = prismaMock();
    prisma.instrument.findMany.mockResolvedValue([
      { id: 'i1', token: '40001', symbol: 'NIFTY13OCT2625000CE', exchange: 'NFO', strike: 25000, optionType: 'CE', lotSize: 75 },
    ]);
    const repo = new PrismaChainRepo(prisma as any);
    const out = await repo.contracts('nifty', '2026-10-13');
    const where = prisma.instrument.findMany.mock.calls[0][0].where;
    expect(where).toEqual({
      name: 'NIFTY',
      exchange: { in: ['NFO', 'MCX'] },
      optionType: { in: ['CE', 'PE'] },
      isActive: true,
      expiry: { gte: localMidnight('2026-10-13'), lt: localMidnight('2026-10-14') },
    });
    expect(out).toEqual([
      { instrumentId: 'i1', ref: { exchange: 'NFO', token: '40001', symbol: 'NIFTY13OCT2625000CE' }, strike: 25000, optionType: 'CE', lotSize: 75 },
    ]);
  });

  it('expiries are host-local YYYY-MM-DD, ascending, distinct, and include today', async () => {
    const prisma = prismaMock();
    prisma.instrument.findMany.mockResolvedValue([{ expiry: localMidnight('2026-10-13') }, { expiry: localMidnight('2026-10-20') }]);
    const repo = new PrismaChainRepo(prisma as any);
    await expect(repo.expiries('NIFTY', '2026-10-13')).resolves.toEqual(['2026-10-13', '2026-10-20']);
    const q = prisma.instrument.findMany.mock.calls[0][0];
    expect(q.where.expiry).toEqual({ gte: localMidnight('2026-10-13') });
    expect(q.distinct).toEqual(['expiry']);
    expect(q.orderBy).toEqual({ expiry: 'asc' });
  });

  it('an MCX underlying is the nearest future of exactly that name expiring on/after the option', async () => {
    const prisma = prismaMock();
    prisma.instrument.findFirst.mockResolvedValue({ token: '472790', symbol: 'CRUDEOIL19OCT26FUT' });
    const repo = new PrismaChainRepo(prisma as any);
    await expect(repo.underlyingRef('CRUDEOIL', 'MCX', '2026-10-16')).resolves.toEqual({ exchange: 'MCX', token: '472790', symbol: 'CRUDEOIL19OCT26FUT' });
    expect(prisma.instrument.findFirst.mock.calls[0][0]).toEqual({
      where: { name: 'CRUDEOIL', exchange: 'MCX', isActive: true, optionType: null, symbol: { endsWith: 'FUT' }, expiry: { gte: localMidnight('2026-10-16') } },
      orderBy: { expiry: 'asc' },
    });
  });

  it('index underlyings come from the index map without a query; stocks from NSE cash (-EQ first)', async () => {
    const prisma = prismaMock();
    const repo = new PrismaChainRepo(prisma as any);
    await expect(repo.underlyingRef('NIFTY', 'NFO', '2026-10-13')).resolves.toEqual({ exchange: 'NSE', token: '99926000', symbol: expect.any(String) });
    expect(prisma.instrument.findFirst).not.toHaveBeenCalled();
    prisma.instrument.findFirst.mockResolvedValueOnce({ token: '2885', symbol: 'RELIANCE-EQ' });
    await expect(repo.underlyingRef('RELIANCE', 'NFO', '2026-10-27')).resolves.toEqual({ exchange: 'NSE', token: '2885', symbol: 'RELIANCE-EQ' });
    expect(prisma.instrument.findFirst.mock.calls[0][0]).toEqual({ where: { symbol: 'RELIANCE-EQ', exchange: 'NSE' } });
  });

  it('writes OI rows with a NULL oiChange when there was no baseline', async () => {
    const prisma = prismaMock();
    const repo = new PrismaChainRepo(prisma as any);
    const at = new Date('2026-10-13T05:00:00Z');
    await repo.writeOi([
      { instrumentId: 'i1', oi: 1000, oiChange: null, volume: 5, at },
      { instrumentId: 'i2', oi: 2000, oiChange: -50, volume: 6, at },
    ]);
    expect(prisma.oISnapshot.createMany.mock.calls[0][0].data).toEqual([
      { instrumentId: 'i1', oi: BigInt(1000), oiChange: null, volume: BigInt(5), timestamp: at },
      { instrumentId: 'i2', oi: BigInt(2000), oiChange: BigInt(-50), volume: BigInt(6), timestamp: at },
    ]);
  });

  it('stores a chain snapshot as source HUB in the legacy OptionsChainEntry[] shape and reads it back', async () => {
    const prisma = prismaMock();
    const repo = new PrismaChainRepo(prisma as any);
    const entries = [{ strikePrice: 25000, expiryDate: '2026-10-13', ceData: null, peData: null }];
    await repo.writeChainSnapshot({ underlying: 'NIFTY', expiry: '2026-10-13', exchange: 'NFO', spot: null, at: Date.parse('2026-10-13T10:00:00Z'), greeks: 'broker', entries });
    expect(prisma.optionChainSnapshot.create.mock.calls[0][0].data).toEqual({
      underlying: 'NIFTY', expiryDate: new Date('2026-10-13'), spotPrice: 0, source: 'HUB', strikeCount: 1,
      chainJson: entries, capturedAt: new Date('2026-10-13T10:00:00Z'),
    });
    prisma.optionChainSnapshot.findFirst.mockResolvedValue({ spotPrice: '0', capturedAt: new Date('2026-10-13T10:00:00Z'), chainJson: entries });
    await expect(repo.latestChainSnapshot('NIFTY', '2026-10-13', 'NFO')).resolves.toEqual({
      underlying: 'NIFTY', expiry: '2026-10-13', exchange: 'NFO', spot: null, at: Date.parse('2026-10-13T10:00:00Z'), greeks: 'none', entries,
    });
    // Only the hub's own rows: a legacy NSE / Angel snapshot is not a hub chain.
    expect(prisma.optionChainSnapshot.findFirst.mock.calls[0][0]).toEqual({
      where: { underlying: 'NIFTY', expiryDate: new Date('2026-10-13'), source: 'HUB' },
      orderBy: { capturedAt: 'desc' },
    });
  });

  it('a stored chain is labelled broker Greeks only when some leg carries an IV, else none', async () => {
    const prisma = prismaMock();
    const repo = new PrismaChainRepo(prisma as any);
    const at = new Date('2026-10-13T10:00:00Z');
    const leg = (iv: number) => ({ ltp: 100, oi: 1000, oiChange: null, volume: 1, iv, delta: 0.5, gamma: 0, theta: 0, vega: 0, bidPrice: 0, askPrice: 0 });
    prisma.optionChainSnapshot.findFirst.mockResolvedValueOnce({
      spotPrice: '25000', capturedAt: at,
      chainJson: [{ strikePrice: 25000, expiryDate: '2026-10-13', ceData: null, peData: null }],
    });
    await expect(repo.latestChainSnapshot('NIFTY', '2026-10-13', 'NFO')).resolves.toEqual(expect.objectContaining({ greeks: 'none' }));
    prisma.optionChainSnapshot.findFirst.mockResolvedValueOnce({
      spotPrice: '25000', capturedAt: at,
      chainJson: [
        { strikePrice: 25000, expiryDate: '2026-10-13', ceData: leg(0), peData: null },
        { strikePrice: 25050, expiryDate: '2026-10-13', ceData: null, peData: leg(13) },
      ],
    });
    await expect(repo.latestChainSnapshot('NIFTY', '2026-10-13', 'NFO')).resolves.toEqual(expect.objectContaining({ greeks: 'broker' }));
  });

  it('baseline asks for the last row per instrument before the cut-off, as numbers', async () => {
    const prisma = prismaMock();
    prisma.$queryRaw.mockResolvedValue([{ instrumentId: 'i1', oi: BigInt(900) }]);
    const repo = new PrismaChainRepo(prisma as any);
    await expect(repo.baseline(['i1', 'i2'], new Date('2026-10-12T18:30:00Z'))).resolves.toEqual(new Map([['i1', 900]]));
    await expect(repo.baseline([], new Date())).resolves.toEqual(new Map());
    expect(prisma.$queryRaw).toHaveBeenCalledTimes(1);
  });
});
