# Immediate + Major S/R Chart Overlay — Design Spec

**Date:** 2026-06-07
**Scope:** Display-only. Surface immediate vs major support/resistance on the charts page by wiring up the existing (unplugged) strong-zone engine. No trade-logic changes — once trusted visually, a later phase wires it into targets/stops.

---

## Background

A P&L audit (388 closed gated-watch trades) showed 91.8% of trades use an arbitrary `fallback-2pct` target because the level book rarely finds structural S/R. Meanwhile a full strong-zone S/R engine already exists and is **never shown on the chart**. This spec plugs it in and frames its output as two trader-meaningful tiers: **immediate** (the next wall) and **major** (the structural wall).

## Current state (verified)

Backend is complete and live:
- `StrongZoneDetectorService` — 3-bar fractal pivots on 15m candles, clustered, scored 0–100 across 6 dimensions, classified STRONG/MEDIUM/WEAK, returns top 5 above + top 5 below LTP sorted by distance, with swap (S→R) detection.
- `GET /api/signals/zones?token=X&exchange=Y` — returns `StrongZone[]`, compute-on-miss + 15m DB cache.
- `useZones(token, exchange)` hook — polls every 60s, returns `{ zones, isLoading, error, refetch }`.
- `ChartZoneOverlay` component — renders zones as lightweight-charts price lines (STRONG solid 2px, MEDIUM dashed 1px, WEAK skipped), red=resistance/green=support, disposed-chart-safe.

The gap: `ChartsPage.tsx` mounts `LevelOverlay` (PDH/PDL/ORH/ORL/VWAP) but never imports `ChartZoneOverlay` nor calls `useZones`. The pieces sit unplugged.

## Tier definitions

Given zones split by LTP into resistances (above) and supports (below), each sorted by distance:

- **Immediate resistance** = nearest resistance zone (smallest distance above), any classification.
- **Immediate support** = nearest support zone (smallest distance below), any classification.
- **Major resistance** = nearest STRONG resistance zone.
- **Major support** = nearest STRONG support zone.

Edge cases:
- If the immediate zone is itself STRONG, it is both immediate and major → single line tagged `IMM·MAJOR R/S`.
- If no STRONG zone exists on a side, there is no major level that side (only immediate shown).
- If no zone exists on a side at all, nothing drawn that side.

## Design (Approach B — wire up + tag the immediate/major pairs)

### 1. Tier classification helper (pure function)
New helper, e.g. `apps/web/src/components/charts/classifyZoneTiers.ts`:
- Input: `zones: StrongZone[]`, `ltp: number`.
- Output: each zone annotated with `tier: 'immediate' | 'major' | 'context'` (and `imMajor: boolean` when a zone is both).
- Logic per definitions above. Pure, unit-testable, no chart dependency.

### 2. Enhance `ChartZoneOverlay`
- Accept a new `ltp: number` prop (needed to compute nearest).
- Run `classifyZoneTiers` internally.
- Visual treatment:
  - **Immediate** (incl. IMM·MAJOR): solid, 3px, brighter shade, title `IMM R` / `IMM S` (or `IMM·MAJOR R/S`). Distance % in title, e.g. `IMM R 2,512 (+0.4%)`.
  - **Major** (STRONG, not nearest): solid, 2px, title `MAJOR R` / `MAJOR S` + distance %.
  - **Context** (MEDIUM, not nearest): dashed, 1px, dimmed, existing strength-score title. WEAK still skipped.
  - Preserve existing swap (S→R) badge behavior.
- Keep existing disposed-chart try/catch and clean teardown.

### 3. Wire `ChartsPage`
- Import `ChartZoneOverlay`.
- Call `useZones(selectedSymbol.token, selectedSymbol.exchange)`.
- Mount alongside the existing `LevelOverlay`, passing `candleSeries={chartRef.current?.candleSeries ?? null}`, `zones`, and current `ltp`.
- Gate by timeframe: only meaningful on 15m (detector basis). On other timeframes, either skip or show context note (see #4).

### 4. Empty / insufficient-data indicator
- When `useZones` returns empty (common per the known Angel daily-session-expiry issue where `getHistoricalData` → `[]`) or `isLoading`/`error`, show a small unobtrusive chip on the chart (e.g. top-left): `S/R: no zones (insufficient data)` vs a normal `S/R: 4 levels`. Prevents a blank overlay from looking like a bug.

## Out of scope (explicitly deferred)
- Any trade-logic use of zones (targets, room-to-target entry gate, stop placement). Tracked in `docs/watch-improvement-backlog.md`.
- Text readout strip beside the chart (Approach C).
- A cron to keep the zone cache warm (compute-on-miss is adequate for on-demand chart loads).

## Testing
- Unit: `classifyZoneTiers` — immediate/major/context assignment, IMM·MAJOR collapse, empty-side cases, all-weak case.
- Manual (verify skill): load charts for a liquid symbol at 15m, confirm immediate + major lines render with correct tags and distances; confirm a symbol with no candle history shows the "insufficient data" chip, not a blank/broken overlay.

## Success criteria
On the 15m charts page, for a symbol with sufficient history, the trader sees at a glance: nearest resistance + nearest support (immediate), and the structural STRONG walls (major), each tagged with price and % distance — enough to judge "is there room for this trade" by eye, before any automated wiring.
