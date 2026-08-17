import { useEffect, useRef } from 'react';
import type { IPriceLine, ISeriesApi } from 'lightweight-charts';
import { withLiveSeries } from './chart-lifecycle';
import type { SentinelPosition } from '@/hooks/useSentinelPositions';

interface SentinelOverlayProps {
  series: ISeriesApi<'Candlestick'> | null;
  /** Positions already filtered to the charted instrument. */
  positions: SentinelPosition[];
  /**
   * The chart's own instrument. A DERIVATIVE position's prices are premiums and
   * belong to a different scale entirely — see the note on {@link drawablePrices}.
   */
  chartSymbol: string;
}

/**
 * Which of a position's prices may be drawn on THIS chart.
 *
 * THE SCALE TRAP, and it is the one thing that must not go wrong here. A
 * `KEI29SEP265800CE` position has entry 271.85 and a green floor of 273.49 —
 * those are PREMIUMS. KEI's cash chart runs around 5,800. Drawing 271.85 on it
 * puts a line labelled "ENTRY" at the very bottom of the pane, on a price the
 * stock has not traded at in years, and a user glancing at it reads a
 * catastrophic position.
 *
 * So a derivative contributes only prices that are already on the UNDERLYING's
 * scale — the thesis level, target and invalidation, which the agent states
 * about the underlying. Its premium-scale numbers (entry, green floor) are
 * shown in the panel as text instead, where they carry their own units.
 *
 * Cash positions are on the chart's own scale, so everything is drawable.
 */
export function drawablePrices(
  position: SentinelPosition,
  isCashOnThisChart: boolean,
): Array<{ price: number; title: string; color: string; style: 0 | 2 | 3 }> {
  const out: Array<{ price: number; title: string; color: string; style: 0 | 2 | 3 }> = [];
  const fmt = (n: number) =>
    n.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

  if (isCashOnThisChart) {
    out.push({ price: position.entryPrice, title: `ENTRY ${fmt(position.entryPrice)}`, color: '#f59e0b', style: 2 });
    const floor = position.verdict?.greenFloor;
    if (typeof floor === 'number' && Number.isFinite(floor)) {
      // The charge-adjusted breakeven — the price an exit must beat to be green
      // net of costs, which is NOT the entry price.
      out.push({ price: floor, title: `GREEN FLOOR ${fmt(floor)}`, color: '#10b981', style: 3 });
    }
  }

  const th = position.thesis;
  if (th?.levelPrice != null && Number.isFinite(th.levelPrice)) {
    out.push({ price: th.levelPrice, title: `THESIS LEVEL ${fmt(th.levelPrice)}`, color: '#60a5fa', style: 2 });
  }
  if (th?.targetPrice != null && Number.isFinite(th.targetPrice)) {
    out.push({ price: th.targetPrice, title: `TARGET ${fmt(th.targetPrice)}`, color: '#34d399', style: 2 });
  }
  if (th?.invalidation != null && Number.isFinite(th.invalidation)) {
    out.push({ price: th.invalidation, title: `INVALIDATION ${fmt(th.invalidation)}`, color: '#f87171', style: 0 });
  }
  return out;
}

/** True when the charted instrument IS the traded one (cash on its own chart). */
export function isCashOnThisChart(positionSymbol: string, chartSymbol: string): boolean {
  const strip = (s: string) => String(s ?? '').trim().toUpperCase().replace(/-[A-Z0-9]{1,3}$/, '');
  return strip(positionSymbol) === strip(chartSymbol);
}

/**
 * Draws the sentinel's read onto the price pane: the levels its thesis stands
 * on, and — for a cash position — the entry and the charge-adjusted floor.
 *
 * Price LINES only. The verdict, its reasoning and its evidence are prose and
 * belong in the panel beside the chart; six overlays on top of the level book
 * and projection band is unreadable, and an unreadable overlay teaches the user
 * to stop looking.
 */
export default function SentinelOverlay({ series, positions, chartSymbol }: SentinelOverlayProps) {
  const linesRef = useRef<IPriceLine[]>([]);

  useEffect(() => {
    if (!series) return;

    for (const line of linesRef.current) {
      try {
        series.removePriceLine(line);
      } catch {
        /* chart may already be disposed */
      }
    }
    linesRef.current = [];

    for (const position of positions) {
      const cash = isCashOnThisChart(position.symbol, chartSymbol);
      for (const spec of drawablePrices(position, cash)) {
        withLiveSeries(series, (s) => {
          const line = s.createPriceLine({
            price: spec.price,
            color: spec.color,
            lineWidth: 1,
            lineStyle: spec.style,
            axisLabelVisible: true,
            title: spec.title,
          });
          linesRef.current.push(line);
        });
      }
    }

    return () => {
      for (const line of linesRef.current) {
        try {
          series.removePriceLine(line);
        } catch {
          /* chart may already be disposed */
        }
      }
      linesRef.current = [];
    };
  }, [series, positions, chartSymbol]);

  return null;
}
