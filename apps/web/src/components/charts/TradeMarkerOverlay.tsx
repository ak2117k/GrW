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
 * Annotates paper positions on the app's own chart: an entry marker (▲) at the
 * fill, a ◐ at an intraday partial book and a ● at the exit, hover-revealing the
 * status, % result and signal source. An open position shows just the entry.
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
  const { positions: trades } = useChartTrades(token);
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
        <div key={p.key}>
          {/* Dashed vertical guide at the entry/exit TIME — spans the pane so the
              marker is findable instead of lost among candles at the same price. */}
          <div
            style={{
              position: 'absolute',
              left: p.x,
              top: 0,
              bottom: 0,
              width: 0,
              borderLeft: `1px dashed ${p.color}`,
              opacity: 0.4,
              pointerEvents: 'none',
            }}
          />
          {/* Badged glyph at the PRICE — a dark pill with a coloured border reads
              clearly over red/green candles where a bare glyph disappeared. */}
          <div
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
                display: 'inline-flex',
                alignItems: 'center',
                justifyContent: 'center',
                minWidth: p.kind === 'entry' ? 20 : 16,
                height: p.kind === 'entry' ? 20 : 16,
                padding: '0 3px',
                background: 'rgba(15,23,42,0.92)',
                border: `1.5px solid ${p.color}`,
                borderRadius: 4,
                color: p.color,
                fontSize: p.kind === 'entry' ? 12 : 10,
                fontWeight: 700,
                boxShadow: '0 0 5px rgba(0,0,0,0.7)',
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
              <div>{p.tooltip}</div>
              {p.detail && (
                <div style={{ color: '#94a3b8', marginTop: 2 }}>{p.detail}</div>
              )}
            </div>
          )}
          </div>
        </div>
      ))}
    </div>
  );
}
