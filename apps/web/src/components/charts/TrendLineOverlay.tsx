import { useEffect, useMemo, useRef } from 'react';
import type { IChartApi, ISeriesApi, Time } from 'lightweight-charts';
import { withLiveChart, withLiveSeries } from './chart-lifecycle';
import { trendLinePoints } from './trendLinePoints';
import type { TrendLine } from '@/hooks/useChartContext';
import type { SeriesBar } from '@/utils/chartSeries';

interface TrendLineOverlayProps {
  chart: IChartApi | null;
  /** `null` means "no clear trend" — nothing is drawn, which is correct. */
  trend: TrendLine | null;
  /** The plotted series; each bar carries both compressed and real time. */
  candles: SeriesBar[];
}

// Dimmed indigo: distinct from every S/R hue (red/green/magenta/teal/amber/
// blue/violet) and translucent enough to sit behind the candles. The trend is
// context, not a level you trade off, so it must never out-shout them.
const TREND_COLOR = 'rgba(129, 140, 248, 0.55)';

function toLineData(points: { time: number; value: number }[]) {
  return points.map((p) => ({ time: p.time as Time, value: p.value }));
}

/**
 * Draws the server-fitted trend line as a lightweight-charts line series.
 *
 * The mapping onto the chart's gap-compressed axis lives in `trendLinePoints`
 * (pure, unit-tested); this component only owns the series lifecycle.
 */
export default function TrendLineOverlay({ chart, trend, candles }: TrendLineOverlayProps) {
  const seriesRef = useRef<ISeriesApi<'Line'> | null>(null);

  // The line's value at a bar depends only on that bar's REAL time, so a live
  // tick (which mutates the last bar's close, not its time) cannot move it.
  // Keying on the bar timeline rather than the array identity keeps a ticking
  // chart from re-running setData several times a second for an identical line.
  const shape = candles.length > 0
    ? `${candles.length}:${candles[0].realTime}:${candles[candles.length - 1].realTime}`
    : '0';
  const trendKey = trend ? `${trend.kind}:${trend.slope}:${trend.intercept}:${trend.fromTime}` : '-';
  const points = useMemo(
    () => trendLinePoints(trend, candles),
    // Recomputed exactly when the drawn line can differ; see above.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [trendKey, shape],
  );

  const pointsRef = useRef(points);
  pointsRef.current = points;

  useEffect(() => {
    if (!chart) return;

    // Same deferral as OIOverlay: a freshly key-remounted chart may not have
    // finished initialising, so yield past this reconciliation pass before
    // touching it.
    let cancelled = false;
    let createdSeries: ISeriesApi<'Line'> | null = null;

    const timerId = setTimeout(() => {
      if (cancelled) return;
      // Gate on the disposal registry, not try/catch: a call into a removed
      // chart queues a repaint against a null canvas that no catch can stop.
      withLiveChart(chart, (c) => {
        const series = c.addLineSeries({
          color: TREND_COLOR,
          lineWidth: 2,
          lineStyle: 2, // dashed — a fit, not a measured level
          lastValueVisible: false,
          priceLineVisible: false,
          crosshairMarkerVisible: false,
        });
        createdSeries = series;
        seriesRef.current = series;
        // The data effect may already have run and found no series (creation is
        // deferred a task), so seed from the latest points here rather than
        // waiting for the next points change — which, for a settled chart,
        // might never come.
        series.setData(toLineData(pointsRef.current));
      });
    }, 0);

    return () => {
      cancelled = true;
      clearTimeout(timerId);
      const toRemove = createdSeries ?? seriesRef.current;
      // Skipping removeSeries on a disposed chart is safe: remove() already
      // tore down every series it owned.
      withLiveSeries(toRemove, (s) => chart.removeSeries(s));
      seriesRef.current = null;
    };
  }, [chart]);

  useEffect(() => {
    // The series can be disposed out from under us by a symbol switch (the
    // chart is keyed on the token), so gate every write on its liveness.
    if (!withLiveSeries(seriesRef.current, (s) => s.setData(toLineData(points)))) {
      seriesRef.current = null;
    }
  }, [chart, points]);

  return null; // pure side-effect
}
