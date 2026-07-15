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

  it('skips a timeframe with too few candles without throwing', async () => {
    const adapter = { getHistoricalData: jest.fn().mockResolvedValue(makeCandles(5)) } as any;
    const repo = { saveMany: jest.fn().mockResolvedValue(0) } as any;
    const svc = new PatternBackfillService(adapter, repo);
    const results = await svc.run([{ token: '2885', exchange: 'NSE', symbol: 'RELIANCE' }], {
      timeframes: ['15m'],
    });
    expect(results[0].observations).toBe(0);
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
});
