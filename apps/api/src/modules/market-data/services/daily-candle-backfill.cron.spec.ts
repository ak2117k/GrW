import { INDICES } from '@td/shared/constants';
import { DailyCandleBackfillCron, istMidnightUtc } from './daily-candle-backfill.cron';

const MS_PER_DAY = 24 * 60 * 60 * 1000;

interface FakeInstrument {
  id: string;
  symbol: string;
  token: string;
  exchange: string;
  name: string;
  expiry: Date | null;
}

function instrument(partial: Partial<FakeInstrument> & { id: string; token: string }): FakeInstrument {
  return {
    symbol: partial.symbol ?? partial.id,
    exchange: partial.exchange ?? 'NSE',
    name: partial.name ?? partial.symbol ?? partial.id,
    expiry: partial.expiry ?? null,
    ...partial,
  } as FakeInstrument;
}

/** N daily bars ending today (IST), the shape of an already-current series. */
function currentSeries(count: number): Array<{ timestamp: Date }> {
  const today = istMidnightUtc(new Date());
  return Array.from({ length: count }, (_, i) => ({
    timestamp: new Date(today.getTime() - i * MS_PER_DAY),
  }));
}

function makeHarness(opts: {
  instruments?: FakeInstrument[];
  openTrackers?: Array<{ token: string; exchange: string; symbol: string }>;
  storedDailies?: Record<string, Array<{ timestamp: Date }>>;
  newestDailyAnywhere?: { timestamp: Date } | null;
}) {
  const instruments = opts.instruments ?? [];
  const stored = opts.storedDailies ?? {};

  const prisma: any = {
    instrument: {
      findFirst: jest.fn(async ({ where }: any) => {
        if (where.token) {
          return (
            instruments.find((i) => i.token === where.token && i.exchange === where.exchange) ?? null
          );
        }
        if (where.symbol) {
          return (
            instruments.find(
              (i) =>
                i.symbol === where.symbol &&
                i.exchange === where.exchange &&
                (where.expiry === undefined || i.expiry === where.expiry),
            ) ?? null
          );
        }
        return null;
      }),
    },
    tradeTracker: {
      findMany: jest.fn(async () => opts.openTrackers ?? []),
    },
    candle: {
      findMany: jest.fn(async ({ where }: any) => stored[where.instrumentId] ?? []),
      findFirst: jest.fn(async () => opts.newestDailyAnywhere ?? null),
    },
  };

  const adapter: any = {
    getHistoricalData: jest.fn(async () => [
      { timestamp: new Date('2026-08-14T03:45:00.000Z'), open: 1, high: 2, low: 0.5, close: 1.5, volume: 100 },
    ]),
  };

  const repo: any = { saveCandles: jest.fn(async (rows: any[]) => rows.length) };

  const cron = new DailyCandleBackfillCron(prisma, adapter, repo);
  return { cron, prisma, adapter, repo };
}

/** Tokens the pass actually spent a slot of the shared historical lane on. */
function fetchedTokens(adapter: any): string[] {
  return adapter.getHistoricalData.mock.calls.map((c: any[]) => c[0]);
}

describe('DailyCandleBackfillCron', () => {
  const nifty = INDICES.NIFTY_50;

  it('fetches only the scoped instruments — open-tracker underlyings and the default universe', async () => {
    const { cron, adapter } = makeHarness({
      instruments: [
        instrument({ id: 'i-nifty', symbol: nifty.symbol, token: nifty.token, exchange: nifty.exchange }),
        instrument({ id: 'i-tracked', symbol: 'KEI', token: '13478', exchange: 'NSE' }),
        // In the master, never tracked, not in the universe: must never be fetched.
        instrument({ id: 'i-other', symbol: 'SOMEOTHER', token: '99999', exchange: 'NSE' }),
      ],
      openTrackers: [{ token: '13478', exchange: 'NSE', symbol: 'KEI' }],
    });

    await cron.run('test');

    const tokens = fetchedTokens(adapter);
    expect(tokens).toContain('13478');
    expect(tokens).toContain(nifty.token);
    expect(tokens).not.toContain('99999');
  });

  it('maps a derivative tracker to its UNDERLYING cash row, not the contract', async () => {
    const { cron, adapter } = makeHarness({
      instruments: [
        instrument({
          id: 'i-opt',
          symbol: 'KEI29SEP265800CE',
          token: '55555',
          exchange: 'NFO',
          name: 'KEI',
          expiry: new Date('2026-09-29T00:00:00.000Z'),
        }),
        instrument({ id: 'i-kei', symbol: 'KEI', token: '13478', exchange: 'NSE' }),
      ],
      openTrackers: [{ token: '55555', exchange: 'NFO', symbol: 'KEI29SEP265800CE' }],
    });

    await cron.run('test');

    const tokens = fetchedTokens(adapter);
    expect(tokens).toContain('13478');
    expect(tokens).not.toContain('55555');
  });

  it('skips an instrument that already has 14 recent dailies (no broker slot spent)', async () => {
    const { cron, adapter } = makeHarness({
      instruments: [
        instrument({ id: 'i-nifty', symbol: nifty.symbol, token: nifty.token, exchange: nifty.exchange }),
      ],
      storedDailies: { 'i-nifty': currentSeries(20) },
    });

    await cron.run('test');

    expect(adapter.getHistoricalData).not.toHaveBeenCalled();
  });

  it('does NOT skip a series that is deep but stale (last bar a week old)', async () => {
    const weekOld = currentSeries(20).map((b) => ({
      timestamp: new Date(b.timestamp.getTime() - 7 * MS_PER_DAY),
    }));
    const { cron, adapter } = makeHarness({
      instruments: [
        instrument({ id: 'i-nifty', symbol: nifty.symbol, token: nifty.token, exchange: nifty.exchange }),
      ],
      storedDailies: { 'i-nifty': weekOld },
    });

    await cron.run('test');

    expect(fetchedTokens(adapter)).toContain(nifty.token);
  });

  it('writes rows with timeframe 1d and the resolved instrument id', async () => {
    const { cron, repo } = makeHarness({
      instruments: [
        instrument({ id: 'i-nifty', symbol: nifty.symbol, token: nifty.token, exchange: nifty.exchange }),
      ],
    });

    await cron.run('test');

    expect(repo.saveCandles).toHaveBeenCalled();
    const rows = repo.saveCandles.mock.calls[0][0];
    expect(rows[0]).toMatchObject({ instrumentId: 'i-nifty', timeframe: '1d' });
    for (const call of repo.saveCandles.mock.calls) {
      for (const row of call[0]) expect(row.timeframe).toBe('1d');
    }
  });

  it('uses BACKGROUND priority so an interactive chart request never queues behind the bulk fill', async () => {
    const { cron, adapter } = makeHarness({
      instruments: [
        instrument({ id: 'i-nifty', symbol: nifty.symbol, token: nifty.token, exchange: nifty.exchange }),
      ],
    });

    await cron.run('test');

    expect(adapter.getHistoricalData.mock.calls[0][5]).toBe('background');
  });

  it('keeps going when one instrument throws, and never throws out of the scheduled method', async () => {
    const { cron, adapter, repo } = makeHarness({
      instruments: [
        instrument({ id: 'i-kei', symbol: 'KEI', token: '13478', exchange: 'NSE' }),
        instrument({ id: 'i-nifty', symbol: nifty.symbol, token: nifty.token, exchange: nifty.exchange }),
      ],
      openTrackers: [{ token: '13478', exchange: 'NSE', symbol: 'KEI' }],
    });
    adapter.getHistoricalData.mockImplementation(async (token: string) => {
      if (token === '13478') throw new Error('broker said no');
      return [
        { timestamp: new Date('2026-08-14T03:45:00.000Z'), open: 1, high: 2, low: 0.5, close: 1.5, volume: 1 },
      ];
    });

    await expect(cron.runDaily()).resolves.toBeUndefined();

    expect(fetchedTokens(adapter)).toContain(nifty.token);
    expect(repo.saveCandles).toHaveBeenCalled();
  });

  it('never throws when target resolution itself fails', async () => {
    const { cron, prisma, adapter } = makeHarness({});
    prisma.tradeTracker.findMany.mockRejectedValue(new Error('db down'));

    await expect(cron.runDaily()).resolves.toBeUndefined();
    expect(adapter.getHistoricalData).not.toHaveBeenCalled();
  });

  describe('boot path', () => {
    const originalBootJobs = process.env.BOOT_JOBS;
    afterEach(() => {
      if (originalBootJobs === undefined) delete process.env.BOOT_JOBS;
      else process.env.BOOT_JOBS = originalBootJobs;
    });

    it('does nothing at all when BOOT_JOBS=false', async () => {
      process.env.BOOT_JOBS = 'false';
      const { cron, adapter, prisma } = makeHarness({});

      await cron.onModuleInit();
      await new Promise((r) => setImmediate(r));

      expect(prisma.candle.findFirst).not.toHaveBeenCalled();
      expect(adapter.getHistoricalData).not.toHaveBeenCalled();
    });

    it('declines to re-fetch on boot when today\'s dailies already landed (restart-loop breaker)', async () => {
      delete process.env.BOOT_JOBS;
      const { cron, adapter } = makeHarness({
        instruments: [
          instrument({ id: 'i-nifty', symbol: nifty.symbol, token: nifty.token, exchange: nifty.exchange }),
        ],
        newestDailyAnywhere: { timestamp: istMidnightUtc(new Date()) },
      });

      await cron.onModuleInit();
      await new Promise((r) => setImmediate(r));

      expect(adapter.getHistoricalData).not.toHaveBeenCalled();
    });

    it('still runs on boot when the daily series is stale', async () => {
      delete process.env.BOOT_JOBS;
      const { cron, adapter } = makeHarness({
        instruments: [
          instrument({ id: 'i-nifty', symbol: nifty.symbol, token: nifty.token, exchange: nifty.exchange }),
        ],
        newestDailyAnywhere: { timestamp: new Date(Date.now() - 5 * MS_PER_DAY) },
      });

      await cron.onModuleInit();
      await new Promise((r) => setImmediate(r));

      expect(fetchedTokens(adapter)).toContain(nifty.token);
    });

    it('a cron tick firing during an in-flight pass does not double-queue the historical lane', async () => {
      const { cron, adapter } = makeHarness({
        instruments: [
          instrument({ id: 'i-nifty', symbol: nifty.symbol, token: nifty.token, exchange: nifty.exchange }),
        ],
      });
      let release: () => void = () => undefined;
      const gate = new Promise<void>((r) => (release = r));
      adapter.getHistoricalData.mockImplementation(async () => {
        await gate;
        return [];
      });

      const first = cron.run('boot');
      await new Promise((r) => setImmediate(r));
      await cron.runDaily();
      const callsDuringOverlap = adapter.getHistoricalData.mock.calls.length;
      release();
      await first;

      expect(callsDuringOverlap).toBe(1);
    });
  });
});
