# Chart Drawing Tools Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add 8 user-drawn annotation tools (horizontal line, horizontal zone, trend line, vertical line, rectangle, Fibonacci retracement, text, arrow) to the candlestick chart on ChartsPage, with full select/move/resize/delete editing, color/style customization, and localStorage persistence per symbol.

**Architecture:** Two-layer rendering — `series.createPriceLine` for horizontal-only tools (gets axis labels free), custom canvas overlay above the chart for everything time-based plus all selection handles. Zustand store as single source of truth. Coordinate conversion isolated in one hook that reads `realTimeMap` from `useChartData`. Spec: `docs/superpowers/specs/2026-05-11-chart-drawing-tools-design.md`.

**Tech Stack:** React 19, TypeScript, Zustand 5, lightweight-charts 4.2.0, Vitest + Testing Library, Tailwind 4, lucide-react icons.

---

## Pre-flight

- [ ] **Step 0.1: Verify dev server state**

The dev server is running as background task `b2w274i1s`. Vite HMR should pick up new files automatically. If at any point HMR breaks, restart with `npm run dev:web` from the repo root.

- [ ] **Step 0.2: Verify test runner works**

Run: `cd apps/web && npx vitest run --reporter=verbose --bail=1 src/utils 2>&1 | tail -20`
Expected: tests run (any count, even zero) without infrastructure errors. If errors mention missing config, see `apps/web/vite.config.ts` for test setup.

---

## Task 1: Drawing types (discriminated union)

**Files:**
- Create: `apps/web/src/types/drawings.ts`

- [ ] **Step 1.1: Write the type module**

Create `apps/web/src/types/drawings.ts`:

```typescript
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
  hline: '#06b6d4',   // cyan
  hzone: '#06b6d4',
  trend: '#eab308',   // yellow
  vline: '#94a3b8',   // slate
  rect: '#06b6d4',
  fib: '#06b6d4',     // base; per-level colors handled in renderer
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

// Factory for new drawings — assigns id, createdAt, default styling.
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
```

- [ ] **Step 1.2: Verify it compiles**

Run: `cd apps/web && npx tsc --noEmit src/types/drawings.ts`
Expected: no output (success).

- [ ] **Step 1.3: Commit**

```bash
git add apps/web/src/types/drawings.ts
git commit -m "feat(charts): drawing-tool discriminated-union types"
```

---

## Task 2: Hit-test geometry (pure functions, TDD)

**Files:**
- Create: `apps/web/src/components/charts/drawing-renderers/hitTest.ts`
- Test: `apps/web/src/components/charts/drawing-renderers/hitTest.spec.ts`

- [ ] **Step 2.1: Write the failing tests**

Create `apps/web/src/components/charts/drawing-renderers/hitTest.spec.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { hitTestDrawing, type ScreenPoint, type DrawingScreen } from './hitTest';

const TOLERANCE = 4;

describe('hitTest', () => {
  describe('hline', () => {
    const drawing: DrawingScreen = { kind: 'hline', id: 'a', y: 100 };

    it('hits within tolerance', () => {
      expect(hitTestDrawing(drawing, { x: 50, y: 102 }, TOLERANCE)).toBe(true);
      expect(hitTestDrawing(drawing, { x: 50, y: 100 }, TOLERANCE)).toBe(true);
    });

    it('misses outside tolerance', () => {
      expect(hitTestDrawing(drawing, { x: 50, y: 105 }, TOLERANCE)).toBe(false);
    });
  });

  describe('hzone', () => {
    const drawing: DrawingScreen = { kind: 'hzone', id: 'a', yUpper: 100, yLower: 200 };

    it('hits inside the band', () => {
      expect(hitTestDrawing(drawing, { x: 50, y: 150 }, TOLERANCE)).toBe(true);
    });

    it('hits on the edges within tolerance', () => {
      expect(hitTestDrawing(drawing, { x: 50, y: 98 }, TOLERANCE)).toBe(true);
      expect(hitTestDrawing(drawing, { x: 50, y: 202 }, TOLERANCE)).toBe(true);
    });

    it('misses outside the band beyond tolerance', () => {
      expect(hitTestDrawing(drawing, { x: 50, y: 95 }, TOLERANCE)).toBe(false);
      expect(hitTestDrawing(drawing, { x: 50, y: 205 }, TOLERANCE)).toBe(false);
    });
  });

  describe('trend', () => {
    const drawing: DrawingScreen = {
      kind: 'trend', id: 'a',
      p1: { x: 0, y: 0 },
      p2: { x: 100, y: 100 },
    };

    it('hits on the line', () => {
      expect(hitTestDrawing(drawing, { x: 50, y: 50 }, TOLERANCE)).toBe(true);
    });

    it('misses perpendicular distance beyond tolerance', () => {
      // perpendicular distance from (50, 56) to y=x line is 6/sqrt(2) ≈ 4.24
      expect(hitTestDrawing(drawing, { x: 50, y: 56 }, TOLERANCE)).toBe(false);
    });

    it('hits perpendicular distance within tolerance', () => {
      // (50, 53) → perp dist = 3/sqrt(2) ≈ 2.12
      expect(hitTestDrawing(drawing, { x: 50, y: 53 }, TOLERANCE)).toBe(true);
    });

    it('does not hit beyond the segment endpoints', () => {
      expect(hitTestDrawing(drawing, { x: -10, y: -10 }, TOLERANCE)).toBe(false);
      expect(hitTestDrawing(drawing, { x: 110, y: 110 }, TOLERANCE)).toBe(false);
    });

    it('handles zero-length segment as a point', () => {
      const zero: DrawingScreen = {
        kind: 'trend', id: 'b',
        p1: { x: 50, y: 50 }, p2: { x: 50, y: 50 },
      };
      expect(hitTestDrawing(zero, { x: 52, y: 51 }, TOLERANCE)).toBe(true);
      expect(hitTestDrawing(zero, { x: 60, y: 60 }, TOLERANCE)).toBe(false);
    });
  });

  describe('vline', () => {
    const drawing: DrawingScreen = { kind: 'vline', id: 'a', x: 100 };

    it('hits within tolerance', () => {
      expect(hitTestDrawing(drawing, { x: 102, y: 50 }, TOLERANCE)).toBe(true);
    });

    it('misses outside tolerance', () => {
      expect(hitTestDrawing(drawing, { x: 105, y: 50 }, TOLERANCE)).toBe(false);
    });
  });

  describe('rect', () => {
    const drawing: DrawingScreen = {
      kind: 'rect', id: 'a',
      p1: { x: 10, y: 10 }, p2: { x: 100, y: 200 },
    };

    it('hits inside', () => {
      expect(hitTestDrawing(drawing, { x: 50, y: 100 }, TOLERANCE)).toBe(true);
    });

    it('hits on edges within tolerance', () => {
      expect(hitTestDrawing(drawing, { x: 8, y: 100 }, TOLERANCE)).toBe(true);
    });

    it('misses outside beyond tolerance', () => {
      expect(hitTestDrawing(drawing, { x: 5, y: 100 }, TOLERANCE)).toBe(false);
      expect(hitTestDrawing(drawing, { x: 200, y: 100 }, TOLERANCE)).toBe(false);
    });

    it('handles rectangle drawn right-to-left (negative width)', () => {
      const reversed: DrawingScreen = {
        kind: 'rect', id: 'b',
        p1: { x: 100, y: 10 }, p2: { x: 10, y: 200 },
      };
      expect(hitTestDrawing(reversed, { x: 50, y: 100 }, TOLERANCE)).toBe(true);
    });
  });

  describe('fib', () => {
    const drawing: DrawingScreen = {
      kind: 'fib', id: 'a',
      levelYs: [100, 120, 140, 160, 180, 195, 200],
    };

    it('hits on any level line within tolerance', () => {
      expect(hitTestDrawing(drawing, { x: 50, y: 102 }, TOLERANCE)).toBe(true);
      expect(hitTestDrawing(drawing, { x: 50, y: 161 }, TOLERANCE)).toBe(true);
    });

    it('misses between levels', () => {
      expect(hitTestDrawing(drawing, { x: 50, y: 110 }, TOLERANCE)).toBe(false);
    });
  });

  describe('text', () => {
    const drawing: DrawingScreen = {
      kind: 'text', id: 'a',
      anchor: { x: 50, y: 100 },
      width: 80, height: 16,
    };

    it('hits inside the text box', () => {
      expect(hitTestDrawing(drawing, { x: 80, y: 108 }, TOLERANCE)).toBe(true);
    });

    it('misses outside the text box', () => {
      expect(hitTestDrawing(drawing, { x: 200, y: 100 }, TOLERANCE)).toBe(false);
    });
  });

  describe('arrow', () => {
    // arrow hit-test is identical to trend (line + endpoints)
    const drawing: DrawingScreen = {
      kind: 'arrow', id: 'a',
      p1: { x: 0, y: 0 }, p2: { x: 100, y: 0 },
    };

    it('hits on the shaft', () => {
      expect(hitTestDrawing(drawing, { x: 50, y: 2 }, TOLERANCE)).toBe(true);
    });

    it('misses off the shaft', () => {
      expect(hitTestDrawing(drawing, { x: 50, y: 10 }, TOLERANCE)).toBe(false);
    });
  });
});
```

- [ ] **Step 2.2: Run tests to verify they fail**

Run: `cd apps/web && npx vitest run src/components/charts/drawing-renderers/hitTest.spec.ts 2>&1 | tail -30`
Expected: FAIL with "Cannot find module './hitTest'".

- [ ] **Step 2.3: Implement hitTest**

Create `apps/web/src/components/charts/drawing-renderers/hitTest.ts`:

```typescript
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

// Point-to-segment distance. Returns Infinity when point projects outside
// the segment (so callers can decide whether to honour the endpoint
// behaviour vs. infinite-line behaviour).
function distancePointToSegment(p: ScreenPoint, a: ScreenPoint, b: ScreenPoint): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const lenSq = dx * dx + dy * dy;
  if (lenSq === 0) {
    // Degenerate: treat as point-to-point distance.
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
```

- [ ] **Step 2.4: Run tests to verify they pass**

Run: `cd apps/web && npx vitest run src/components/charts/drawing-renderers/hitTest.spec.ts 2>&1 | tail -15`
Expected: All tests pass.

- [ ] **Step 2.5: Commit**

```bash
git add apps/web/src/components/charts/drawing-renderers/hitTest.ts apps/web/src/components/charts/drawing-renderers/hitTest.spec.ts
git commit -m "feat(charts): hit-test geometry for drawing tools"
```

---

## Task 3: Drawing store (Zustand)

**Files:**
- Create: `apps/web/src/stores/drawing-store.ts`
- Test: `apps/web/src/stores/drawing-store.spec.ts`

- [ ] **Step 3.1: Write the failing tests**

Create `apps/web/src/stores/drawing-store.spec.ts`:

```typescript
import { beforeEach, describe, expect, it } from 'vitest';
import { useDrawingStore } from './drawing-store';
import { makeDrawing } from '@/types/drawings';

beforeEach(() => {
  useDrawingStore.setState({
    drawings: {},
    selectedId: null,
    activeTool: null,
    inFlight: null,
  });
});

describe('drawing-store', () => {
  it('adds a drawing for a token', () => {
    const d = makeDrawing('hline', { price: 100 });
    useDrawingStore.getState().addDrawing('TOK1', d);
    expect(useDrawingStore.getState().drawings.TOK1).toEqual([d]);
  });

  it('isolates drawings per token', () => {
    const a = makeDrawing('hline', { price: 100 });
    const b = makeDrawing('hline', { price: 200 });
    useDrawingStore.getState().addDrawing('TOK1', a);
    useDrawingStore.getState().addDrawing('TOK2', b);
    expect(useDrawingStore.getState().drawings.TOK1).toEqual([a]);
    expect(useDrawingStore.getState().drawings.TOK2).toEqual([b]);
  });

  it('updates an existing drawing via patch', () => {
    const d = makeDrawing('hline', { price: 100 });
    useDrawingStore.getState().addDrawing('TOK1', d);
    useDrawingStore.getState().updateDrawing('TOK1', d.id, { price: 150 } as Partial<typeof d>);
    expect((useDrawingStore.getState().drawings.TOK1[0] as typeof d).price).toBe(150);
  });

  it('deletes a drawing by id', () => {
    const d1 = makeDrawing('hline', { price: 100 });
    const d2 = makeDrawing('hline', { price: 200 });
    useDrawingStore.getState().addDrawing('TOK1', d1);
    useDrawingStore.getState().addDrawing('TOK1', d2);
    useDrawingStore.getState().deleteDrawing('TOK1', d1.id);
    expect(useDrawingStore.getState().drawings.TOK1).toEqual([d2]);
  });

  it('clears all drawings for a token', () => {
    useDrawingStore.getState().addDrawing('TOK1', makeDrawing('hline', { price: 100 }));
    useDrawingStore.getState().addDrawing('TOK1', makeDrawing('hline', { price: 200 }));
    useDrawingStore.getState().clearToken('TOK1');
    expect(useDrawingStore.getState().drawings.TOK1).toEqual([]);
  });

  it('manages active tool', () => {
    useDrawingStore.getState().setActiveTool('hline');
    expect(useDrawingStore.getState().activeTool).toBe('hline');
    useDrawingStore.getState().setActiveTool(null);
    expect(useDrawingStore.getState().activeTool).toBeNull();
  });

  it('manages selection', () => {
    useDrawingStore.getState().setSelected('abc');
    expect(useDrawingStore.getState().selectedId).toBe('abc');
    useDrawingStore.getState().setSelected(null);
    expect(useDrawingStore.getState().selectedId).toBeNull();
  });

  it('replaces an entire token list (for hydration from localStorage)', () => {
    const list = [makeDrawing('hline', { price: 100 })];
    useDrawingStore.getState().setDrawingsForToken('TOK1', list);
    expect(useDrawingStore.getState().drawings.TOK1).toEqual(list);
  });
});
```

- [ ] **Step 3.2: Run tests to verify they fail**

Run: `cd apps/web && npx vitest run src/stores/drawing-store.spec.ts 2>&1 | tail -10`
Expected: FAIL with "Cannot find module './drawing-store'".

- [ ] **Step 3.3: Implement the store**

Create `apps/web/src/stores/drawing-store.ts`:

```typescript
import { create } from 'zustand';
import type { Drawing, ToolKind } from '@/types/drawings';

interface DrawingState {
  // Drawings keyed by chart token. Empty key means "no token set" — we skip
  // persistence in that case but still let drawings exist in memory.
  drawings: Record<string, Drawing[]>;
  selectedId: string | null;
  activeTool: ToolKind | null;
  // In-flight tracks anchor points collected so far when a multi-click
  // tool (hzone, trend, rect, fib, arrow) is mid-draw. Cleared on commit
  // or Esc cancel.
  inFlight: { kind: ToolKind; points: { time: number; price: number }[] } | null;

  addDrawing: (token: string, drawing: Drawing) => void;
  updateDrawing: (token: string, id: string, patch: Partial<Drawing>) => void;
  deleteDrawing: (token: string, id: string) => void;
  clearToken: (token: string) => void;
  setDrawingsForToken: (token: string, list: Drawing[]) => void;
  setActiveTool: (kind: ToolKind | null) => void;
  setSelected: (id: string | null) => void;
  startInFlight: (kind: ToolKind) => void;
  pushInFlightPoint: (point: { time: number; price: number }) => void;
  clearInFlight: () => void;
}

export const useDrawingStore = create<DrawingState>((set) => ({
  drawings: {},
  selectedId: null,
  activeTool: null,
  inFlight: null,

  addDrawing: (token, drawing) =>
    set((s) => ({
      drawings: {
        ...s.drawings,
        [token]: [...(s.drawings[token] ?? []), drawing],
      },
    })),

  updateDrawing: (token, id, patch) =>
    set((s) => ({
      drawings: {
        ...s.drawings,
        [token]: (s.drawings[token] ?? []).map((d) =>
          d.id === id ? ({ ...d, ...patch } as Drawing) : d,
        ),
      },
    })),

  deleteDrawing: (token, id) =>
    set((s) => ({
      drawings: {
        ...s.drawings,
        [token]: (s.drawings[token] ?? []).filter((d) => d.id !== id),
      },
      selectedId: s.selectedId === id ? null : s.selectedId,
    })),

  clearToken: (token) =>
    set((s) => ({
      drawings: { ...s.drawings, [token]: [] },
      selectedId: null,
    })),

  setDrawingsForToken: (token, list) =>
    set((s) => ({
      drawings: { ...s.drawings, [token]: list },
    })),

  setActiveTool: (kind) => set({ activeTool: kind, selectedId: null, inFlight: null }),

  setSelected: (id) => set({ selectedId: id }),

  startInFlight: (kind) => set({ inFlight: { kind, points: [] } }),

  pushInFlightPoint: (point) =>
    set((s) =>
      s.inFlight
        ? { inFlight: { ...s.inFlight, points: [...s.inFlight.points, point] } }
        : {},
    ),

  clearInFlight: () => set({ inFlight: null }),
}));

// Convenience selector to read the drawings list for a token without
// triggering renders on unrelated tokens.
export const selectDrawingsForToken = (token: string) =>
  (s: DrawingState): Drawing[] => s.drawings[token] ?? [];
```

- [ ] **Step 3.4: Run tests to verify they pass**

Run: `cd apps/web && npx vitest run src/stores/drawing-store.spec.ts 2>&1 | tail -15`
Expected: All 8 tests pass.

- [ ] **Step 3.5: Commit**

```bash
git add apps/web/src/stores/drawing-store.ts apps/web/src/stores/drawing-store.spec.ts
git commit -m "feat(charts): drawing-store with per-token isolation"
```

---

## Task 4: Coordinate converter hook

**Files:**
- Create: `apps/web/src/hooks/useCoordinateConverter.ts`
- Test: `apps/web/src/hooks/useCoordinateConverter.spec.ts`

- [ ] **Step 4.1: Write the failing tests**

Create `apps/web/src/hooks/useCoordinateConverter.spec.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { buildConverter } from './useCoordinateConverter';

// Mock the lightweight-charts surface area we need.
function mockChart(timeMap: Record<number, number | null>) {
  return {
    timeScale: () => ({
      timeToCoordinate: (t: number) => timeMap[t] ?? null,
      coordinateToTime: (x: number) => {
        // Inverse: find the time whose coord equals x (or null if not in map).
        for (const [t, coord] of Object.entries(timeMap)) {
          if (coord === x) return Number(t);
        }
        return null;
      },
    }),
  };
}

function mockSeries(priceMap: Record<number, number | null>) {
  return {
    priceToCoordinate: (p: number) => priceMap[p] ?? null,
    coordinateToPrice: (y: number) => {
      for (const [p, coord] of Object.entries(priceMap)) {
        if (coord === y) return Number(p);
      }
      return null;
    },
  };
}

describe('buildConverter', () => {
  it('round-trips real time through compressed time', () => {
    // realTimeMap: compressedTime -> realTime
    //   compressed 1000 -> real 1000 (no gap)
    //   compressed 1015 -> real 2000 (15s collapsed gap)
    const realTimeMap = new Map<number, number>([
      [1000, 1000],
      [1015, 2000],
    ]);
    const chart = mockChart({ 1000: 100, 1015: 200 });
    const series = mockSeries({});

    const conv = buildConverter(chart as any, series as any, realTimeMap);
    expect(conv.timeToX(1000)).toBe(100);
    expect(conv.timeToX(2000)).toBe(200);
  });

  it('returns null for real time not in the compressed map', () => {
    const realTimeMap = new Map<number, number>([[1000, 1000]]);
    const chart = mockChart({ 1000: 100 });
    const series = mockSeries({});
    const conv = buildConverter(chart as any, series as any, realTimeMap);
    expect(conv.timeToX(9999)).toBeNull();
  });

  it('xToTime returns real time for a known compressed coordinate', () => {
    const realTimeMap = new Map<number, number>([[1015, 2000]]);
    const chart = mockChart({ 1015: 200 });
    const series = mockSeries({});
    const conv = buildConverter(chart as any, series as any, realTimeMap);
    expect(conv.xToTime(200)).toBe(2000);
  });

  it('priceToY delegates to series', () => {
    const chart = mockChart({});
    const series = mockSeries({ 150: 50 });
    const conv = buildConverter(chart as any, series as any, new Map());
    expect(conv.priceToY(150)).toBe(50);
  });

  it('yToPrice delegates to series', () => {
    const chart = mockChart({});
    const series = mockSeries({ 150: 50 });
    const conv = buildConverter(chart as any, series as any, new Map());
    expect(conv.yToPrice(50)).toBe(150);
  });
});
```

- [ ] **Step 4.2: Run tests to verify they fail**

Run: `cd apps/web && npx vitest run src/hooks/useCoordinateConverter.spec.ts 2>&1 | tail -10`
Expected: FAIL with "Cannot find module './useCoordinateConverter'".

- [ ] **Step 4.3: Implement the converter**

Create `apps/web/src/hooks/useCoordinateConverter.ts`:

```typescript
import { useMemo } from 'react';
import type { IChartApi, ISeriesApi, Time } from 'lightweight-charts';

export interface CoordinateConverter {
  timeToX: (realSec: number) => number | null;
  xToTime: (px: number) => number | null;
  priceToY: (price: number) => number | null;
  yToPrice: (px: number) => number | null;
}

/**
 * Build a converter from the chart, candle series, and the real↔compressed
 * map maintained by useChartData. Exposed as a pure function so it's
 * unit-testable; the hook below is a thin memoization wrapper.
 *
 * timeToX: realSec → reverse-lookup realTimeMap to compressed → chart coord.
 * xToTime: chart coord → forward-lookup realTimeMap to real seconds.
 */
export function buildConverter(
  chart: IChartApi,
  series: ISeriesApi<'Candlestick'>,
  realTimeMap: Map<number, number>,   // compressedTime -> realTime
): CoordinateConverter {
  // Pre-build reverse map (real -> compressed) for O(1) timeToX.
  const reverseMap = new Map<number, number>();
  for (const [compressed, real] of realTimeMap) {
    reverseMap.set(real, compressed);
  }

  return {
    timeToX: (realSec) => {
      const compressed = reverseMap.get(realSec);
      if (compressed === undefined) return null;
      const coord = chart.timeScale().timeToCoordinate(compressed as Time);
      return coord;
    },
    xToTime: (px) => {
      const compressed = chart.timeScale().coordinateToTime(px);
      if (compressed === null) return null;
      const real = realTimeMap.get(compressed as number);
      return real ?? (compressed as number);
    },
    priceToY: (price) => series.priceToCoordinate(price),
    yToPrice: (px) => series.coordinateToPrice(px),
  };
}

export function useCoordinateConverter(
  chart: IChartApi | null,
  series: ISeriesApi<'Candlestick'> | null,
  realTimeMap: Map<number, number>,
): CoordinateConverter | null {
  return useMemo(() => {
    if (!chart || !series) return null;
    return buildConverter(chart, series, realTimeMap);
  }, [chart, series, realTimeMap]);
}
```

- [ ] **Step 4.4: Run tests to verify they pass**

Run: `cd apps/web && npx vitest run src/hooks/useCoordinateConverter.spec.ts 2>&1 | tail -15`
Expected: All 5 tests pass.

- [ ] **Step 4.5: Commit**

```bash
git add apps/web/src/hooks/useCoordinateConverter.ts apps/web/src/hooks/useCoordinateConverter.spec.ts
git commit -m "feat(charts): real↔compressed time/price coordinate converter"
```

---

## Task 5: localStorage persistence hook

**Files:**
- Create: `apps/web/src/hooks/useDrawingPersistence.ts`
- Test: `apps/web/src/hooks/useDrawingPersistence.spec.ts`

- [ ] **Step 5.1: Write the failing tests**

Create `apps/web/src/hooks/useDrawingPersistence.spec.ts`:

```typescript
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { storageKey, readDrawings, writeDrawings, SCHEMA_VERSION } from './useDrawingPersistence';
import { makeDrawing } from '@/types/drawings';

beforeEach(() => {
  localStorage.clear();
});

describe('drawing persistence', () => {
  it('builds a token-scoped storage key', () => {
    expect(storageKey('459277')).toBe('td:drawings:v1:459277');
  });

  it('returns empty list when no key exists', () => {
    expect(readDrawings('NOPE')).toEqual([]);
  });

  it('round-trips drawings', () => {
    const list = [makeDrawing('hline', { price: 100 })];
    writeDrawings('TOK', list);
    expect(readDrawings('TOK')).toEqual(list);
  });

  it('skips writing for empty / 0 tokens', () => {
    writeDrawings('', [makeDrawing('hline', { price: 100 })]);
    writeDrawings('0', [makeDrawing('hline', { price: 100 })]);
    expect(localStorage.length).toBe(0);
  });

  it('returns empty on parse failure (does NOT auto-wipe)', () => {
    localStorage.setItem(storageKey('BAD'), '{not valid json');
    expect(readDrawings('BAD')).toEqual([]);
    // Corrupted entry preserved — user gets to decide via reset toast.
    expect(localStorage.getItem(storageKey('BAD'))).toBe('{not valid json');
  });

  it('returns empty on schema-version mismatch', () => {
    localStorage.setItem(
      storageKey('OLD'),
      JSON.stringify({ version: 999, drawings: [{ id: 'x' }], updatedAt: 0 }),
    );
    expect(readDrawings('OLD')).toEqual([]);
  });

  it('survives quota-exceeded by surfacing the error', () => {
    const original = localStorage.setItem;
    localStorage.setItem = vi.fn(() => {
      throw new DOMException('quota', 'QuotaExceededError');
    });
    expect(() => writeDrawings('TOK', [makeDrawing('hline', { price: 100 })])).toThrow();
    localStorage.setItem = original;
  });

  it('writes the current schema version', () => {
    writeDrawings('TOK', [makeDrawing('hline', { price: 100 })]);
    const raw = localStorage.getItem(storageKey('TOK'));
    expect(JSON.parse(raw!).version).toBe(SCHEMA_VERSION);
  });
});
```

- [ ] **Step 5.2: Run tests to verify they fail**

Run: `cd apps/web && npx vitest run src/hooks/useDrawingPersistence.spec.ts 2>&1 | tail -10`
Expected: FAIL with "Cannot find module './useDrawingPersistence'".

- [ ] **Step 5.3: Implement persistence**

Create `apps/web/src/hooks/useDrawingPersistence.ts`:

```typescript
import { useEffect, useRef } from 'react';
import { useDrawingStore, selectDrawingsForToken } from '@/stores/drawing-store';
import type { Drawing } from '@/types/drawings';

export const SCHEMA_VERSION = 1;
const DEBOUNCE_MS = 500;

export function storageKey(token: string): string {
  return `td:drawings:v${SCHEMA_VERSION}:${token}`;
}

interface StoredShape {
  version: number;
  drawings: Drawing[];
  updatedAt: number;
}

export function readDrawings(token: string): Drawing[] {
  if (!token || token === '0') return [];
  try {
    const raw = localStorage.getItem(storageKey(token));
    if (!raw) return [];
    const parsed = JSON.parse(raw) as StoredShape;
    if (parsed.version !== SCHEMA_VERSION) {
      // eslint-disable-next-line no-console
      console.warn(`[drawings] schema mismatch v${parsed.version} for ${token}; ignoring`);
      return [];
    }
    return Array.isArray(parsed.drawings) ? parsed.drawings : [];
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn(`[drawings] parse failed for ${token}; ignoring (kept in storage):`, err);
    return [];
  }
}

export function writeDrawings(token: string, drawings: Drawing[]): void {
  if (!token || token === '0') return;
  const payload: StoredShape = {
    version: SCHEMA_VERSION,
    drawings,
    updatedAt: Date.now(),
  };
  localStorage.setItem(storageKey(token), JSON.stringify(payload));
}

/**
 * Hydrate the store from localStorage on token change, then debounce-write
 * back on subsequent changes. Also flushes on `beforeunload` so a fast
 * tab-close doesn't lose the last drag.
 *
 * Listens to the cross-tab `storage` event so edits made in another tab
 * (same browser, same symbol) propagate into this tab.
 */
export function useDrawingPersistence(token: string): void {
  const setDrawingsForToken = useDrawingStore((s) => s.setDrawingsForToken);
  const drawings = useDrawingStore(selectDrawingsForToken(token));
  const timeoutRef = useRef<number | null>(null);
  const lastHydratedToken = useRef<string | null>(null);

  // Hydrate on token change.
  useEffect(() => {
    if (token === lastHydratedToken.current) return;
    lastHydratedToken.current = token;
    setDrawingsForToken(token, readDrawings(token));
  }, [token, setDrawingsForToken]);

  // Debounced write.
  useEffect(() => {
    if (!token || token === '0') return;
    // Skip the initial render that happens immediately after hydration —
    // otherwise we'd rewrite identical content. The hydration effect runs
    // synchronously before this in StrictMode-aware ordering, so by here
    // `drawings` already reflects what we just read.
    if (timeoutRef.current !== null) window.clearTimeout(timeoutRef.current);
    timeoutRef.current = window.setTimeout(() => {
      try {
        writeDrawings(token, drawings);
      } catch (err) {
        // eslint-disable-next-line no-console
        console.error('[drawings] write failed:', err);
        // TODO surface toast on QuotaExceeded once toaster wiring is in place.
      }
    }, DEBOUNCE_MS);
    return () => {
      if (timeoutRef.current !== null) window.clearTimeout(timeoutRef.current);
    };
  }, [drawings, token]);

  // beforeunload flush.
  useEffect(() => {
    if (!token || token === '0') return;
    const onUnload = () => {
      try {
        writeDrawings(token, drawings);
      } catch {
        // best-effort on unload
      }
    };
    window.addEventListener('beforeunload', onUnload);
    return () => window.removeEventListener('beforeunload', onUnload);
  }, [drawings, token]);

  // Cross-tab sync.
  useEffect(() => {
    if (!token || token === '0') return;
    const key = storageKey(token);
    const onStorage = (e: StorageEvent) => {
      if (e.key !== key) return;
      setDrawingsForToken(token, readDrawings(token));
    };
    window.addEventListener('storage', onStorage);
    return () => window.removeEventListener('storage', onStorage);
  }, [token, setDrawingsForToken]);
}
```

- [ ] **Step 5.4: Run tests to verify they pass**

Run: `cd apps/web && npx vitest run src/hooks/useDrawingPersistence.spec.ts 2>&1 | tail -15`
Expected: All 8 tests pass.

- [ ] **Step 5.5: Commit**

```bash
git add apps/web/src/hooks/useDrawingPersistence.ts apps/web/src/hooks/useDrawingPersistence.spec.ts
git commit -m "feat(charts): localStorage persistence with debounce + cross-tab sync"
```

---

## Task 6: Per-kind canvas renderers (trend, vline, rect, text, arrow)

**Files:**
- Create: `apps/web/src/components/charts/drawing-renderers/canvas.ts`

- [ ] **Step 6.1: Write the canvas renderer module**

Create `apps/web/src/components/charts/drawing-renderers/canvas.ts`:

```typescript
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

  // Shaft
  ctx.beginPath();
  ctx.moveTo(x1, y1);
  ctx.lineTo(x2, y2);
  ctx.stroke();

  // Head — filled triangle
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

// Selection handles — small filled circles at the listed points. Drawn
// AFTER the drawing itself so they overlay cleanly.
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
```

- [ ] **Step 6.2: Verify it compiles**

Run: `cd apps/web && npx tsc --noEmit 2>&1 | grep -E "drawing-renderers/canvas" | head -10`
Expected: no output (no type errors in this file).

- [ ] **Step 6.3: Commit**

```bash
git add apps/web/src/components/charts/drawing-renderers/canvas.ts
git commit -m "feat(charts): canvas renderers for trend/vline/rect/text/arrow"
```

---

## Task 7: createPriceLine adapters (hline, hzone, fib)

**Files:**
- Create: `apps/web/src/components/charts/drawing-renderers/priceLines.ts`

- [ ] **Step 7.1: Write the priceLine adapters**

Create `apps/web/src/components/charts/drawing-renderers/priceLines.ts`:

```typescript
import type { IPriceLine, ISeriesApi, LineStyle as LWLineStyle } from 'lightweight-charts';
import type {
  HorizontalLineDrawing, HorizontalZoneDrawing, FibDrawing, Drawing,
} from '@/types/drawings';
import { FIB_LEVEL_COLORS } from '@/types/drawings';

function lwLineStyle(s: Drawing['lineStyle']): LWLineStyle {
  // lightweight-charts uses numeric enum: 0=solid 2=dashed 3=large-dashed 4=sparse-dotted.
  switch (s) {
    case 'dashed': return 2 as LWLineStyle;
    case 'dotted': return 4 as LWLineStyle;
    default: return 0 as LWLineStyle;
  }
}

function formatPriceLabel(price: number): string {
  return price.toLocaleString('en-IN', {
    minimumFractionDigits: 0,
    maximumFractionDigits: 2,
  });
}

// Each entry corresponds to ONE Drawing (an hline produces 1 priceLine, an
// hzone produces 2, a fib produces N=levels.length). The renderer keeps a
// Map<drawingId, IPriceLine[]> and reconciles via applyOptions.

export function buildHLine(
  series: ISeriesApi<'Candlestick'>,
  d: HorizontalLineDrawing,
): IPriceLine[] {
  return [
    series.createPriceLine({
      price: d.price,
      color: d.color,
      lineWidth: d.lineWidth,
      lineStyle: lwLineStyle(d.lineStyle),
      axisLabelVisible: true,
      title: d.label ?? formatPriceLabel(d.price),
    }),
  ];
}

export function buildHZone(
  series: ISeriesApi<'Candlestick'>,
  d: HorizontalZoneDrawing,
): IPriceLine[] {
  return [
    series.createPriceLine({
      price: d.upper,
      color: d.color,
      lineWidth: d.lineWidth,
      lineStyle: lwLineStyle(d.lineStyle),
      axisLabelVisible: true,
      title: d.label ? `${d.label} ↑` : formatPriceLabel(d.upper),
    }),
    series.createPriceLine({
      price: d.lower,
      color: d.color,
      lineWidth: d.lineWidth,
      lineStyle: lwLineStyle(d.lineStyle),
      axisLabelVisible: true,
      title: d.label ? `${d.label} ↓` : formatPriceLabel(d.lower),
    }),
  ];
}

export function buildFib(
  series: ISeriesApi<'Candlestick'>,
  d: FibDrawing,
): IPriceLine[] {
  const span = d.p2.price - d.p1.price;
  return d.levels.map((ratio) => {
    const price = d.p1.price + span * ratio;
    return series.createPriceLine({
      price,
      color: FIB_LEVEL_COLORS[String(ratio)] ?? d.color,
      lineWidth: 1,
      lineStyle: lwLineStyle(d.lineStyle),
      axisLabelVisible: true,
      title: `${ratio.toFixed(3)} — ${formatPriceLabel(price)}`,
    });
  });
}

// applyOptions-based reconciliation — call this when the drawing's geometry
// changes but it's still the same N price lines. Returns true on success;
// false if line count mismatches (caller should tear down + rebuild).
export function reconcileHLine(lines: IPriceLine[], d: HorizontalLineDrawing): boolean {
  if (lines.length !== 1) return false;
  lines[0].applyOptions({
    price: d.price,
    color: d.color,
    lineWidth: d.lineWidth,
    lineStyle: lwLineStyle(d.lineStyle),
    title: d.label ?? formatPriceLabel(d.price),
  });
  return true;
}

export function reconcileHZone(lines: IPriceLine[], d: HorizontalZoneDrawing): boolean {
  if (lines.length !== 2) return false;
  lines[0].applyOptions({
    price: d.upper, color: d.color, lineWidth: d.lineWidth,
    lineStyle: lwLineStyle(d.lineStyle),
    title: d.label ? `${d.label} ↑` : formatPriceLabel(d.upper),
  });
  lines[1].applyOptions({
    price: d.lower, color: d.color, lineWidth: d.lineWidth,
    lineStyle: lwLineStyle(d.lineStyle),
    title: d.label ? `${d.label} ↓` : formatPriceLabel(d.lower),
  });
  return true;
}

export function reconcileFib(lines: IPriceLine[], d: FibDrawing): boolean {
  if (lines.length !== d.levels.length) return false;
  const span = d.p2.price - d.p1.price;
  d.levels.forEach((ratio, i) => {
    const price = d.p1.price + span * ratio;
    lines[i].applyOptions({
      price,
      color: FIB_LEVEL_COLORS[String(ratio)] ?? d.color,
      title: `${ratio.toFixed(3)} — ${formatPriceLabel(price)}`,
    });
  });
  return true;
}
```

- [ ] **Step 7.2: Verify it compiles**

Run: `cd apps/web && npx tsc --noEmit 2>&1 | grep -E "drawing-renderers/priceLines" | head -10`
Expected: no output.

- [ ] **Step 7.3: Commit**

```bash
git add apps/web/src/components/charts/drawing-renderers/priceLines.ts
git commit -m "feat(charts): createPriceLine adapters for hline/hzone/fib"
```

---

## Task 8: Drawing toolbar (left-side vertical)

**Files:**
- Create: `apps/web/src/components/charts/DrawingToolbar.tsx`

- [ ] **Step 8.1: Implement the toolbar**

Create `apps/web/src/components/charts/DrawingToolbar.tsx`:

```typescript
import { useState } from 'react';
import {
  MousePointer2, Minus, Square, TrendingUp, AlignVerticalJustifyCenter,
  Triangle, Type, ArrowUpRight, Trash2,
} from 'lucide-react';
import clsx from 'clsx';
import { useDrawingStore } from '@/stores/drawing-store';
import type { ToolKind } from '@/types/drawings';

interface ToolButton {
  kind: ToolKind | null;   // null = cursor (deselect)
  label: string;
  icon: React.ComponentType<{ size?: number; className?: string }>;
}

const TOOLS: ToolButton[] = [
  { kind: null, label: 'Cursor', icon: MousePointer2 },
  { kind: 'hline', label: 'Horizontal line', icon: Minus },
  { kind: 'hzone', label: 'Horizontal zone', icon: AlignVerticalJustifyCenter },
  { kind: 'trend', label: 'Trend line', icon: TrendingUp },
  { kind: 'vline', label: 'Vertical line', icon: AlignVerticalJustifyCenter },
  { kind: 'rect', label: 'Rectangle', icon: Square },
  { kind: 'fib', label: 'Fibonacci retracement', icon: Triangle },
  { kind: 'text', label: 'Text', icon: Type },
  { kind: 'arrow', label: 'Arrow', icon: ArrowUpRight },
];

interface DrawingToolbarProps {
  token: string;
}

export default function DrawingToolbar({ token }: DrawingToolbarProps) {
  const activeTool = useDrawingStore((s) => s.activeTool);
  const setActiveTool = useDrawingStore((s) => s.setActiveTool);
  const clearToken = useDrawingStore((s) => s.clearToken);
  const drawingsCount = useDrawingStore((s) => (s.drawings[token] ?? []).length);
  const [confirmingClear, setConfirmingClear] = useState(false);

  function handleClick(kind: ToolKind | null) {
    // Clicking the active tool again de-arms it.
    setActiveTool(activeTool === kind ? null : kind);
  }

  function handleClear() {
    if (!confirmingClear) {
      setConfirmingClear(true);
      window.setTimeout(() => setConfirmingClear(false), 3000);
      return;
    }
    clearToken(token);
    setConfirmingClear(false);
  }

  return (
    <div
      className="flex flex-col items-center gap-0.5 border-r border-[var(--color-border-subtle)] bg-[var(--color-bg-secondary)] py-2"
      style={{ width: 40 }}
    >
      {TOOLS.map((t) => {
        const Icon = t.icon;
        const isActive = activeTool === t.kind;
        return (
          <button
            key={t.label}
            type="button"
            title={t.label}
            onClick={() => handleClick(t.kind)}
            className={clsx(
              'w-8 h-8 flex items-center justify-center rounded transition-colors',
              isActive
                ? 'bg-[var(--color-accent-blue)] text-white'
                : 'text-[var(--color-text-secondary)] hover:bg-[var(--color-bg-tertiary)]',
            )}
          >
            <Icon size={16} />
          </button>
        );
      })}
      <div className="flex-1" />
      <button
        type="button"
        title={confirmingClear ? `Click again to clear ${drawingsCount}` : 'Clear all drawings'}
        onClick={handleClear}
        disabled={drawingsCount === 0}
        className={clsx(
          'w-8 h-8 flex items-center justify-center rounded transition-colors disabled:opacity-30 disabled:cursor-not-allowed',
          confirmingClear
            ? 'bg-[var(--color-accent-red)] text-white'
            : 'text-[var(--color-text-secondary)] hover:bg-[var(--color-bg-tertiary)]',
        )}
      >
        <Trash2 size={16} />
      </button>
    </div>
  );
}
```

- [ ] **Step 8.2: Verify it compiles**

Run: `cd apps/web && npx tsc --noEmit 2>&1 | grep -E "DrawingToolbar" | head -5`
Expected: no output.

- [ ] **Step 8.3: Commit**

```bash
git add apps/web/src/components/charts/DrawingToolbar.tsx
git commit -m "feat(charts): left-side vertical drawing toolbar"
```

---

## Task 9: Context menu

**Files:**
- Create: `apps/web/src/components/charts/DrawingContextMenu.tsx`

- [ ] **Step 9.1: Implement the right-click menu**

Create `apps/web/src/components/charts/DrawingContextMenu.tsx`:

```typescript
import { useEffect, useRef } from 'react';
import { useDrawingStore } from '@/stores/drawing-store';
import type { Drawing, LineStyle, LineWidth } from '@/types/drawings';

const COLOR_SWATCHES = [
  '#06b6d4', '#22c55e', '#eab308', '#f97316', '#ef4444',
  '#a855f7', '#3b82f6', '#94a3b8', '#ffffff',
];

interface DrawingContextMenuProps {
  token: string;
  drawing: Drawing;
  x: number;
  y: number;
  onClose: () => void;
}

export default function DrawingContextMenu({ token, drawing, x, y, onClose }: DrawingContextMenuProps) {
  const updateDrawing = useDrawingStore((s) => s.updateDrawing);
  const deleteDrawing = useDrawingStore((s) => s.deleteDrawing);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const onClick = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('mousedown', onClick);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onClick);
      document.removeEventListener('keydown', onKey);
    };
  }, [onClose]);

  return (
    <div
      ref={ref}
      style={{ position: 'fixed', left: x, top: y, zIndex: 200 }}
      className="bg-[var(--color-bg-tertiary)] border border-[var(--color-border-subtle)] rounded shadow-lg p-2 text-xs min-w-[180px]"
    >
      <div className="mb-2">
        <div className="text-[10px] uppercase text-[var(--color-text-muted)] mb-1">Color</div>
        <div className="grid grid-cols-9 gap-1">
          {COLOR_SWATCHES.map((c) => (
            <button
              key={c}
              type="button"
              onClick={() => updateDrawing(token, drawing.id, { color: c })}
              className="w-4 h-4 rounded-sm border border-black/20"
              style={{ background: c }}
              aria-label={`Color ${c}`}
            />
          ))}
        </div>
      </div>

      <div className="mb-2">
        <div className="text-[10px] uppercase text-[var(--color-text-muted)] mb-1">Style</div>
        <div className="flex gap-1">
          {(['solid', 'dashed', 'dotted'] as LineStyle[]).map((s) => (
            <button
              key={s}
              type="button"
              onClick={() => updateDrawing(token, drawing.id, { lineStyle: s })}
              className={`px-2 py-1 rounded ${drawing.lineStyle === s ? 'bg-[var(--color-accent-blue)] text-white' : 'hover:bg-[var(--color-bg-secondary)]'}`}
            >
              {s}
            </button>
          ))}
        </div>
      </div>

      <div className="mb-2">
        <div className="text-[10px] uppercase text-[var(--color-text-muted)] mb-1">Width</div>
        <div className="flex gap-1">
          {([1, 2, 3] as LineWidth[]).map((w) => (
            <button
              key={w}
              type="button"
              onClick={() => updateDrawing(token, drawing.id, { lineWidth: w })}
              className={`px-2 py-1 rounded ${drawing.lineWidth === w ? 'bg-[var(--color-accent-blue)] text-white' : 'hover:bg-[var(--color-bg-secondary)]'}`}
            >
              {w}px
            </button>
          ))}
        </div>
      </div>

      <button
        type="button"
        onClick={() => { deleteDrawing(token, drawing.id); onClose(); }}
        className="w-full text-left px-2 py-1 rounded text-[var(--color-accent-red)] hover:bg-[var(--color-bg-secondary)]"
      >
        Delete
      </button>
    </div>
  );
}
```

- [ ] **Step 9.2: Commit**

```bash
git add apps/web/src/components/charts/DrawingContextMenu.tsx
git commit -m "feat(charts): right-click context menu for color/style/delete"
```

---

## Task 10: Text input overlay

**Files:**
- Create: `apps/web/src/components/charts/TextDrawingInput.tsx`

- [ ] **Step 10.1: Implement inline text editor**

Create `apps/web/src/components/charts/TextDrawingInput.tsx`:

```typescript
import { useEffect, useRef, useState } from 'react';

interface TextDrawingInputProps {
  initialText?: string;
  x: number;
  y: number;
  onCommit: (text: string) => void;
  onCancel: () => void;
}

export default function TextDrawingInput({ initialText = '', x, y, onCommit, onCancel }: TextDrawingInputProps) {
  const [text, setText] = useState(initialText);
  const ref = useRef<HTMLInputElement>(null);

  useEffect(() => {
    ref.current?.focus();
    ref.current?.select();
  }, []);

  return (
    <input
      ref={ref}
      type="text"
      value={text}
      onChange={(e) => setText(e.target.value)}
      onKeyDown={(e) => {
        if (e.key === 'Enter') { if (text.trim()) onCommit(text.trim()); else onCancel(); }
        if (e.key === 'Escape') onCancel();
      }}
      onBlur={() => { if (text.trim()) onCommit(text.trim()); else onCancel(); }}
      style={{
        position: 'absolute', left: x, top: y, zIndex: 150,
        background: 'rgba(10, 10, 26, 0.95)',
        border: '1px solid #06b6d4',
        color: 'white', padding: '2px 4px', fontSize: 12, minWidth: 80,
      }}
    />
  );
}
```

- [ ] **Step 10.2: Commit**

```bash
git add apps/web/src/components/charts/TextDrawingInput.tsx
git commit -m "feat(charts): inline text-drawing input"
```

---

## Task 11: DrawingsOverlay (the big one)

**Files:**
- Create: `apps/web/src/components/charts/DrawingsOverlay.tsx`

- [ ] **Step 11.1: Write the overlay component**

This is the largest single file. Create `apps/web/src/components/charts/DrawingsOverlay.tsx`:

```typescript
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

  // Reconciliation: ensure priceLinesRef matches current drawings list.
  function reconcilePriceLines() {
    if (!series) return;
    const existing = priceLinesRef.current;
    const wantedIds = new Set(drawings.filter((d) => d.kind === 'hline' || d.kind === 'hzone' || d.kind === 'fib').map((d) => d.id));

    // Remove orphans.
    for (const [id, lines] of existing) {
      if (!wantedIds.has(id)) {
        for (const l of lines) {
          try { series.removePriceLine(l); } catch { /* disposed */ }
        }
        existing.delete(id);
      }
    }

    // Build or reconcile.
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
          // Count mismatched (e.g. Fib levels changed). Tear down + rebuild.
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

  // Map a drawing to its screen-space shape for hit-testing.
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
        // approximate width based on char count * fontSize * 0.6
        return { kind: 'text', id: d.id, anchor: { x, y }, width: d.text.length * d.fontSize * 0.6, height: d.fontSize * 1.2 };
      }
    }
  }

  // Render canvas + reconcile price lines.
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

    // Render canvas-based kinds, collect handle points for selected.
    const handlePointsByDrawingId = new Map<string, { x: number; y: number }[]>();
    for (const d of drawings) {
      let coords: { p1?: { x: number; y: number }; p2?: { x: number; y: number }; x?: number; anchor?: { x: number; y: number } } | null = null;
      switch (d.kind) {
        case 'trend': {
          const r = drawTrendLine(ctx, d, conv);
          if (r) { coords = r; handlePointsByDrawingId.set(d.id, [r.p1, r.p2]); }
          break;
        }
        case 'vline': {
          const r = drawVerticalLine(ctx, d, conv, h);
          if (r) { coords = r; handlePointsByDrawingId.set(d.id, [{ x: r.x, y: 10 }]); }
          break;
        }
        case 'rect': {
          const r = drawRectangle(ctx, d, conv);
          if (r) {
            coords = r;
            handlePointsByDrawingId.set(d.id, [r.p1, r.p2, { x: r.p1.x, y: r.p2.y }, { x: r.p2.x, y: r.p1.y }]);
          }
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
          // Handled by createPriceLine. Skip canvas render but compute handle positions.
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

    // Draw handles for selected drawing on top.
    if (selectedId) {
      const pts = handlePointsByDrawingId.get(selectedId);
      if (pts) drawHandles(ctx, pts);
    }

    // In-flight preview using mouse.
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

  // Subscribe to render triggers.
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

  // Render on any state change.
  useEffect(() => { render(); });

  // Token cleanup: when token changes, remove price lines from old token.
  useEffect(() => {
    return () => {
      if (!series) return;
      for (const [, lines] of priceLinesRef.current) {
        for (const l of lines) try { series.removePriceLine(l); } catch { /* */ }
      }
      priceLinesRef.current.clear();
    };
  }, [token, series]);

  // Mouse handlers.
  function handleMouseDown(e: React.MouseEvent) {
    if (!conv || !canvasRef.current) return;
    const rect = canvasRef.current.getBoundingClientRect();
    const mx = e.clientX - rect.left;
    const my = e.clientY - rect.top;

    if (e.button === 2) {
      // right click on a drawing → context menu
      const hit = findHit(mx, my);
      if (hit) {
        setContextMenu({ drawing: hit, x: e.clientX, y: e.clientY });
        setSelected(hit.id);
        e.preventDefault();
      }
      return;
    }

    if (activeTool) {
      // Drawing mode: collect a point.
      const time = conv.xToTime(mx);
      const price = conv.yToPrice(my);
      if (time === null || price === null) return;
      handleDrawClick(activeTool, { time, price });
      return;
    }

    // Cursor mode: hit-test.
    const hit = findHit(mx, my);
    if (hit) {
      setSelected(hit.id);
      dragRef.current = { id: hit.id, handle: 'body', startMouse: { x: mx, y: my }, origin: hit };
    } else {
      setSelected(null);
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
    const dx = mx - drag.startMouse.x;
    const dy = my - drag.startMouse.y;
    const origin = drag.origin;

    // Convert pixel delta into time/price delta by sampling at midpoint.
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

  function handleMouseUp() {
    dragRef.current = null;
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
    // Multi-click tools.
    if (!inFlight) {
      startInFlight(kind);
      pushInFlightPoint(point);
      return;
    }
    pushInFlightPoint(point);
    const all = [...inFlight.points, point];
    // Decide commit point per tool.
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

  // Keyboard shortcuts.
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

  // Decide canvas pointer-events: capture when armed/selected/drawing.
  const captureEvents = activeTool !== null || selectedId !== null || inFlight !== null;

  return (
    <div ref={containerRef} className="absolute inset-0" style={{ pointerEvents: 'none' }}>
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
```

- [ ] **Step 11.2: Verify it compiles**

Run: `cd apps/web && npx tsc --noEmit 2>&1 | grep -E "DrawingsOverlay" | head -10`
Expected: no output. If TypeScript complains about `findHit` accessing `d.text.length` on a non-text union member, that's a real bug — fix the `toScreen` text branch with a type narrowing.

- [ ] **Step 11.3: Commit**

```bash
git add apps/web/src/components/charts/DrawingsOverlay.tsx
git commit -m "feat(charts): DrawingsOverlay component with FSM event handling"
```

---

## Task 12: Wire into ChartsPage

**Files:**
- Modify: `apps/web/src/pages/charts/ChartsPage.tsx`
- Modify: `apps/web/src/components/charts/index.ts`

- [ ] **Step 12.1: Add exports**

Open `apps/web/src/components/charts/index.ts` and append:

```typescript
export { default as DrawingToolbar } from './DrawingToolbar';
export { default as DrawingsOverlay } from './DrawingsOverlay';
```

- [ ] **Step 12.2: Wire into ChartsPage**

In `apps/web/src/pages/charts/ChartsPage.tsx`:

1. Add imports at the top (around line 4):

```typescript
import { DrawingToolbar, DrawingsOverlay } from '@/components/charts';
import { useDrawingPersistence } from '@/hooks/useDrawingPersistence';
```

2. Inside the component, after the `useChartData()` destructure (around line 190), add:

```typescript
  useDrawingPersistence(selectedSymbol.token);
```

3. Add the toolbar to the chart row. Find the existing `<div className="flex-1 relative min-w-0 h-full">` (around line 291) and *immediately before it*, insert:

```typescript
          <DrawingToolbar token={selectedSymbol.token} />
```

4. Inside that same `<div className="flex-1 relative min-w-0 h-full">`, *after* the `<CandlestickChart>` element (around line 332) and before `<OIOverlay>`, insert:

```typescript
          <DrawingsOverlay
            token={selectedSymbol.token}
            chart={chartRef.current?.chart ?? null}
            series={chartRef.current?.candleSeries ?? null}
            realTimeMap={realTimeMap}
          />
```

- [ ] **Step 12.3: Smoke-test in browser**

The dev server should HMR. Open http://localhost:4000/charts in a browser.

Verify visually:
1. Left toolbar appears with 9 tool icons + a clear-all icon.
2. Click the horizontal-line icon → cursor becomes crosshair → click anywhere on the chart → a horizontal line appears with a right-axis price tag.
3. Click the cursor icon → click the line → handle appears at right edge.
4. Drag the line → it moves with the cursor.
5. Press Delete → line disappears.
6. Refresh the page → drawings you drew earlier persist.
7. Switch to a different watchlist symbol → drawings disappear (other symbol has none).
8. Switch back → drawings re-appear.

- [ ] **Step 12.4: Commit**

```bash
git add apps/web/src/pages/charts/ChartsPage.tsx apps/web/src/components/charts/index.ts
git commit -m "feat(charts): wire drawing toolbar + overlay into ChartsPage"
```

---

## Task 13: Manual full-feature smoke test

- [ ] **Step 13.1: Walk through every tool**

For each tool below: click in toolbar → place on chart → click cursor → click drawing to select → drag to verify, right-click for color menu, Delete to remove.

1. Horizontal line — 1 click to place.
2. Horizontal zone — 2 clicks for upper + lower.
3. Trend line — 2 clicks.
4. Vertical line — 1 click.
5. Rectangle — 2 clicks for opposite corners.
6. Fibonacci retracement — 2 clicks for the two swing anchors. Verify 7 axis labels appear with ratios + prices.
7. Text — click anchor, type, Enter.
8. Arrow — click tail, click head. Verify arrowhead points to the head.

- [ ] **Step 13.2: Persistence and cross-symbol**

1. Draw 2-3 drawings on GOLD.
2. Switch to SILVER.
3. Verify GOLD's drawings are gone.
4. Draw 1 drawing on SILVER.
5. Switch back to GOLD → original 2-3 drawings reappear.
6. Refresh the browser → both symbols' drawings persist.
7. Open the same chart in a second tab → drawings sync if you draw in either.

- [ ] **Step 13.3: Keyboard shortcuts**

1. Arm a tool → press Esc → tool disarms (cursor icon highlights).
2. Start drawing a 2-click tool (place 1st point) → Esc → in-flight discarded.
3. Click a drawing to select → press Delete → it's gone.

- [ ] **Step 13.4: If anything is broken, file a follow-up note**

For each broken case: a one-line entry in this plan file listing the symptom + suspected file. Do NOT fix during smoke-test — gather everything first, then a single fix pass.

---

## Task 14: Run full test suite + cleanup

- [ ] **Step 14.1: Run all new tests**

Run: `cd apps/web && npx vitest run src/components/charts/drawing-renderers src/stores/drawing-store.spec.ts src/hooks/useCoordinateConverter.spec.ts src/hooks/useDrawingPersistence.spec.ts 2>&1 | tail -20`
Expected: all tests pass.

- [ ] **Step 14.2: Run type-check on the whole web app**

Run: `cd apps/web && npx tsc --noEmit 2>&1 | tail -20`
Expected: no errors. Existing warnings about unrelated files are fine; new code must be clean.

- [ ] **Step 14.3: Lint**

Run: `cd apps/web && npm run lint -- src/components/charts/drawing-renderers src/components/charts/DrawingsOverlay.tsx src/components/charts/DrawingToolbar.tsx src/components/charts/DrawingContextMenu.tsx src/components/charts/TextDrawingInput.tsx src/stores/drawing-store.ts src/hooks/useDrawingPersistence.ts src/hooks/useCoordinateConverter.ts src/types/drawings.ts 2>&1 | tail -10`
Expected: zero errors. Fix any warnings.

- [ ] **Step 14.4: Final commit if cleanup was needed**

```bash
git status
# If files changed beyond what was committed:
git add -A
git commit -m "chore(charts): cleanup post-smoke-test"
```

---

## Done criteria

- All 8 drawing tools work end-to-end (draw, select, drag-move, delete, right-click color/style).
- Drawings persist via localStorage per symbol.
- Switching watchlist symbols swaps drawing sets without leaks.
- All unit + component tests pass.
- `npx tsc --noEmit` is clean for new files.
- `npm run lint` is clean for new files.
- Manual smoke test in Task 13 passes.
