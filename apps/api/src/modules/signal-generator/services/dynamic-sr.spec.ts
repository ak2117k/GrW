import { maLevels, anchoredVwap, type DynamicCandle } from './dynamic-sr';

function k(
  high: number,
  low: number,
  close: number,
  volume = 10,
): DynamicCandle {
  return { high, low, close, volume };
}

/** Flat OHLC bar at a single price (close == high == low). */
function flat(close: number, volume = 10): DynamicCandle {
  return k(close, close, close, volume);
}

describe('maLevels', () => {
  it('returns [] for empty input', () => {
    expect(maLevels([], 100)).toEqual([]);
  });

  it('computes the 20/50/200 SMA of close, length-weighted', () => {
    // Linear ramp close = i for i in 0..199.
    const candles = Array.from({ length: 200 }, (_, i) => flat(i));
    const levels = maLevels(candles, 250); // ltp clear of all MAs

    const by = (n: number) => levels.find((l) => l.score === n);
    // SMA20 = mean(180..199) = 189.5, score 8
    expect(by(8)!.price).toBeCloseTo(189.5, 6);
    // SMA50 = mean(150..199) = 174.5, score 14
    expect(by(14)!.price).toBeCloseTo(174.5, 6);
    // SMA200 = mean(0..199) = 99.5, score 20 (strongest)
    expect(by(20)!.price).toBeCloseTo(99.5, 6);

    expect(levels.every((l) => l.kind === 'MA')).toBe(true);
    // length-weighted: 200 > 50 > 20
    const scores = levels.map((l) => l.score);
    expect(Math.max(...scores)).toBe(20);
  });

  it('skips MAs without enough candles (30 bars → only MA20)', () => {
    const candles = Array.from({ length: 30 }, (_, i) => flat(100 + i));
    const levels = maLevels(candles, 500);
    expect(levels).toHaveLength(1);
    expect(levels[0].score).toBe(8); // only the 20-period qualifies
  });

  it('skips an MA that equals the live price', () => {
    const candles = Array.from({ length: 200 }, (_, i) => flat(i));
    // SMA20 = 189.5 → set ltp there; that MA must drop out.
    const levels = maLevels(candles, 189.5);
    expect(levels.some((l) => l.score === 8)).toBe(false);
    expect(levels.some((l) => l.score === 20)).toBe(true);
  });
});

describe('anchoredVwap', () => {
  it('returns [] for fewer than 2 candles', () => {
    expect(anchoredVwap([], 100)).toEqual([]);
    expect(anchoredVwap([flat(100)], 100)).toEqual([]);
  });

  it('anchors at the swing high and swing low extremes', () => {
    const candles: DynamicCandle[] = [
      k(110, 100, 105, 10), // typical 105
      k(108, 98, 102, 10), // typical 102.667
      k(112, 101, 109, 10), // highest high (112) → swing-high anchor
      k(109, 99, 104, 10), // typical 104
      k(103, 90, 95, 10), // lowest low (90) → swing-low anchor (last bar)
    ];
    const levels = anchoredVwap(candles, 100);

    expect(levels).toHaveLength(2);
    expect(levels.every((l) => l.kind === 'AVWAP' && l.score === 25)).toBe(true);

    // Low anchor is the last bar → VWAP collapses to that bar's typical (96).
    const lowAnchorTypical = (103 + 90 + 95) / 3;
    expect(levels.some((l) => Math.abs(l.price - lowAnchorTypical) < 1e-6)).toBe(true);

    // High anchor (index 2 forward, equal volume) = mean of typicals of bars 2..4.
    const t2 = (112 + 101 + 109) / 3;
    const t3 = (109 + 99 + 104) / 3;
    const t4 = (103 + 90 + 95) / 3;
    const highAnchorVwap = (t2 + t3 + t4) / 3;
    expect(levels.some((l) => Math.abs(l.price - highAnchorVwap) < 1e-6)).toBe(true);
  });

  it('emits a single anchor when high and low coincide on one bar', () => {
    // Monotonic ramp: highest high AND lowest low both at edge bars but the
    // single-bar coincidence case — use two bars where one bar dominates both.
    const candles: DynamicCandle[] = [
      k(100, 100, 100, 10),
      k(120, 90, 110, 10), // both highest high and lowest low here
    ];
    const levels = anchoredVwap(candles, 50);
    expect(levels).toHaveLength(1);
    expect(levels[0].kind).toBe('AVWAP');
  });

  it('skips an anchor VWAP that lands on the live price', () => {
    const candles: DynamicCandle[] = [
      k(110, 100, 105, 10),
      k(112, 101, 109, 10),
      k(103, 90, 96, 10), // last bar typical = (103+90+96)/3 = 96.333
    ];
    const lastTypical = (103 + 90 + 96) / 3;
    const levels = anchoredVwap(candles, lastTypical);
    expect(levels.some((l) => Math.abs(l.price - lastTypical) < 1e-6)).toBe(false);
  });
});
