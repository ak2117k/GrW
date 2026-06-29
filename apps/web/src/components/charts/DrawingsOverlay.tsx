import { useEffect, useRef, useState } from 'react';
import type { IChartApi, ISeriesApi, IPriceLine } from 'lightweight-charts';
import { useDrawingStore, selectDrawingsForToken } from '@/stores/drawing-store';
import {
  makeDrawing,
  type Drawing, type ToolKind, type TimePricePoint,
  DEFAULT_FIB_LEVELS,
} from '@/types/drawings';
import { useCoordinateConverter } from '@/hooks/useCoordinateConverter';
import { hitTestDrawing, type DrawingScreen } from './drawing-renderers/hitTest';
import {
  drawTrendLine, drawVerticalLine, drawRectangle, drawText, drawArrow, drawHandles,
} from './drawing-renderers/canvas';
import {
  buildHLine, buildHZone, buildFib,
  reconcileHLine, reconcileHZone, reconcileFib,
} from './drawing-renderers/priceLines';
import DrawingContextMenu from './DrawingContextMenu';
import TextDrawingInput from './TextDrawingInput';

const HIT_TOLERANCE = 4;

interface DrawingsOverlayProps {
  token: string;
  chart: IChartApi | null;
  series: ISeriesApi<'Candlestick'> | null;
  realTimeMap: Map<number, number>;
}

interface ContextMenuState { drawing: Drawing; x: number; y: number; }
interface TextInputState { x: number; y: number; anchor: TimePricePoint; }

export default function DrawingsOverlay({ token, chart, series, realTimeMap }: DrawingsOverlayProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const conv = useCoordinateConverter(chart, series, realTimeMap);

  const drawings = useDrawingStore(selectDrawingsForToken(token));
  const activeTool = useDrawingStore((s) => s.activeTool);
  const selectedId = useDrawingStore((s) => s.selectedId);
  const inFlight = useDrawingStore((s) => s.inFlight);
  const setActiveTool = useDrawingStore((s) => s.setActiveTool);
  const setSelected = useDrawingStore((s) => s.setSelected);
  const startInFlight = useDrawingStore((s) => s.startInFlight);
  const pushInFlightPoint = useDrawingStore((s) => s.pushInFlightPoint);
  const clearInFlight = useDrawingStore((s) => s.clearInFlight);
  const addDrawing = useDrawingStore((s) => s.addDrawing);
  const updateDrawing = useDrawingStore((s) => s.updateDrawing);
  const deleteDrawing = useDrawingStore((s) => s.deleteDrawing);

  const [mousePos, setMousePos] = useState<{ x: number; y: number } | null>(null);
  const [contextMenu, setContextMenu] = useState<ContextMenuState | null>(null);
  const [textInput, setTextInput] = useState<TextInputState | null>(null);
  const dragRef = useRef<{ id: string; handle: 'body' | 'p1' | 'p2' | 'upper' | 'lower'; startMouse: { x: number; y: number }; origin: Drawing } | null>(null);
  const priceLinesRef = useRef<Map<string, IPriceLine[]>>(new Map());

  function reconcilePriceLines() {
    if (!series) return;
    const existing = priceLinesRef.current;
    const wantedIds = new Set(drawings.filter((d) => d.kind === 'hline' || d.kind === 'hzone' || d.kind === 'fib').map((d) => d.id));

    for (const [id, lines] of existing) {
      if (!wantedIds.has(id)) {
        for (const l of lines) {
          try { series.removePriceLine(l); } catch { /* disposed */ }
        }
        existing.delete(id);
      }
    }

    for (const d of drawings) {
      if (d.kind !== 'hline' && d.kind !== 'hzone' && d.kind !== 'fib') continue;
      const lines = existing.get(d.id);
      if (!lines) {
        let built: IPriceLine[] = [];
        if (d.kind === 'hline') built = buildHLine(series, d);
        else if (d.kind === 'hzone') built = buildHZone(series, d);
        else built = buildFib(series, d);
        existing.set(d.id, built);
      } else {
        let ok = false;
        if (d.kind === 'hline') ok = reconcileHLine(lines, d);
        else if (d.kind === 'hzone') ok = reconcileHZone(lines, d);
        else ok = reconcileFib(lines, d);
        if (!ok) {
          for (const l of lines) try { series.removePriceLine(l); } catch { /* */ }
          let built: IPriceLine[] = [];
          if (d.kind === 'hline') built = buildHLine(series, d);
          else if (d.kind === 'hzone') built = buildHZone(series, d);
          else built = buildFib(series, d);
          existing.set(d.id, built);
        }
      }
    }
  }

  function toScreen(d: Drawing): DrawingScreen | null {
    if (!conv || !series) return null;
    switch (d.kind) {
      case 'hline': {
        const y = conv.priceToY(d.price);
        return y === null ? null : { kind: 'hline', id: d.id, y };
      }
      case 'hzone': {
        const yU = conv.priceToY(d.upper);
        const yL = conv.priceToY(d.lower);
        return yU === null || yL === null ? null : { kind: 'hzone', id: d.id, yUpper: yU, yLower: yL };
      }
      case 'trend':
      case 'arrow': {
        const x1 = conv.timeToX(d.p1.time); const y1 = conv.priceToY(d.p1.price);
        const x2 = conv.timeToX(d.p2.time); const y2 = conv.priceToY(d.p2.price);
        if (x1 === null || y1 === null || x2 === null || y2 === null) return null;
        return { kind: d.kind, id: d.id, p1: { x: x1, y: y1 }, p2: { x: x2, y: y2 } };
      }
      case 'vline': {
        const x = conv.timeToX(d.time);
        return x === null ? null : { kind: 'vline', id: d.id, x };
      }
      case 'rect': {
        const x1 = conv.timeToX(d.p1.time); const y1 = conv.priceToY(d.p1.price);
        const x2 = conv.timeToX(d.p2.time); const y2 = conv.priceToY(d.p2.price);
        if (x1 === null || y1 === null || x2 === null || y2 === null) return null;
        return { kind: 'rect', id: d.id, p1: { x: x1, y: y1 }, p2: { x: x2, y: y2 } };
      }
      case 'fib': {
        const span = d.p2.price - d.p1.price;
        const ys: number[] = [];
        for (const r of d.levels) {
          const y = conv.priceToY(d.p1.price + span * r);
          if (y !== null) ys.push(y);
        }
        return { kind: 'fib', id: d.id, levelYs: ys };
      }
      case 'text': {
        const x = conv.timeToX(d.anchor.time);
        const y = conv.priceToY(d.anchor.price);
        if (x === null || y === null) return null;
        return { kind: 'text', id: d.id, anchor: { x, y }, width: d.text.length * d.fontSize * 0.6, height: d.fontSize * 1.2 };
      }
    }
  }

  function render() {
    reconcilePriceLines();

    const canvas = canvasRef.current;
    const container = containerRef.current;
    if (!canvas || !container || !conv) return;

    const dpr = window.devicePixelRatio || 1;
    const w = container.clientWidth;
    const h = container.clientHeight;
    if (canvas.width !== w * dpr || canvas.height !== h * dpr) {
      canvas.width = w * dpr;
      canvas.height = h * dpr;
      canvas.style.width = `${w}px`;
      canvas.style.height = `${h}px`;
    }
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);

    const handlePointsByDrawingId = new Map<string, { x: number; y: number }[]>();
    for (const d of drawings) {
      switch (d.kind) {
        case 'trend': {
          const r = drawTrendLine(ctx, d, conv);
          if (r) handlePointsByDrawingId.set(d.id, [r.p1, r.p2]);
          break;
        }
        case 'vline': {
          const r = drawVerticalLine(ctx, d, conv, h);
          if (r) handlePointsByDrawingId.set(d.id, [{ x: r.x, y: 10 }]);
          break;
        }
        case 'rect': {
          const r = drawRectangle(ctx, d, conv);
          if (r) handlePointsByDrawingId.set(d.id, [r.p1, r.p2, { x: r.p1.x, y: r.p2.y }, { x: r.p2.x, y: r.p1.y }]);
          break;
        }
        case 'text': {
          const r = drawText(ctx, d, conv);
          if (r) handlePointsByDrawingId.set(d.id, [r.anchor]);
          break;
        }
        case 'arrow': {
          const r = drawArrow(ctx, d, conv);
          if (r) handlePointsByDrawingId.set(d.id, [r.p1, r.p2]);
          break;
        }
        case 'hline': case 'hzone': case 'fib':
          if (d.id === selectedId) {
            if (d.kind === 'hline') {
              const y = conv.priceToY(d.price);
              if (y !== null) handlePointsByDrawingId.set(d.id, [{ x: w - 10, y }]);
            } else if (d.kind === 'hzone') {
              const yU = conv.priceToY(d.upper); const yL = conv.priceToY(d.lower);
              if (yU !== null && yL !== null) handlePointsByDrawingId.set(d.id, [{ x: w - 10, y: yU }, { x: w - 10, y: yL }]);
            } else if (d.kind === 'fib') {
              const x1 = conv.timeToX(d.p1.time); const y1 = conv.priceToY(d.p1.price);
              const x2 = conv.timeToX(d.p2.time); const y2 = conv.priceToY(d.p2.price);
              if (x1 !== null && y1 !== null && x2 !== null && y2 !== null) handlePointsByDrawingId.set(d.id, [{ x: x1, y: y1 }, { x: x2, y: y2 }]);
            }
          }
          break;
      }
    }

    if (selectedId) {
      const pts = handlePointsByDrawingId.get(selectedId);
      if (pts) drawHandles(ctx, pts);
    }

    if (inFlight && mousePos && inFlight.points.length > 0) {
      const first = inFlight.points[0];
      const x1 = conv.timeToX(first.time);
      const y1 = conv.priceToY(first.price);
      if (x1 !== null && y1 !== null) {
        ctx.strokeStyle = '#06b6d4';
        ctx.setLineDash([4, 4]);
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(x1, y1);
        ctx.lineTo(mousePos.x, mousePos.y);
        ctx.stroke();
        ctx.setLineDash([]);
      }
    }
  }

  useEffect(() => {
    if (!chart) return;
    const ts = chart.timeScale();
    const onRange = () => render();
    ts.subscribeVisibleLogicalRangeChange(onRange);
    return () => ts.unsubscribeVisibleLogicalRangeChange(onRange);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chart]);

  useEffect(() => {
    if (!containerRef.current) return;
    const ro = new ResizeObserver(() => render());
    ro.observe(containerRef.current);
    return () => ro.disconnect();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => { render(); });

  useEffect(() => {
    return () => {
      if (!series) return;
      for (const [, lines] of priceLinesRef.current) {
        for (const l of lines) try { series.removePriceLine(l); } catch { /* */ }
      }
      priceLinesRef.current.clear();
    };
  }, [token, series]);

  // Forward a mouse event to the chart canvas underneath. Used when the
  // overlay captured a click on empty space — we deselect and let the
  // chart respond normally (panning, crosshair pickup, etc.). Without
  // this, having any drawing on the chart would freeze pan/zoom.
  function forwardEventToChartCanvas(
    clientX: number,
    clientY: number,
    type: 'mousedown' | 'mouseup',
  ) {
    const overlay = canvasRef.current;
    if (!overlay) return;
    // Temporarily turn off our pointer-events so elementFromPoint sees
    // the canvas underneath instead of ourselves.
    const savedPE = overlay.style.pointerEvents;
    overlay.style.pointerEvents = 'none';
    const below = document.elementFromPoint(clientX, clientY);
    overlay.style.pointerEvents = savedPE;
    if (below && below.tagName === 'CANVAS' && below !== overlay) {
      below.dispatchEvent(
        new MouseEvent(type, {
          clientX,
          clientY,
          button: 0,
          buttons: type === 'mousedown' ? 1 : 0,
          bubbles: true,
          cancelable: true,
        }),
      );
    }
  }

  function handleMouseDown(e: React.MouseEvent) {
    if (!conv || !canvasRef.current) return;
    const rect = canvasRef.current.getBoundingClientRect();
    const mx = e.clientX - rect.left;
    const my = e.clientY - rect.top;

    if (e.button === 2) {
      const hit = findHit(mx, my);
      if (hit) {
        setContextMenu({ drawing: hit, x: e.clientX, y: e.clientY });
        setSelected(hit.id);
        e.preventDefault();
      }
      return;
    }

    if (activeTool) {
      const time = conv.xToTime(mx);
      const price = conv.yToPrice(my);
      if (time === null || price === null) return;
      handleDrawClick(activeTool, { time, price });
      return;
    }

    const hit = findHit(mx, my);
    if (hit) {
      setSelected(hit.id);
      dragRef.current = { id: hit.id, handle: 'body', startMouse: { x: mx, y: my }, origin: hit };
    } else {
      // Empty click in cursor mode: deselect AND forward to chart so the
      // user can still pan/zoom on a chart that has drawings on it.
      setSelected(null);
      forwardEventToChartCanvas(e.clientX, e.clientY, 'mousedown');
    }
  }

  function handleMouseMove(e: React.MouseEvent) {
    const rect = canvasRef.current?.getBoundingClientRect();
    if (!rect) return;
    const mx = e.clientX - rect.left;
    const my = e.clientY - rect.top;
    setMousePos({ x: mx, y: my });

    if (!dragRef.current || !conv) return;
    const drag = dragRef.current;
    const origin = drag.origin;

    const t0 = conv.xToTime(drag.startMouse.x);
    const t1 = conv.xToTime(mx);
    const p0 = conv.yToPrice(drag.startMouse.y);
    const p1 = conv.yToPrice(my);
    if (t0 === null || t1 === null || p0 === null || p1 === null) return;
    const dt = t1 - t0;
    const dp = p1 - p0;

    if (drag.handle === 'body') {
      switch (origin.kind) {
        case 'hline':
          updateDrawing(token, origin.id, { price: origin.price + dp });
          break;
        case 'hzone':
          updateDrawing(token, origin.id, { upper: origin.upper + dp, lower: origin.lower + dp });
          break;
        case 'vline':
          updateDrawing(token, origin.id, { time: origin.time + dt });
          break;
        case 'trend':
        case 'arrow':
          updateDrawing(token, origin.id, {
            p1: { time: origin.p1.time + dt, price: origin.p1.price + dp },
            p2: { time: origin.p2.time + dt, price: origin.p2.price + dp },
          });
          break;
        case 'rect':
        case 'fib':
          updateDrawing(token, origin.id, {
            p1: { time: origin.p1.time + dt, price: origin.p1.price + dp },
            p2: { time: origin.p2.time + dt, price: origin.p2.price + dp },
          });
          break;
        case 'text':
          updateDrawing(token, origin.id, {
            anchor: { time: origin.anchor.time + dt, price: origin.anchor.price + dp },
          });
          break;
      }
    }
  }

  function handleMouseUp(e: React.MouseEvent) {
    const wasDragging = dragRef.current !== null;
    dragRef.current = null;
    if (!wasDragging) {
      // If the mousedown was forwarded to the chart, the chart's pan
      // gesture needs a matching mouseup to end cleanly.
      forwardEventToChartCanvas(e.clientX, e.clientY, 'mouseup');
    }
  }

  function handleDrawClick(kind: ToolKind, point: TimePricePoint) {
    if (kind === 'hline') {
      addDrawing(token, makeDrawing('hline', { price: point.price }));
      setActiveTool(null);
      return;
    }
    if (kind === 'vline') {
      addDrawing(token, makeDrawing('vline', { time: point.time }));
      setActiveTool(null);
      return;
    }
    if (kind === 'text') {
      const x = conv?.timeToX(point.time) ?? 0;
      const y = conv?.priceToY(point.price) ?? 0;
      setTextInput({ x, y, anchor: point });
      return;
    }
    if (!inFlight) {
      startInFlight(kind);
      pushInFlightPoint(point);
      return;
    }
    pushInFlightPoint(point);
    const all = [...inFlight.points, point];
    switch (kind) {
      case 'hzone':
        addDrawing(token, makeDrawing('hzone', { upper: Math.max(all[0].price, all[1].price), lower: Math.min(all[0].price, all[1].price), fillOpacity: 0.15 }));
        clearInFlight(); setActiveTool(null);
        break;
      case 'trend':
        addDrawing(token, makeDrawing('trend', { p1: all[0], p2: all[1] }));
        clearInFlight(); setActiveTool(null);
        break;
      case 'rect':
        addDrawing(token, makeDrawing('rect', { p1: all[0], p2: all[1], fillOpacity: 0.15 }));
        clearInFlight(); setActiveTool(null);
        break;
      case 'fib':
        addDrawing(token, makeDrawing('fib', { p1: all[0], p2: all[1], levels: DEFAULT_FIB_LEVELS }));
        clearInFlight(); setActiveTool(null);
        break;
      case 'arrow':
        addDrawing(token, makeDrawing('arrow', { p1: all[0], p2: all[1] }));
        clearInFlight(); setActiveTool(null);
        break;
    }
  }

  function findHit(mx: number, my: number): Drawing | null {
    for (let i = drawings.length - 1; i >= 0; i--) {
      const d = drawings[i];
      const screen = toScreen(d);
      if (!screen) continue;
      if (hitTestDrawing(screen, { x: mx, y: my }, HIT_TOLERANCE)) return d;
    }
    return null;
  }

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') {
        setActiveTool(null);
        clearInFlight();
        setSelected(null);
        return;
      }
      if ((e.key === 'Delete' || e.key === 'Backspace') && selectedId) {
        e.preventDefault();
        deleteDrawing(token, selectedId);
      }
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [selectedId, token, setActiveTool, clearInFlight, setSelected, deleteDrawing]);

  // Capture pointer events whenever we MIGHT need to react: a tool is armed
  // (to place new drawings), something is selected (to drag-edit), an
  // in-flight multi-click draw is collecting points, OR any drawings exist
  // for this token (so they can be hit-tested for selection). When no
  // drawings exist and nothing is going on, the overlay stays fully
  // transparent so the chart's own pan/zoom/crosshair work unimpeded.
  const captureEvents =
    activeTool !== null ||
    selectedId !== null ||
    inFlight !== null ||
    drawings.length > 0;

  return (
    <div
      ref={containerRef}
      className="absolute inset-0"
      style={{ pointerEvents: 'none', zIndex: 5 }}
    >
      <canvas
        ref={canvasRef}
        onMouseDown={handleMouseDown}
        onMouseMove={handleMouseMove}
        onMouseUp={handleMouseUp}
        onContextMenu={(e) => e.preventDefault()}
        style={{
          width: '100%', height: '100%',
          pointerEvents: captureEvents ? 'auto' : 'none',
          cursor: activeTool ? 'crosshair' : 'default',
        }}
      />
      {contextMenu && (
        <DrawingContextMenu
          token={token}
          drawing={contextMenu.drawing}
          x={contextMenu.x}
          y={contextMenu.y}
          onClose={() => setContextMenu(null)}
        />
      )}
      {textInput && (
        <TextDrawingInput
          x={textInput.x}
          y={textInput.y}
          onCommit={(text) => {
            addDrawing(token, makeDrawing('text', { anchor: textInput.anchor, text, fontSize: 12 }));
            setActiveTool(null);
            setTextInput(null);
          }}
          onCancel={() => { setTextInput(null); setActiveTool(null); }}
        />
      )}
    </div>
  );
}
