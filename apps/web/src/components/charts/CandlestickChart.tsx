import { useRef, useEffect, useCallback, forwardRef, useImperativeHandle } from 'react';
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
  candles: ChartCandle[];
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

function formatRealTimeShort(realSec: number): string {
  const d = new Date(realSec * 1000);
  return d.toLocaleTimeString('en-IN', {
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
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
    const prevCandlesLenRef = useRef(0);
    const prevFirstCandleTimeRef = useRef<number | null>(null);
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
          // time when labelling the bottom axis. If no map is provided
          // (e.g. very early during initial load), fall back to formatting
          // the raw value so labels never go blank.
          tickMarkFormatter: (time: Time) => {
            const t = time as number;
            const real = realTimeMapRef.current?.get(t) ?? t;
            return formatRealTimeShort(real);
          },
        },
        localization: {
          // Same translation for the crosshair tooltip on the time axis.
          timeFormatter: (time: number) => {
            const real = realTimeMapRef.current?.get(time) ?? time;
            return formatRealTime(real);
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

      // Volume histogram on the same chart
      const volumeSeries = chart.addHistogramSeries({
        priceFormat: { type: 'volume' },
        priceScaleId: 'volume',
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
        chart.remove();
        chartRef.current = null;
        candleSeriesRef.current = null;
        volumeSeriesRef.current = null;
        prevCandlesLenRef.current = 0;
        prevFirstCandleTimeRef.current = null;
      };
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    // Update candle data
    const updateData = useCallback(() => {
      if (!candleSeriesRef.current || !volumeSeriesRef.current) return;

      // Clear chart when candles are empty (e.g. symbol just changed)
      if (candles.length === 0) {
        candleSeriesRef.current.setData([]);
        volumeSeriesRef.current.setData([]);
        prevCandlesLenRef.current = 0;
        prevFirstCandleTimeRef.current = null;
        prevPrependSeqRef.current = prependSeq;
        return;
      }

      const candleData = candles.map((c) => ({
        time: Math.floor(c.time) as Time,
        open: c.open,
        high: c.high,
        low: c.low,
        close: c.close,
      }));

      const volumeData = candles.map((c) => ({
        time: Math.floor(c.time) as Time,
        value: c.volume,
        color: c.close >= c.open ? 'rgba(0, 207, 132, 0.35)' : 'rgba(239, 68, 68, 0.35)',
      }));

      const newFirstTime = candles[0].time;

      // PREPEND update: older bars were just added at the FRONT (lower compressed
      // times) while existing bars keep their times. This also changes the first
      // candle time, so we use prependSeq — not the first-candle-time delta — to
      // distinguish it from a real dataset reset. Preserve the user's scroll
      // position by capturing the visible range before setData and restoring it
      // after, and skip the default-zoom logic entirely.
      const isPrepend = prependSeq !== prevPrependSeqRef.current;
      if (isPrepend) {
        const ts = chartRef.current?.timeScale();
        const savedRange = ts?.getVisibleRange() ?? null;
        candleSeriesRef.current.setData(candleData);
        volumeSeriesRef.current.setData(volumeData);
        if (ts && savedRange) {
          ts.setVisibleRange(savedRange);
        }
        // Now that more history exists to the left, re-arm so a subsequent
        // scroll back to the (new) edge can request the next page.
        loadOlderArmedRef.current = true;
        prevCandlesLenRef.current = candles.length;
        prevFirstCandleTimeRef.current = newFirstTime;
        prevPrependSeqRef.current = prependSeq;
        return;
      }

      // Detect a symbol/dataset change: if the first candle's timestamp differs
      // from what we saw before, this is a completely new dataset — force a full
      // setData() by resetting the incremental counter.
      if (prevFirstCandleTimeRef.current !== null && prevFirstCandleTimeRef.current !== newFirstTime) {
        prevCandlesLenRef.current = 0;
      }

      const isIncremental =
        prevCandlesLenRef.current > 0 &&
        Math.abs(candles.length - prevCandlesLenRef.current) <= 1;

      if (isIncremental) {
        // Real-time update: try to update/append the last candle
        try {
          const lastCandle = candleData[candleData.length - 1];
          const lastVolume = volumeData[volumeData.length - 1];
          candleSeriesRef.current.update(lastCandle);
          volumeSeriesRef.current.update(lastVolume);
        } catch {
          // Fallback to full setData if update fails (e.g. time out of order)
          candleSeriesRef.current.setData(candleData);
          volumeSeriesRef.current.setData(volumeData);
        }
      } else {
        candleSeriesRef.current.setData(candleData);
        volumeSeriesRef.current.setData(volumeData);

        // Default-zoom to the LATEST ~100 bars on dataset reset (initial load
        // OR symbol/timeframe change). The chart still HAS all fetched bars
        // (often 250-400) — user can scroll/zoom left to see older history.
        //
        // Why not fitContent(): with 250+ bars and a typical 800px chart,
        // fitContent compresses bars to <4px wide, making them invisible/
        // squished. Showing the most-recent 100 keeps bars at usable width
        // for default-view trading decisions.
        //
        // Deferred via rAF: calling setVisibleLogicalRange synchronously
        // after setData races the chart's internal time-scale state.
        if (prevCandlesLenRef.current === 0) {
          requestAnimationFrame(() => {
            const ts = chartRef.current?.timeScale();
            if (!ts) return;
            const totalBars = candleData.length;
            const defaultVisible = 100;
            if (totalBars > defaultVisible) {
              ts.setVisibleLogicalRange({
                from: totalBars - defaultVisible,
                to: totalBars + 2, // small right pad for live tick growth
              });
            } else {
              ts.fitContent();
            }
          });
        }
      }

      prevCandlesLenRef.current = candles.length;
      prevFirstCandleTimeRef.current = newFirstTime;
      prevPrependSeqRef.current = prependSeq;
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
