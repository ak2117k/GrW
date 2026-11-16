import { MultiTimeframeReaderService } from './multi-timeframe-reader.service';

const prismaFake = (dbRows: number) => ({
  instrument: {
    findFirst: jest.fn().mockResolvedValue(null),
    findMany: jest.fn().mockResolvedValue([{ id: 'i1', symbol: 'ADANIGREEN-EQ', exchange: 'NSE', token: '3563' }]),
  },
  candle: {
    findMany: jest.fn().mockImplementation(() =>
      Promise.resolve(Array.from({ length: dbRows }, (_, i) => ({ timestamp: new Date(Date.UTC(2026, 10, 11) - i * 60_000), open: 1, high: 2, low: 0.5, close: 1 }))),
    ),
  },
  $queryRaw: jest.fn().mockResolvedValue([]),
});
const candles = (n: number, stepMs: number) =>
  Array.from({ length: n }, (_, i) => ({ timestamp: new Date(Date.now() - (n - i) * stepMs), open: 100 + i, high: 101 + i, low: 99 + i, close: 100 + i, volume: 0 }));

describe('MultiTimeframeReaderService (F3 data fix)', () => {
  it('with the owner userId it reads bars from the broker per timeframe and never from the database', async () => {
    const prisma = prismaFake(5);
    const feeds = { fetchCandles: jest.fn().mockImplementation((_u, _t, _e, tf: string) => Promise.resolve(candles(300, tf === '1d' ? 86_400_000 : tf === '15m' ? 900_000 : 60_000))) };
    const svc = new MultiTimeframeReaderService(prisma as never, feeds as never);
    const v = await svc.read('ADANIGREEN', 'NSE', 'owner');
    expect(v).not.toBeNull();
    expect(feeds.fetchCandles.mock.calls.map((c) => c[3])).toEqual(['1m', '15m', '1d']);
    expect(feeds.fetchCandles.mock.calls[0].slice(0, 3)).toEqual(['owner', '3563', 'NSE']);
    expect(prisma.candle.findMany).not.toHaveBeenCalled();
    expect(v!.lastBarIst).toBeDefined();
  });
  it('a broker failure falls back to stored bars and the read still returns (stale sources say so)', async () => {
    const prisma = prismaFake(150);
    const feeds = { fetchCandles: jest.fn().mockRejectedValue(new Error('throttled')) };
    const svc = new MultiTimeframeReaderService(prisma as never, feeds as never);
    const v = await svc.read('ADANIGREEN', 'NSE', 'owner');
    expect(v).not.toBeNull();
    expect(prisma.candle.findMany).toHaveBeenCalled();
    expect(v!.timeframes['15m']).toMatchObject({ available: false, reason: expect.stringMatching(/^stale/) });
  });
  it('the broker is cached per cadence: a second read inside a minute makes no new calls', async () => {
    const feeds = { fetchCandles: jest.fn().mockResolvedValue(candles(300, 60_000)) };
    const svc = new MultiTimeframeReaderService(prismaFake(0) as never, feeds as never);
    await svc.read('ADANIGREEN', 'NSE', 'owner');
    await svc.read('ADANIGREEN', 'NSE', 'owner');
    expect(feeds.fetchCandles).toHaveBeenCalledTimes(3);
  });
});
