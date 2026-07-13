import { findSwingPoints, swingHighs, swingLows, type Candle } from './swing-points';

/** Build a candle from just its high/low (open/close default inside the range). */
function c(high: number, low: number, index: number): Candle {
  return { time: index, high, low, open: (high + low) / 2, close: (high + low) / 2 };
}

/** Turn parallel high/low arrays into candles indexed by position. */
function series(highs: number[], lows: number[]): Candle[] {
  return highs.map((h, i) => c(h, lows[i], i));
}

describe('findSwingPoints (the keystone primitive)', () => {
  it('detects a clear swing HIGH at the peak', () => {
    // highs peak at index 2; lows flat so no swing lows in the checkable middle.
    const candles = series([1, 2, 5, 2, 1], [0, 0, 0, 0, 0]);
    expect(swingHighs(candles, 2)).toEqual([
      { index: 2, time: 2, price: 5, kind: 'HIGH' },
    ]);
  });

  it('detects a clear swing LOW at the trough', () => {
    const candles = series([9, 9, 9, 9, 9], [5, 4, 1, 4, 5]);
    expect(swingLows(candles, 2)).toEqual([
      { index: 2, time: 2, price: 1, kind: 'LOW' },
    ]);
  });

  it('bigger strength ⇒ fewer, more significant pivots', () => {
    const highs = [1, 3, 2, 5, 2, 3, 1];
    const candles = series(highs, highs.map(() => 0));
    // strength 1: three local peaks (indices 1, 3, 5)
    expect(swingHighs(candles, 1).map((s) => s.index)).toEqual([1, 3, 5]);
    // strength 2: only the dominant peak at index 3 survives
    expect(swingHighs(candles, 2).map((s) => s.index)).toEqual([3]);
  });

  it('never marks the first/last `strength` candles (no full window)', () => {
    // The tall bars sit at the very edges → they cannot be pivots.
    const candles = series([9, 1, 1, 1, 9], [0, 0, 0, 0, 0]);
    expect(swingHighs(candles, 1)).toEqual([]);
  });

  it('a flat top (equal highs) produces NO pivot — strict comparison', () => {
    const candles = series([1, 5, 5, 1], [0, 0, 0, 0]);
    expect(swingHighs(candles, 1)).toEqual([]);
  });

  it('a candle that is BOTH the highest high and lowest low is both a HIGH and a LOW', () => {
    // index 2 is an "outside bar": highest high AND lowest low of its window.
    const candles = series([2, 3, 9, 3, 2], [1, 1, -5, 1, 1]);
    const swings = findSwingPoints(candles, 2);
    expect(swings).toEqual([
      { index: 2, time: 2, price: 9, kind: 'HIGH' },
      { index: 2, time: 2, price: -5, kind: 'LOW' },
    ]);
  });

  it('rejects strength < 1', () => {
    expect(() => findSwingPoints([], 0)).toThrow('strength must be >= 1');
  });
});
