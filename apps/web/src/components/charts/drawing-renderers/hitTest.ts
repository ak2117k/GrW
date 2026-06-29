// Pure geometric hit-testing per drawing kind. All inputs are screen-space
// pixels (no chart-time, no price). Renderers convert to this shape before
// calling. Tolerance is in CSS pixels (caller adjusts for DPR if needed).

export interface ScreenPoint {
  x: number;
  y: number;
}

export type DrawingScreen =
  | { kind: 'hline'; id: string; y: number }
  | { kind: 'hzone'; id: string; yUpper: number; yLower: number }
  | { kind: 'trend'; id: string; p1: ScreenPoint; p2: ScreenPoint }
  | { kind: 'vline'; id: string; x: number }
  | { kind: 'rect'; id: string; p1: ScreenPoint; p2: ScreenPoint }
  | { kind: 'fib'; id: string; levelYs: number[] }
  | { kind: 'text'; id: string; anchor: ScreenPoint; width: number; height: number }
  | { kind: 'arrow'; id: string; p1: ScreenPoint; p2: ScreenPoint };

function distancePointToSegment(p: ScreenPoint, a: ScreenPoint, b: ScreenPoint): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const lenSq = dx * dx + dy * dy;
  if (lenSq === 0) {
    const ex = p.x - a.x;
    const ey = p.y - a.y;
    return Math.hypot(ex, ey);
  }
  const t = ((p.x - a.x) * dx + (p.y - a.y) * dy) / lenSq;
  if (t < 0 || t > 1) return Infinity;
  const projX = a.x + t * dx;
  const projY = a.y + t * dy;
  return Math.hypot(p.x - projX, p.y - projY);
}

export function hitTestDrawing(
  d: DrawingScreen,
  mouse: ScreenPoint,
  tolerance: number,
): boolean {
  switch (d.kind) {
    case 'hline':
      return Math.abs(mouse.y - d.y) <= tolerance;

    case 'hzone': {
      const top = Math.min(d.yUpper, d.yLower);
      const bottom = Math.max(d.yUpper, d.yLower);
      return mouse.y >= top - tolerance && mouse.y <= bottom + tolerance;
    }

    case 'trend':
    case 'arrow':
      return distancePointToSegment(mouse, d.p1, d.p2) <= tolerance;

    case 'vline':
      return Math.abs(mouse.x - d.x) <= tolerance;

    case 'rect': {
      const left = Math.min(d.p1.x, d.p2.x);
      const right = Math.max(d.p1.x, d.p2.x);
      const top = Math.min(d.p1.y, d.p2.y);
      const bottom = Math.max(d.p1.y, d.p2.y);
      return (
        mouse.x >= left - tolerance &&
        mouse.x <= right + tolerance &&
        mouse.y >= top - tolerance &&
        mouse.y <= bottom + tolerance
      );
    }

    case 'fib':
      return d.levelYs.some((y) => Math.abs(mouse.y - y) <= tolerance);

    case 'text':
      return (
        mouse.x >= d.anchor.x - tolerance &&
        mouse.x <= d.anchor.x + d.width + tolerance &&
        mouse.y >= d.anchor.y - tolerance &&
        mouse.y <= d.anchor.y + d.height + tolerance
      );
  }
}
