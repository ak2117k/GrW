import { useRef, useEffect, useCallback, forwardRef, useImperativeHandle } from 'react';
import { markChartDisposed, withLiveChart } from './chart-lifecycle';
import { planRender, type SeriesBar } from '@/utils/chartSeries';
import {
  createChart,
  ColorType,
  CrosshairMode,
  type IChartApi,
  type ISeriesApi,
  type CandlestickSeriesOptions,
  type DeepPartial,
  type MouseEventParams,
  type Time,
  TickMarkType,
} from 'lightweight-charts';

export interface ChartCandle {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export interface CandlestickChartHandle {
  chart: IChartApi | null;
  candleSeries: ISeriesApi<'Candlestick'> | null;
  fitContent: () => void;
}

interface CandlestickChartProps {
  candles: SeriesBar[];
  width?: number;
  height?: number;
  onCrosshairMove?: (params: MouseEventParams<Time>) => void;
  showVolume?: boolean;
  // Maps the compressed time on the chart's axis to the real (unix) time
  // of the underlying candle. When provided, the time-axis labels and
  // crosshair tooltips show real market times instead of the synthetic
  // gap-collapsed timestamps.
  realTimeMap?: Map<number, number>;
  // Infinite history scroll: invoked when the user scrolls near the left edge
  // (oldest bar) and more history is available. Parent should fetch + prepend
  // older bars, then bump `prependSeq` so the chart preserves scroll position.
  onLoadOlder?: () => void;
  // Whether older history is still available to load. When false the left-edge
  // detection will not fire `onLoadOlder`.
  canLoadOlder?: boolean;
  // Monotonically-increasing counter the parent bumps after prepending older
  // bars. A change signals a PREPEND update (preserve scroll, no default-zoom)
  // rather than a fresh dataset reset.
  prependSeq?: number;
}

function formatRealTime(realSec: number): string {
  const d = new Date(realSec * 1000);
  return d.toLocaleString('en-IN', {
    day: '2-digit',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
}

/**
 * Bottom-axis tick label. Formats by the tick's granularity so daily/weekly bars
 * (timestamped at midnight) show a DATE, not "00:00", and intraday bars show the
 * time. Without honouring `tickMarkType` every daily tick rendered as "00:00".
 */
function formatAxisTick(realSec: number, tickMarkType: TickMarkType): string {
  const d = new Date(realSec * 1000);
  switch (tickMarkType) {
    case TickMarkType.Year:
      return d.toLocaleDateString('en-IN', { year: 'numeric' });
    case TickMarkType.Month:
      return d.toLocaleDateString('en-IN', { month: 'short', year: '2-digit' });
    case TickMarkType.DayOfMonth:
      return d.toLocaleDateString('en-IN', { day: '2-digit', month: 'short' });
    default: // Time / TimeWithSeconds — intraday
      return d.toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', hour12: false });
  }
}

/** A plotted bar -> the point shapes lightweight-charts wants. */
function toCandlePoint(bar: SeriesBar) {
  return {
    time: Math.floor(bar.time) as Time,
    open: bar.open,
    high: bar.high,
    low: bar.low,
    close: bar.close,
  };
}

function toVolumePoint(bar: SeriesBar) {
  return {
    time: Math.floor(bar.time) as Time,
    value: bar.volume,
    color: bar.close >= bar.open ? 'rgba(0, 207, 132, 0.35)' : 'rgba(239, 68, 68, 0.35)',
  };
}

const CandlestickChart = forwardRef<CandlestickChartHandle, CandlestickChartProps>(
  function CandlestickChart(
    {
      candles,
      width,
      height,
      onCrosshairMove,
      showVolume = true,
      realTimeMap,
      onLoadOlder,
      canLoadOlder,
      prependSeq,
    },
    ref,
  ) {
    const containerRef = useRef<HTMLDivElement>(null);
    const chartRef = useRef<IChartApi | null>(null);
    const candleSeriesRef = useRef<ISeriesApi<'Candlestick'> | null>(null);
    const volumeSeriesRef = useRef<ISeriesApi<'Histogram'> | null>(null);
    // The exact bars array last pushed to the canvas. `planRender` diffs the
    // incoming array against it by reference, which is exact because every
    // series transition copy-on-writes only the bars it touched.
    const prevBarsRef = useRef<SeriesBar[] | null>(null);
    // Whether this dataset has had its one default zoom. Cleared when the
    // series empties (symbol/timeframe switch).
    const hasZoomedRef = useRef(false);
    // Tracks the last seen prependSeq so updateData can distinguish a PREPEND
    // (older bars added at the front — preserve scroll) from a real dataset
    // reset (symbol/timeframe change — default-zoom).
    const prevPrependSeqRef = useRef<number | undefined>(prependSeq);
    // Hold the latest onLoadOlder / canLoadOlder in refs so the once-at-mount
    // visible-range subscription always reads current values without needing
    // to re-subscribe on every prop change.
    const onLoadOlderRef = useRef<(() => void) | undefined>(onLoadOlder);
    const canLoadOlderRef = useRef<boolean | undefined>(canLoadOlder);
    // In-flight guard: disarms after firing onLoadOlder at the left edge and
    // re-arms once the visible range scrolls away from the edge. Prevents a
    // burst of onLoadOlder calls while the parent is fetching.
    const loadOlderArmedRef = useRef(true);
    useEffect(() => {
      onLoadOlderRef.current = onLoadOlder;
      canLoadOlderRef.current = canLoadOlder;
    }, [onLoadOlder, canLoadOlder]);
    // Hold the latest realTimeMap in a ref so chart-level formatters (created
    // once at mount) can always read the current map without re-creating the
    // chart on every prop change.
    const realTimeMapRef = useRef<Map<number, number> | undefined>(realTimeMap);
    useEffect(() => {
      realTimeMapRef.current = realTimeMap;
    }, [realTimeMap]);

    useImperativeHandle(ref, () => ({
      get chart() {
        return chartRef.current;
      },
      get candleSeries() {
        return candleSeriesRef.current;
      },
      fitContent: () => {
        chartRef.current?.timeScale().fitContent();
      },
    }));

    // Initialize chart
    useEffect(() => {
      if (!containerRef.current) return;

      const chart = createChart(containerRef.current, {
        layout: {
          background: { type: ColorType.Solid, color: '#0a0a1a' },
          textColor: '#94a3b8',
          fontSize: 12,
        },
        grid: {
          vertLines: { color: 'rgba(30, 41, 59, 0.5)' },
          horzLines: { color: 'rgba(30, 41, 59, 0.5)' },
        },
        crosshair: {
          mode: CrosshairMode.Normal,
          vertLine: {
            color: 'rgba(59, 130, 246, 0.4)',
            labelBackgroundColor: '#3b82f6',
          },
          horzLine: {
            color: 'rgba(59, 130, 246, 0.4)',
            labelBackgroundColor: '#3b82f6',
          },
        },
        rightPriceScale: {
          borderColor: '#1e293b',
          scaleMargins: {
            top: 0.05,
            bottom: showVolume ? 0.25 : 0.05,
          },
        },
        timeScale: {
          borderColor: '#1e293b',
          timeVisible: true,
          secondsVisible: false,
          rightOffset: 5,
          barSpacing: 6,
          // Don't let the chart try to render bars so thin they vanish.
          // fitContent() respects this floor — if all bars can't fit at >=
          // minBarSpacing, the chart scrolls horizontally instead.
          minBarSpacing: 2,
          // Translate the chart's compressed time back to the real market
          // time when labelling the bottom axis.
          //
          // There is deliberately NO `?? time` fallback. A compressed time IS
          // a valid-looking timestamp (compression subtracts the overnight
          // gap), so falling back to it renders the PREVIOUS DAY's date on a
          // bar and reads as real. The map is derived from the plotted bars,
          // so a miss means the axis is ahead of the data — show nothing
          // rather than a plausible lie.
          tickMarkFormatter: (time: Time, tickMarkType: TickMarkType) => {
            const real = realTimeMapRef.current?.get(time as number);
            return real === undefined ? '' : formatAxisTick(real, tickMarkType);
          },
        },
        localization: {
          // Same translation for the crosshair tooltip on the time axis.
          timeFormatter: (time: number) => {
            const real = realTimeMapRef.current?.get(time);
            return real === undefined ? '—' : formatRealTime(real);
          },
        },
        width: width ?? containerRef.current.clientWidth,
        height: height ?? containerRef.current.clientHeight,
      });

      const candleOptions: DeepPartial<CandlestickSeriesOptions> = {
        upColor: '#00cf84',
        downColor: '#ef4444',
        borderUpColor: '#00cf84',
        borderDownColor: '#ef4444',
        wickUpColor: '#00cf84',
        wickDownColor: '#ef4444',
      };

      const candleSeries = chart.addCandlestickSeries(candleOptions);
      candleSeriesRef.current = candleSeries;

      // Volume histogram on the same chart.
      //
      // lastValueVisible/priceLineVisible default to TRUE, which draws the
      // histogram's own last-value line and axis badge on the volume scale.
      // Indices (NIFTY, BANKNIFTY, SENSEX) report volume 0, so that rendered
      // a stray line and a red "0" badge overlapping the price axis labels.
      const volumeSeries = chart.addHistogramSeries({
        priceFormat: { type: 'volume' },
        priceScaleId: 'volume',
        lastValueVisible: false,
        priceLineVisible: false,
      });

      chart.priceScale('volume').applyOptions({
        scaleMargins: { top: 0.8, bottom: 0 },
        borderVisible: false,
      });

      volumeSeriesRef.current = volumeSeries;

      chartRef.current = chart;

      // Crosshair callback
      if (onCrosshairMove) {
        chart.subscribeCrosshairMove(onCrosshairMove);
      }

      // Left-edge detection for infinite history scroll. Subscribed once at
      // mount; reads onLoadOlder / canLoadOlder via refs so it always sees the
      // current values without re-subscribing.
      const handleVisibleLogicalRangeChange = (
        range: { from: number; to: number } | null,
      ) => {
        if (!range) return;
        // Re-arm once we've scrolled comfortably away from the left edge.
        if (range.from >= 20) {
          loadOlderArmedRef.current = true;
        }
        // Within ~8 bars of logical index 0 — request older history.
        if (range.from < 8 && loadOlderArmedRef.current && canLoadOlderRef.current) {
          loadOlderArmedRef.current = false;
          onLoadOlderRef.current?.();
        }
      };
      chart
        .timeScale()
        .subscribeVisibleLogicalRangeChange(handleVisibleLogicalRangeChange);

      // ResizeObserver for auto-resize
      const resizeObserver = new ResizeObserver((entries) => {
        for (const entry of entries) {
          const { width: w, height: h } = entry.contentRect;
          if (w > 0 && h > 0) {
            chart.applyOptions({ width: w, height: h });
          }
        }
      });

      if (!width && !height) {
        resizeObserver.observe(containerRef.current);
      }

      return () => {
        resizeObserver.disconnect();
        if (onCrosshairMove) {
          chart.unsubscribeCrosshairMove(onCrosshairMove);
        }
        chart
          .timeScale()
          .unsubscribeVisibleLogicalRangeChange(handleVisibleLogicalRangeChange);
        // Mark BEFORE remove(): the overlays are unkeyed siblings holding this
        // instance via `chartRef.current?.chart`, and their cleanups run around
        // this one. Marking first means any of their calls that land after this
        // point are skipped rather than queuing a repaint on a dead canvas.
        // Mark the series too: several overlays (LevelOverlay, SetupMarker,
        // EntryTargetOverlay, EvidenceLevelOverlay) receive ONLY a series and
        // have no chart handle to check liveness against.
        markChartDisposed(chart, [candleSeriesRef.current, volumeSeriesRef.current]);
        chart.remove();
        chartRef.current = null;
        candleSeriesRef.current = null;
        volumeSeriesRef.current = null;
        prevBarsRef.current = null;
        hasZoomedRef.current = false;
      };
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    // Update candle data.
    //
    // What the canvas is told is decided by `planRender`, an exact reference
    // diff of the bars array — NOT by a length delta. The old heuristic
    // ("length changed by <= 1 → update the last bar") was wrong in exactly
    // the case the 20s REST poll produces: correct an earlier bar AND append
    // a new one. That reads as "+1 bar", so only the appended bar was pushed
    // and the correction never reached the canvas, leaving the drawn chart
    // permanently disagreeing with the data behind the OHLC readout.
    const updateData = useCallback(() => {
      const candleApi = candleSeriesRef.current;
      const volumeApi = volumeSeriesRef.current;
      if (!candleApi || !volumeApi) return;

      // A prepend must preserve the user's scroll position; every other
      // reset is a fresh dataset.
      const isPrepend = prependSeq !== prevPrependSeqRef.current;
      prevPrependSeqRef.current = prependSeq;

      const plan = planRender(prevBarsRef.current, candles);
      if (plan.kind === 'none') return;

      if (candles.length === 0) {
        candleApi.setData([]);
        volumeApi.setData([]);
        prevBarsRef.current = candles;
        hasZoomedRef.current = false;
        return;
      }

      if (plan.kind === 'update') {
        candleApi.update(toCandlePoint(plan.bar));
        volumeApi.update(toVolumePoint(plan.bar));
        prevBarsRef.current = candles;
        return;
      }

      const ts = chartRef.current?.timeScale();
      const savedRange = isPrepend ? (ts?.getVisibleRange() ?? null) : null;
      candleApi.setData(candles.map(toCandlePoint));
      volumeApi.setData(candles.map(toVolumePoint));
      prevBarsRef.current = candles;

      if (isPrepend) {
        if (ts && savedRange) ts.setVisibleRange(savedRange);
        // More history now exists to the left — re-arm so a subsequent scroll
        // to the (new) edge can request the next page.
        loadOlderArmedRef.current = true;
        return;
      }

      // Default-zoom to the LATEST ~100 bars, once per dataset. The chart
      // still HOLDS all fetched bars (often 250-400) — the user can scroll
      // left for history. Not fitContent(): with 250+ bars in ~800px, bars
      // compress below 4px and effectively vanish.
      //
      // Guarded by hasZoomedRef (cleared when the series empties on a symbol
      // switch) so a later full setData — a poll filling an interior hole,
      // say — re-renders without yanking the user's view back.
      if (hasZoomedRef.current) return;
      hasZoomedRef.current = true;
      const totalBars = candles.length;
      requestAnimationFrame(() => {
        // The chart can be removed between scheduling and this frame (a symbol
        // switch remounts this component). Checking `chartRef.current` alone is
        // not enough — the ref is nulled by OUR cleanup, but the instance may
        // be disposed by a path that runs first.
        withLiveChart(chartRef.current, (c) => {
          const scale = c.timeScale();
          const defaultVisible = 100;
          if (totalBars > defaultVisible) {
            scale.setVisibleLogicalRange({
              from: totalBars - defaultVisible,
              to: totalBars + 2, // small right pad for live tick growth
            });
          } else {
            scale.fitContent();
          }
        });
      });
    }, [candles, prependSeq]);

    useEffect(() => {
      updateData();
    }, [updateData]);

    // Toggle volume visibility
    useEffect(() => {
      if (!volumeSeriesRef.current) return;
      volumeSeriesRef.current.applyOptions({
        visible: showVolume,
      });
    }, [showVolume]);

    return (
      <div
        ref={containerRef}
        style={{
          width: width ? `${width}px` : '100%',
          height: height ? `${height}px` : '100%',
          minHeight: '300px',
        }}
      />
    );
  },
);

export default CandlestickChart;
