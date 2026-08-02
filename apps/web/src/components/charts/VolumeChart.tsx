import { useRef, useEffect } from 'react';
import {
  createChart,
  ColorType,
  type IChartApi,
  type ISeriesApi,
  type LogicalRange,
  type Time,
} from 'lightweight-charts';
import { markChartDisposed, withLiveChart } from './chart-lifecycle';

interface VolumeData {
  time: number;
  open: number;
  close: number;
  volume: number;
}

interface VolumeChartProps {
  data: VolumeData[];
  height?: number;
  /** Reference to the main chart for time scale syncing */
  mainChart?: IChartApi | null;
}

export default function VolumeChart({ data, height = 120, mainChart }: VolumeChartProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const seriesRef = useRef<ISeriesApi<'Histogram'> | null>(null);

  useEffect(() => {
    if (!containerRef.current) return;

    const chart = createChart(containerRef.current, {
      layout: {
        background: { type: ColorType.Solid, color: '#0a0a1a' },
        textColor: '#64748b',
        fontSize: 10,
      },
      grid: {
        vertLines: { color: 'rgba(30, 41, 59, 0.3)' },
        horzLines: { color: 'rgba(30, 41, 59, 0.3)' },
      },
      rightPriceScale: {
        borderColor: '#1e293b',
      },
      timeScale: {
        borderColor: '#1e293b',
        timeVisible: true,
        secondsVisible: false,
        visible: true,
      },
      height,
      width: containerRef.current.clientWidth,
    });

    const series = chart.addHistogramSeries({
      priceFormat: { type: 'volume' },
    });

    chartRef.current = chart;
    seriesRef.current = series;

    // Sync with main chart time scale.
    //
    // The main->volume handler lives on the MAIN chart's emitter, so it
    // OUTLIVES this component: without the unsubscribe below it keeps firing
    // after our chart.remove() and drives a repaint into a disposed canvas.
    // Both directions are also liveness-gated, because either chart can be
    // removed while the other is still emitting.
    const syncToVolume = (range: LogicalRange | null) => {
      if (!range) return;
      withLiveChart(chart, (c) => c.timeScale().setVisibleLogicalRange(range));
    };
    const syncToMain = (range: LogicalRange | null) => {
      if (!range) return;
      withLiveChart(mainChart, (c) => c.timeScale().setVisibleLogicalRange(range));
    };

    if (mainChart) {
      mainChart.timeScale().subscribeVisibleLogicalRangeChange(syncToVolume);
      chart.timeScale().subscribeVisibleLogicalRangeChange(syncToMain);
    }

    const resizeObserver = new ResizeObserver((entries) => {
      for (const entry of entries) {
        const { width: w } = entry.contentRect;
        if (w > 0) {
          chart.applyOptions({ width: w });
        }
      }
    });
    resizeObserver.observe(containerRef.current);

    return () => {
      resizeObserver.disconnect();
      // Detach the handler we installed on the MAIN chart first — it is not
      // ours to leave behind, and it closes over the chart we are about to
      // destroy.
      withLiveChart(mainChart, (c) =>
        c.timeScale().unsubscribeVisibleLogicalRangeChange(syncToVolume),
      );
      markChartDisposed(chart);
      chart.remove();
      chartRef.current = null;
      seriesRef.current = null;
    };
  }, [height, mainChart]);

  useEffect(() => {
    if (!seriesRef.current || data.length === 0) return;

    const volumeData = data.map((d) => ({
      time: d.time as Time,
      value: d.volume,
      color: d.close >= d.open ? 'rgba(0, 207, 132, 0.5)' : 'rgba(239, 68, 68, 0.5)',
    }));

    seriesRef.current.setData(volumeData);
  }, [data]);

  return (
    <div
      ref={containerRef}
      style={{ width: '100%', height: `${height}px` }}
    />
  );
}
