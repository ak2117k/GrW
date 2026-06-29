import { useEffect, useMemo, useRef } from 'react';
import type { IPriceLine, ISeriesApi } from 'lightweight-charts';
import type { EvidenceLevel } from '@/types';

interface Props {
  candleSeries: ISeriesApi<'Candlestick'> | null;
  evidence: EvidenceLevel[];
}

/** Colour by the dominant evidence kind; soft levels are faint dotted. */
function styleFor(e: EvidenceLevel): { color: string; lineWidth: 1 | 2; lineStyle: 0 | 1 | 2 } {
  if (e.soft) return { color: '#94a3b8', lineWidth: 1, lineStyle: 1 }; // gray dotted (projected)
  const k = e.kinds[0];
  // Options-flow walls — magenta, solid, prominent
  if (k === 'OI_CALL' || k === 'OI_PUT' || k === 'OI_CHANGE' || k === 'MAX_PAIN')
    return { color: '#d946ef', lineWidth: 2, lineStyle: 0 };
  // Volume: POC strongest (orange), shelves teal, value-area faint teal
  if (k === 'POC') return { color: '#f59e0b', lineWidth: 2, lineStyle: 0 }; // amber POC
  if (k === 'VOLUME') return { color: '#14b8a6', lineWidth: e.score >= 60 ? 2 : 1, lineStyle: 0 };
  if (k === 'VALUE_AREA') return { color: '#2dd4bf', lineWidth: 1, lineStyle: 2 }; // faint teal VA edge
  // Dynamic S/R
  if (k === 'MA') return { color: '#3b82f6', lineWidth: e.score >= 16 ? 2 : 1, lineStyle: 0 }; // blue MA (200 thicker)
  if (k === 'AVWAP') return { color: '#8b5cf6', lineWidth: 1, lineStyle: 0 }; // violet anchored VWAP
  // Structure
  if (k === 'GAP') return { color: '#ef4444', lineWidth: 1, lineStyle: 2 }; // red gap edge
  if (k === 'FIB') return { color: '#eab308', lineWidth: 1, lineStyle: 2 }; // gold fib
  return { color: '#a3a3a3', lineWidth: 1, lineStyle: 2 }; // round/other dashed
}

function title(e: EvidenceLevel): string {
  const role = e.side === 'resistance' ? 'R' : 'S';
  const tag = e.soft ? 'PROJ' : e.kinds.includes('OI_CALL') || e.kinds.includes('OI_PUT') ? 'OI' : e.kinds[0];
  const price = e.price.toLocaleString('en-IN', { maximumFractionDigits: 2 });
  const sign = e.distancePct >= 0 ? '+' : '';
  return `${tag} ${role} ${price} (${sign}${e.distancePct.toFixed(1)}%)`;
}

function safeCreate(series: ISeriesApi<'Candlestick'>, opts: Parameters<ISeriesApi<'Candlestick'>['createPriceLine']>[0]): IPriceLine | null {
  try { return series.createPriceLine(opts); } catch { return null; }
}
function safeRemove(series: ISeriesApi<'Candlestick'>, line: IPriceLine): void {
  try { series.removePriceLine(line); } catch { /* disposed */ }
}

export default function EvidenceLevelOverlay({ candleSeries, evidence }: Props) {
  const linesRef = useRef<IPriceLine[]>([]);
  const drawKey = useMemo(
    () => evidence.map((e) => `${e.price}:${e.side}:${e.score}:${e.soft}:${e.distancePct.toFixed(1)}`).join('|'),
    [evidence],
  );

  useEffect(() => {
    if (!candleSeries) return;
    const series = candleSeries;
    for (const l of linesRef.current) safeRemove(series, l);
    linesRef.current = [];
    for (const e of evidence) {
      const s = styleFor(e);
      const line = safeCreate(series, {
        price: e.price, color: s.color, lineWidth: s.lineWidth, lineStyle: s.lineStyle,
        axisLabelVisible: true, title: title(e),
      });
      if (line) linesRef.current.push(line);
    }
    return () => {
      for (const l of linesRef.current) safeRemove(series, l);
      linesRef.current = [];
    };
    // evidence captured via drawKey (stable across no-op re-renders).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [candleSeries, drawKey]);

  return null;
}
