# Chart Drawing Tools — Design Spec

**Date**: 2026-05-11
**Status**: Approved for implementation
**Scope**: v1 — full Groww-parity drawing toolset on the ChartsPage

---

## 1. Goal

Add user-drawn annotations to the candlestick chart on `apps/web/src/pages/charts/ChartsPage.tsx`, matching Groww's drawing-tool feel:

- Horizontal line
- Horizontal zone (price band)
- Trend line (diagonal, 2-point)
- Vertical line (time marker)
- Rectangle (price + time bounds)
- Fibonacci retracement
- Text label
- Arrow

Drawings persist per-symbol via localStorage. v1 is single-browser; backend sync is deferred to a later milestone.

## 2. Constraints

- **Chart library**: `lightweight-charts@4.2.0` (TradingView's open-source library). No native drawing tools — we build our own on top.
- **Compressed-time axis**: `useChartData.ts` gap-collapses overnight/weekend ranges. All drawing time anchors store **real** unix seconds; conversion to compressed time happens only at the rendering boundary via the existing `realTimeMap`.
- **No new heavyweight dependencies**: stay on the current chart stack. Build on the existing overlay pattern (`LevelOverlay`, `ChartZoneOverlay`, `EntryTargetOverlay`).
- **Performance**: drag-edit interactions must stay at 60 fps on a typical laptop. No per-frame React re-renders of the chart tree; drag handlers mutate a Zustand store; the overlay canvas redraws.

## 3. Architecture

### 3.1 Two-layer rendering strategy

| Layer | Used for | Why |
|---|---|---|
| **A — `series.createPriceLine`** (reuse existing pattern) | horizontal line, horizontal zone, Fibonacci levels | Gets right-axis price labels for free with native Indian-locale formatting. Reconciles smoothly via `applyOptions` during drag. Integrates with price-scale autoscaling. |
| **B — Custom canvas overlay** (new) | trend line, vertical line, rectangle, text, arrow, all selection handles & in-flight previews | Tools that need pixel-level freedom or time-axis anchoring. Single canvas blit alongside the chart's own canvas — no SVG/canvas compositing jank. |

### 3.2 Layout

```
ChartsPage
├── DrawingToolbar (NEW, left vertical, Groww-style)
└── Chart container
    ├── <canvas> lightweight-charts (existing)
    ├── <canvas> DrawingsOverlay (NEW; pointer-events toggled by FSM state)
    ├── LevelOverlay (existing)
    ├── ChartZoneOverlay (existing)
    └── EntryTargetOverlay (existing)
```

### 3.3 State ownership

A new Zustand store `drawing-store.ts` (mirrors `chart-store.ts`):

```typescript
interface DrawingState {
  drawings: Record<string, Drawing[]>;   // keyed by token
  selectedId: string | null;
  activeTool: ToolKind | null;           // which toolbar button is armed
  inFlight: Partial<Drawing> | null;     // anchor points being collected mid-draw

  addDrawing: (token: string, d: Drawing) => void;
  updateDrawing: (token: string, id: string, patch: Partial<Drawing>) => void;
  deleteDrawing: (token: string, id: string) => void;
  clearToken: (token: string) => void;
  setActiveTool: (kind: ToolKind | null) => void;
  setSelected: (id: string | null) => void;
}
```

No `persist` middleware — `useDrawingPersistence` handles localStorage explicitly so we can debounce writes and version the schema.

## 4. Data model

`apps/web/src/types/drawings.ts` (NEW):

```typescript
type ToolKind =
  | 'hline' | 'hzone' | 'trend' | 'vline'
  | 'rect' | 'fib' | 'text' | 'arrow';

interface BaseDrawing {
  id: string;                 // crypto.randomUUID()
  createdAt: number;          // Date.now()
  color: string;              // hex, default per kind
  lineWidth: 1 | 2 | 3;
  lineStyle: 'solid' | 'dashed' | 'dotted';
  locked?: boolean;
}

interface HorizontalLineDrawing extends BaseDrawing {
  kind: 'hline';
  price: number;
  label?: string;
}

interface HorizontalZoneDrawing extends BaseDrawing {
  kind: 'hzone';
  upper: number;
  lower: number;
  fillOpacity: number;        // 0..1
  label?: string;
}

interface TrendLineDrawing extends BaseDrawing {
  kind: 'trend';
  p1: { time: number; price: number };   // REAL seconds
  p2: { time: number; price: number };
  extendLeft?: boolean;
  extendRight?: boolean;
}

interface VerticalLineDrawing extends BaseDrawing {
  kind: 'vline';
  time: number;               // REAL seconds
  label?: string;
}

interface RectangleDrawing extends BaseDrawing {
  kind: 'rect';
  p1: { time: number; price: number };
  p2: { time: number; price: number };
  fillOpacity: number;
}

interface FibDrawing extends BaseDrawing {
  kind: 'fib';
  p1: { time: number; price: number };   // 0% anchor
  p2: { time: number; price: number };   // 100% anchor
  levels: number[];           // default [0, 0.236, 0.382, 0.5, 0.618, 0.786, 1]
}

interface TextDrawing extends BaseDrawing {
  kind: 'text';
  anchor: { time: number; price: number };
  text: string;
  fontSize: 10 | 12 | 14 | 16;
}

interface ArrowDrawing extends BaseDrawing {
  kind: 'arrow';
  p1: { time: number; price: number };
  p2: { time: number; price: number };
}

export type Drawing =
  | HorizontalLineDrawing | HorizontalZoneDrawing | TrendLineDrawing
  | VerticalLineDrawing | RectangleDrawing | FibDrawing
  | TextDrawing | ArrowDrawing;
```

**Invariant**: all `time` fields are stored as real unix seconds. The renderer converts to compressed time via `realTimeMap` at the boundary.

## 5. Tool-by-tool spec

| Kind | Create flow | Render | Selection handles | Default style |
|---|---|---|---|---|
| `hline` | click tool → click chart → placed | `createPriceLine` | one drag handle at right edge | cyan `#06b6d4`, 1px solid |
| `hzone` | click tool → click upper → click lower | two `createPriceLine` (edges) + canvas fill | upper-right + lower-right handles | cyan, 15% fill, 1px solid edges |
| `trend` | click tool → click p1 → click p2 | canvas line p1→p2 | two endpoint handles + midpoint translate | yellow `#eab308`, 2px solid |
| `vline` | click tool → click anywhere | canvas vertical x → top-to-bottom | one drag handle at top | slate `#94a3b8`, 1px dashed |
| `rect` | click tool → click p1 → click p2 | canvas strokeRect + fillRect | 4 corners + 4 edge midpoints | cyan, 15% fill, 1px solid |
| `fib` | click tool → click p1 → click p2 | each level via `createPriceLine` (gets axis tag w/ ratio + price) | two anchor handles on canvas | level colors: 0/1 white, 0.236 red, 0.382 orange, 0.5 yellow, 0.618 green, 0.786 blue |
| `text` | click tool → click anchor → inline input → Enter | canvas `fillText` | bounding box, drag to translate, dblclick to re-edit | 12px white |
| `arrow` | click tool → click tail → click head | canvas line + filled triangle at head | two endpoint handles | yellow, 2px |

### 5.1 Common selection/edit UX

- Click an empty area: deselects.
- Esc: deselects + cancels in-flight draw.
- Delete / Backspace: removes selected drawing.
- Right-click on drawing: floating menu with `Color ▸` (swatch grid), `Style ▸` (solid/dashed/dotted, line width 1/2/3), `Lock`, `Delete`.
- Toolbar `↻ Clear all`: confirm modal, wipes drawings for the current token only.
- Hit-test tolerance: 4 CSS pixels (DPR-adjusted).

## 6. Coordinate conversion

A single `useCoordinateConverter` hook is the **only** place that knows about compressed time:

```typescript
interface CoordinateConverter {
  timeToX: (realSec: number) => number | null;   // null when out of loaded range
  xToTime: (px: number) => number | null;        // snaps to nearest loaded bar
  priceToY: (price: number) => number | null;
  yToPrice: (px: number) => number | null;
}
```

- `timeToX`: real seconds → reverse-lookup `realTimeMap` to compressed time → `chart.timeScale().timeToCoordinate(compressed)`.
- `xToTime`: `chart.timeScale().coordinateToTime(px)` → forward-lookup `realTimeMap` to real seconds.
- Price conversions delegate to `series.priceToCoordinate` / `coordinateToPrice` directly (no compression involved on the price axis).

Every renderer is compression-blind; mistakes about real vs. compressed time are impossible at the renderer level.

## 7. Render pipeline

`DrawingsOverlay` redraws when any of these change:
1. **drawings state** — Zustand subscription on current token.
2. **visible logical range** — `chart.timeScale().subscribeVisibleLogicalRangeChange` (a second subscriber alongside the existing `onReachStart`).
3. **container size** — `ResizeObserver`.
4. **new bar arrives** — small notifier ref in `useChartData`.

Render loop:
```
1. Clear canvas (clearRect, DPR-aware).
2. For each drawing in token list:
     switch (kind):
       hline | hzone | fib → reconcile via priceLineRef map:
         absent → createPriceLine + store ref
         present → applyOptions
       others → convert coords → kind-specific canvas renderer
     if id === selectedId, draw handles on canvas
3. For each priceLineRef entry whose drawing was deleted: removePriceLine + delete from map.
4. If an in-flight draw is active, render a ghost preview using current mouse coords as the unfixed end.
```

**Why reconcile, not tear-down**: `createPriceLine` re-creates during drag would flash the right-axis label every mousemove. `applyOptions({ price: newPrice })` updates in place.

## 8. Event handling

The overlay canvas runs a finite state machine:

```
states:
  IDLE         no tool armed, no drag in progress
  DRAWING      tool armed; collecting anchor points
  SELECTED     a drawing is selected; awaiting drag or input
  DRAGGING     actively translating/resizing

transitions:
  IDLE         --tool click-->     DRAWING (armed for kind)
  DRAWING      --canvas click-->   DRAWING (collect next point) or IDLE (commit)
  DRAWING      --Esc-->            IDLE (cancel, discard in-flight)
  IDLE         --click drawing-->  SELECTED
  SELECTED     --empty / Esc-->    IDLE
  SELECTED     --mousedown-->      DRAGGING
  DRAGGING     --mousemove-->      DRAGGING (update geometry via store)
  DRAGGING     --mouseup-->        SELECTED
  SELECTED     --Delete / Bksp-->  IDLE (remove drawing)
```

**pointer-events toggling**: the overlay canvas is `pointer-events: none` in IDLE *unless* the mouse is hovering near an existing drawing (hit-tested on a sibling transparent layer's mousemove). When in DRAWING/SELECTED/DRAGGING, the overlay captures all events. The chart's own pan/zoom/crosshair stay responsive whenever you're not actively interacting with drawings.

**DPR correction**: `(e.clientX - rect.left) * dpr` for all mouse coords so retina screens hit-test correctly.

## 9. Persistence

### 9.1 Storage shape

```
key:   td:drawings:v1:{token}
value: {
  version: 1,
  drawings: Drawing[],
  updatedAt: number
}
```

Per-token keys — not one mega-key — so each write only serializes one symbol's drawings.

### 9.2 Read

On token change: read the key, JSON.parse in try/catch, hydrate the store. Parse failure or version mismatch → log warn, treat as empty (no auto-wipe).

### 9.3 Write

Debounced 500ms after last drawing-state change. `beforeunload` event flushes synchronously. Quota-exceeded errors surface a toast: "Drawing storage full — delete some to save more."

### 9.4 Cross-tab sync

`window.addEventListener('storage', …)` for our key on the active token → re-hydrate. Last-write-wins.

### 9.5 Token edge cases

Blank or `'0'` token → skip persistence; drawings exist in memory only for that session.

## 10. File layout

```
apps/web/src/
├── types/
│   └── drawings.ts                          NEW
├── stores/
│   └── drawing-store.ts                     NEW
├── hooks/
│   ├── useDrawingPersistence.ts             NEW
│   └── useCoordinateConverter.ts            NEW
├── components/charts/
│   ├── DrawingsOverlay.tsx                  NEW
│   ├── DrawingToolbar.tsx                   NEW
│   ├── DrawingContextMenu.tsx               NEW
│   ├── TextDrawingInput.tsx                 NEW
│   └── drawing-renderers/
│       ├── index.ts                         NEW (dispatcher)
│       ├── horizontal.ts                    NEW (createPriceLine adapters)
│       ├── trendLine.ts                     NEW
│       ├── vertical.ts                      NEW
│       ├── rectangle.ts                     NEW
│       ├── fibonacci.ts                     NEW (createPriceLine adapter)
│       ├── text.ts                          NEW
│       ├── arrow.ts                         NEW
│       └── hitTest.ts                       NEW (geometry per kind)
└── pages/charts/
    └── ChartsPage.tsx                       MODIFIED (~15 lines: mount toolbar + overlay)
```

## 11. Testing

### 11.1 Unit (Vitest)

- `hitTest.spec.ts` — geometry per kind. For each of 8 kinds: on-drawing true, 5px-off false, 3px-off true. Edge cases: zero-length trend, rect drawn right-to-left, Fib with p1 above p2.
- `coordinate-converter.spec.ts` — round-trip via compressed time stays within 0.5px; gap-collapse boundaries handled correctly; out-of-range returns `null`.
- `drawing-store.spec.ts` — add/update/delete/clearAll, select/deselect, multi-token isolation, persistence round-trip.

### 11.2 Component (Vitest + Testing Library)

- `DrawingToolbar.spec.tsx` — tool arming, double-click disarms, Clear all confirm.
- `DrawingsOverlay.spec.tsx` — mock chart APIs; assert createPriceLine/applyOptions/removePriceLine called appropriately; token-switch reconciles all drawings.

### 11.3 Explicitly out of scope for v1

- E2E (Playwright) — deferred. Component-level tests cover the contract.
- Canvas pixel screenshot tests — cross-OS flakiness > value.
- Testing `createPriceLine` itself — trust the library.

## 12. Out of scope (deferred to later milestones)

- Backend sync per user (waiting on multi-tenant auth roadmap).
- Drawing templates / save-as-template.
- Drawing groups / multi-select.
- Snap-to-OHLC / snap-to-round-number.
- Pitchfork, Gann, Elliott Wave, channel.
- Undo/redo stack (single-step undo via Ctrl-Z may be added if cheap; full history is v1.1).
- Touch / mobile gesture support (desktop-first; touch in v1.1).

## 13. Success criteria

- All 8 tool kinds draw, select, edit (drag-move + drag-handle-resize), and delete cleanly.
- Drawings persist across refresh on the same browser, scoped to the current symbol.
- Switching between watchlist symbols swaps drawing sets without leaks or flashes.
- Drag-editing maintains 60 fps on a typical laptop (manual smoke test, not automated).
- Drawings stay anchored to their original bars across pan, zoom, timeframe change, and live-tick updates.
- Unit tests for hit-testing and coordinate conversion pass.
