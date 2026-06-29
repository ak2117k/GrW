# Immediate + Major S/R Chart Overlay Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Surface immediate vs major support/resistance on the 15m charts page by wiring up the existing (unplugged) strong-zone S/R engine, tagging the nearest wall each side as `IMM` and the structural STRONG walls as `MAJOR`.

**Architecture:** Display-only. A new pure helper (`classifyZoneTiers`) annotates each `StrongZone` with a tier relative to the live price. The existing `ChartZoneOverlay` is upgraded to consume those tiers (distinct width/color/title). `ChartsPage` calls the existing `useZones` hook and mounts the overlay, gated to the 15m timeframe, plus a small status chip so an empty overlay (known Angel session-expiry → empty candles) reads as "no zones" rather than a bug. No trade-logic changes.

**Tech Stack:** React 18 + TypeScript, Vite, lightweight-charts, Vitest (node env, no jsdom — pure-function tests only).

**Spec:** `docs/superpowers/specs/2026-06-07-immediate-major-sr-chart-overlay-design.md`

---

## File Structure

- **Create** `apps/web/src/components/charts/classifyZoneTiers.ts` — pure helper: given `StrongZone[]` + `ltp`, returns per-zone tier annotations (`immediate` / `major` / `context`) with reachable-edge reference price and signed % distance. Single responsibility, no chart dependency, fully unit-tested.
- **Create** `apps/web/src/components/charts/classifyZoneTiers.test.ts` — Vitest unit tests for the helper.
- **Modify** `apps/web/src/components/charts/ChartZoneOverlay.tsx` — add `ltp` prop, render via `classifyZoneTiers`, new tier-based style + title (IMM / MAJOR / strength), labeled line at the reachable edge + thin band edge.
- **Modify** `apps/web/src/pages/charts/ChartsPage.tsx` — call `useZones`, derive `ltp`, mount `ChartZoneOverlay` (15m only), render the S/R status chip.

**Notes for the implementer (codebase conventions):**
- `StrongZone` type lives at `apps/web/src/types/index.ts:131`. Fields used here: `type` (`'support'|'resistance'`), `upper`, `lower`, `isLine`, `classification` (`'STRONG'|'MEDIUM'|'WEAK'`), `strength` (0–100 int), `flippedAt?`, `wasType?`.
- `lineWidth` accepted by lightweight-charts price lines is `1 | 2 | 3 | 4`. `lineStyle` numeric: `0 = solid`, `2 = dashed` (convention already used in this file).
- Color convention in this codebase: resistance red `#ef4444`, support green `#22c55e`. We modulate **alpha** (`cc`, `66` hex suffix) for tier emphasis, never the hue — red always means resistance.
- WEAK zones are never drawn (existing behavior) — the helper filters them out, so "immediate" never points at an invisible level.
- `currentPrice` from `useChartData` is `number | null` (`apps/web/src/hooks/useChartData.ts:27`); fall back to the last candle close when null.
- The charts page imports overlay components **directly** (e.g. `LevelOverlay`), not via the `charts/index.ts` barrel — follow that pattern; no barrel edit needed.

---

## Task 1: `classifyZoneTiers` pure helper (TDD)

**Files:**
- Create: `apps/web/src/components/charts/classifyZoneTiers.ts`
- Test: `apps/web/src/components/charts/classifyZoneTiers.test.ts`

- [ ] **Step 1: Write the failing test**

Create `apps/web/src/components/charts/classifyZoneTiers.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import type { StrongZone } from '@/types';
import { classifyZoneTiers } from './classifyZoneTiers';

// Minimal StrongZone factory — only the fields the helper reads matter.
function zone(p: Partial<StrongZone> & {
  type: 'support' | 'resistance';
  classification: 'STRONG' | 'MEDIUM' | 'WEAK';
  upper: number;
  lower: number;
}): StrongZone {
  return {
    id: `${p.type}-${p.upper}`,
    token: '1',
    symbol: 'TEST',
    exchange: 'NSE',
    isLine: p.isLine ?? true,
    strength: p.strength ?? 50,
    touchCount: 3,
    lastTouchTimestamp: 0,
    scoreBreakdown: {
      touchCount: 0, reversalScore: 0, volumeScore: 0,
      recencyScore: 0, confluenceBonus: 0, wickDensity: 0,
    },
    computedAt: 0,
    expiresAt: 0,
    ...p,
  };
}

describe('classifyZoneTiers', () => {
  it('returns [] when ltp is not positive', () => {
    const zones = [zone({ type: 'resistance', classification: 'STRONG', upper: 110, lower: 110 })];
    expect(classifyZoneTiers(zones, 0)).toEqual([]);
    expect(classifyZoneTiers(zones, -5)).toEqual([]);
    expect(classifyZoneTiers(zones, NaN)).toEqual([]);
  });

  it('returns [] for empty input', () => {
    expect(classifyZoneTiers([], 100)).toEqual([]);
  });

  it('drops WEAK zones entirely', () => {
    const zones = [zone({ type: 'resistance', classification: 'WEAK', upper: 110, lower: 110 })];
    expect(classifyZoneTiers(zones, 100)).toEqual([]);
  });

  it('marks the single resistance and single support both as immediate', () => {
    const zones = [
      zone({ type: 'resistance', classification: 'MEDIUM', upper: 110, lower: 110 }),
      zone({ type: 'support', classification: 'MEDIUM', upper: 90, lower: 90 }),
    ];
    const out = classifyZoneTiers(zones, 100);
    const r = out.find((a) => a.zone.type === 'resistance')!;
    const s = out.find((a) => a.zone.type === 'support')!;
    expect(r.tier).toBe('immediate');
    expect(s.tier).toBe('immediate');
    expect(r.isImmediate).toBe(true);
    expect(s.isImmediate).toBe(true);
  });

  it('signs distancePct: + above price, - below', () => {
    const zones = [
      zone({ type: 'resistance', classification: 'MEDIUM', upper: 102, lower: 102 }),
      zone({ type: 'support', classification: 'MEDIUM', upper: 98, lower: 98 }),
    ];
    const out = classifyZoneTiers(zones, 100);
    expect(out.find((a) => a.zone.type === 'resistance')!.distancePct).toBeCloseTo(2, 5);
    expect(out.find((a) => a.zone.type === 'support')!.distancePct).toBeCloseTo(-2, 5);
  });

  it('nearer MEDIUM is immediate, farther STRONG is major (same side)', () => {
    const near = zone({ type: 'resistance', classification: 'MEDIUM', upper: 105, lower: 105 });
    const far = zone({ type: 'resistance', classification: 'STRONG', upper: 120, lower: 120 });
    const out = classifyZoneTiers([near, far], 100);
    const nearA = out.find((a) => a.zone.upper === 105)!;
    const farA = out.find((a) => a.zone.upper === 120)!;
    expect(nearA.tier).toBe('immediate');
    expect(nearA.isImmediate).toBe(true);
    expect(nearA.isMajor).toBe(false);
    expect(farA.tier).toBe('major');
    expect(farA.isMajor).toBe(true);
  });

  it('when the nearest zone is STRONG it is both immediate and major', () => {
    const out = classifyZoneTiers(
      [zone({ type: 'resistance', classification: 'STRONG', upper: 105, lower: 105 })],
      100,
    );
    expect(out[0].isImmediate).toBe(true);
    expect(out[0].isMajor).toBe(true);
    expect(out[0].tier).toBe('immediate');
  });

  it('uses the reachable band edge: lower edge for resistance, upper for support', () => {
    const res = zone({ type: 'resistance', classification: 'MEDIUM', upper: 115, lower: 110, isLine: false });
    const sup = zone({ type: 'support', classification: 'MEDIUM', upper: 90, lower: 85, isLine: false });
    const out = classifyZoneTiers([res, sup], 100);
    expect(out.find((a) => a.zone.type === 'resistance')!.refPrice).toBe(110);
    expect(out.find((a) => a.zone.type === 'support')!.refPrice).toBe(90);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd apps/web && npx vitest run src/components/charts/classifyZoneTiers.test.ts`
Expected: FAIL — `Failed to resolve import "./classifyZoneTiers"` / "classifyZoneTiers is not a function".

- [ ] **Step 3: Write the minimal implementation**

Create `apps/web/src/components/charts/classifyZoneTiers.ts`:

```ts
import type { StrongZone } from '@/types';

export type ZoneTier = 'immediate' | 'major' | 'context';

export interface ZoneTierAnnotation {
  zone: StrongZone;
  tier: ZoneTier;
  /** True when this is the nearest drawable zone on its side of the LTP. */
  isImmediate: boolean;
  /** True when this is the nearest STRONG zone on its side of the LTP. */
  isMajor: boolean;
  /** The band edge price reaches first coming from the LTP (== center for lines). */
  refPrice: number;
  /** Signed % distance from LTP. + = above price, - = below. */
  distancePct: number;
}

/** The band edge a mover reaches first coming from the LTP side. */
function refPriceFor(zone: StrongZone): number {
  if (zone.isLine) return zone.upper; // upper === lower for a line
  // Resistance sits above price → its LOWER edge is hit first.
  // Support sits below price → its UPPER edge is hit first.
  return zone.type === 'resistance' ? zone.lower : zone.upper;
}

/**
 * Annotate strong zones into two trader tiers relative to the live price:
 *  - immediate = nearest drawable (non-WEAK) zone on each side (the next wall)
 *  - major     = nearest STRONG zone on each side (the structural wall)
 * A zone can be both (nearest is STRONG) — `tier` is 'immediate' but
 * `isMajor` is also true so the renderer can tag it `IMM·MAJOR`.
 *
 * WEAK zones are dropped (never drawn, too unreliable to call a "wall").
 * Returns [] when ltp is not a positive number.
 */
export function classifyZoneTiers(
  zones: StrongZone[],
  ltp: number,
): ZoneTierAnnotation[] {
  if (!Number.isFinite(ltp) || ltp <= 0) return [];

  const drawable = zones.filter((z) => z.classification !== 'WEAK');

  const above: StrongZone[] = [];
  const below: StrongZone[] = [];
  for (const z of drawable) {
    const ref = refPriceFor(z);
    if (ref > ltp) above.push(z);
    else below.push(z); // ref <= ltp → treat as support side deterministically
  }

  const annotateSide = (side: StrongZone[]): ZoneTierAnnotation[] => {
    if (side.length === 0) return [];
    const rows = side.map((zone) => {
      const refPrice = refPriceFor(zone);
      return {
        zone,
        refPrice,
        distancePct: ((refPrice - ltp) / ltp) * 100,
        absDist: Math.abs(refPrice - ltp),
      };
    });

    let nearestIdx = 0;
    for (let i = 1; i < rows.length; i++) {
      if (rows[i].absDist < rows[nearestIdx].absDist) nearestIdx = i;
    }

    let strongIdx = -1;
    for (let i = 0; i < rows.length; i++) {
      if (rows[i].zone.classification !== 'STRONG') continue;
      if (strongIdx === -1 || rows[i].absDist < rows[strongIdx].absDist) {
        strongIdx = i;
      }
    }

    return rows.map((d, i) => {
      const isImmediate = i === nearestIdx;
      const isMajor = i === strongIdx;
      const tier: ZoneTier = isImmediate
        ? 'immediate'
        : isMajor
          ? 'major'
          : 'context';
      return {
        zone: d.zone,
        tier,
        isImmediate,
        isMajor,
        refPrice: d.refPrice,
        distancePct: d.distancePct,
      };
    });
  };

  return [...annotateSide(above), ...annotateSide(below)];
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd apps/web && npx vitest run src/components/charts/classifyZoneTiers.test.ts`
Expected: PASS — 8 tests passing.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/components/charts/classifyZoneTiers.ts apps/web/src/components/charts/classifyZoneTiers.test.ts
git commit -m "feat(charts): classifyZoneTiers helper for immediate/major S/R tiers"
```

---

## Task 2: Upgrade `ChartZoneOverlay` to render tiers

**Files:**
- Modify: `apps/web/src/components/charts/ChartZoneOverlay.tsx` (full rewrite of props + render logic; keep `safeCreatePriceLine`/`safeRemovePriceLine`)

- [ ] **Step 1: Replace the props interface and style/title helpers**

In `apps/web/src/components/charts/ChartZoneOverlay.tsx`, replace the import block and the `ChartZoneOverlayProps`, `StyleSpec`, `styleFor`, and `formatTitle` definitions (the current lines 1–57) with:

```tsx
import { useEffect, useRef } from 'react';
import type { IPriceLine, ISeriesApi } from 'lightweight-charts';
import type { StrongZone } from '@/types';
import { classifyZoneTiers, type ZoneTierAnnotation } from './classifyZoneTiers';

interface ChartZoneOverlayProps {
  candleSeries: ISeriesApi<'Candlestick'> | null;
  zones: StrongZone[];
  /** Live price — required to compute nearest (immediate) walls. */
  ltp: number;
}

interface StyleSpec {
  color: string;
  lineWidth: 1 | 2 | 3;
  // 0 = solid, 2 = dashed (lightweight-charts LineStyle numeric convention).
  lineStyle: 0 | 2;
}

/**
 * Tier drives emphasis; hue always encodes role (red = resistance,
 * green = support). We modulate alpha, never hue.
 *   immediate → solid, 3px, full opacity   (the next wall)
 *   major     → solid, 2px, ~80% opacity    (structural STRONG wall)
 *   context   → dashed, 1px, ~40% opacity   (other MEDIUM levels)
 */
function styleForTier(a: ZoneTierAnnotation): StyleSpec {
  const base = a.zone.type === 'resistance' ? '#ef4444' : '#22c55e';
  if (a.tier === 'immediate') return { color: base, lineWidth: 3, lineStyle: 0 };
  if (a.tier === 'major') return { color: `${base}cc`, lineWidth: 2, lineStyle: 0 };
  return { color: `${base}66`, lineWidth: 1, lineStyle: 2 };
}

/** e.g. "IMM R 2,512 (+0.4%)", "MAJOR S 2,440 (-2.9%)", "R 2,540 (S55)". */
function tierTitle(a: ZoneTierAnnotation): string {
  const role = a.zone.type === 'resistance' ? 'R' : 'S';
  // Swap-aware prefix preserved from the original overlay.
  const flip =
    a.zone.flippedAt && a.zone.wasType
      ? a.zone.wasType === 'support'
        ? 'S→R '
        : 'R→S '
      : '';
  let tag: string;
  if (a.isImmediate && a.isMajor) tag = 'IMM·MAJOR';
  else if (a.isImmediate) tag = 'IMM';
  else if (a.isMajor) tag = 'MAJOR';
  else tag = `S${a.zone.strength}`; // context keeps the strength score
  const priceStr = a.refPrice.toLocaleString('en-IN', {
    minimumFractionDigits: 0,
    maximumFractionDigits: 2,
  });
  const sign = a.distancePct >= 0 ? '+' : '';
  // For context lines the strength tag already carries info; show distance for
  // immediate/major where it drives the "room to target" judgement.
  const dist =
    a.isImmediate || a.isMajor ? ` (${sign}${a.distancePct.toFixed(1)}%)` : '';
  return `${flip}${tag} ${role} ${priceStr}${dist}`;
}
```

- [ ] **Step 2: Replace the render effect to iterate annotations**

In the same file, replace the component body (current `export default function ChartZoneOverlay({ candleSeries, zones }: ...)` through its closing `}`, currently lines 104–180) with:

```tsx
/**
 * Renders immediate/major/context S/R as horizontal price lines on the
 * candlestick series. Pure side-effect component — returns null.
 *
 * Each zone draws ONE labeled line at its reachable edge (`refPrice`), plus —
 * for bands (isLine === false) — a thin dashed unlabeled line at the far edge
 * so the band's width is visible. WEAK zones are dropped by classifyZoneTiers.
 *
 * On every input change we tear down previously-drawn lines and recreate.
 * Cheap (≤ ~20 lines for top 5+5 zones) and avoids stale reconciliation bugs.
 */
export default function ChartZoneOverlay({
  candleSeries,
  zones,
  ltp,
}: ChartZoneOverlayProps) {
  const linesRef = useRef<IPriceLine[]>([]);

  useEffect(() => {
    if (!candleSeries) return;
    const series = candleSeries;

    // 1. Tear down anything drawn previously.
    for (const line of linesRef.current) {
      safeRemovePriceLine(series, line);
    }
    linesRef.current = [];

    // 2. Draw tier-annotated zones.
    const annotations = classifyZoneTiers(zones, ltp);
    for (const a of annotations) {
      const style = styleForTier(a);

      const labeled = safeCreatePriceLine(series, {
        price: a.refPrice,
        color: style.color,
        lineWidth: style.lineWidth,
        lineStyle: style.lineStyle,
        axisLabelVisible: true,
        title: tierTitle(a),
      });
      if (labeled) linesRef.current.push(labeled);

      // Band: draw the far edge thin + dashed + unlabeled to show width.
      if (!a.zone.isLine) {
        const farEdge =
          a.zone.type === 'resistance' ? a.zone.upper : a.zone.lower;
        if (farEdge !== a.refPrice) {
          const edge = safeCreatePriceLine(series, {
            price: farEdge,
            color: `${a.zone.type === 'resistance' ? '#ef4444' : '#22c55e'}66`,
            lineWidth: 1,
            lineStyle: 2, // dashed
            axisLabelVisible: false,
            title: '',
          });
          if (edge) linesRef.current.push(edge);
        }
      }
    }

    // 3. Cleanup on unmount or before the next update.
    return () => {
      for (const line of linesRef.current) {
        safeRemovePriceLine(series, line);
      }
      linesRef.current = [];
    };
  }, [candleSeries, zones, ltp]);

  return null;
}
```

- [ ] **Step 3: Type-check the change**

Run: `cd apps/web && npx tsc -b --noEmit`
Expected: PASS — no type errors. (If `tsc -b --noEmit` reports "referenced project may not disable emit", use `npx tsc --noEmit -p tsconfig.json` instead.)

- [ ] **Step 4: Run the existing helper test to confirm nothing regressed**

Run: `cd apps/web && npx vitest run src/components/charts/classifyZoneTiers.test.ts`
Expected: PASS — still 8 tests passing (the overlay imports the helper; this catches an accidental break in the import path).

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/components/charts/ChartZoneOverlay.tsx
git commit -m "feat(charts): tier-aware ChartZoneOverlay (immediate/major/context lines)"
```

---

## Task 3: Wire the overlay + status chip into `ChartsPage`

**Files:**
- Modify: `apps/web/src/pages/charts/ChartsPage.tsx`

- [ ] **Step 1: Add the imports**

In `apps/web/src/pages/charts/ChartsPage.tsx`, after the existing `import EntryTargetOverlay ...` line (line 8), add:

```tsx
import ChartZoneOverlay from '@/components/charts/ChartZoneOverlay';
import { classifyZoneTiers } from '@/components/charts/classifyZoneTiers';
import { useZones } from '@/hooks/useZones';
```

- [ ] **Step 2: Call useZones and derive ltp + chip state**

In the same file, immediately after the `useDrawingPersistence(selectedSymbol.token);` line (currently line 211), add:

```tsx
  // Strong-zone S/R (display-only). Polls /signals/zones every 60s.
  const {
    zones,
    isLoading: zonesLoading,
  } = useZones(selectedSymbol.token, selectedSymbol.exchange);

  // Live price for nearest-wall computation; fall back to last candle close
  // (currentPrice is null pre-feed / outside market hours).
  const ltp = useMemo(() => {
    if (currentPrice && currentPrice > 0) return currentPrice;
    return candles.length > 0 ? candles[candles.length - 1].close : 0;
  }, [currentPrice, candles]);

  // Count of drawable (non-WEAK) tiered levels — drives the status chip.
  const srLevelCount = useMemo(
    () => classifyZoneTiers(zones, ltp).length,
    [zones, ltp],
  );
```

- [ ] **Step 3: Mount the overlay (15m only)**

In the same file, directly after the always-on analysis `LevelOverlay` block (the `{!setupContext && analysisOverlayLevels.length > 0 && ( ... )}` block ending at line 404), add:

```tsx
          {/* Strong-zone S/R overlay — immediate (next wall) + major (STRONG
              structural) tiers. Detector basis is 15m, so only render there. */}
          {timeframe === '15m' && ltp > 0 && (
            <ChartZoneOverlay
              candleSeries={chartRef.current?.candleSeries ?? null}
              zones={zones}
              ltp={ltp}
            />
          )}
```

- [ ] **Step 4: Add the status chip**

In the same file, directly before the `{/* Watermark */}` comment (currently line 426), add:

```tsx
          {/* S/R status chip — an empty overlay is normal when candle history
              is insufficient (e.g. Angel daily session expiry). Surface that
              explicitly so a blank chart doesn't look like a bug. */}
          {timeframe === '15m' && (
            <div className="absolute top-3 right-3 z-20 rounded-full bg-[var(--color-bg-secondary)]/90 px-3 py-1 text-[11px] font-medium text-[var(--color-text-secondary)] shadow backdrop-blur-sm">
              {zonesLoading && zones.length === 0
                ? 'S/R: loading…'
                : srLevelCount > 0
                  ? `S/R: ${srLevelCount} levels`
                  : 'S/R: no zones (insufficient data)'}
            </div>
          )}
```

- [ ] **Step 5: Type-check**

Run: `cd apps/web && npx tsc -b --noEmit`
Expected: PASS — no type errors. (Fallback: `npx tsc --noEmit -p tsconfig.json`.)

- [ ] **Step 6: Lint the touched files**

Run: `cd apps/web && npx eslint src/pages/charts/ChartsPage.tsx src/components/charts/ChartZoneOverlay.tsx src/components/charts/classifyZoneTiers.ts`
Expected: PASS — no errors.

- [ ] **Step 7: Commit**

```bash
git add apps/web/src/pages/charts/ChartsPage.tsx
git commit -m "feat(charts): mount tiered S/R overlay + status chip on charts page (15m)"
```

---

## Task 4: End-to-end manual verification

**Files:** none (verification only)

- [ ] **Step 1: Confirm app is running**

The app runs via `pnpm dev` (web :4000, api :4001). Verify both are up:
Run: `netstat -ano | findstr ":4000 :4001" | findstr LISTENING`
Expected: both ports LISTENING. If not, start with `pnpm dev` from the repo root and wait for Vite + Nest to boot.

- [ ] **Step 2: Verify the zones API returns data for a liquid symbol**

Run: `curl -s "http://127.0.0.1:4001/api/signals/zones?token=99926009&exchange=NSE"`
Expected: a JSON array (possibly empty). If empty, S/R is genuinely unavailable for that token right now (insufficient 15m history / session expiry) — pick a liquid equity token with history, or note the "insufficient data" path is the expected display.

- [ ] **Step 3: Eyeball the chart (use the `verify` or `run` skill)**

Open `http://localhost:4000/charts?symbol=BANKNIFTY&token=99926009&exchange=NSE&tf=15m`. Confirm:
  - The S/R status chip (top-right) shows either `S/R: N levels` or `S/R: no zones (insufficient data)` — never a blank/broken overlay.
  - When levels exist: the nearest resistance + nearest support render as solid 3px lines tagged `IMM R …(+x%)` / `IMM S …(-x%)`; STRONG far levels render solid 2px tagged `MAJOR …`; other MEDIUM levels render thin dashed with their `S<score>` tag.
  - Switch the timeframe away from 15m → the S/R lines and chip disappear. Switch back → they return.
  - Switch symbols rapidly → no console "Object is disposed" crashes (safeCreate/Remove guards).

- [ ] **Step 4: Confirm the deferred scope is untouched**

Confirm no changes were made to target/stop/entry logic: `git diff --stat main -- apps/api` should show no API changes from this branch.
Expected: empty (this feature is frontend-only).

---

## Self-Review (completed during planning)

- **Spec coverage:** Tier definitions → Task 1. Overlay tagging/visual treatment → Task 2. Wire-up + 15m gating → Task 3 steps 2–3. Empty/insufficient-data chip → Task 3 step 4. Manual verification of the success criterion ("judge room to target by eye") → Task 4 step 3. Deferred trade-logic scope → Task 4 step 4 guard. All spec sections mapped.
- **Placeholders:** none — all code blocks complete, all commands concrete with expected output.
- **Type consistency:** `classifyZoneTiers(zones, ltp): ZoneTierAnnotation[]` and `ZoneTierAnnotation` fields (`tier`, `isImmediate`, `isMajor`, `refPrice`, `distancePct`) are defined in Task 1 and consumed identically in Task 2 (`styleForTier`, `tierTitle`) and Task 3 (`srLevelCount`). `ChartZoneOverlay` prop set (`candleSeries`, `zones`, `ltp`) defined in Task 2 matches the mount in Task 3. `useZones` returns `{ zones, isLoading }` (verified against the hook source).
