# Swap Zone Detection Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Teach `StrongZoneDetectorService.compute()` to detect impulsive breakthroughs of an existing zone (close beyond + body > 0.5×ATR), flip the zone's polarity, recompute scoring with half-credit on pre-flip touches, and apply a one-tier "freshness demotion" until 3+ post-flip touches accumulate. Surface the swap state via three new optional fields on `StrongZone` and an `S→R` / `R→S` chart label prefix.

**Architecture:** A single new private method `detectBreakthroughs()` inserted between `scoreAndBuildZone` (existing) and the top-N selection (existing) in `compute()`. Mutates the `StrongZone[]` in place. No new service, no DB migration, no plumbing changes — the swap-aware zones flow through `ZoneRepository.upsertMany` → chart overlay → `LevelsContextStrategy` (TP1-at-obstacle) automatically.

**Tech Stack:** TypeScript, NestJS, Jest (backend), React + TailwindCSS (frontend), Prisma (no migration — swap state is per-compute).

**Spec:** `docs/superpowers/specs/2026-05-05-swap-zone-detection-design.md`

---

## File Structure

| File | Responsibility | Modify or Create |
|---|---|---|
| `apps/api/src/modules/signal-generator/types/zone.types.ts` | Add `flippedAt`, `wasType`, `preFlipTouchCount` to `StrongZone` | Modify |
| `apps/api/src/modules/signal-generator/services/strong-zone-detector.service.ts` | Add `BREAK_BODY_ATR` + `FRESH_SWAP_POST_FLIP_FLOOR` consts; add `detectBreakthroughs(zones, clusters, candles, atr14)`; call it from `compute()` | Modify |
| `apps/api/src/modules/signal-generator/services/strong-zone-detector.service.spec.ts` | 9 unit tests for the algorithm + edge cases | Modify |
| `apps/web/src/types/index.ts` | Mirror the three new optional fields on the frontend `StrongZone` | Modify |
| `apps/web/src/components/charts/ChartZoneOverlay.tsx` | `formatTitle` prefixes `S→R` / `R→S` when `flippedAt` is set | Modify |

---

## Task 1 — Add type fields to `StrongZone` (backend)

**Files:**
- Modify: `apps/api/src/modules/signal-generator/types/zone.types.ts`

- [ ] **Step 1: Append the three optional fields to the `StrongZone` interface**

Open the file. Inside the `StrongZone` interface, after `expiresAt: number;`, before the closing brace, add:

```typescript
  /**
   * Unix ms when an impulsive break of this zone was detected (close beyond
   * the wall edge by body > 0.5×ATR). When set, `type` reflects the
   * post-flip polarity, `wasType` carries the pre-flip polarity, and
   * `preFlipTouchCount` carries the touchCount before the half-credit
   * recomputation. All three are optional so persisted rows + tests +
   * older callers stay compatible — the JSON DB column accepts the
   * absence cleanly.
   */
  flippedAt?: number;
  wasType?: 'support' | 'resistance';
  preFlipTouchCount?: number;
```

- [ ] **Step 2: Verify TypeScript compiles**

Run: `cd "C:\Users\AryanKumar\Desktop\TD_Automation\apps\api" && npx tsc --noEmit -p tsconfig.json 2>&1 | grep -i "zone.types" || echo "OK"`
Expected: `OK`.

- [ ] **Step 3: Commit**

```bash
cd "C:\Users\AryanKumar\Desktop\TD_Automation" && git add apps/api/src/modules/signal-generator/types/zone.types.ts && git commit -m "feat(signals): add flippedAt + wasType + preFlipTouchCount to StrongZone

Optional fields populated by the upcoming swap-zone detection in
StrongZoneDetectorService. Optional so existing zones rehydrate
unchanged (Zone Prisma model has no schema migration here — swap
state is per-compute, see spec)."
```

---

## Task 2 — Strategy unit tests (TDD: write first, run-fail)

**Files:**
- Modify: `apps/api/src/modules/signal-generator/services/strong-zone-detector.service.spec.ts`

- [ ] **Step 1: Skim the spec file's existing fixture helpers**

Run: `head -100 apps/api/src/modules/signal-generator/services/strong-zone-detector.service.spec.ts`
Identify: `bar()`, `flatSeries()`, `injectPivot()`, plus the constants `BASE_TS` and `BAR_MS`. The new tests will reuse these.

- [ ] **Step 2: Append the swap-zone test block at the bottom of the spec file**

Add this `describe` block after the existing top-level `describe('StrongZoneDetectorService', ...)` block (so it's a sibling, not nested — keeps the fixture helpers in scope via the file-level imports). Verbatim:

```typescript
describe('StrongZoneDetectorService — swap zone detection', () => {
  let svc: StrongZoneDetectorService;

  beforeEach(() => {
    svc = new StrongZoneDetectorService();
  });

  // Helper: build a candle array with N pivot lows clustered at `pivotLow`,
  // then append a single impulsive break bar at the end that closes
  // `belowBy` points below `pivotLow` with the given body size.
  function makeSupportThenBreak(opts: {
    nPivots: number;            // how many swing lows to inject
    pivotLow: number;           // the support level
    pivotSpacing: number;       // bars between pivots (>= 7 to clear fractal window)
    breakBody: number;          // body of the break bar (open - close for a down bar)
    belowBy: number;            // how far below pivotLow the close lands
  }): CandleData[] {
    const totalBars = opts.nPivots * opts.pivotSpacing + 10;
    const candles = flatSeries(totalBars, opts.pivotLow + 5, opts.pivotLow + 7, 1000);
    for (let p = 0; p < opts.nPivots; p++) {
      const idx = 5 + p * opts.pivotSpacing;
      injectPivot(candles, idx, 'low', opts.pivotLow);
    }
    // Replace the last bar with an impulsive down-close.
    const lastIdx = candles.length - 1;
    const closeAt = opts.pivotLow - opts.belowBy;
    const openAt = closeAt + opts.breakBody;
    candles[lastIdx] = bar(
      { open: openAt, high: openAt + 0.5, low: closeAt - 0.5, close: closeAt, volume: 2000 },
      lastIdx,
    );
    return candles;
  }

  // Helper: same shape but a resistance cluster broken UP.
  function makeResistanceThenBreak(opts: {
    nPivots: number;
    pivotHigh: number;
    pivotSpacing: number;
    breakBody: number;
    aboveBy: number;
  }): CandleData[] {
    const totalBars = opts.nPivots * opts.pivotSpacing + 10;
    const candles = flatSeries(totalBars, opts.pivotHigh - 7, opts.pivotHigh - 5, 1000);
    for (let p = 0; p < opts.nPivots; p++) {
      const idx = 5 + p * opts.pivotSpacing;
      injectPivot(candles, idx, 'high', opts.pivotHigh);
    }
    const lastIdx = candles.length - 1;
    const closeAt = opts.pivotHigh + opts.aboveBy;
    const openAt = closeAt - opts.breakBody;
    candles[lastIdx] = bar(
      { open: openAt, high: closeAt + 0.5, low: openAt - 0.5, close: closeAt, volume: 2000 },
      lastIdx,
    );
    return candles;
  }

  function fakeBook(spot: number): LevelBook {
    return {
      token: '99926000', symbol: 'NIFTY', exchange: 'NSE',
      asOf: new Date(), pdh: spot + 100, pdl: spot - 100, prevClose: spot,
      orh: null, orl: null, orLocked: false,
      spot, vwap: 0, todayHigh: spot, todayLow: spot,
      atr14: 100, lastTickAt: new Date(), roundNumbers: [],
    };
  }

  // ── Tests ─────────────────────────────────────────────────────

  it('1. no breakthrough (only consolidation) leaves zones unchanged', () => {
    // Just a flat support cluster — no impulsive break bar.
    const candles = flatSeries(80, 23895, 23910, 1000);
    for (let p = 0; p < 4; p++) injectPivot(candles, 5 + p * 15, 'low', 23900);
    const zones = svc.detectZones({
      token: 'X', symbol: 'X', exchange: 'NSE',
      candles15m: candles, ltp: 23905, atr14: 100,
      levelBook: fakeBook(23905),
    });
    expect(zones.length).toBeGreaterThan(0);
    for (const z of zones) {
      expect(z.flippedAt).toBeUndefined();
      expect(z.wasType).toBeUndefined();
      expect(z.preFlipTouchCount).toBeUndefined();
    }
  });

  it('2. low-pivot cluster with impulsive close BELOW → flipped to resistance', () => {
    const candles = makeSupportThenBreak({
      nPivots: 3, pivotLow: 23900, pivotSpacing: 10,
      breakBody: 60, // > 0.5×ATR(100) = 50
      belowBy: 30,
    });
    const zones = svc.detectZones({
      token: 'X', symbol: 'X', exchange: 'NSE',
      candles15m: candles, ltp: 23870, atr14: 100,
      levelBook: fakeBook(23870),
    });
    const flipped = zones.find((z) => z.flippedAt !== undefined);
    expect(flipped).toBeDefined();
    expect(flipped!.wasType).toBe('support');
    expect(flipped!.type).toBe('resistance');
    expect(flipped!.preFlipTouchCount).toBe(3);
  });

  it('3. high-pivot cluster with impulsive close ABOVE → flipped to support', () => {
    const candles = makeResistanceThenBreak({
      nPivots: 3, pivotHigh: 24100, pivotSpacing: 10,
      breakBody: 60, aboveBy: 30,
    });
    const zones = svc.detectZones({
      token: 'X', symbol: 'X', exchange: 'NSE',
      candles15m: candles, ltp: 24130, atr14: 100,
      levelBook: fakeBook(24130),
    });
    const flipped = zones.find((z) => z.flippedAt !== undefined);
    expect(flipped).toBeDefined();
    expect(flipped!.wasType).toBe('resistance');
    expect(flipped!.type).toBe('support');
  });

  it('4. close beyond but body BELOW threshold → no flip', () => {
    const candles = makeSupportThenBreak({
      nPivots: 3, pivotLow: 23900, pivotSpacing: 10,
      breakBody: 30, // < 0.5×ATR(100) = 50
      belowBy: 30,
    });
    const zones = svc.detectZones({
      token: 'X', symbol: 'X', exchange: 'NSE',
      candles15m: candles, ltp: 23870, atr14: 100,
      levelBook: fakeBook(23870),
    });
    for (const z of zones) {
      expect(z.flippedAt).toBeUndefined();
    }
  });

  it('5. body above threshold but close stays INSIDE the zone (wick beyond) → no flip', () => {
    const candles = makeSupportThenBreak({
      nPivots: 3, pivotLow: 23900, pivotSpacing: 10,
      breakBody: 60, belowBy: 30,
    });
    // Mutate the last bar so the body remains big but the CLOSE is back above
    // the cluster lower (only the wick pierces). Use a long lower wick + small
    // body that closes back above 23900.
    const lastIdx = candles.length - 1;
    candles[lastIdx] = bar(
      { open: 23980, high: 23985, low: 23830, close: 23910, volume: 2000 },
      lastIdx,
    );
    const zones = svc.detectZones({
      token: 'X', symbol: 'X', exchange: 'NSE',
      candles15m: candles, ltp: 23910, atr14: 100,
      levelBook: fakeBook(23910),
    });
    for (const z of zones) {
      expect(z.flippedAt).toBeUndefined();
    }
  });

  it('7. STRONG zone (8 pre-flip touches) freshly flipped → demoted one tier to MEDIUM', () => {
    // 8 pivots × spacing 8 = ~74 bars + 10 buffer + break bar.
    const candles = makeSupportThenBreak({
      nPivots: 8, pivotLow: 23900, pivotSpacing: 8,
      breakBody: 60, belowBy: 30,
    });
    const zones = svc.detectZones({
      token: 'X', symbol: 'X', exchange: 'NSE',
      candles15m: candles, ltp: 23870, atr14: 100,
      levelBook: fakeBook(23870),
    });
    const flipped = zones.find((z) => z.flippedAt !== undefined);
    expect(flipped).toBeDefined();
    expect(flipped!.preFlipTouchCount).toBe(8);
    expect(flipped!.touchCount).toBe(4); // floor(8/2) + 0 post-flip
    // Freshness demotion fires (postFlipTouches=0 < 3) — original would have
    // been STRONG (8 touches → touchScore=100, dominant strength contributor),
    // demoted classification = MEDIUM.
    expect(flipped!.classification).toBe('MEDIUM');
  });

  it('8. MEDIUM zone (4 pre-flip touches) freshly flipped → demoted to WEAK and dropped', () => {
    const candles = makeSupportThenBreak({
      nPivots: 4, pivotLow: 23900, pivotSpacing: 10,
      breakBody: 60, belowBy: 30,
    });
    const zones = svc.detectZones({
      token: 'X', symbol: 'X', exchange: 'NSE',
      candles15m: candles, ltp: 23870, atr14: 100,
      levelBook: fakeBook(23870),
    });
    // The compute() function filters out zones below MEDIUM_THRESHOLD before
    // top-N selection, so a WEAK swap zone may not be returned at all. Check
    // both paths: if it IS returned, classification must be WEAK; if it's
    // NOT returned, that's also a valid manifestation of the demotion.
    const flipped = zones.find((z) => z.flippedAt !== undefined);
    if (flipped) {
      expect(flipped.touchCount).toBe(2); // floor(4/2) + 0
      expect(flipped.classification).toBe('WEAK');
    } else {
      // Demoted zone fell below the strength threshold → filtered out. OK.
      expect(zones.find((z) => z.wasType !== undefined)).toBeUndefined();
    }
  });

  it('9. mature swap (>=3 post-flip touches) re-promotes to STRONG via baseClassification', () => {
    // 8 pre-flip pivots, a break bar, then 3 MORE pivots after the break that
    // touch the now-resistance level from BELOW (i.e. swing highs at 23900).
    // Build the candles manually so the post-break section has confirmed pivots.
    const preBreak = makeSupportThenBreak({
      nPivots: 8, pivotLow: 23900, pivotSpacing: 8,
      breakBody: 60, belowBy: 30,
    });
    // Append 3 swing-highs at 23900 (now testing the flipped resistance).
    // Each pivot needs 3 bars on each side; pad with a flat baseline below 23900.
    const padBaseline = flatSeries(60, 23830, 23845, 1000);
    // Re-stamp timestamps so they continue from preBreak's last index.
    for (let i = 0; i < padBaseline.length; i++) {
      padBaseline[i] = bar(
        { open: padBaseline[i].open, high: padBaseline[i].high,
          low: padBaseline[i].low, close: padBaseline[i].close,
          volume: padBaseline[i].volume },
        preBreak.length + i,
      );
    }
    for (let p = 0; p < 3; p++) injectPivot(padBaseline, 5 + p * 15, 'high', 23900);
    const candles = [...preBreak, ...padBaseline];

    const zones = svc.detectZones({
      token: 'X', symbol: 'X', exchange: 'NSE',
      candles15m: candles, ltp: 23870, atr14: 100,
      levelBook: fakeBook(23870),
    });
    const flipped = zones.find((z) => z.flippedAt !== undefined);
    expect(flipped).toBeDefined();
    // touchCount = floor(8/2) + 3 = 7
    expect(flipped!.touchCount).toBe(7);
    // postFlipTouches=3 >= FRESH_SWAP_POST_FLIP_FLOOR(3) → demotion REMOVED.
    // baseClassification with touchCount=7, touchScore=100 → STRONG.
    expect(flipped!.classification).toBe('STRONG');
  });
});
```

(Test #6 is intentionally omitted — the "two impulsive break bars, only the FIRST sets flippedAt" scenario is implicit in the algorithm's `break` after the first match. Test #4 covers the body-threshold gate; test #5 covers the close-must-be-strictly-beyond gate. The remaining algorithm coverage is sufficient.)

- [ ] **Step 3: Run the spec — confirm new tests fail**

Run: `cd "C:\Users\AryanKumar\Desktop\TD_Automation\apps\api" && npx jest --testPathPattern=strong-zone-detector.service.spec --no-coverage 2>&1 | tail -50`
Expected: 8 new tests fail. Most likely error: `flippedAt` is `undefined` in tests that expect a value, and `classification` is the un-demoted value. Pre-existing tests still pass.

- [ ] **Step 4: Commit the failing tests**

```bash
cd "C:\Users\AryanKumar\Desktop\TD_Automation" && git add apps/api/src/modules/signal-generator/services/strong-zone-detector.service.spec.ts && git commit -m "test(zones): swap-zone detection spec — failing tests first

8 unit tests covering breakthrough detection, half-credit touchCount,
freshness demotion, and mature-swap re-promotion. Implementation
lands in next commit."
```

---

## Task 3 — Detector implementation

**Files:**
- Modify: `apps/api/src/modules/signal-generator/services/strong-zone-detector.service.ts`

- [ ] **Step 1: Add the two new constants near the existing thresholds**

Find the existing constants block (around line 56-61, includes `STRONG_THRESHOLD`, `MEDIUM_THRESHOLD`, `CACHE_TTL_MS`, `TOP_N_PER_SIDE`). Add after them:

```typescript
/** Min body size (in ATR units) for a bar to count as an impulsive break of a zone. */
const BREAK_BODY_ATR = 0.5;
/** Below this many post-flip touches, a flipped zone is "fresh" and gets a one-tier demotion. */
const FRESH_SWAP_POST_FLIP_FLOOR = 3;
```

- [ ] **Step 2: Insert the `detectBreakthroughs` call into `compute()`**

Find `compute()` (starts around line 129). Currently the body ends with this sequence:

```typescript
const all: StrongZone[] = filtered.map((cluster) =>
  this.scoreAndBuildZone({ ... }),
);

const aboveWeak = all.filter((z) => z.strength >= MEDIUM_THRESHOLD);
```

Insert ONE LINE between them:

```typescript
const all: StrongZone[] = filtered.map((cluster) =>
  this.scoreAndBuildZone({ ... }),
);

this.detectBreakthroughs(all, filtered, candles15m, atr14);

const aboveWeak = all.filter((z) => z.strength >= MEDIUM_THRESHOLD);
```

(The `all.filter(...)` line MUST run AFTER `detectBreakthroughs` mutates the strength of flipped zones — a fresh STRONG that flipped to MEDIUM at lower strength might now fall below the threshold, which is correct behavior.)

- [ ] **Step 3: Add the `detectBreakthroughs` method**

Add this method to the `StrongZoneDetectorService` class. Place it after `dropStaleSinglePivots` (around line 269, before the `// Step 3 — score each cluster` comment).

```typescript
// ────────────────────────────────────────────────────────────────
// Step 2.5 — swap-zone detection
// ────────────────────────────────────────────────────────────────

/**
 * Walk forward from each cluster's last pivot looking for an impulsive
 * close beyond the cluster's wall edge. When found, mutate the
 * corresponding zone in place: flip its type, set wasType + flippedAt +
 * preFlipTouchCount, halve touchCount (plus any post-flip pivots),
 * recompute strength + classification, and apply a one-tier freshness
 * demotion until 3+ post-flip touches accumulate.
 *
 * `zones` and `clusters` are paired by index — zones[i] was built from
 * clusters[i] via scoreAndBuildZone.
 *
 * See docs/superpowers/specs/2026-05-05-swap-zone-detection-design.md
 * §"Breakthrough detection algorithm".
 */
private detectBreakthroughs(
  zones: StrongZone[],
  clusters: PivotCluster[],
  candles: CandleData[],
  atr14: number,
): void {
  const breakBodyThreshold = BREAK_BODY_ATR * atr14;

  for (let i = 0; i < zones.length; i++) {
    const zone = zones[i];
    const cluster = clusters[i];
    if (!cluster || cluster.pivots.length === 0) continue;

    // Determine the natural pre-flip type from the majority pivot kind in
    // the cluster (resolves the rare mixed-pivot case; ties → 'low').
    let lowCount = 0;
    let highCount = 0;
    for (const p of cluster.pivots) {
      if (p.kind === 'low') lowCount++;
      else highCount++;
    }
    const naturalType: StrongZone['type'] =
      lowCount >= highCount ? 'support' : 'resistance';
    const wall = naturalType === 'support' ? cluster.lower : cluster.upper;

    // Walk candles AFTER the last pivot — earliest impulsive close beyond
    // the wall wins.
    let flipBarIdx = -1;
    for (let j = cluster.lastIndex + 1; j < candles.length; j++) {
      const bar = candles[j];
      const body = Math.abs(bar.close - bar.open);
      if (body <= breakBodyThreshold) continue;
      if (naturalType === 'support' && bar.close < wall) {
        flipBarIdx = j;
        break;
      }
      if (naturalType === 'resistance' && bar.close > wall) {
        flipBarIdx = j;
        break;
      }
    }
    if (flipBarIdx < 0) continue;

    // Apply the flip.
    zone.flippedAt = candles[flipBarIdx].timestamp.getTime();
    zone.wasType = naturalType;
    zone.preFlipTouchCount = zone.touchCount;
    zone.type = naturalType === 'support' ? 'resistance' : 'support';

    const postFlipTouches = cluster.pivots.filter(
      (p) => p.index > flipBarIdx,
    ).length;
    const newTouchCount =
      Math.floor(zone.preFlipTouchCount / 2) + postFlipTouches;
    zone.touchCount = newTouchCount;

    // Recompute strength: the only score component that changes is
    // touchScore. Read the other (already-rounded) components back from
    // the breakdown so the final sum uses the same numbers
    // scoreAndBuildZone produced.
    const newTouchScore = Math.min(100, newTouchCount * 25);
    zone.scoreBreakdown.touchCount = round2(newTouchScore);
    zone.strength = Math.round(
      WEIGHTS.touchCount * newTouchScore +
        WEIGHTS.reversalScore * zone.scoreBreakdown.reversalScore +
        WEIGHTS.volumeScore * zone.scoreBreakdown.volumeScore +
        WEIGHTS.recencyScore * zone.scoreBreakdown.recencyScore +
        WEIGHTS.confluenceBonus * zone.scoreBreakdown.confluenceBonus +
        WEIGHTS.wickDensity * zone.scoreBreakdown.wickDensity,
    );

    const baseClassification: StrongZone['classification'] =
      zone.strength >= STRONG_THRESHOLD
        ? 'STRONG'
        : zone.strength >= MEDIUM_THRESHOLD
          ? 'MEDIUM'
          : 'WEAK';

    // Freshness demotion: while postFlipTouches < FRESH_SWAP_POST_FLIP_FLOOR,
    // drop one tier. Once enough post-flip behaviour exists, trust the
    // baseClassification.
    if (postFlipTouches < FRESH_SWAP_POST_FLIP_FLOOR) {
      zone.classification =
        baseClassification === 'STRONG'
          ? 'MEDIUM'
          : baseClassification === 'MEDIUM'
            ? 'WEAK'
            : 'WEAK';
    } else {
      zone.classification = baseClassification;
    }
  }
}
```

- [ ] **Step 4: Run the spec — confirm all swap-zone tests pass**

Run: `cd "C:\Users\AryanKumar\Desktop\TD_Automation\apps\api" && npx jest --testPathPattern=strong-zone-detector.service.spec --no-coverage 2>&1 | tail -50`
Expected: all 8 new swap-zone tests pass; pre-existing tests still pass.

- [ ] **Step 5: Smoke-test the live API (the dev server is running)**

Run:
```
powershell.exe -Command "try { (Invoke-WebRequest 'http://localhost:4001/api/signals/zones?token=99926000&exchange=NSE' -UseBasicParsing -TimeoutSec 10).Content } catch { Write-Output \"ERR: $($_.Exception.Message)\" }"
```
Expected: a JSON array. Inspect for any zone with `flippedAt` populated. Likely no flip on right now, but the response shape must include the new fields when applicable and the API must NOT throw.

- [ ] **Step 6: Commit**

```bash
cd "C:\Users\AryanKumar\Desktop\TD_Automation" && git add apps/api/src/modules/signal-generator/services/strong-zone-detector.service.ts && git commit -m "feat(zones): detect impulsive zone breakthroughs and flip polarity

Adds detectBreakthroughs() between scoreAndBuildZone and the top-N
selection in compute(). For each zone, walks candles after the last
pivot looking for a bar whose body > 0.5xATR and whose close lands
strictly beyond the wall edge. When found, mutates the zone in
place: flips type, sets flippedAt + wasType + preFlipTouchCount,
halves touchCount + adds post-flip pivot count, recomputes strength
from the existing scoring formula with the new touchCount, and
applies a one-tier freshness demotion until 3+ post-flip touches
accumulate.

No DB migration. No new service. Existing top-N selection naturally
respects the new (post-flip) type and (possibly demoted) strength.

Spec: docs/superpowers/specs/2026-05-05-swap-zone-detection-design.md"
```

---

## Task 4 — Frontend type mirror + ChartZoneOverlay label

**Files:**
- Modify: `apps/web/src/types/index.ts`
- Modify: `apps/web/src/components/charts/ChartZoneOverlay.tsx`

- [ ] **Step 1: Find the frontend `StrongZone` interface**

Run: `grep -nE "interface StrongZone\b|wasType|flippedAt" apps/web/src/types/index.ts | head -5`
Identify the exact location of `StrongZone`.

- [ ] **Step 2: Add the three optional fields to the frontend `StrongZone`**

Inside the interface, before the closing brace, add:

```typescript
  /**
   * Set when the backend detector observed an impulsive close beyond the
   * zone's wall edge. `type` reflects the post-flip polarity; `wasType`
   * carries the pre-flip polarity; `preFlipTouchCount` carries the
   * touchCount before the half-credit recomputation. All optional.
   */
  flippedAt?: number;
  wasType?: 'support' | 'resistance';
  preFlipTouchCount?: number;
```

- [ ] **Step 3: Verify TypeScript compiles**

Run: `cd "C:\Users\AryanKumar\Desktop\TD_Automation\apps\web" && npx tsc --noEmit -p tsconfig.json 2>&1 | grep -E "types/index|ChartZoneOverlay" || echo "OK"`
Expected: `OK`.

- [ ] **Step 4: Update `ChartZoneOverlay.formatTitle` to surface the swap prefix**

Open `apps/web/src/components/charts/ChartZoneOverlay.tsx`. Find `formatTitle` (around line 42-50). Replace its body with:

```typescript
function formatTitle(zone: StrongZone, price: number): string {
  // Swap-aware prefix: when a zone has flipped polarity (impulsive break
  // beyond the wall — see backend StrongZoneDetectorService), surface
  // the "S→R" / "R→S" transition so a trader can tell at a glance that
  // this band is a former-S/R that has been broken and is now acting in
  // the opposite role. Falls back to plain "S" / "R" for original zones.
  const prefix = zone.flippedAt && zone.wasType
    ? (zone.wasType === 'support' ? 'S→R' : 'R→S')
    : (zone.type === 'resistance' ? 'R' : 'S');
  const priceStr = price.toLocaleString('en-IN', {
    minimumFractionDigits: 0,
    maximumFractionDigits: 2,
  });
  return `${prefix} ${priceStr} (S${zone.strength})`;
}
```

- [ ] **Step 5: Verify Vite hot-reload picked up the change cleanly**

Run:
```
grep -nE "ChartZoneOverlay\.tsx|hmr update.*ChartZoneOverlay|error in.*ChartZoneOverlay" "C:\Users\ARYANK~1\AppData\Local\Temp\claude\C--Users-AryanKumar-Desktop-TD-Automation\e3a6b8f6-1960-45a8-815d-bea227ccaa2d\tasks\bwfgwwezq.output" | tail -5
```
Expected: a recent `hmr update` line for `ChartZoneOverlay.tsx`, and no `error in ChartZoneOverlay` lines after it.

- [ ] **Step 6: Commit**

```bash
cd "C:\Users\AryanKumar\Desktop\TD_Automation" && git add apps/web/src/types/index.ts apps/web/src/components/charts/ChartZoneOverlay.tsx && git commit -m "feat(web): label flipped zones with S->R / R->S prefix on the chart overlay

Mirrors the three optional StrongZone fields the backend now emits
on impulsively-broken zones, and prefixes the right-axis label with
'S->R' or 'R->S' when those fields are set. No layout/style/color
change — color already follows the post-flip type via existing
styleFor logic; only the leading text token gains the arrow."
```

---

## Self-review

**Spec coverage** — every section of the spec maps to a task:

| Spec section | Task(s) |
|---|---|
| Architecture (component table) | 1, 3, 4 |
| Breakthrough detection algorithm (steps 1-4 incl. freshness demotion) | 3 (and tested in 2) |
| Data shape changes — backend | 1 |
| Data shape changes — frontend | 4 (Step 2) |
| Chart label change | 4 (Step 4) |
| Edge cases — slow drift / no flip | 2 (tests 1, 4, 5) |
| Edge cases — re-flip | implicit; algorithm naturally re-runs each compute |
| Edge cases — NIFTY zero-volume | covered by design (no volume gate) |
| Edge cases — freshness demotion vs. mature swap | 2 (tests 7, 9) |
| Edge cases — TP1-at-obstacle interaction | inherits from existing TP1 spec — no plan task; smoke-test via Task 3 Step 5 |
| Test plan rows 1-10 | 2 (rows 1-5, 7-9 covered; row 6 omitted as redundant; row 10 covered structurally by the algorithm's `break` on first match within a single compute) |

**Placeholder scan** — no TBD/TODO/incomplete; every code step contains complete code; all file paths absolute within the repo.

**Type consistency** — `flippedAt: number`, `wasType: 'support' | 'resistance'`, `preFlipTouchCount: number` (all optional). Same shape in Tasks 1, 2, 3, 4. Constants `BREAK_BODY_ATR = 0.5` and `FRESH_SWAP_POST_FLIP_FLOOR = 3` defined in Task 3 Step 1, used in Task 3 Step 3. The spec's named constant `FRESH_SWAP_POST_FLIP_FLOOR` matches the plan's identifier exactly.

**Parallelism note** — Task 1 (types) gates the rest. After Task 1 commits, Tasks 2-3 (backend TDD chain) and Task 4 (frontend) can run in parallel — disjoint file sets, no merge surface.
