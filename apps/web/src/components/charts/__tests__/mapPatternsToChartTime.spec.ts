import { describe, it, expect } from 'vitest';
import { mapPatternsToChartTime } from '../mapPatternsToChartTime';
import type { PatternMarker } from '@/hooks/usePatterns';

/**
 * A gap-compressed map (mirrors `compressTimes` output). Real bar-starts are
 * 1000, 1100 (contiguous, 100s bars) then 5000 (a large real gap collapsed to a
 * single bar). Compressed times stay contiguous at +100 each, so compressed
 * (200/300) diverges from real (1100/5000) — exactly the case markers must
 * survive.
 *
 *   compressed → real
 *        100   → 1000
 *        200   → 1100
 *        300   → 5000
 */
const realTimeMap = new Map<number, number>([
  [100, 1000],
  [200, 1100],
  [300, 5000],
]);

function candlestick(name: string, timeMs: number): PatternMarker {
  return {
    category: 'CANDLESTICK',
    name,
    bias: 'BULLISH',
    time: timeMs,
    points: [],
    necklinePrice: null,
    confirmed: null,
    confirmTime: null,
  };
}

describe('mapPatternsToChartTime', () => {
  it('maps an in-window pattern to its compressed time (MS→seconds)', () => {
    // 1100s real → compressed 200. Passed as epoch MS.
    const out = mapPatternsToChartTime([candlestick('HAMMER', 1_100_000)], realTimeMap);
    expect(out).toHaveLength(1);
    expect(out[0].anchorTime).toBe(200);
  });

  it('maps a bar whose compressed time diverges from real (post-gap bar)', () => {
    const out = mapPatternsToChartTime([candlestick('DOJI', 5_000_000)], realTimeMap);
    expect(out).toHaveLength(1);
    expect(out[0].anchorTime).toBe(300);
  });

  it('drops a pattern whose time is outside the displayed window', () => {
    // 9999s is far past the last bar-start (5000) by more than one bar (100s).
    const out = mapPatternsToChartTime([candlestick('HAMMER', 9_999_000)], realTimeMap);
    expect(out).toHaveLength(0);
  });

  it('resolves a time that falls INSIDE a bar (not exactly at its start)', () => {
    // 1150s is 50s into the bar starting at 1100 (< 100s width) → compressed 200.
    const out = mapPatternsToChartTime([candlestick('HAMMER', 1_150_000)], realTimeMap);
    expect(out).toHaveLength(1);
    expect(out[0].anchorTime).toBe(200);
  });

  it('does MS→seconds conversion (raw MS would never match a real second)', () => {
    // If the helper forgot to divide by 1000, 1_100_000 would be treated as a
    // real second far outside the window and get dropped. Its survival proves
    // the conversion happened.
    const dropped = mapPatternsToChartTime(
      [{ ...candlestick('HAMMER', 1_100_000), time: 1100 /* already seconds, wrong unit */ }],
      realTimeMap,
    );
    // 1100ms → 1.1s → rounds to 1s → no bar at/under 1s → dropped.
    expect(dropped).toHaveLength(0);
  });

  it('maps CHART pattern points and keeps only in-window peaks', () => {
    const chart: PatternMarker = {
      category: 'CHART',
      name: 'DOUBLE_TOP',
      bias: 'BEARISH',
      time: 1_100_000,
      points: [1_000_000, 1_100_000, 9_999_000], // last peak is out of window
      necklinePrice: 123.5,
      confirmed: true,
      confirmTime: 1_100_000,
    };
    const out = mapPatternsToChartTime([chart], realTimeMap);
    expect(out).toHaveLength(1);
    // 1000s→100, 1100s→200, 9999s dropped.
    expect(out[0].pointTimes).toEqual([100, 200]);
  });

  it('keeps a CHART pattern when the anchor is out of window but a peak is in', () => {
    const chart: PatternMarker = {
      category: 'CHART',
      name: 'DOUBLE_BOTTOM',
      bias: 'BULLISH',
      time: 9_999_000, // anchor out of window
      points: [1_000_000], // peak in window
      necklinePrice: 100,
      confirmed: false,
      confirmTime: null,
    };
    const out = mapPatternsToChartTime([chart], realTimeMap);
    expect(out).toHaveLength(1);
    expect(out[0].anchorTime).toBeNull();
    expect(out[0].pointTimes).toEqual([100]);
  });
});
