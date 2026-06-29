import { useEffect } from 'react';
import type { ISeriesApi, Time } from 'lightweight-charts';

interface SetupMarkerProps {
  series: ISeriesApi<'Candlestick'> | null;
  time: number; // unix seconds — triggerCandle.time
  side: 'BUY' | 'SELL';
  text: string;
}

export default function SetupMarker({ series, time, side, text }: SetupMarkerProps) {
  useEffect(() => {
    if (!series) return;
    const marker = {
      time: time as Time,
      position: side === 'BUY' ? 'belowBar' as const : 'aboveBar' as const,
      color: side === 'BUY' ? '#22c55e' : '#ef4444',
      shape: side === 'BUY' ? 'arrowUp' as const : 'arrowDown' as const,
      text,
    };
    series.setMarkers([marker]);
    return () => {
      try { series.setMarkers([]); } catch { /* ignore */ }
    };
  }, [series, time, side, text]);

  return null;
}
