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
});
