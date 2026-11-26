import { PrismaChainRepo } from './chain-repository';
import { localMidnight } from './chain-dates';

const CALL_AT = new Date('2026-10-12T05:00:00Z');

/** A full instrument-master row (what contractsByTokens selects). */
function row(p: { token: string; symbol: string; name: string; exchange?: string; optionType?: string | null; expiry?: Date | null; isActive?: boolean }) {
  return {
    id: `id-${p.symbol}`, exchange: 'NFO', lotSize: 1, tickSize: 0.05, strike: null, optionType: 'CE',
    expiry: new Date('2026-12-29T00:00:00Z'), isActive: true, createdAt: new Date('2026-08-01T00:00:00Z'), updatedAt: new Date('2026-10-01T00:00:00Z'),
    ...p,
  };
}

function prismaMock() {
  return {
    instrument: { findMany: jest.fn().mockResolvedValue([]), findFirst: jest.fn().mockResolvedValue(null) },
    oISnapshot: { createMany: jest.fn().mockResolvedValue({ count: 2 }), deleteMany: jest.fn().mockResolvedValue({ count: 5 }) },
    optionChainSnapshot: { create: jest.fn().mockResolvedValue({}), findFirst: jest.fn().mockResolvedValue(null) },
    $queryRaw: jest.fn().mockResolvedValue([]),
  };
}

describe('PrismaChainRepo', () => {
  it('contracts match the underlying name exactly, NFO/BFO/MCX CE/PE, one expiry day with the master convention', async () => {
    const prisma = prismaMock();
    prisma.instrument.findMany.mockResolvedValue([
      { id: 'i1', token: '40001', symbol: 'NIFTY13OCT2625000CE', exchange: 'NFO', strike: 25000, optionType: 'CE', lotSize: 75 },
    ]);
    const repo = new PrismaChainRepo(prisma as any);
    const out = await repo.contracts('nifty', '2026-10-13');
    const where = prisma.instrument.findMany.mock.calls[0][0].where;
    expect(where).toEqual({
      name: 'NIFTY',
      exchange: { in: ['NFO', 'BFO', 'MCX'] },
      optionType: { in: ['CE', 'PE'] },
      isActive: true,
      token: { not: { startsWith: 'PAPER-' } },
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
    expect(q.where.token).toEqual({ not: { startsWith: 'PAPER-' } }); // paper rows (prod 2026-11-09) made crude read as NFO, closed at 15:30
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

  it('writes OI rows with a NULL oiChange when there was no baseline, and a NULL ltp when none was quoted', async () => {
    const prisma = prismaMock();
    const repo = new PrismaChainRepo(prisma as any);
    const at = new Date('2026-10-13T05:00:00Z');
    await repo.writeOi([
      { instrumentId: 'i1', oi: 1000, oiChange: null, volume: 5, at },
      { instrumentId: 'i2', oi: 2000, oiChange: -50, volume: 6, ltp: 101.5, at },
    ]);
    expect(prisma.oISnapshot.createMany.mock.calls[0][0].data).toEqual([
      { instrumentId: 'i1', oi: BigInt(1000), oiChange: null, volume: BigInt(5), ltp: null, timestamp: at },
      { instrumentId: 'i2', oi: BigInt(2000), oiChange: BigInt(-50), volume: BigInt(6), ltp: 101.5, timestamp: at },
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

  it('describe covers BFO (SENSEX) contracts, never cash', async () => {
    const prisma = prismaMock();
    prisma.instrument.findMany.mockResolvedValue([
      row({ exchange: 'BFO', token: '8001', symbol: 'SENSEX2610282000CE', name: 'SENSEX', expiry: localMidnight('2026-10-29') }),
      // The same token re-used: an expired BANKEX contract must not add a dead chain.
      row({ exchange: 'BFO', token: '8001', symbol: 'BANKEX25AUG2660000CE', name: 'BANKEX', expiry: localMidnight('2026-08-25'), isActive: false }),
    ]);
    const repo = new PrismaChainRepo(prisma as any);
    await expect(
      repo.describe([
        { exchange: 'BFO', token: '8001', symbol: 'SENSEX2610282000CE' },
        { exchange: 'NSE', token: '2885', symbol: 'RELIANCE-EQ' },
      ]),
    ).resolves.toEqual([{ name: 'SENSEX', expiry: '2026-10-29' }]);
    expect(prisma.instrument.findMany.mock.calls[0][0].where).toEqual({ OR: [{ exchange: 'BFO', token: '8001' }] });
  });

  it('futures: active NFO FUT rows expiring on/after today, as upper-cased names and host-local expiries', async () => {
    const prisma = prismaMock();
    prisma.instrument.findMany.mockResolvedValue([
      { id: 'f1', token: '52001', symbol: 'RELIANCE27OCT26FUT', name: 'reliance', expiry: localMidnight('2026-10-27') },
      { id: 'f2', token: '52002', symbol: 'BROKEN26FUT', name: null, expiry: localMidnight('2026-10-27') },
    ]);
    const repo = new PrismaChainRepo(prisma as any);
    await expect(repo.futures('2026-10-12')).resolves.toEqual([
      { instrumentId: 'f1', ref: { exchange: 'NFO', token: '52001', symbol: 'RELIANCE27OCT26FUT' }, name: 'RELIANCE', expiry: '2026-10-27' },
    ]);
    expect(prisma.instrument.findMany.mock.calls[0][0].where).toEqual({
      exchange: 'NFO', optionType: null, isActive: true, symbol: { endsWith: 'FUT' }, expiry: { gte: localMidnight('2026-10-12') },
    });
  });

  it("optionCallUnderlyings: today's NFO option calls (by token) then open option trades, de-duplicated in order", async () => {
    const prisma: any = {
      ...prismaMock(),
      telegramSignal: {
        findMany: jest.fn().mockResolvedValue([
          { token: 'T1', symbol: 'KOTAKBANK29DEC262000CE', createdAt: CALL_AT },
          { token: 'T2', symbol: 'ADANIPORTS29DEC261500PE', createdAt: CALL_AT },
          { token: 'T1', symbol: 'KOTAKBANK29DEC262000CE', createdAt: CALL_AT },
          { token: 'TFUT', symbol: 'KOTAKBANK29DEC26FUT', createdAt: CALL_AT },
        ]),
      },
      trade: { findMany: jest.fn().mockResolvedValue([{ instrument: { name: 'cipla' } }, { instrument: { name: 'KOTAKBANK' } }]) },
    };
    prisma.instrument.findMany.mockResolvedValue([
      row({ token: 'T1', symbol: 'KOTAKBANK29DEC262000CE', name: 'KOTAKBANK', optionType: 'CE' }),
      row({ token: 'T2', symbol: 'ADANIPORTS29DEC261500PE', name: 'ADANIPORTS', optionType: 'PE' }),
      // T2 re-used: an expired contract of another underlying held it before.
      row({ token: 'T2', symbol: 'BDL25AUG261500CE', name: 'BDL', optionType: 'CE', expiry: new Date('2026-08-25T00:00:00Z'), isActive: false }),
      row({ token: 'TFUT', symbol: 'KOTAKBANK29DEC26FUT', name: 'KOTAKBANK', optionType: null }),
    ]);
    const repo = new PrismaChainRepo(prisma);
    const since = new Date('2026-10-11T18:30:00Z');
    // Only option contracts name a chain (the futures call adds none); the re-used T2 is ADANIPORTS, not BDL.
    await expect(repo.optionCallUnderlyings(since)).resolves.toEqual(['KOTAKBANK', 'ADANIPORTS', 'CIPLA']);
    expect(prisma.telegramSignal.findMany.mock.calls[0][0].where).toEqual({ createdAt: { gte: since }, exchange: 'NFO', token: { not: null } });
    expect(prisma.trade.findMany.mock.calls[0][0].where).toEqual({
      status: { in: ['OPEN', 'PARTIALLY_FILLED'] },
      instrument: { exchange: 'NFO', optionType: { in: ['CE', 'PE'] } },
    });
    expect(prisma.instrument.findMany).toHaveBeenCalledTimes(1);
  });
});
