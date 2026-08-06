import { fitTrendLine, type TrendCandle } from './trend-line';

const T0 = 1_700_000_000; // arbitrary unix-seconds epoch
const STEP = 900; // 15m bars
const t = (i: number): number => T0 + i * STEP;

/** Flat baseline candles that produce NO pivots on their own (ties are not
 *  strict extremes), so every pivot in a fixture is one the test placed. */
function flat(n: number, high = 105, low = 95): TrendCandle[] {
  return Array.from({ length: n }, (_, i) => ({ time: t(i), high, low }));
}

describe('fitTrendLine', () => {
  it('fits a clean uptrend through rising swing lows', () => {
    // Rising baseline with a deep dip every 8 bars: the dips are the only
    // pivots, and they rise linearly.
    const candles: TrendCandle[] = [];
    for (let i = 0; i < 40; i++) {
      const base = 100 + 0.5 * i;
      const isDip = i % 8 === 0 && i >= 8 && i <= 32;
      candles.push({ time: t(i), high: base + 1, low: isDip ? base - 5 : base });
    }

    const line = fitTrendLine(candles);

    expect(line).not.toBeNull();
    expect(line!.kind).toBe('uptrend');
    expect(line!.slope).toBeGreaterThan(0);
    // 0.5 price per bar of 900s.
    expect(line!.slope).toBeCloseTo(0.5 / STEP, 10);
    expect(line!.r2).toBeCloseTo(1, 10);
    expect(line!.touches).toBe(4);
    expect(line!.fromTime).toBe(t(8));
    expect(line!.toTime).toBe(t(32));
    // intercept is the fitted price AT fromTime — the first dip, 100+4-5.
    expect(line!.intercept).toBeCloseTo(99, 8);
  });

  it('fits a clean downtrend through falling swing highs', () => {
    const candles: TrendCandle[] = [];
    for (let i = 0; i < 40; i++) {
      const base = 200 - 0.5 * i;
      const isSpike = i % 8 === 0 && i >= 8 && i <= 32;
      candles.push({ time: t(i), high: isSpike ? base + 5 : base, low: base - 1 });
    }

    const line = fitTrendLine(candles);

    expect(line).not.toBeNull();
    expect(line!.kind).toBe('downtrend');
    expect(line!.slope).toBeLessThan(0);
    expect(line!.slope).toBeCloseTo(-0.5 / STEP, 10);
    expect(line!.r2).toBeCloseTo(1, 10);
    expect(line!.touches).toBe(4);
    expect(line!.intercept).toBeCloseTo(201, 8); // 200-4+5 at the first spike
  });

  it('returns null when the pivots are too noisy to be a line (r2 < minR2)', () => {
    // Four dips that zig-zag rather than trend: a line through them explains
    // almost nothing, and drawing it would be worse than drawing nothing.
    const candles = flat(40);
    const dips = [90, 110, 92, 108];
    dips.forEach((price, k) => {
      candles[8 + k * 8] = { time: t(8 + k * 8), high: 120, low: price };
    });

    expect(fitTrendLine(candles)).toBeNull();
  });

  it('returns null with fewer than minTouches pivots on either side', () => {
    const candles = flat(40);
    // Only two rising dips — a line through two points always fits perfectly,
    // which is exactly why two is not evidence of a trend.
    candles[10] = { time: t(10), high: 105, low: 80 };
    candles[20] = { time: t(20), high: 105, low: 85 };

    expect(fitTrendLine(candles)).toBeNull();
    // ...and three of them is.
    candles[30] = { time: t(30), high: 105, low: 90 };
    expect(fitTrendLine(candles)!.kind).toBe('uptrend');
  });

  it('honours an explicit minTouches', () => {
    const candles = flat(40);
    [80, 85, 90].forEach((low, k) => {
      candles[10 + k * 8] = { time: t(10 + k * 8), high: 105, low };
    });

    expect(fitTrendLine(candles, { minTouches: 4 })).toBeNull();
    expect(fitTrendLine(candles, { minTouches: 3 })).not.toBeNull();
  });

  it('rejects a side whose slope contradicts it — falling lows are no uptrend', () => {
    const candles = flat(40);
    // Four tightly-fitting but FALLING swing lows. The fit quality is perfect;
    // the direction is wrong for the only side lows can anchor, so there is no
    // line — it must not be relabelled a downtrend.
    [110, 105, 100, 95].forEach((low, k) => {
      candles[8 + k * 8] = { time: t(8 + k * 8), high: 120, low };
    });

    expect(fitTrendLine(candles)).toBeNull();
  });

  it('keeps the higher-r2 side when both an uptrend and a downtrend qualify', () => {
    // Converging triangle: rising lows AND falling highs. Only the r2 differs.
    const build = (highs: number[], lows: number[]): TrendCandle[] => {
      const candles = flat(40);
      highs.forEach((high, k) => {
        const i = 6 + k * 8;
        candles[i] = { time: t(i), high, low: 95 };
      });
      lows.forEach((low, k) => {
        const i = 10 + k * 8;
        candles[i] = { time: t(i), high: 105, low };
      });
      return candles;
    };

    const perfectLows = [70, 75, 80, 85];
    const perfectHighs = [130, 125, 120, 115];
    const wobblyHighs = [130, 124, 120, 115];
    const wobblyLows = [70, 76, 80, 85];

    const upWins = fitTrendLine(build(wobblyHighs, perfectLows))!;
    expect(upWins.kind).toBe('uptrend');
    expect(upWins.r2).toBeCloseTo(1, 10);

    const downWins = fitTrendLine(build(perfectHighs, wobblyLows))!;
    expect(downWins.kind).toBe('downtrend');
    expect(downWins.r2).toBeCloseTo(1, 10);
  });

  describe('degenerate input returns null without throwing', () => {
    it('empty array', () => {
      expect(fitTrendLine([])).toBeNull();
    });

    it('fewer candles than the fractal rule can confirm', () => {
      const few = flat(6).map((c, i) => ({ ...c, low: c.low - i }));
      expect(fitTrendLine(few)).toBeNull();
    });

    it('not an array at all', () => {
      expect(fitTrendLine(undefined as never)).toBeNull();
      expect(fitTrendLine(null as never)).toBeNull();
    });

    it('identical timestamps (zero time variance would divide by zero)', () => {
      const candles = flat(40).map((c) => ({ ...c, time: T0 }));
      [80, 85, 90, 95].forEach((low, k) => {
        candles[8 + k * 8] = { time: T0, high: 120, low };
      });
      expect(fitTrendLine(candles)).toBeNull();
    });

    it('non-finite prices', () => {
      const candles = flat(40).map((c) => ({ ...c, high: NaN, low: NaN }));
      expect(fitTrendLine(candles)).toBeNull();
    });

    it('non-finite times on the pivot bars', () => {
      const candles = flat(40);
      [80, 85, 90, 95].forEach((low, k) => {
        candles[8 + k * 8] = { time: NaN, high: 120, low };
      });
      expect(fitTrendLine(candles)).toBeNull();
    });

    it('a perfectly flat series has no trend', () => {
      expect(fitTrendLine(flat(40))).toBeNull();
    });
  });
});
