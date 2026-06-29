import { useEffect, useRef } from 'react';
import type { IPriceLine, ISeriesApi } from 'lightweight-charts';

interface Level {
  type: string;
  value: number;
  color: string;
  label: string;
}

interface LevelOverlayProps {
  series: ISeriesApi<'Candlestick'> | null;
  levels: Level[];
}

/**
 * Draws each level as a horizontal price line on the candle series.
 * Reconciles via the price-line API: lines are added on mount + when levels
 * change, and removed on unmount.
 */
export default function LevelOverlay({ series, levels }: LevelOverlayProps) {
  const linesRef = useRef<IPriceLine[]>([]);

  useEffect(() => {
    if (!series) return;

    // Clear previous lines
    for (const line of linesRef.current) {
      try { series.removePriceLine(line); } catch { /* chart may be disposed */ }
    }
    linesRef.current = [];

    // Add new lines
    for (const lvl of levels) {
      const line = series.createPriceLine({
        price: lvl.value,
        color: lvl.color,
        lineWidth: 1,
        lineStyle: 2, // dashed
        axisLabelVisible: true,
        title: lvl.label,
      });
      linesRef.current.push(line);
    }

    return () => {
      for (const line of linesRef.current) {
        try { series.removePriceLine(line); } catch { /* ignore */ }
      }
      linesRef.current = [];
    };
  }, [series, levels]);

  return null; // pure side-effect
}

export const LEVEL_COLORS: Record<string, string> = {
  PDH: '#ef4444', PDL: '#22c55e',
  ORH: '#a855f7', ORL: '#a855f7',
  // Previous-session OR fallback — dimmed (50% alpha) purple to visually
  // signal "this is yesterday's OR, today's hasn't locked yet".
  // lightweight-charts accepts 8-char hex on price lines.
  Y_ORH: '#a855f780', Y_ORL: '#a855f780',
  VWAP: '#06b6d4',
  ROUND: '#94a3b8',
  VOL_STRIKE: '#f59e0b',
};
