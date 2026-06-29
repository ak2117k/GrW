import { useRef, useEffect } from 'react';
import {
  createChart,
  ColorType,
  type IChartApi,
  type ISeriesApi,
  type Time,
} from 'lightweight-charts';

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

    // Sync with main chart time scale
    if (mainChart) {
      mainChart.timeScale().subscribeVisibleLogicalRangeChange((range) => {
        if (range) {
          chart.timeScale().setVisibleLogicalRange(range);
        }
      });

      chart.timeScale().subscribeVisibleLogicalRangeChange((range) => {
        if (range) {
          mainChart.timeScale().setVisibleLogicalRange(range);
        }
      });
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
