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
    const feeds = { fetchCandleWindow: jest.fn().mockImplementation((_u, _r, tf: string) => Promise.resolve(candles(300, tf === 'ONE_DAY' ? 86_400_000 : tf === 'FIFTEEN_MINUTE' ? 900_000 : 60_000))) };
    const svc = new MultiTimeframeReaderService(prisma as never, feeds as never);
    const v = await svc.read('ADANIGREEN', 'NSE', 'owner');
    expect(v).not.toBeNull();
    expect(feeds.fetchCandleWindow.mock.calls.map((c) => c[2])).toEqual(['ONE_MINUTE', 'FIFTEEN_MINUTE', 'ONE_DAY']);
    expect(feeds.fetchCandleWindow.mock.calls[0].slice(0, 2)).toEqual(['owner', { token: '3563', exchange: 'NSE' }]);
    expect(prisma.candle.findMany).not.toHaveBeenCalled();
    expect(v!.lastBarIst).toBeDefined();
  });
  it('a broker failure falls back to stored bars and the read still returns (stale sources say so)', async () => {
    const prisma = prismaFake(150);
    const feeds = { fetchCandleWindow: jest.fn().mockRejectedValue(new Error('throttled')) };
    const svc = new MultiTimeframeReaderService(prisma as never, feeds as never);
    const v = await svc.read('ADANIGREEN', 'NSE', 'owner');
    expect(v).not.toBeNull();
    expect(prisma.candle.findMany).toHaveBeenCalled();
    expect(v!.timeframes['15m']).toMatchObject({ available: false, reason: expect.stringMatching(/^stale/) });
  });
  it('the broker is cached per cadence: a second read inside a minute makes no new calls', async () => {
    const feeds = { fetchCandleWindow: jest.fn().mockResolvedValue(candles(300, 60_000)) };
    const svc = new MultiTimeframeReaderService(prismaFake(0) as never, feeds as never);
    await svc.read('ADANIGREEN', 'NSE', 'owner');
    await svc.read('ADANIGREEN', 'NSE', 'owner');
    expect(feeds.fetchCandleWindow).toHaveBeenCalledTimes(3);
  });
});

describe('MultiTimeframeReaderService stale-while-revalidate', () => {
  it('after the first read, a slow broker never delays a read: the cached view comes back at once', async () => {
    let release: (v: unknown) => void = () => undefined;
    const feeds = { fetchCandleWindow: jest.fn().mockResolvedValue(candles(300, 60_000)) };
    const svc = new MultiTimeframeReaderService(prismaFake(0) as never, feeds as never);
    const first = await svc.read('ADANIGREEN', 'NSE', 'owner');
    expect(first).not.toBeNull();
    feeds.fetchCandleWindow.mockImplementation(() => new Promise((r) => (release = r)));
    const realNow = Date.now;
    Date.now = () => realNow() + 10 * 60_000; // everything is due
    try {
      const t0 = realNow();
      const second = await svc.read('ADANIGREEN', 'NSE', 'owner');
      expect(realNow() - t0).toBeLessThan(200);
      expect(second).toBe(first);
      await new Promise((r) => setImmediate(r));
      expect(feeds.fetchCandleWindow).toHaveBeenCalledTimes(4); // one background refresh started
    } finally {
      Date.now = realNow;
      release(candles(300, 60_000));
    }
  });
});

describe('MultiTimeframeReaderService hub 1m fallback: session minutes only (2026-11-24)', () => {
  it('filters candles_1m to the session in SQL, before the LIMIT (NSE 09:15–15:30; MCX 09:00–23:55)', async () => {
    const { capturedSql, sessionBounds } = await import('../../market-hub/testing/captured-sql');
    const prisma = prismaFake(5); // fewer `candles` 1m rows than MIN_1M_ROWS → candles_1m is read
    const svc = new MultiTimeframeReaderService(prisma as never);
    await svc.read('ADANIGREEN', 'NSE', null);
    const q = capturedSql(prisma.$queryRaw.mock.calls);
    expect(q.text).toMatch(/FROM "candles_1m"/);
    expect(sessionBounds(q)).toEqual({ from: '09:15', to: '15:30' });
    expect(q.text.indexOf('AT TIME ZONE')).toBeLessThan(q.text.indexOf('LIMIT'));
  });
});
