import { useEffect, useRef } from 'react';
import type { IPriceLine, ISeriesApi } from 'lightweight-charts';

interface EntryTargetOverlayProps {
  series: ISeriesApi<'Candlestick'> | null;
  entry: number | null;
  stoploss: number | null;       // ORIGINAL hard stop
  target: number | null;
  partialTakeAt?: number | null; // TP1 line
  trailingSl?: number | null;    // replaces stoploss line visually
                                 // when status === 'PARTIAL_BOOKED'
  status?:
    | 'PENDING'
    | 'ACTIVE'
    | 'PARTIAL_BOOKED'
    | 'TARGET_HIT'
    | 'STOPPED'
    | 'EOD'
    | 'INVALIDATED'
    | 'TRAIL_STOPPED';
}

export default function EntryTargetOverlay({
  series,
  entry,
  stoploss,
  target,
  partialTakeAt,
  trailingSl,
  status,
}: EntryTargetOverlayProps) {
  const linesRef = useRef<IPriceLine[]>([]);

  useEffect(() => {
    if (!series) return;

    for (const line of linesRef.current) {
      try { series.removePriceLine(line); } catch { /* chart may be disposed */ }
    }
    linesRef.current = [];

    if (entry === null || stoploss === null || target === null) {
      return;
    }

    const fmt = (n: number) =>
      n.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

    const entryLine = series.createPriceLine({
      price: entry,
      color: '#f59e0b',
      lineWidth: 1,
      lineStyle: 2,
      axisLabelVisible: true,
      title: `ENTRY ${fmt(entry)}`,
    });
    linesRef.current.push(entryLine);

    // After partial book, show trailing stop (if provided) instead of original
    // hard stop. Title flips from SL to TRAIL so the user knows the runner's
    // stop is now ratcheting.
    const useTrail =
      status === 'PARTIAL_BOOKED' && trailingSl !== null && trailingSl !== undefined;
    const slPrice = useTrail ? (trailingSl as number) : stoploss;
    const slTitle = useTrail ? `TRAIL ${fmt(slPrice)}` : `SL ${fmt(slPrice)}`;
    const slLine = series.createPriceLine({
      price: slPrice,
      color: '#ef4444',
      lineWidth: 1,
      lineStyle: 0,
      axisLabelVisible: true,
      title: slTitle,
    });
    linesRef.current.push(slLine);

    const tgtLine = series.createPriceLine({
      price: target,
      color: '#10b981',
      lineWidth: 1,
      lineStyle: 0,
      axisLabelVisible: true,
      title: `TGT ${fmt(target)}`,
    });
    linesRef.current.push(tgtLine);

    // TP1 line — only visible while the partial is still in front of price
    // (PENDING / ACTIVE). Once PARTIAL_BOOKED fires it's already filled, so
    // dropping it keeps the chart from looking stale.
    if (
      partialTakeAt !== null &&
      partialTakeAt !== undefined &&
      (status === 'PENDING' || status === 'ACTIVE')
    ) {
      const tp1Line = series.createPriceLine({
        price: partialTakeAt,
        color: '#06b6d4',
        lineWidth: 1,
        lineStyle: 2,
        axisLabelVisible: true,
        title: `TP1 ${fmt(partialTakeAt)}`,
      });
      linesRef.current.push(tp1Line);
    }

    return () => {
      for (const line of linesRef.current) {
        try { series.removePriceLine(line); } catch { /* ignore */ }
      }
      linesRef.current = [];
    };
  }, [series, entry, stoploss, target, partialTakeAt, trailingSl, status]);

  return null;
}
