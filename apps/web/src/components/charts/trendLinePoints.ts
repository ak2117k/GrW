import type { TrendLine } from '@/hooks/useChartContext';
import type { SeriesBar } from '@/utils/chartSeries';

/** A point on the chart's compressed axis, ready for a line series. */
export interface TrendPoint {
  /** Compressed axis time — what lightweight-charts plots. */
  time: number;
  value: number;
}

/**
 * Project a server-fitted trend line onto the chart's COMPRESSED time axis.
 *
 * The server fits over real market time (`fromTime` in unix seconds, slope in
 * price per second). The chart does not plot real time: `useChartData`
 * gap-compresses overnight/weekend/holiday gaps, so every bar carries both a
 * compressed `time` (plotted) and its true `realTime` (see chartSeries.ts).
 * Handing lightweight-charts `fromTime` directly would place the line days away
 * from where its anchoring pivot is actually drawn — the exact class of bug the
 * compressed-axis model exists to prevent.
 *
 * So the line is evaluated PER BAR: price from the bar's real time, plotted at
 * the bar's compressed time. That needs no inverse map (the compressed -> real
 * map is not invertible in general) and no extrapolation — the polyline simply
 * ends at the newest bar, i.e. the chart's right edge.
 *
 * Bars before `fromTime` are excluded: the fit says nothing about the market
 * before its first anchoring pivot, and back-projecting it would invent a claim
 * the server never made. `toTime` is deliberately NOT an upper bound — carrying
 * the line forward to the live edge is the whole point of drawing it.
 */
export function trendLinePoints(
  trend: TrendLine | null,
  bars: readonly SeriesBar[],
): TrendPoint[] {
  if (!trend || !Number.isFinite(trend.slope) || !Number.isFinite(trend.intercept)) return [];

  const points: TrendPoint[] = [];
  for (const bar of bars) {
    if (bar.realTime < trend.fromTime) continue;
    points.push({
      time: bar.time,
      value: trend.intercept + trend.slope * (bar.realTime - trend.fromTime),
    });
  }

  // A single point is not a line; lightweight-charts would render a lone dot
  // that reads as a level rather than a trend.
  return points.length >= 2 ? points : [];
}
