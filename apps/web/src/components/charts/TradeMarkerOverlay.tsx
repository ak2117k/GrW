import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { IChartApi, ISeriesApi, Time } from 'lightweight-charts';
import { useChartTrades } from '@/hooks/useChartTrades';
import { buildChartTimeResolver } from './mapPatternsToChartTime';
import { buildTradeMarkers, type TradeMarkerDescriptor } from './tradeMarkers';

interface TradeMarkerOverlayProps {
  token: string;
  chart: IChartApi | null;
  series: ISeriesApi<'Candlestick'> | null;
  // Compressed-time → real-seconds map the chart is currently plotting on.
  realTimeMap: Map<number, number>;
}

interface PositionedMarker extends TradeMarkerDescriptor {
  x: number;
  y: number;
}

/**
 * Annotates realized trades on the app's own chart: an entry marker (▲ long /
 * ▼ short) at the fill and a ● at each exit, hover-revealing the sold/remaining
 * quantities and the signal source.
 *
 * Rendered as custom absolutely-positioned HTML — NOT `series.setMarkers()`,
 * which `PatternOverlay` owns and which REPLACES all markers (the two would
 * clobber each other). Each marker's real epoch-MS time is mapped onto the
 * chart's gap-compressed axis via the SAME resolver the pattern overlay uses
 * (`buildChartTimeResolver`) so markers land on the correct bars, then through
 * `timeScale().timeToCoordinate()` + `series.priceToCoordinate()` for pixels.
 *
 * Positions are recomputed on pan/zoom (visible-range), crosshair move and
 * resize. All lightweight-charts calls are try/caught: the series/chart can be
 * disposed out from under us on a symbol switch (see the OIOverlay lesson).
 */
export default function TradeMarkerOverlay({
  token,
  chart,
  series,
  realTimeMap,
}: TradeMarkerOverlayProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const { trades } = useChartTrades(token);
  const [positions, setPositions] = useState<PositionedMarker[]>([]);
  const [hovered, setHovered] = useState<string | null>(null);

  const markers = useMemo(() => buildTradeMarkers(trades), [trades]);

  const recompute = useCallback(() => {
    if (!chart || !series || markers.length === 0) {
      setPositions([]);
      return;
    }
    const resolver = buildChartTimeResolver(realTimeMap);
    const next: PositionedMarker[] = [];
    for (const m of markers) {
      const compressed = resolver.resolveMs(m.timeMs);
      if (compressed === null) continue; // outside the displayed window
      let x: number | null = null;
      let y: number | null = null;
      try {
        x = chart.timeScale().timeToCoordinate(compressed as Time);
        y = series.priceToCoordinate(m.price);
      } catch {
        // Chart/series disposed mid-cycle (symbol switch) — skip this pass.
        return;
      }
      if (x === null || y === null) continue;
      next.push({ ...m, x, y });
    }
    setPositions(next);
  }, [chart, series, realTimeMap, markers]);

  // Recompute whenever the inputs change (trades load, symbol/data switch).
  useEffect(() => {
    recompute();
  }, [recompute]);

  // Reposition on pan/zoom + crosshair move.
  useEffect(() => {
    if (!chart) return;
    const ts = chart.timeScale();
    const handler = () => recompute();
    try {
      ts.subscribeVisibleLogicalRangeChange(handler);
      chart.subscribeCrosshairMove(handler);
    } catch {
      /* disposed */
    }
    return () => {
      try {
        ts.unsubscribeVisibleLogicalRangeChange(handler);
      } catch {
        /* ignore */
      }
      try {
        chart.unsubscribeCrosshairMove(handler);
      } catch {
        /* ignore */
      }
    };
  }, [chart, recompute]);

  // Reposition on container resize.
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => recompute());
    ro.observe(el);
    return () => ro.disconnect();
  }, [recompute]);

  return (
    <div
      ref={containerRef}
      className="absolute inset-0"
      style={{ pointerEvents: 'none', zIndex: 6, overflow: 'hidden' }}
    >
      {positions.map((p) => (
        <div
          key={p.key}
          style={{
            position: 'absolute',
            left: p.x,
            top: p.y,
            transform: 'translate(-50%, -50%)',
            pointerEvents: 'auto',
            cursor: 'default',
            lineHeight: 1,
          }}
          onMouseEnter={() => setHovered(p.key)}
          onMouseLeave={() => setHovered((h) => (h === p.key ? null : h))}
        >
          <span
            style={{
              color: p.color,
              fontSize: p.kind === 'exit' ? 11 : 14,
              textShadow: '0 0 3px rgba(0,0,0,0.9)',
              userSelect: 'none',
            }}
          >
            {p.glyph}
          </span>
          {hovered === p.key && (
            <div
              style={{
                position: 'absolute',
                left: '50%',
                bottom: 'calc(100% + 4px)',
                transform: 'translateX(-50%)',
                whiteSpace: 'nowrap',
                pointerEvents: 'none',
                background: 'rgba(15, 23, 42, 0.95)',
                color: '#e2e8f0',
                border: '1px solid rgba(148, 163, 184, 0.3)',
                borderRadius: 4,
                padding: '3px 6px',
                fontSize: 11,
                zIndex: 30,
                boxShadow: '0 2px 8px rgba(0,0,0,0.4)',
              }}
            >
              {p.tooltip}
            </div>
          )}
        </div>
      ))}
    </div>
  );
}
