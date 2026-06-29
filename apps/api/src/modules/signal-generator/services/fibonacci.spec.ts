import { fibLevels, type FibCandle } from './fibonacci';

function f(high: number, low: number): FibCandle {
  return { high, low };
}

describe('fibLevels', () => {
  it('returns [] for fewer than 2 candles', () => {
    expect(fibLevels([], 100)).toEqual([]);
    expect(fibLevels([f(100, 90)], 100)).toEqual([]);
  });

  it('returns [] for a degenerate (zero-range) swing', () => {
    const candles = Array.from({ length: 5 }, () => f(100, 100));
    expect(fibLevels(candles, 100)).toEqual([]);
  });

  it('emits 0.382/0.5/0.618 retracements of an up-leg', () => {
    // low 100 at index 0, high 200 at index 4 → up-leg, range 100.
    const candles: FibCandle[] = [
      f(110, 100),
      f(140, 120),
      f(170, 150),
      f(190, 180),
      f(200, 195),
    ];
    const levels = fibLevels(candles, 175); // clear of all levels

    const by = (s: number) => levels.find((l) => l.score === s)!;
    // up-leg: high - ratio*range
    expect(by(10).price).toBeCloseTo(200 - 0.382 * 100, 6); // 161.8
    expect(by(12).price).toBeCloseTo(200 - 0.5 * 100, 6); // 150
    expect(by(15).price).toBeCloseTo(200 - 0.618 * 100, 6); // 138.2

    expect(levels.every((l) => l.kind === 'FIB')).toBe(true);
    // 0.618 (golden) strongest
    expect(Math.max(...levels.map((l) => l.score))).toBe(15);
  });

  it('emits retracements measured up from the low for a down-leg', () => {
    // high 200 at index 0, low 100 at index 4 → down-leg, range 100.
    const candles: FibCandle[] = [
      f(200, 190),
      f(180, 160),
      f(150, 140),
      f(130, 110),
      f(105, 100),
    ];
    const levels = fibLevels(candles, 175);
    const by = (s: number) => levels.find((l) => l.score === s)!;
    // down-leg: low + ratio*range
    expect(by(10).price).toBeCloseTo(100 + 0.382 * 100, 6); // 138.2
    expect(by(12).price).toBeCloseTo(100 + 0.5 * 100, 6); // 150
    expect(by(15).price).toBeCloseTo(100 + 0.618 * 100, 6); // 161.8
  });

  it('skips a fib level equal to the live price', () => {
    const candles: FibCandle[] = [
      f(110, 100),
      f(150, 130),
      f(200, 195),
    ];
    // 0.5 retracement = 150; set ltp there → that level drops out.
    const levels = fibLevels(candles, 150);
    expect(levels.some((l) => l.score === 12)).toBe(false);
    expect(levels.some((l) => l.score === 15)).toBe(true);
  });
});
