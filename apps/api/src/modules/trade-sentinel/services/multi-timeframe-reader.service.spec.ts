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

describe('MultiTimeframeReaderService 15m / 1d fall back to the hub candles_1m rolled up, not a months-old table (2026-11-25)', () => {
  // Wed 25 Nov 2026 14:00 IST — MCX and NSE both in session.
  const NOW = Date.parse('2026-11-25T14:00:00+05:30');
  const IST = 330 * 60_000;
  const DAY = 86_400_000;
  const istMin = (ts: number) => Math.floor((((ts + IST) % DAY) + DAY) % DAY / 60_000);
  const weekday = (ts: number) => { const d = new Date(ts + IST).getUTCDay(); return d !== 0 && d !== 6; };
  /** `n` in-session MCX 15m bucket starts, oldest first, the newest at `last`. */
  const mcxBuckets = (n: number, last: number) => {
    const out: number[] = [];
    for (let t = last; out.length < n; t -= 15 * 60_000) if (weekday(t) && istMin(t) >= 540 && istMin(t) < 1435) out.push(t);
    return out.reverse();
  };
  /** `n` weekday IST dates ('YYYY-MM-DD'), oldest first, the newest on `last`'s IST date. */
  const istDates = (n: number, last: number) => {
    const out: string[] = [];
    for (let t = last; out.length < n; t -= DAY) if (weekday(t)) out.push(new Date(t + IST).toISOString().slice(0, 10));
    return out.reverse();
  };
  const ohlc = (i: number) => ({ open: 100 + i, high: 101 + i, low: 99 + i, close: 100 + i });
  /** The `candles` table: a stale August series per timeframe unless overridden. */
  const AUG = Date.parse('2026-08-21T23:45:00+05:30');
  const tableRows = (tf: string, over: Partial<Record<string, number[]>> = {}) => {
    const ts = over[tf] ?? (tf === '15m' ? mcxBuckets(150, AUG) : tf === '1d' ? istDates(150, AUG).map((d) => Date.parse(`${d}T00:00:00+05:30`)) : []);
    // findMany is ORDER BY timestamp DESC
    return ts.map((t, i) => ({ timestamp: new Date(t), ...ohlc(i) })).reverse();
  };
  const isHub15 = (strings: readonly string[]) => strings.join('?').includes('bucket_s');
  const isHubDay = (strings: readonly string[]) => strings.join('?').includes('ist_date');
  const fake = (opts: { exchange?: 'MCX' | 'NSE'; table?: Partial<Record<string, number[]>>; hub15?: number[]; hubDays?: string[] }) => ({
    instrument: {
      findFirst: jest.fn().mockResolvedValue({ id: 'i1', exchange: 'MCX', token: '488291' }),
      findMany: jest.fn().mockResolvedValue([{ id: 'i2', symbol: 'ADANIGREEN-EQ', exchange: 'NSE', token: '3563' }]),
    },
    candle: {
      findMany: jest.fn().mockImplementation((args: { where: { timeframe: string } }) => Promise.resolve(tableRows(args.where.timeframe, opts.table))),
    },
    // DESC order, like the SQL
    $queryRaw: jest.fn().mockImplementation((strings: readonly string[]) => {
      if (isHub15(strings)) return Promise.resolve((opts.hub15 ?? []).map((t, i) => ({ bucket_s: BigInt(t / 1000), ...ohlc(i) })).reverse());
      if (isHubDay(strings)) return Promise.resolve((opts.hubDays ?? []).map((d, i) => ({ ist_date: d, ...ohlc(i) })).reverse());
      return Promise.resolve([]);
    }),
  });

  let nowSpy: jest.SpyInstance;
  beforeEach(() => { nowSpy = jest.spyOn(Date, 'now').mockReturnValue(NOW); });
  afterEach(() => nowSpy.mockRestore());

  it('table 15m/1d stopped in August, hub is fresh -> the hub series is used and 15m/1d are not stale', async () => {
    const prisma = fake({ hub15: mcxBuckets(150, Date.parse('2026-11-25T13:45:00+05:30')), hubDays: istDates(150, NOW) });
    const v = await new MultiTimeframeReaderService(prisma as never).read('NATURALGAS', 'MCX', null);
    expect(v).not.toBeNull();
    expect(v!.lastBarIst!['15m']).toBe('2026-11-25 13:45');
    expect(v!.lastBarIst!['1d']).toBe('2026-11-25 00:00');
    for (const tf of ['15m', '30m', '1h', '1d'] as const) {
      expect((v!.timeframes[tf] as { reason?: string }).reason ?? '').not.toMatch(/^stale/);
    }
  });

  it('the table is fresher -> the table series is kept', async () => {
    const tableLast = Date.parse('2026-11-25T13:45:00+05:30');
    const prisma = fake({
      table: { '15m': mcxBuckets(150, tableLast), '1d': istDates(150, NOW).map((d) => Date.parse(`${d}T00:00:00+05:30`)) },
      hub15: mcxBuckets(150, Date.parse('2026-11-24T23:45:00+05:30')),
      hubDays: istDates(150, NOW - DAY),
    });
    const v = await new MultiTimeframeReaderService(prisma as never).read('NATURALGAS', 'MCX', null);
    expect(v!.lastBarIst!['15m']).toBe('2026-11-25 13:45');
    expect(v!.lastBarIst!['1d']).toBe('2026-11-25 00:00');
  });

  it('equal newest bar -> the longer series wins', async () => {
    const last = Date.parse('2026-11-25T13:45:00+05:30');
    const prisma = fake({ table: { '15m': mcxBuckets(40, last) }, hub15: mcxBuckets(150, last) });
    const v = await new MultiTimeframeReaderService(prisma as never).read('NATURALGAS', 'MCX', null);
    // 150 bars clears MIN_BARS (100); the 40-bar table series would not
    expect(v!.timeframes['15m'].available).toBe(true);
  });

  it('the hub 15m / 1d SQL carries the venue session filter (MCX 09:00–23:55, NSE 09:15–15:30), 15m on 15-minute epoch buckets', async () => {
    const { capturedSql, sessionBounds } = await import('../../market-hub/testing/captured-sql');
    for (const [sym, ex, bounds] of [['NATURALGAS', 'MCX', { from: '09:00', to: '23:55' }], ['ADANIGREEN', 'NSE', { from: '09:15', to: '15:30' }]] as const) {
      const prisma = fake({});
      await new MultiTimeframeReaderService(prisma as never).read(sym, ex, null);
      const calls = prisma.$queryRaw.mock.calls;
      const i15 = calls.findIndex((c) => isHub15(c[0] as string[]));
      const iDay = calls.findIndex((c) => isHubDay(c[0] as string[]));
      expect(i15).toBeGreaterThanOrEqual(0);
      expect(iDay).toBeGreaterThanOrEqual(0);
      const q15 = capturedSql(calls, i15);
      const qDay = capturedSql(calls, iDay);
      expect(q15.text).toMatch(/FROM "candles_1m"/);
      expect(q15.text).toMatch(/900/);
      expect(sessionBounds(q15)).toEqual(bounds);
      expect(sessionBounds(qDay)).toEqual(bounds);
      expect(q15.text.indexOf('AT TIME ZONE')).toBeLessThan(q15.text.indexOf('LIMIT'));
    }
  });

  describe('a short hub roll-up never replaces a usable table series', () => {
    const read = (prisma: ReturnType<typeof fake>) => new MultiTimeframeReaderService(prisma as never).read('NATURALGAS', 'MCX', null);
    const dayStamps = (n: number, last: number) => istDates(n, last).map((d) => Date.parse(`${d}T00:00:00+05:30`));

    it('table daily fresh (previous session, 250 bars) + hub daily 3 bars ending today -> TABLE', async () => {
      const v = await read(fake({ table: { '1d': dayStamps(250, NOW - DAY) }, hubDays: istDates(3, NOW) }));
      expect(v!.lastBarIst!['1d']).toBe('2026-11-24 00:00');
      expect(v!.timeframes['1d'].available).toBe(true);
    });

    it('table daily stale (Aug) + hub daily 150 bars ending today -> HUB', async () => {
      const v = await read(fake({ hubDays: istDates(150, NOW) }));
      expect(v!.lastBarIst!['1d']).toBe('2026-11-25 00:00');
    });

    it('table daily empty + hub 3 bars -> HUB', async () => {
      const v = await read(fake({ table: { '1d': [] }, hubDays: istDates(3, NOW) }));
      expect(v!.lastBarIst!['1d']).toBe('2026-11-25 00:00');
    });

    it('table daily last bar 2 days ago + hub 3 bars ending today -> TABLE (gap <= 3 days, hub too short)', async () => {
      const v = await read(fake({ table: { '1d': dayStamps(250, NOW - 2 * DAY) }, hubDays: istDates(3, NOW) }));
      expect(v!.lastBarIst!['1d']).toBe('2026-11-23 00:00');
    });

    it('15m: table stale (Aug) + hub only 56 buckets ending today -> HUB (table > 3 days behind, any length)', async () => {
      const v = await read(fake({ hub15: mcxBuckets(56, Date.parse('2026-11-25T13:45:00+05:30')) }));
      expect(v!.lastBarIst!['15m']).toBe('2026-11-25 13:45');
    });

    it('table daily stale (Aug) + hub only 4 bars ending today -> HUB', async () => {
      const v = await read(fake({ hubDays: istDates(4, NOW) }));
      expect(v!.lastBarIst!['1d']).toBe('2026-11-25 00:00');
    });

    it('15m: table stale (Aug) + hub 120 buckets -> HUB', async () => {
      const v = await read(fake({ hub15: mcxBuckets(120, Date.parse('2026-11-25T13:45:00+05:30')) }));
      expect(v!.lastBarIst!['15m']).toBe('2026-11-25 13:45');
    });
  });

  it('broker bars present for a timeframe -> neither the table nor the hub roll-up is read for it', async () => {
    const prisma = fake({ hubDays: istDates(150, NOW) });
    const bars = (n: number, step: number) => Array.from({ length: n }, (_, i) => ({ timestamp: new Date(NOW - (n - i) * step), open: 1, high: 2, low: 0.5, close: 1 }));
    const feeds = { fetchCandleWindow: jest.fn().mockImplementation((_u, _r, tf: string) => Promise.resolve(tf === 'ONE_DAY' ? [] : bars(300, tf === 'FIFTEEN_MINUTE' ? 900_000 : 60_000))) };
    await new MultiTimeframeReaderService(prisma as never, feeds as never).read('NATURALGAS', 'MCX', 'owner');
    const tfs = prisma.candle.findMany.mock.calls.map((c) => (c[0] as { where: { timeframe: string } }).where.timeframe);
    expect(tfs).toEqual(['1d']);
    expect(prisma.$queryRaw.mock.calls.some((c) => isHub15(c[0] as string[]))).toBe(false);
    expect(prisma.$queryRaw.mock.calls.some((c) => isHubDay(c[0] as string[]))).toBe(true);
  });
});
