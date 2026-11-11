import { TREND_MAX_BARS } from '../domain/trend-tag';
import { loadTrendBars, TREND_HUB_LOOKBACK_MS } from './trend-bars.loader';

const NOW = new Date('2026-11-11T04:20:00Z');
const Q = 15 * 60_000;
const bar = (ts: number, c: number) => ({ ts, open: c, high: c + 1, low: c - 1, close: c });

describe('loadTrendBars (shared by signal-trader market.trend and the entry engine gates)', () => {
  it('reads the hub 10 days back + the newest 300 stored 15m bars, the hub wins a shared bucket, only completed bars', async () => {
    const t0 = Math.floor(NOW.getTime() / Q) * Q; // the forming bucket
    const repo = {
      hub15mBars: jest.fn(async () => [bar(t0 - 2 * Q, 102), bar(t0 - Q, 103), bar(t0, 104)]),
      stored15mBars: jest.fn(async () => [bar(t0 - 3 * Q, 1), bar(t0 - 2 * Q, 2)]),
    };
    const r = await loadTrendBars(repo as never, { exchange: 'NSE', token: '99926000', symbol: 'NIFTY' }, NOW);
    expect(repo.hub15mBars).toHaveBeenCalledWith('NSE', '99926000', new Date(NOW.getTime() - TREND_HUB_LOOKBACK_MS), NOW);
    expect(repo.stored15mBars).toHaveBeenCalledWith('NSE', '99926000', TREND_MAX_BARS, NOW);
    expect(r.bars.map((b) => b.close)).toEqual([1, 102, 103]); // the forming bucket t0 is dropped; t0 − 2Q is the hub's
    expect(r.source).toBe('candles_1m NIFTY → 15m (3 bars) + candles 15m (2)');
  });

  it('a failed stored read degrades to the hub alone; a failed hub read throws (the caller decides)', async () => {
    const ok = await loadTrendBars({ hub15mBars: async () => [], stored15mBars: async () => { throw new Error('x'); } } as never, { exchange: 'NSE', token: '1', symbol: 'S' }, NOW);
    expect(ok).toEqual({ bars: [], source: 'candles_1m S → 15m (0 bars)' });
    await expect(loadTrendBars({ hub15mBars: async () => { throw new Error('db down'); }, stored15mBars: async () => [] } as never, { exchange: 'NSE', token: '1', symbol: 'S' }, NOW)).rejects.toThrow('db down');
  });
});
