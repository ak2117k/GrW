# Unified S/R Decision Read — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Synthesize one "nearest resistance above / nearest support below" S/R read from BOTH the always-present anchored levels (PDH/PDL/ORH/ORL/VWAP) and the pivot zones, so a moving stock always shows an actionable trade-decision readout — and surface freshly-flipped (forming) pivot levels instead of hiding them.

**Architecture:** Frontend-only. A new pure helper `buildSRView` unifies the level book + pivot zones into a tiered S/R view and drives an upgraded status chip (the decision readout). `classifyZoneTiers`/`ChartZoneOverlay` gain a `forming` tier so flipped pivot levels draw as dotted lines. No backend changes.

**Tech Stack:** React + TypeScript, Vite, lightweight-charts, Vitest (node env, pure-function tests).

**Spec:** `docs/superpowers/specs/2026-06-08-unified-sr-decision-read-design.md`

---

## File Structure
- **Create** `apps/web/src/components/charts/buildSRView.ts` — pure helper unifying `LevelsSnapshot` anchored levels + `StrongZone[]` pivots into `{ immediateResistance, immediateSupport, levels }`. Single responsibility, fully tested.
- **Create** `apps/web/src/components/charts/buildSRView.test.ts` — Vitest unit tests.
- **Modify** `apps/web/src/components/charts/classifyZoneTiers.ts` — keep flipped-WEAK zones, add `forming` tier (additive; existing behavior for non-flipped unchanged).
- **Modify** `apps/web/src/components/charts/classifyZoneTiers.test.ts` — add forming coverage.
- **Modify** `apps/web/src/components/charts/ChartZoneOverlay.tsx` — render the `forming` tier (dotted, `FORMING` tag).
- **Modify** `apps/web/src/pages/charts/ChartsPage.tsx` — wire `buildSRView` into the chip as the decision readout.

**Conventions:**
- `LevelsSnapshot` (the level book) is at `apps/web/src/components/stock-overview/SetupContextCard.tsx`: `{ pdh: number; pdl: number; orh: number|null; orl: number|null; vwap: number; todayHigh; todayLow; atr14; prevOrh?: number|null; prevOrl?: number|null }`. In `ChartsPage` it's `analysis.levels`.
- `StrongZone` at `apps/web/src/types/index.ts:131` (`type, upper, lower, isLine, classification, strength, flippedAt?, wasType?`).
- lightweight-charts `lineStyle`: 0 solid, 1 dotted, 2 dashed.

---

## Task 1: `buildSRView` pure helper (TDD)

**Files:**
- Create: `apps/web/src/components/charts/buildSRView.ts`
- Test: `apps/web/src/components/charts/buildSRView.test.ts`

- [ ] **Step 1: Write the failing test**

Create `apps/web/src/components/charts/buildSRView.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import type { StrongZone } from '@/types';
import { buildSRView, type LevelBookLite } from './buildSRView';

function zone(p: Partial<StrongZone> & {
  type: 'support' | 'resistance';
  classification: 'STRONG' | 'MEDIUM' | 'WEAK';
  upper: number; lower: number;
}): StrongZone {
  return {
    id: `${p.type}-${p.upper}`, token: '1', symbol: 'T', exchange: 'NSE',
    isLine: p.isLine ?? true, strength: p.strength ?? 50, touchCount: 3,
    lastTouchTimestamp: 0,
    scoreBreakdown: { touchCount: 0, reversalScore: 0, volumeScore: 0, recencyScore: 0, confluenceBonus: 0, wickDensity: 0 },
    computedAt: 0, expiresAt: 0, ...p,
  };
}

const emptyBook: LevelBookLite = {
  pdh: null, pdl: null, orh: null, orl: null, prevOrh: null, prevOrl: null, vwap: 0,
};

describe('buildSRView', () => {
  it('returns empty view when ltp <= 0', () => {
    const v = buildSRView({ ...emptyBook, pdh: 110 }, [], 0);
    expect(v.immediateResistance).toBeNull();
    expect(v.immediateSupport).toBeNull();
    expect(v.levels).toEqual([]);
  });

  it('anchored-only (no zones) still yields immediate R and S', () => {
    const book: LevelBookLite = { ...emptyBook, pdh: 110, pdl: 90, vwap: 105 };
    const v = buildSRView(book, [], 100);
    expect(v.immediateResistance?.price).toBe(105); // VWAP nearer than PDH
    expect(v.immediateResistance?.source).toBe('VWAP');
    expect(v.immediateSupport?.price).toBe(90);
    expect(v.immediateSupport?.source).toBe('PDL');
  });

  it('signs distancePct: + above, - below', () => {
    const v = buildSRView({ ...emptyBook, pdh: 102, pdl: 98 }, [], 100);
    expect(v.immediateResistance?.distancePct).toBeCloseTo(2, 5);
    expect(v.immediateSupport?.distancePct).toBeCloseTo(-2, 5);
  });

  it('nearest can be a pivot zone (mixes sources)', () => {
    const book: LevelBookLite = { ...emptyBook, pdh: 120 };
    const piv = zone({ type: 'resistance', classification: 'MEDIUM', upper: 105, lower: 105 });
    const v = buildSRView(book, [piv], 100);
    expect(v.immediateResistance?.source).toBe('PIVOT');
    expect(v.immediateResistance?.price).toBe(105);
  });

  it('uses pivot reachable edge: lower for resistance, upper for support', () => {
    const res = zone({ type: 'resistance', classification: 'MEDIUM', upper: 115, lower: 110, isLine: false });
    const v = buildSRView(emptyBook, [res], 100);
    expect(v.immediateResistance?.price).toBe(110);
  });

  it('includes a flipped (forming) WEAK pivot but excludes non-flipped WEAK', () => {
    const formingSup = zone({ type: 'support', classification: 'WEAK', upper: 95, lower: 95, flippedAt: 1, wasType: 'resistance' });
    const noiseSup = zone({ type: 'support', classification: 'WEAK', upper: 96, lower: 96 });
    const v = buildSRView(emptyBook, [formingSup, noiseSup], 100);
    // forming (95) is included; non-flipped weak (96, nearer) is excluded
    expect(v.immediateSupport?.price).toBe(95);
    expect(v.levels.some((l) => l.source === 'PIVOT' && l.price === 96)).toBe(false);
  });

  it('major tier = STRONG pivots + PDH/PDL (non-immediate)', () => {
    const book: LevelBookLite = { ...emptyBook, pdh: 130, pdl: 70, vwap: 101 };
    const strongRes = zone({ type: 'resistance', classification: 'STRONG', upper: 120, lower: 120 });
    const v = buildSRView(book, [strongRes], 100);
    // VWAP 101 is immediate R; PDH 130 and STRONG 120 are major
    const pdh = v.levels.find((l) => l.source === 'PDH')!;
    const strong = v.levels.find((l) => l.source === 'PIVOT')!;
    expect(pdh.tier).toBe('major');
    expect(strong.tier).toBe('major');
    expect(v.immediateResistance?.source).toBe('VWAP');
  });

  it('falls back to prevOrh/prevOrl when orh/orl are null, labelled ORH/ORL', () => {
    const book: LevelBookLite = { ...emptyBook, orh: null, orl: null, prevOrh: 108, prevOrl: 92 };
    const v = buildSRView(book, [], 100);
    expect(v.immediateResistance?.source).toBe('ORH');
    expect(v.immediateResistance?.price).toBe(108);
    expect(v.immediateSupport?.source).toBe('ORL');
    expect(v.immediateSupport?.price).toBe(92);
  });

  it('one-sided: only resistances above → immediateSupport null', () => {
    const v = buildSRView({ ...emptyBook, pdh: 110, orh: 120 }, [], 100);
    expect(v.immediateResistance).not.toBeNull();
    expect(v.immediateSupport).toBeNull();
  });

  it('dedupes anchored vs pivot at the same price (keeps anchored label)', () => {
    const book: LevelBookLite = { ...emptyBook, pdh: 110 };
    const pivAtPdh = zone({ type: 'resistance', classification: 'MEDIUM', upper: 110, lower: 110 });
    const v = buildSRView(book, [pivAtPdh], 100);
    const at110 = v.levels.filter((l) => Math.abs(l.price - 110) < 0.01);
    expect(at110).toHaveLength(1);
    expect(at110[0].source).toBe('PDH');
  });
});
```

- [ ] **Step 2: Run the test, confirm it FAILS**

Run: `cd apps/web && npx vitest run src/components/charts/buildSRView.test.ts`
Expected: FAIL — cannot resolve `./buildSRView`.

- [ ] **Step 3: Write the implementation**

Create `apps/web/src/components/charts/buildSRView.ts`:

```ts
import type { StrongZone } from '@/types';

export type SRSource = 'PDH' | 'PDL' | 'ORH' | 'ORL' | 'VWAP' | 'PIVOT';
export type SRTier = 'immediate' | 'major' | 'context';

export interface SRLevel {
  price: number;
  side: 'resistance' | 'support';
  source: SRSource;
  label: string;
  tier: SRTier;
  distancePct: number;
  classification?: 'STRONG' | 'MEDIUM' | 'WEAK';
}

export interface SRView {
  immediateResistance: SRLevel | null;
  immediateSupport: SRLevel | null;
  levels: SRLevel[];
}

/** Minimal level-book shape (structurally satisfied by AnalysisDto.levels). */
export interface LevelBookLite {
  pdh: number | null;
  pdl: number | null;
  orh: number | null;
  orl: number | null;
  prevOrh?: number | null;
  prevOrl?: number | null;
  vwap: number;
}

const DEDUPE_EPS_PCT = 0.05; // 0.05% — treat anchored & pivot within this as one

/** Pivot reachable edge: resistance hits its lower edge first, support its upper. */
function pivotRefPrice(z: StrongZone): number {
  if (z.isLine) return z.upper;
  return z.type === 'resistance' ? z.lower : z.upper;
}

interface Candidate {
  price: number;
  source: SRSource;
  label: string;
  isStructural: boolean; // STRONG pivot, or PDH/PDL — eligible for `major`
  classification?: 'STRONG' | 'MEDIUM' | 'WEAK';
}

export function buildSRView(
  book: LevelBookLite | null,
  zones: StrongZone[],
  ltp: number,
): SRView {
  if (!Number.isFinite(ltp) || ltp <= 0) {
    return { immediateResistance: null, immediateSupport: null, levels: [] };
  }

  const candidates: Candidate[] = [];

  // Anchored levels (single prices). PDH/PDL are structural (daily).
  if (book) {
    const push = (price: number | null | undefined, source: SRSource, label: string, structural: boolean) => {
      if (price != null && price > 0) candidates.push({ price, source, label, isStructural: structural });
    };
    push(book.pdh, 'PDH', 'PDH', true);
    push(book.pdl, 'PDL', 'PDL', true);
    // ORH/ORL with prev-session fallback; keep the ORH/ORL identity either way.
    push(book.orh ?? book.prevOrh, 'ORH', 'ORH', false);
    push(book.orl ?? book.prevOrl, 'ORL', 'ORL', false);
    if (book.vwap > 0) push(book.vwap, 'VWAP', 'VWAP', false);
  }

  // Pivot zones: include flipped (forming) even if WEAK; exclude non-flipped WEAK.
  for (const z of zones) {
    const isForming = z.flippedAt != null;
    if (z.classification === 'WEAK' && !isForming) continue;
    candidates.push({
      price: pivotRefPrice(z),
      source: 'PIVOT',
      label: `S${z.strength}`,
      isStructural: z.classification === 'STRONG',
      classification: z.classification,
    });
  }

  // Split by side relative to ltp.
  const above: Candidate[] = [];
  const below: Candidate[] = [];
  for (const c of candidates) {
    if (c.price > ltp) above.push(c);
    else if (c.price < ltp) below.push(c);
    // price === ltp ignored (a level you're sitting exactly on is not a wall)
  }

  // Dedupe within a side: drop a later candidate within EPS of an already-kept
  // one. Sort so anchored (non-pivot) win ties — they carry the better label.
  const dedupe = (arr: Candidate[]): Candidate[] => {
    const sorted = [...arr].sort((a, b) => {
      const d = Math.abs(a.price - ltp) - Math.abs(b.price - ltp);
      if (d !== 0) return d;
      // same distance: anchored before pivot
      return (a.source === 'PIVOT' ? 1 : 0) - (b.source === 'PIVOT' ? 1 : 0);
    });
    const kept: Candidate[] = [];
    for (const c of sorted) {
      const eps = (ltp * DEDUPE_EPS_PCT) / 100;
      if (kept.some((k) => Math.abs(k.price - c.price) <= eps)) continue;
      kept.push(c);
    }
    return kept;
  };
  const aboveKept = dedupe(above);
  const belowKept = dedupe(below);

  const toLevel = (
    c: Candidate,
    side: 'resistance' | 'support',
    isImmediate: boolean,
  ): SRLevel => {
    const tier: SRTier = isImmediate ? 'immediate' : c.isStructural ? 'major' : 'context';
    return {
      price: c.price,
      side,
      source: c.source,
      label: c.label,
      tier,
      distancePct: ((c.price - ltp) / ltp) * 100,
      classification: c.classification,
    };
  };

  // Nearest each side = immediate (kept arrays are already distance-sorted).
  const resLevels = aboveKept.map((c, i) => toLevel(c, 'resistance', i === 0));
  const supLevels = belowKept.map((c, i) => toLevel(c, 'support', i === 0));

  return {
    immediateResistance: resLevels[0] ?? null,
    immediateSupport: supLevels[0] ?? null,
    levels: [...resLevels, ...supLevels],
  };
}
```

- [ ] **Step 4: Run the test, confirm it PASSES**

Run: `cd apps/web && npx vitest run src/components/charts/buildSRView.test.ts`
Expected: PASS — 10 tests passing.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/components/charts/buildSRView.ts apps/web/src/components/charts/buildSRView.test.ts
git commit -m "feat(charts): buildSRView — unify anchored levels + pivots into S/R decision read"
```

---

## Task 2: `forming` tier in classifyZoneTiers + ChartZoneOverlay

**Files:**
- Modify: `apps/web/src/components/charts/classifyZoneTiers.ts`
- Modify: `apps/web/src/components/charts/classifyZoneTiers.test.ts`
- Modify: `apps/web/src/components/charts/ChartZoneOverlay.tsx`

- [ ] **Step 1: Add a failing test for the forming tier**

In `apps/web/src/components/charts/classifyZoneTiers.test.ts`, add this test before the final `});`:

```ts
  it('keeps a flipped WEAK zone as a forming tier (not dropped)', () => {
    const forming = zone({ type: 'support', classification: 'WEAK', upper: 95, lower: 95, flippedAt: 1, wasType: 'resistance' });
    const out = classifyZoneTiers([forming], 100);
    expect(out).toHaveLength(1);
    expect(out[0].tier).toBe('forming');
    expect(out[0].isImmediate).toBe(false);
    expect(out[0].isMajor).toBe(false);
  });

  it('a forming zone does not steal immediate from a real zone on the same side', () => {
    const forming = zone({ type: 'support', classification: 'WEAK', upper: 98, lower: 98, flippedAt: 1, wasType: 'resistance' });
    const real = zone({ type: 'support', classification: 'MEDIUM', upper: 95, lower: 95 });
    const out = classifyZoneTiers([forming, real], 100);
    const realA = out.find((a) => a.zone.classification === 'MEDIUM')!;
    const formingA = out.find((a) => a.zone.classification === 'WEAK')!;
    expect(realA.tier).toBe('immediate');
    expect(formingA.tier).toBe('forming');
  });
```

- [ ] **Step 2: Run, confirm the new tests FAIL**

Run: `cd apps/web && npx vitest run src/components/charts/classifyZoneTiers.test.ts`
Expected: the two new tests FAIL (flipped WEAK currently dropped); the prior tests still pass.

- [ ] **Step 3: Update `classifyZoneTiers.ts`**

In `apps/web/src/components/charts/classifyZoneTiers.ts`:

(a) Widen the tier type:
```ts
export type ZoneTier = 'immediate' | 'major' | 'context' | 'forming';
```

(b) Change the WEAK filter to KEEP flipped zones. Replace:
```ts
  const drawable = zones.filter(
    (z) =>
      z.classification !== 'WEAK' &&
      (z.isLine || z.lower > ltp || z.upper < ltp),
  );
```
with:
```ts
  // Keep non-WEAK zones AND freshly-flipped (forming) zones — a flipped level
  // is the breakout origin and is the most relevant level on a moving stock,
  // even while the detector demotes it to WEAK until 3+ retests. Still drop
  // non-flipped WEAK (genuine noise) and straddle bands.
  const drawable = zones.filter(
    (z) =>
      (z.classification !== 'WEAK' || z.flippedAt != null) &&
      (z.isLine || z.lower > ltp || z.upper < ltp),
  );
```

(c) Split forming out before the per-side tiering so it doesn't steal immediate/major. Find `annotateSide` and the final `return [...annotateSide(above), ...annotateSide(below)];`. Replace the side-splitting + return section. Locate this block:
```ts
  const above: StrongZone[] = [];
  const below: StrongZone[] = [];
  for (const z of drawable) {
    const ref = refPriceFor(z);
    if (ref > ltp) above.push(z);
    else below.push(z); // ref <= ltp → treat as support side deterministically
  }
```
Replace it with:
```ts
  // Forming (flipped + WEAK) zones get their own tier and are excluded from the
  // immediate/major competition so they don't steal those tiers from proven
  // zones. They still render (dotted) so a breakout's flipped level is visible.
  const forming: StrongZone[] = [];
  const above: StrongZone[] = [];
  const below: StrongZone[] = [];
  for (const z of drawable) {
    if (z.classification === 'WEAK' && z.flippedAt != null) {
      forming.push(z);
      continue;
    }
    const ref = refPriceFor(z);
    if (ref > ltp) above.push(z);
    else below.push(z); // ref <= ltp → treat as support side deterministically
  }
  const formingAnnotations: ZoneTierAnnotation[] = forming.map((zone) => {
    const refPrice = refPriceFor(zone);
    return {
      zone,
      tier: 'forming',
      isImmediate: false,
      isMajor: false,
      refPrice,
      distancePct: ((refPrice - ltp) / ltp) * 100,
    };
  });
```
And change the final return from:
```ts
  return [...annotateSide(above), ...annotateSide(below)];
```
to:
```ts
  return [...annotateSide(above), ...annotateSide(below), ...formingAnnotations];
```

- [ ] **Step 4: Run the test, confirm ALL pass**

Run: `cd apps/web && npx vitest run src/components/charts/classifyZoneTiers.test.ts`
Expected: PASS — all tests (the prior set + the 2 new) green.

- [ ] **Step 5: Render the forming tier in ChartZoneOverlay**

In `apps/web/src/components/charts/ChartZoneOverlay.tsx`:

(a) Widen `StyleSpec.lineStyle` to allow dotted:
```ts
interface StyleSpec {
  color: string;
  lineWidth: 1 | 2 | 3;
  // 0 = solid, 1 = dotted, 2 = dashed (lightweight-charts LineStyle).
  lineStyle: 0 | 1 | 2;
}
```

(b) In `styleForTier`, handle forming (orange dotted — a distinct "tentative" look, role hue kept via the title). Replace:
```ts
function styleForTier(a: ZoneTierAnnotation): StyleSpec {
  const base = baseColor(a.zone);
  if (a.tier === 'immediate') return { color: base, lineWidth: 3, lineStyle: 0 };
  if (a.tier === 'major') return { color: `${base}cc`, lineWidth: 2, lineStyle: 0 };
  return { color: `${base}66`, lineWidth: 1, lineStyle: 2 };
}
```
with:
```ts
function styleForTier(a: ZoneTierAnnotation): StyleSpec {
  const base = baseColor(a.zone);
  if (a.tier === 'immediate') return { color: base, lineWidth: 3, lineStyle: 0 };
  if (a.tier === 'major') return { color: `${base}cc`, lineWidth: 2, lineStyle: 0 };
  // Forming = freshly-flipped, unproven: dotted + amber so it reads as tentative.
  if (a.tier === 'forming') return { color: '#f59e0b', lineWidth: 1, lineStyle: 1 };
  return { color: `${base}66`, lineWidth: 1, lineStyle: 2 };
}
```

(c) In `tierTitle`, add a FORMING tag. Replace the tag-selection block:
```ts
  let tag: string;
  if (a.isImmediate && a.isMajor) tag = 'IMM·MAJOR';
  else if (a.isImmediate) tag = 'IMM';
  else if (a.isMajor) tag = 'MAJOR';
  else tag = `S${a.zone.strength}`; // context keeps the strength score
```
with:
```ts
  let tag: string;
  if (a.tier === 'forming') tag = 'FORMING';
  else if (a.isImmediate && a.isMajor) tag = 'IMM·MAJOR';
  else if (a.isImmediate) tag = 'IMM';
  else if (a.isMajor) tag = 'MAJOR';
  else tag = `S${a.zone.strength}`; // context keeps the strength score
```
And include the distance for forming too — replace:
```ts
  const dist =
    a.isImmediate || a.isMajor ? ` (${sign}${a.distancePct.toFixed(1)}%)` : '';
```
with:
```ts
  const dist =
    a.isImmediate || a.isMajor || a.tier === 'forming'
      ? ` (${sign}${a.distancePct.toFixed(1)}%)`
      : '';
```
(The `flip` prefix already prepends `S→R `/`R→S ` for flipped zones, so a forming support reads e.g. `S→R FORMING S 95 (-5.0%)`.)

- [ ] **Step 6: Type-check**

Run: `cd apps/web && npx tsc -b --noEmit` (fallback `npx tsc --noEmit -p tsconfig.json`).
Expected: no NEW errors in classifyZoneTiers.ts or ChartZoneOverlay.tsx (pre-existing unrelated errors in SignalCard/useChartData/signal-store are known — ignore).

- [ ] **Step 7: Commit**

```bash
git add apps/web/src/components/charts/classifyZoneTiers.ts apps/web/src/components/charts/classifyZoneTiers.test.ts apps/web/src/components/charts/ChartZoneOverlay.tsx
git commit -m "feat(charts): forming tier — draw freshly-flipped pivot levels (dotted)"
```

---

## Task 3: Wire `buildSRView` into the ChartsPage chip

**Files:**
- Modify: `apps/web/src/pages/charts/ChartsPage.tsx`

- [ ] **Step 1: Add the import**

After `import { classifyZoneTiers } from '@/components/charts/classifyZoneTiers';` add:
```tsx
import { buildSRView } from '@/components/charts/buildSRView';
```

- [ ] **Step 2: Compute the SR view**

Find the existing `srLevelCount` memo (added earlier):
```tsx
  // Count of drawable (non-WEAK) tiered levels — drives the status chip.
  const srLevelCount = useMemo(
    () => classifyZoneTiers(zones, ltp).length,
    [zones, ltp],
  );
```
Replace it with:
```tsx
  // Unified S/R decision read — nearest wall above + below, synthesized from
  // BOTH the anchored level book (PDH/PDL/ORH/ORL/VWAP) and the pivot zones.
  // Anchored levels are always present, so a moving stock always gets a read.
  const srView = useMemo(
    () => buildSRView(analysis?.levels ?? null, zones, ltp),
    [analysis?.levels, zones, ltp],
  );
```

- [ ] **Step 3: Replace the chip body with the decision readout**

Find the status-chip block (added earlier):
```tsx
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
Replace it with:
```tsx
          {timeframe === '15m' && (
            <div className="absolute top-3 right-3 z-20 rounded-full bg-[var(--color-bg-secondary)]/90 px-3 py-1 text-[11px] font-medium tabular-nums text-[var(--color-text-secondary)] shadow backdrop-blur-sm">
              {(() => {
                const fmt = (n: number) =>
                  n.toLocaleString('en-IN', { maximumFractionDigits: 2 });
                const sign = (p: number) => (p >= 0 ? '+' : '');
                if (ltp <= 0) return 'S/R: insufficient data';
                const r = srView.immediateResistance;
                const s = srView.immediateSupport;
                if (!r && !s) return 'S/R: no levels';
                const rTxt = r
                  ? `R ${fmt(r.price)} (${sign(r.distancePct)}${r.distancePct.toFixed(1)}%)`
                  : 'R —';
                const sTxt = s
                  ? `S ${fmt(s.price)} (${sign(s.distancePct)}${s.distancePct.toFixed(1)}%)`
                  : 'S —';
                return `${rTxt} · ${sTxt}`;
              })()}
            </div>
          )}
```

- [ ] **Step 4: Remove the now-unused `classifyZoneTiers` import if unused**

`classifyZoneTiers` was only used by the old `srLevelCount`. Check whether it's still referenced in `ChartsPage.tsx`:
Run: `cd apps/web && grep -n "classifyZoneTiers" src/pages/charts/ChartsPage.tsx`
If the only remaining line is the import, remove the import line `import { classifyZoneTiers } from '@/components/charts/classifyZoneTiers';`. (The `ChartZoneOverlay` still uses it internally — that's separate.) If it's still referenced elsewhere, leave it.

- [ ] **Step 5: Type-check**

Run: `cd apps/web && npx tsc -b --noEmit` (fallback `npx tsc --noEmit -p tsconfig.json`).
Expected: no new errors in ChartsPage.tsx. (`analysis?.levels` is `LevelsSnapshot | undefined`; `buildSRView` accepts `LevelBookLite | null` — `LevelsSnapshot` structurally satisfies `LevelBookLite`, and `?? null` handles undefined.)

- [ ] **Step 6: Commit**

```bash
git add apps/web/src/pages/charts/ChartsPage.tsx
git commit -m "feat(charts): chip shows nearest R/S decision readout from unified S/R view"
```

---

## Task 4: End-to-end manual verification

**Files:** none.

- [ ] **Step 1: Confirm app up + tests green**

Run: `cd apps/web && npx vitest run src/components/charts/buildSRView.test.ts src/components/charts/classifyZoneTiers.test.ts`
Expected: all green.
Run: `netstat -ano | findstr ":4000 :4001" | findstr LISTENING` — both up.

- [ ] **Step 2: GUFICBIO — the target case**

Open `http://localhost:4000/charts?symbol=GUFICBIO&token=11606&exchange=NSE&tf=15m`. Confirm:
  - The chip now reads `R <price> (+x%) · S <price> (−y%)` (NOT "no zones") — synthesized from PDH/ORH/VWAP/PDL etc.
  - The flipped support draws as an amber dotted `… FORMING …` line.
  - The existing PDH/PDL/ORH/ORL/VWAP lines still render.

- [ ] **Step 3: RELIANCE — regression**

Open `http://localhost:4000/charts?symbol=RELIANCE&token=2885&exchange=NSE&tf=15m`. Confirm its MEDIUM pivot zones still draw (IMM/context) and the chip shows a sensible nearest R/S.

- [ ] **Step 4: Timeframe gating + no crashes**

Switch off 15m → S/R chip + overlay disappear. Switch back → return. Rapidly switch symbols → no console "Object is disposed" crashes.

---

## Self-Review (completed during planning)
- **Spec coverage:** unified builder → Task 1; forming pivot lines → Task 2; decision-readout chip + "insufficient data" only-when-no-candles → Task 3; manual GUFICBIO/RELIANCE → Task 4. All spec sections mapped.
- **Placeholders:** none — all code/commands concrete.
- **Type consistency:** `buildSRView(book: LevelBookLite | null, zones, ltp): SRView` with `SRLevel`/`SRView` defined in Task 1 and consumed in Task 3 (`srView.immediateResistance/.immediateSupport/.distancePct/.price`). `ZoneTier` gains `'forming'` in Task 2 and is read in `ChartZoneOverlay.styleForTier`/`tierTitle`. `analysis.levels` (`LevelsSnapshot`) structurally satisfies `LevelBookLite` (pdh/pdl number → number|null OK; prevOr optional both sides).
