import { PatternBackfillService, BACKFILL_TIMEFRAMES } from './pattern-backfill.service';

function makeCandles(n: number) {
  // Rising then dipping series so detectors + labels have something to chew on.
  return Array.from({ length: n }, (_, i) => ({
    timestamp: new Date(i * 900_000),
    open: 100 + Math.sin(i / 3) * 2,
    high: 101 + Math.sin(i / 3) * 2,
    low: 99 + Math.sin(i / 3) * 2,
    close: 100 + Math.sin(i / 3) * 2,
    volume: 1000,
  }));
}

describe('PatternBackfillService', () => {
  it('runs each target across all timeframes and saves observations', async () => {
    const adapter = { getHistoricalData: jest.fn().mockResolvedValue(makeCandles(120)) } as any;
    const repo = { saveMany: jest.fn().mockResolvedValue(3) } as any;
    const svc = new PatternBackfillService(adapter, repo);

    const results = await svc.run([{ token: '2885', exchange: 'NSE', symbol: 'RELIANCE' }]);

    // one result per (target × timeframe)
    expect(results).toHaveLength(BACKFILL_TIMEFRAMES.length);
    expect(adapter.getHistoricalData).toHaveBeenCalledTimes(BACKFILL_TIMEFRAMES.length);
    // each timeframe passed through to the adapter
    const tfsCalled = adapter.getHistoricalData.mock.calls.map((c: any[]) => c[2]);
    expect(tfsCalled.sort()).toEqual([...BACKFILL_TIMEFRAMES].sort());
    expect(repo.saveMany).toHaveBeenCalled();
  });

  it('skips a timeframe with too few candles without hitting the repo', async () => {
    const adapter = { getHistoricalData: jest.fn().mockResolvedValue(makeCandles(5)) } as any;
    const repo = { saveMany: jest.fn().mockResolvedValue(0) } as any;
    const svc = new PatternBackfillService(adapter, repo);
    const results = await svc.run([{ token: '2885', exchange: 'NSE', symbol: 'RELIANCE' }], {
      timeframes: ['15m'],
    });
    expect(results[0].observations).toBe(0);
    // The <25-candle guard must short-circuit BEFORE the repo call — asserting
    // only on `observations` can't see the guard (saveMany is mocked to 0).
    expect(repo.saveMany).not.toHaveBeenCalled();
  });

  it('continues to the next timeframe when the adapter throws', async () => {
    const adapter = {
      getHistoricalData: jest
        .fn()
        .mockRejectedValueOnce(new Error('throttled'))
        .mockResolvedValue(makeCandles(120)),
    } as any;
    const repo = { saveMany: jest.fn().mockResolvedValue(2) } as any;
    const svc = new PatternBackfillService(adapter, repo);
    const results = await svc.run([{ token: '2885', exchange: 'NSE', symbol: 'RELIANCE' }], {
      timeframes: ['1m', '15m'],
    });
    expect(results).toHaveLength(2);
    expect(results[0].observations).toBe(0); // first threw → 0
  });

  // The adapter's candle cache is keyed token:exchange:timeframe and IGNORES
  // [from,to]. On 'background' this replay would be handed the ~7-day window a
  // live scan cached (truncating it — and for '1d', dropping under the >=25 bar
  // guard to write ZERO rows), and would publish its own 120-day array to live
  // consumers under the shared key. 'bulk' bypasses the cache both ways.
  it('fetches history on the bulk priority lane (cache-bypassing)', async () => {
    const adapter = { getHistoricalData: jest.fn().mockResolvedValue(makeCandles(120)) } as any;
    const repo = { saveMany: jest.fn().mockResolvedValue(3) } as any;
    const svc = new PatternBackfillService(adapter, repo);

    await svc.run([{ token: '2885', exchange: 'NSE', symbol: 'RELIANCE' }], {
      timeframes: ['15m'],
    });

    expect(adapter.getHistoricalData).toHaveBeenCalledWith(
      '2885', 'NSE', '15m', expect.any(Date), expect.any(Date), 'bulk',
    );
  });

  describe('in-flight guard', () => {
    /** An adapter whose fetch we can hold open, to overlap two runs. */
    function gatedAdapter() {
      let release!: () => void;
      const gate = new Promise<void>((r) => (release = r));
      const getHistoricalData = jest
        .fn()
        .mockImplementation(async () => {
          await gate;
          return makeCandles(120);
        });
      return { adapter: { getHistoricalData } as any, release: () => release() };
    }

    it('refuses a second run() while the first is still in flight', async () => {
      const { adapter, release } = gatedAdapter();
      const repo = { saveMany: jest.fn().mockResolvedValue(3) } as any;
      const svc = new PatternBackfillService(adapter, repo);
      const targets = [{ token: '2885', exchange: 'NSE', symbol: 'RELIANCE' }];

      // First run parks on the gated adapter call.
      const first = svc.run(targets, { timeframes: ['15m'] });
      expect(svc.isRunning).toBe(true);

      // Second run lands mid-flight. Deliberately NOT awaited here: an
      // unguarded run would park on the same gate and never resolve, turning
      // this into a 5s timeout instead of a legible assertion failure.
      const second = svc.run(targets, { timeframes: ['15m'] });
      await new Promise((r) => setImmediate(r)); // let the refusal path settle

      // The second pass must never have reached the adapter. An unguarded run
      // would have parked a second fetch on the gate → 2 calls.
      expect(adapter.getHistoricalData).toHaveBeenCalledTimes(1);
      await expect(second).resolves.toEqual([]);

      release();
      const firstResults = await first;
      expect(firstResults).toHaveLength(1); // the first pass completed normally
      expect(adapter.getHistoricalData).toHaveBeenCalledTimes(1);
    });

    it('releases the guard once a run finishes, so a later run proceeds', async () => {
      const adapter = { getHistoricalData: jest.fn().mockResolvedValue(makeCandles(120)) } as any;
      const repo = { saveMany: jest.fn().mockResolvedValue(3) } as any;
      const svc = new PatternBackfillService(adapter, repo);
      const targets = [{ token: '2885', exchange: 'NSE', symbol: 'RELIANCE' }];

      await svc.run(targets, { timeframes: ['15m'] });
      expect(svc.isRunning).toBe(false);
      await svc.run(targets, { timeframes: ['15m'] });

      expect(adapter.getHistoricalData).toHaveBeenCalledTimes(2); // both passes ran
    });

    // A pass that throws must not wedge the flag on forever — otherwise one bad
    // run silently disables the backfill until the process restarts.
    it('releases the guard even when a pass throws', async () => {
      const repo = { saveMany: jest.fn().mockResolvedValue(3) } as any;
      const adapter = { getHistoricalData: jest.fn().mockResolvedValue(makeCandles(120)) } as any;
      const svc = new PatternBackfillService(adapter, repo);
      const targets = [{ token: '2885', exchange: 'NSE', symbol: 'RELIANCE' }];

      // Per-timeframe failures are caught INSIDE the pass, so force one the pass
      // does not catch: a non-iterable timeframes list blows up the for-of
      // itself, outside the inner try.
      await expect(svc.run(targets, { timeframes: 5 as never })).rejects.toThrow();

      // Released via finally — otherwise one bad run would refuse every run
      // that follows, for the life of the process.
      expect(svc.isRunning).toBe(false);
      await svc.run(targets, { timeframes: ['15m'] });
      expect(adapter.getHistoricalData).toHaveBeenCalledTimes(1);
    });
  });
});
