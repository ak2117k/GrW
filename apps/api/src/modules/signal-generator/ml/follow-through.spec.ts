import { resolveFollowThrough } from './follow-through';
import type { OhlcvCandle } from './pattern-observation.types';

// Helper: a flat candle at a given close (high/low straddle it by `spread`).
function bar(time: number, close: number, spread = 0): OhlcvCandle {
  return { time, open: close, high: close + spread, low: close - spread, close, volume: 0 };
}

describe('resolveFollowThrough', () => {
  const params = { k: 1.5, m: 1.0, n: 10 };
  const atr = 2; // favorable = close + 3, adverse = close - 2 (bullish)

  it('WIN: bullish price reaches +k*ATR before -m*ATR', () => {
    // entry close=100 at index 0; favorable=103, adverse=98.
    const candles = [bar(0, 100), bar(1, 101), bar(2, 103.5, 0)]; // high 103.5 >= 103
    const r = resolveFollowThrough(candles, 0, 1, atr, params);
    expect(r.outcome).toBe('WIN');
    expect(r.label).toBe(1);
    expect(r.resolvedIndex).toBe(2);
  });

  it('LOSS: bullish adverse level hit first', () => {
    const candles = [bar(0, 100), bar(1, 97.5, 0)]; // low 97.5 <= 98
    const r = resolveFollowThrough(candles, 0, 1, atr, params);
    expect(r.outcome).toBe('LOSS');
    expect(r.label).toBe(0);
    expect(r.resolvedIndex).toBe(1);
  });

  it('LOSS: both levels touched in the SAME bar → conservative LOSS', () => {
    // wide bar hits both 103 and 98.
    const candles = [bar(0, 100), { time: 1, open: 100, high: 104, low: 97, close: 100, volume: 0 }];
    const r = resolveFollowThrough(candles, 0, 1, atr, params);
    expect(r.outcome).toBe('LOSS');
  });

  it('TIMEOUT: full horizon available, neither level hit', () => {
    const candles = [bar(0, 100), bar(1, 100), bar(2, 100), bar(3, 100), bar(4, 100),
      bar(5, 100), bar(6, 100), bar(7, 100), bar(8, 100), bar(9, 100), bar(10, 100)];
    const r = resolveFollowThrough(candles, 0, 1, atr, params);
    expect(r.outcome).toBe('TIMEOUT');
    expect(r.label).toBeNull();
  });

  it('PENDING: not enough forward bars yet and no hit', () => {
    const candles = [bar(0, 100), bar(1, 100), bar(2, 100)]; // only 2 forward bars < n=10
    const r = resolveFollowThrough(candles, 0, 1, atr, params);
    expect(r.outcome).toBe('PENDING');
  });

  it('bearish mirror: WIN when price falls -k*ATR first', () => {
    // dir=-1, entry=100, favorable=97 (close-3), adverse=102 (close+2).
    const candles = [bar(0, 100), bar(1, 96.5, 0)]; // low 96.5 <= 97
    const r = resolveFollowThrough(candles, 0, -1, atr, params);
    expect(r.outcome).toBe('WIN');
    expect(r.label).toBe(1);
  });
});
