import type {
  Drawing, TrendLineDrawing, VerticalLineDrawing,
  RectangleDrawing, TextDrawing, ArrowDrawing,
} from '@/types/drawings';
import type { CoordinateConverter } from '@/hooks/useCoordinateConverter';

const ARROW_HEAD_PX = 10;
const ARROW_ANGLE = Math.PI / 7;

function applyStroke(ctx: CanvasRenderingContext2D, d: Drawing): void {
  ctx.strokeStyle = d.color;
  ctx.lineWidth = d.lineWidth;
  switch (d.lineStyle) {
    case 'dashed': ctx.setLineDash([8, 4]); break;
    case 'dotted': ctx.setLineDash([2, 4]); break;
    default: ctx.setLineDash([]); break;
  }
}

export function drawTrendLine(
  ctx: CanvasRenderingContext2D,
  d: TrendLineDrawing,
  conv: CoordinateConverter,
): { p1: { x: number; y: number }; p2: { x: number; y: number } } | null {
  const x1 = conv.timeToX(d.p1.time);
  const y1 = conv.priceToY(d.p1.price);
  const x2 = conv.timeToX(d.p2.time);
  const y2 = conv.priceToY(d.p2.price);
  if (x1 === null || y1 === null || x2 === null || y2 === null) return null;

  applyStroke(ctx, d);
  ctx.beginPath();
  ctx.moveTo(x1, y1);
  ctx.lineTo(x2, y2);
  ctx.stroke();
  ctx.setLineDash([]);
  return { p1: { x: x1, y: y1 }, p2: { x: x2, y: y2 } };
}

export function drawVerticalLine(
  ctx: CanvasRenderingContext2D,
  d: VerticalLineDrawing,
  conv: CoordinateConverter,
  height: number,
): { x: number } | null {
  const x = conv.timeToX(d.time);
  if (x === null) return null;

  applyStroke(ctx, d);
  ctx.beginPath();
  ctx.moveTo(x, 0);
  ctx.lineTo(x, height);
  ctx.stroke();
  ctx.setLineDash([]);
  return { x };
}

export function drawRectangle(
  ctx: CanvasRenderingContext2D,
  d: RectangleDrawing,
  conv: CoordinateConverter,
): { p1: { x: number; y: number }; p2: { x: number; y: number } } | null {
  const x1 = conv.timeToX(d.p1.time);
  const y1 = conv.priceToY(d.p1.price);
  const x2 = conv.timeToX(d.p2.time);
  const y2 = conv.priceToY(d.p2.price);
  if (x1 === null || y1 === null || x2 === null || y2 === null) return null;

  const left = Math.min(x1, x2);
  const top = Math.min(y1, y2);
  const w = Math.abs(x2 - x1);
  const h = Math.abs(y2 - y1);

  applyStroke(ctx, d);
  ctx.fillStyle = d.color + Math.round(d.fillOpacity * 255).toString(16).padStart(2, '0');
  ctx.fillRect(left, top, w, h);
  ctx.strokeRect(left, top, w, h);
  ctx.setLineDash([]);
  return { p1: { x: x1, y: y1 }, p2: { x: x2, y: y2 } };
}

export function drawText(
  ctx: CanvasRenderingContext2D,
  d: TextDrawing,
  conv: CoordinateConverter,
): { anchor: { x: number; y: number }; width: number; height: number } | null {
  const x = conv.timeToX(d.anchor.time);
  const y = conv.priceToY(d.anchor.price);
  if (x === null || y === null) return null;

  ctx.fillStyle = d.color;
  ctx.font = `${d.fontSize}px -apple-system, system-ui, sans-serif`;
  ctx.textBaseline = 'top';
  const metrics = ctx.measureText(d.text);
  ctx.fillText(d.text, x, y);
  return {
    anchor: { x, y },
    width: metrics.width,
    height: d.fontSize * 1.2,
  };
}

export function drawArrow(
  ctx: CanvasRenderingContext2D,
  d: ArrowDrawing,
  conv: CoordinateConverter,
): { p1: { x: number; y: number }; p2: { x: number; y: number } } | null {
  const x1 = conv.timeToX(d.p1.time);
  const y1 = conv.priceToY(d.p1.price);
  const x2 = conv.timeToX(d.p2.time);
  const y2 = conv.priceToY(d.p2.price);
  if (x1 === null || y1 === null || x2 === null || y2 === null) return null;

  applyStroke(ctx, d);

  ctx.beginPath();
  ctx.moveTo(x1, y1);
  ctx.lineTo(x2, y2);
  ctx.stroke();

  const angle = Math.atan2(y2 - y1, x2 - x1);
  ctx.fillStyle = d.color;
  ctx.beginPath();
  ctx.moveTo(x2, y2);
  ctx.lineTo(
    x2 - ARROW_HEAD_PX * Math.cos(angle - ARROW_ANGLE),
    y2 - ARROW_HEAD_PX * Math.sin(angle - ARROW_ANGLE),
  );
  ctx.lineTo(
    x2 - ARROW_HEAD_PX * Math.cos(angle + ARROW_ANGLE),
    y2 - ARROW_HEAD_PX * Math.sin(angle + ARROW_ANGLE),
  );
  ctx.closePath();
  ctx.fill();
  ctx.setLineDash([]);

  return { p1: { x: x1, y: y1 }, p2: { x: x2, y: y2 } };
}

export function drawHandles(
  ctx: CanvasRenderingContext2D,
  points: { x: number; y: number }[],
  color = '#06b6d4',
): void {
  ctx.fillStyle = '#ffffff';
  ctx.strokeStyle = color;
  ctx.lineWidth = 2;
  for (const p of points) {
    ctx.beginPath();
    ctx.arc(p.x, p.y, 5, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
  }
}
