// Discriminated union for all user-drawn chart annotations. Every renderer
// switches on `kind` — TypeScript exhaustiveness will catch missing cases.
//
// INVARIANT: every `time` field is REAL unix seconds, never the chart's
// compressed time. Conversion happens at the rendering boundary via
// useCoordinateConverter.

export type ToolKind =
  | 'hline' | 'hzone' | 'trend' | 'vline'
  | 'rect' | 'fib' | 'text' | 'arrow';

export type LineStyle = 'solid' | 'dashed' | 'dotted';
export type LineWidth = 1 | 2 | 3;
export type FontSize = 10 | 12 | 14 | 16;

export interface TimePricePoint {
  time: number;   // real unix seconds
  price: number;
}

interface BaseDrawing {
  id: string;
  createdAt: number;
  color: string;
  lineWidth: LineWidth;
  lineStyle: LineStyle;
  locked?: boolean;
}

export interface HorizontalLineDrawing extends BaseDrawing {
  kind: 'hline';
  price: number;
  label?: string;
}

export interface HorizontalZoneDrawing extends BaseDrawing {
  kind: 'hzone';
  upper: number;
  lower: number;
  fillOpacity: number;
  label?: string;
}

export interface TrendLineDrawing extends BaseDrawing {
  kind: 'trend';
  p1: TimePricePoint;
  p2: TimePricePoint;
  extendLeft?: boolean;
  extendRight?: boolean;
}

export interface VerticalLineDrawing extends BaseDrawing {
  kind: 'vline';
  time: number;   // real unix seconds
  label?: string;
}

export interface RectangleDrawing extends BaseDrawing {
  kind: 'rect';
  p1: TimePricePoint;
  p2: TimePricePoint;
  fillOpacity: number;
}

export interface FibDrawing extends BaseDrawing {
  kind: 'fib';
  p1: TimePricePoint;
  p2: TimePricePoint;
  levels: number[];
}

export interface TextDrawing extends BaseDrawing {
  kind: 'text';
  anchor: TimePricePoint;
  text: string;
  fontSize: FontSize;
}

export interface ArrowDrawing extends BaseDrawing {
  kind: 'arrow';
  p1: TimePricePoint;
  p2: TimePricePoint;
}

export type Drawing =
  | HorizontalLineDrawing | HorizontalZoneDrawing | TrendLineDrawing
  | VerticalLineDrawing | RectangleDrawing | FibDrawing
  | TextDrawing | ArrowDrawing;

export const DEFAULT_FIB_LEVELS = [0, 0.236, 0.382, 0.5, 0.618, 0.786, 1];

export const DEFAULT_COLORS: Record<ToolKind, string> = {
  hline: '#06b6d4',
  hzone: '#06b6d4',
  trend: '#eab308',
  vline: '#94a3b8',
  rect: '#06b6d4',
  fib: '#06b6d4',
  text: '#ffffff',
  arrow: '#eab308',
};

export const FIB_LEVEL_COLORS: Record<string, string> = {
  '0': '#ffffff',
  '0.236': '#ef4444',
  '0.382': '#f97316',
  '0.5': '#eab308',
  '0.618': '#22c55e',
  '0.786': '#3b82f6',
  '1': '#ffffff',
};

export function makeDrawing<K extends ToolKind>(
  kind: K,
  fields: Omit<Extract<Drawing, { kind: K }>, 'id' | 'createdAt' | 'color' | 'lineWidth' | 'lineStyle' | 'kind'>,
): Extract<Drawing, { kind: K }> {
  return {
    id: crypto.randomUUID(),
    createdAt: Date.now(),
    color: DEFAULT_COLORS[kind],
    lineWidth: 1,
    lineStyle: 'solid',
    kind,
    ...fields,
  } as Extract<Drawing, { kind: K }>;
}
