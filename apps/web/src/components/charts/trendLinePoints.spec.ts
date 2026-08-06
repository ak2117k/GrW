import { describe, it, expect } from 'vitest';
import { trendLinePoints } from './trendLinePoints';
import { buildSeries, type RealBar, type SeriesBar } from '@/utils/chartSeries';
import type { TrendLine } from '@/hooks/useChartContext';

const TF = 60; // 1-minute bars, in seconds

function real(time: number): RealBar {
  return { time, open: 100, high: 101, low: 99, close: 100, volume: 10 };
}

/**
 * Four bars either side of an overnight gap. `buildSeries` collapses the gap to
 * a single bar step, so from the third bar on the compressed `time` and the
 * real `realTime` DIVERGE by a full day — which is exactly the condition that
 * makes plotting `fromTime` directly wrong.
 */
function gappedBars(): SeriesBar[] {
  const day = 86_400;
  return buildSeries(
    [real(1_000), real(1_060), real(1_000 + day), real(1_060 + day)],
    TF,
  ).bars;
}

function trend(over: Partial<TrendLine> = {}): TrendLine {
  return {
    kind: 'uptrend',
    slope: 1, // 1 rupee per second — keeps the arithmetic obvious
    intercept: 500,
    fromTime: 1_000,
    toTime: 1_060 + 86_400,
    touches: 3,
    r2: 0.9,
    ...over,
  };
}

describe('trendLinePoints', () => {
  it('plots at COMPRESSED time but prices from REAL time', () => {
    const bars = gappedBars();
    // Sanity: the fixture really does diverge, or the test proves nothing.
    expect(bars.map((b) => b.time)).toEqual([1_000, 1_060, 1_120, 1_180]);
    expect(bars.map((b) => b.realTime)).toEqual([1_000, 1_060, 87_400, 87_460]);

    expect(trendLinePoints(trend(), bars)).toEqual([
      { time: 1_000, value: 500 },
      { time: 1_060, value: 560 },
      // Post-gap bars price off the FULL real elapsed time (a whole day),
      // while still being plotted at the next compressed slot.
      { time: 1_120, value: 500 + 86_400 },
      { time: 1_180, value: 500 + 86_460 },
    ]);
  });

  it('handles a negative slope (downtrend) the same way', () => {
    const bars = gappedBars();
    const points = trendLinePoints(trend({ kind: 'downtrend', slope: -0.5 }), bars);
    expect(points[0]).toEqual({ time: 1_000, value: 500 });
    expect(points[3]).toEqual({ time: 1_180, value: 500 - 86_460 / 2 });
  });

  it('excludes bars before fromTime', () => {
    const bars = gappedBars();
    // Anchor on the third bar (real 87_400): the two pre-gap bars drop out.
    const points = trendLinePoints(trend({ fromTime: 87_400 }), bars);
    expect(points).toEqual([
      { time: 1_120, value: 500 },
      { time: 1_180, value: 560 },
    ]);
  });

  it('extends past toTime to the newest bar (the right edge)', () => {
    const bars = gappedBars();
    const points = trendLinePoints(trend({ toTime: 1_060 }), bars);
    expect(points).toHaveLength(bars.length);
  });

  it('returns [] for a null trend', () => {
    expect(trendLinePoints(null, gappedBars())).toEqual([]);
  });

  it('returns [] when only one bar qualifies — a dot is not a line', () => {
    const bars = gappedBars();
    expect(trendLinePoints(trend({ fromTime: 87_460 }), bars)).toEqual([]);
  });

  it('returns [] when no bar qualifies, and for no bars at all', () => {
    expect(trendLinePoints(trend({ fromTime: 999_999 }), gappedBars())).toEqual([]);
    expect(trendLinePoints(trend(), [])).toEqual([]);
  });

  it('ignores a non-finite fit rather than emitting NaN prices', () => {
    expect(trendLinePoints(trend({ slope: Number.NaN }), gappedBars())).toEqual([]);
  });
});
