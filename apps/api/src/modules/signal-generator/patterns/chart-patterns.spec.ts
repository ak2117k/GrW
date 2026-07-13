import {
  findDoubleTops,
  findDoubleBottoms,
  findChartPatterns,
  type ChartPattern,
} from './chart-patterns';
import { type Candle, type SwingPoint } from './swing-points';

/**
 * Build candles from parallel high/low/close arrays (indexed by position).
 * Swing detection only reads high/low, so `close` (used solely for neckline
 * confirmation) defaults to the candle midpoint when a closes array is omitted.
 */
function series(highs: number[], lows: number[], closes?: number[]): Candle[] {
  return highs.map((h, i) => {
    const low = lows[i];
    return {
      time: i,
      high: h,
      low,
      open: (h + low) / 2,
      close: closes ? closes[i] : (h + low) / 2,
    };
  });
}

// --- Shared fixtures --------------------------------------------------------

// A clean double TOP at the default strength 3: equal peaks (110) at idx 4 & 12,
// a valley (90) at idx 8. Descending tails keep the peaks the ONLY swing highs.
const TOP_HIGHS = [100, 101, 102, 103, 110, 103, 102, 101, 95, 101, 102, 103, 110, 103, 102, 101];
const TOP_LOWS = [98, 99, 100, 101, 108, 100, 98, 96, 90, 96, 98, 100, 108, 101, 100, 99];

// A clean double BOTTOM: equal troughs (90) at idx 4 & 12, a peak (120) at idx 8.
const BOTTOM_HIGHS = [102, 103, 104, 105, 95, 105, 106, 107, 120, 107, 106, 105, 95, 105, 104, 103];
const BOTTOM_LOWS = [100, 99, 98, 97, 90, 97, 98, 99, 105, 99, 98, 97, 90, 97, 98, 99];

describe('findDoubleTops', () => {
  it('detects a clean double top (two equal peaks, valley between)', () => {
    const patterns = findDoubleTops(series(TOP_HIGHS, TOP_LOWS));
    expect(patterns).toHaveLength(1);

    const p = patterns[0];
    expect(p.name).toBe('DOUBLE_TOP');
    expect(p.bias).toBe('BEARISH');
    expect(p.first).toEqual<SwingPoint>({ index: 4, time: 4, price: 110, kind: 'HIGH' });
    expect(p.second).toEqual<SwingPoint>({ index: 12, time: 12, price: 110, kind: 'HIGH' });
    expect(p.neckline).toEqual<SwingPoint>({ index: 8, time: 8, price: 90, kind: 'LOW' });
    expect(p.necklinePrice).toBe(90);
    // Midpoint closes never dip below the neckline ⇒ unconfirmed.
    expect(p.confirmed).toBe(false);
    expect(p.confirmIndex).toBeNull();
  });

  it('rejects when the two peaks differ in height beyond priceTolerance', () => {
    // Raise the second peak to 130: |110-130|/110 ≈ 0.18 > 0.02 default.
    const highs = [...TOP_HIGHS];
    highs[12] = 130;
    expect(findDoubleTops(series(highs, TOP_LOWS))).toEqual([]);
  });

  it('rejects when the neckline is too shallow (fails minDepthRatio)', () => {
    // Equal peaks (110) but a valley at 108 ⇒ depth (110-108)/108 ≈ 0.0185 < 0.03.
    const highs = [
      108, 108.5, 109, 109.5, 110, 109.5, 109, 108.8, 108.5, 108.8, 109, 109.5, 110, 109.5, 109,
      108.5,
    ];
    const lows = [
      107, 107.5, 108.5, 109, 109.5, 108.9, 108.6, 108.3, 108, 108.3, 108.6, 108.9, 109.5, 109,
      108.5, 108,
    ];
    expect(findDoubleTops(series(highs, lows))).toEqual([]);
  });

  it('confirms when a later candle closes BELOW the neckline', () => {
    // Same swings, but idx 13 closes at 85 (< neckline 90) — the first breakdown.
    const closes = [...TOP_LOWS];
    closes[13] = 85;
    const patterns = findDoubleTops(series(TOP_HIGHS, TOP_LOWS, closes));
    expect(patterns).toHaveLength(1);
    expect(patterns[0].confirmed).toBe(true);
    expect(patterns[0].confirmIndex).toBe(13);
  });
});

describe('findDoubleBottoms', () => {
  it('detects a clean double bottom (two equal troughs, peak between)', () => {
    const patterns = findDoubleBottoms(series(BOTTOM_HIGHS, BOTTOM_LOWS));
    expect(patterns).toHaveLength(1);

    const p = patterns[0];
    expect(p.name).toBe('DOUBLE_BOTTOM');
    expect(p.bias).toBe('BULLISH');
    expect(p.first).toEqual<SwingPoint>({ index: 4, time: 4, price: 90, kind: 'LOW' });
    expect(p.second).toEqual<SwingPoint>({ index: 12, time: 12, price: 90, kind: 'LOW' });
    expect(p.neckline).toEqual<SwingPoint>({ index: 8, time: 8, price: 120, kind: 'HIGH' });
    expect(p.necklinePrice).toBe(120);
    expect(p.confirmed).toBe(false);
    expect(p.confirmIndex).toBeNull();
  });

  it('confirms when a later candle closes ABOVE the neckline', () => {
    // idx 13 closes at 125 (> neckline 120) — the first breakout up.
    const closes = [...BOTTOM_HIGHS];
    closes[13] = 125;
    const patterns = findDoubleBottoms(series(BOTTOM_HIGHS, BOTTOM_LOWS, closes));
    expect(patterns).toHaveLength(1);
    expect(patterns[0].confirmed).toBe(true);
    expect(patterns[0].confirmIndex).toBe(13);
  });
});

describe('findChartPatterns (tops ++ bottoms)', () => {
  it('returns both a double top and a double bottom from one combined series', () => {
    // idx 0-12: double top (peaks 110 @ 4 & 12, valley 90 @ 8)
    // idx 13-19: monotonic descent (no spurious swings)
    // idx 20-32: double bottom (troughs 50 @ 20 & 28, peak 70 @ 24)
    const highs = [
      100, 101, 102, 103, 110, 103, 102, 101, 95, 101, 102, 103, 110, // top
      100, 90, 85, 80, 78, 74, 70, // descent into the bottom
      62, 64, 66, 68, 70, 68, 66, 64, 62, 64, 66, 68, 70, // bottom
    ];
    const lows = [
      98, 99, 100, 101, 108, 100, 98, 96, 90, 96, 98, 100, 108, // top
      95, 85, 80, 75, 72, 66, 58, // descent
      50, 58, 62, 66, 60, 62, 58, 54, 50, 56, 60, 62, 64, // bottom
    ];
    const candles = series(highs, lows);

    const tops = findDoubleTops(candles);
    const bottoms = findDoubleBottoms(candles);
    expect(tops.map((p) => p.name)).toEqual(['DOUBLE_TOP']);
    expect(tops[0].first.index).toBe(4);
    expect(tops[0].second.index).toBe(12);
    expect(bottoms.map((p) => p.name)).toEqual(['DOUBLE_BOTTOM']);
    expect(bottoms[0].first.index).toBe(20);
    expect(bottoms[0].second.index).toBe(28);

    // findChartPatterns concatenates tops-then-bottoms.
    const all = findChartPatterns(candles);
    expect(all.map((p) => p.name)).toEqual<ChartPattern['name'][]>(['DOUBLE_TOP', 'DOUBLE_BOTTOM']);
  });
});
