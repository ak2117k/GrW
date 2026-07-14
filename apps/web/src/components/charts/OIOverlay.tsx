import { useEffect, useRef } from 'react';
import type { IChartApi, ISeriesApi, Time } from 'lightweight-charts';

interface OIDataPoint {
  time: number;
  value: number;
}

interface OIOverlayProps {
  chart: IChartApi | null;
  oiData: OIDataPoint[];
  visible: boolean;
}

export default function OIOverlay({ chart, oiData, visible }: OIOverlayProps) {
  const seriesRef = useRef<ISeriesApi<'Line'> | null>(null);

  useEffect(() => {
    if (!chart) return;

    // The chart prop may point to a freshly-created instance whose internal
    // model has not finished initialising yet (e.g. after a key-driven
    // remount).  Defer series creation to the next task so the chart has a
    // full render cycle to complete its setup before we touch it.
    let cancelled = false;
    let createdSeries: ISeriesApi<'Line'> | null = null;

    const setup = () => {
      if (cancelled) return;

      try {
        const series = chart.addLineSeries({
          color: '#fbbf24',
          lineWidth: 2,
          priceScaleId: 'oi',
          lastValueVisible: true,
          priceLineVisible: false,
          crosshairMarkerVisible: true,
          crosshairMarkerRadius: 4,
        });

        chart.priceScale('oi').applyOptions({
          scaleMargins: { top: 0.1, bottom: 0.3 },
          borderVisible: false,
          textColor: '#fbbf24',
        });

        createdSeries = series;
        seriesRef.current = series;
      } catch (err) {
        // Chart was disposed or not yet ready — skip silently.
        console.warn('[OIOverlay] addLineSeries failed (chart not ready):', err);
      }
    };

    // Use setTimeout(0) instead of queueMicrotask so we yield past the
    // current synchronous React reconciliation pass.
    const timerId = setTimeout(setup, 0);

    return () => {
      cancelled = true;
      clearTimeout(timerId);
      // createdSeries may still be null if the timeout never fired.
      const seriesToRemove = createdSeries ?? seriesRef.current;
      if (seriesToRemove) {
        try {
          chart.removeSeries(seriesToRemove);
        } catch {
          // Chart may already be disposed during remount.
        }
      }
      seriesRef.current = null;
    };
  }, [chart]);

  // Update data
  useEffect(() => {
    if (!seriesRef.current || oiData.length === 0) return;

    const lineData = oiData.map((d) => ({
      time: d.time as Time,
      value: d.value,
    }));

    // The series can be disposed out from under us: a symbol switch remounts
    // CandlestickChart (key={token}) whose cleanup calls chart.remove(), which
    // disposes THIS series too, but seriesRef.current is only nulled by our own
    // [chart] cleanup — a window where setData hits a dead series and throws
    // "Object is disposed". Guard + null-on-failure (matches sibling overlays).
    try {
      seriesRef.current.setData(lineData);
    } catch {
      seriesRef.current = null;
    }
  }, [oiData]);

  // Toggle visibility
  useEffect(() => {
    if (!seriesRef.current) return;
    try {
      seriesRef.current.applyOptions({ visible });
    } catch {
      seriesRef.current = null;
    }
  }, [visible]);

  // This component renders no DOM -- it adds a series to the parent chart
  return null;
}
