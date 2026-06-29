# Swap Zone Detection — Design Spec

**Date:** 2026-05-05
**Status:** Approved (user picked options (b) across all three clarifying questions)
**Author:** Brainstorm session with Claude (Opus 4.7)

---

## Goal

Teach `StrongZoneDetectorService` to recognise when a zone has been **impulsively broken** (price closes beyond the zone with a body > 0.5×ATR), flip the zone's polarity, and emit it back into the active zone set as a "swap zone." Swap zones surface in the existing chart overlay and feed the existing TP1-at-obstacle code with no consumer-side changes.

## Non-goals

- A new strategy that fires on swap-zone retest. Explicitly deferred to a follow-up brainstorm (option 3 from the original three-way split).
- Reworking the existing pivot/cluster/score pipeline. The change adds a single post-scoring step.
- Persisting swap state to the database. Per-compute re-derivation is sufficient (same approach used for `tp1Source` / `tp1Obstacle`).
- Volume-confirmed breakthrough detection. NIFTY spot index has volume=0 by design, so a volume gate would silently disable the feature on the most-traded instrument.
- Per-instrument tuning of the breakthrough sensitivity. One global threshold (0.5×ATR body size) for now.

---

## Why this design

The user described a "swap zone" (SMC / ICT polarity flip): when an impulsive bar closes beyond a supply or demand zone, that zone reverses role on retest — broken support becomes resistance, broken resistance becomes support.

Today our detector partially captures this *accidentally*: `scoreAndBuildZone` assigns `type` from `center >= ltp`, so a cluster's type changes label whenever LTP crosses the cluster center. But:

- It conflates an impulsive break with a slow drift. Both produce the same relabel.
- The cluster's `touchCount` carries pivots from the pre-flip behavior unchanged, so a freshly-broken support might appear with `touchCount=8` as if it were a long-tested resistance.
- There is no marker on the zone that lets a consumer distinguish "this was support before it broke" from "this was always resistance."

The user's existing trading workflow benefits from knowing both that a zone has flipped AND that the post-flip behavior has not yet been proven. This design adds exactly those two pieces of information without disturbing the existing detector flow.

---

## Architecture

```
                     ┌────────────────────────────┐
                     │ StrongZoneDetectorService  │
                     │   .compute(input)          │
                     └──────────────┬─────────────┘
                                    │
                          existing pipeline ↓
                                    │
                detectPivots → clusterPivots → dropStaleSinglePivots
                                    │
                            scoreAndBuildZone ──→ StrongZone[]  (today's output)
                                    │
                                    ▼
                  ┌────────────────────────────────────┐
                  │  NEW: detectBreakthroughs()        │
                  │  for each zone, walk candles after │
                  │  cluster.lastIndex; if a bar's     │
                  │  body > 0.5×ATR closes beyond the  │
                  │  near edge → flip the zone.        │
                  └──────────────┬─────────────────────┘
                                 │
                       Updated StrongZone[] (swap-aware) ──→
                                                            ZoneRepository.upsertMany
                                                            chart overlay
                                                            TP1-at-obstacle (existing)
```

**Component responsibilities:**

| Component | What changes |
|---|---|
| `StrongZoneDetectorService.detectPivots` | nothing |
| `StrongZoneDetectorService.clusterPivots` | nothing |
| `StrongZoneDetectorService.scoreAndBuildZone` | nothing |
| `StrongZoneDetectorService.compute` | inserts a new `detectBreakthroughs(zones, candles15m, atr14)` call after scoring; mutates the returned `StrongZone[]` in place to flip type, set new fields, recompute strength + classification |
| `StrongZone` type (+ frontend mirror) | adds `flippedAt`, `wasType`, `preFlipTouchCount` (all optional) |
| `ChartZoneOverlay.formatTitle` | when `flippedAt` is set, prefix label with `S→R` (was support, now resistance) or `R→S` (was resistance, now support) instead of the plain `S` / `R` |

---

## Breakthrough detection algorithm

```
Inputs (added to the existing compute pipeline):
  zones      : StrongZone[]              // output of scoreAndBuildZone
  candles15m : CandleData[]              // already in scope for compute()
  atr14      : number                     // already in scope
  clusters   : PivotCluster[]            // we need cluster.lastIndex too — extend the
                                          //   internal contract to carry it through
                                          //   to detectBreakthroughs (cheap; same module)

Constants:
  BREAK_BODY_ATR = 0.5

For each (zone, cluster) pair:
  1. Determine the natural pre-flip type from the cluster's pivot mix.
     Clusters can in principle contain both kinds (clusterPivots groups by
     price proximity, not pivot kind), so use whichever kind dominates:
       majorityKind = the kind with more pivots in cluster.pivots
                      (ties → 'low')
       majorityKind === 'low'   →  naturalType = 'support'    (wall = cluster.lower)
       majorityKind === 'high'  →  naturalType = 'resistance' (wall = cluster.upper)

  2. Walk candles15m from index (cluster.lastIndex + 1) to the end:
       For each bar at index i:
         body = abs(bar.close - bar.open)
         IF body <= BREAK_BODY_ATR * atr14:  continue
         IF naturalType === 'support'   AND bar.close < cluster.lower:
              flipBarIdx = i ; break
         IF naturalType === 'resistance' AND bar.close > cluster.upper:
              flipBarIdx = i ; break
     (Take the FIRST bar that meets both conditions — earliest impulsive break.)

  3. If no flipBarIdx found → leave zone unchanged. Done.

  4. If flipBarIdx found:
       zone.flippedAt          = candles15m[flipBarIdx].timestamp.getTime()
       zone.wasType            = naturalType
       zone.preFlipTouchCount  = zone.touchCount
       zone.type               = (naturalType === 'support' ? 'resistance' : 'support')

       // Half-credit on the displayed/scored touchCount (informative)
       postFlipTouches = count of pivots in cluster with index > flipBarIdx
       newTouchCount   = floor(preFlipTouchCount / 2) + postFlipTouches
       zone.touchCount = newTouchCount

       // Recompute strength using the existing scoring formula with the
       // new touchCount. Note: touchScore = min(100, newTouchCount * 25)
       // saturates at touchCount >= 4, so for STRONG zones with many
       // pre-flip touches, the strength change alone would not be enough
       // to drop the classification. The freshness demotion below is what
       // actually delivers the "fresh swap zones drop one tier" guarantee.
       zone.scoreBreakdown.touchCount = min(100, newTouchCount * 25)
       zone.strength = round(weighted-sum using existing WEIGHTS — only
                             the touchCount component changes; reversalScore /
                             volumeScore / recencyScore / confluenceBonus /
                             wickDensity stay as scoreAndBuildZone computed them)
       baseClassification = strength >= STRONG_THRESHOLD ? 'STRONG'
                          : strength >= MEDIUM_THRESHOLD ? 'MEDIUM'
                          : 'WEAK'

       // Freshness demotion: while the swap is unproven (fewer than 3
       // post-flip touches), drop the classification one tier. Guarantees
       // the "fresh swap → one tier weaker" semantic regardless of where
       // the underlying score lands. Once postFlipTouches >= 3 we trust
       // the math and use baseClassification directly.
       FRESH_SWAP_POST_FLIP_FLOOR = 3
       IF postFlipTouches < FRESH_SWAP_POST_FLIP_FLOOR:
           zone.classification = (baseClassification === 'STRONG' ? 'MEDIUM'
                                : baseClassification === 'MEDIUM' ? 'WEAK'
                                : 'WEAK')
       ELSE:
           zone.classification = baseClassification
```

---

## Data shape changes

`apps/api/src/modules/signal-generator/types/zone.types.ts` — `StrongZone` gains three optional fields:

```typescript
export interface StrongZone {
  // ...existing fields unchanged...

  /**
   * Unix ms when an impulsive break of the zone was detected (close beyond
   * the wall edge by body > 0.5×ATR). When set, `type` reflects the
   * post-flip polarity, `wasType` carries the pre-flip polarity, and
   * `preFlipTouchCount` carries the touchCount before half-credit.
   */
  flippedAt?: number;
  wasType?: 'support' | 'resistance';
  preFlipTouchCount?: number;
}
```

Mirror the same three fields on `apps/web/src/types/index.ts` `StrongZone`.

**No DB migration.** Swap state is per-compute (15-min cache); each recompute re-derives the breakthrough from the same candle history. After an API restart the swap badge disappears for the first compute cycle and reappears automatically.

---

## Chart label change

In `apps/web/src/components/charts/ChartZoneOverlay.tsx`, modify `formatTitle`:

```typescript
function formatTitle(zone: StrongZone, price: number): string {
  const prefix = zone.flippedAt && zone.wasType
    ? (zone.wasType === 'support' ? 'S→R' : 'R→S')
    : (zone.type === 'resistance' ? 'R' : 'S');
  const priceStr = price.toLocaleString('en-IN', {
    minimumFractionDigits: 0, maximumFractionDigits: 2,
  });
  return `${prefix} ${priceStr} (S${zone.strength})`;
}
```

No layout/style/color changes — flipped zones already inherit the color appropriate to their post-flip type via existing `styleFor` logic. Only the text label gains the `→` token.

---

## Edge cases

| Case | Behavior |
|---|---|
| Slow drift through the zone (no bar's body > 0.5×ATR closes beyond) | `detectBreakthroughs` returns no flip. The zone keeps its naturally-detected type. No swap label. The existing `center >= ltp` type assignment still fires elsewhere — that's pre-existing behavior, untouched. |
| Multiple impulsive breaks (re-flip) | Each subsequent compute re-runs `detectBreakthroughs` from cluster.lastIndex. The FIRST break in that window wins. If a zone is broken twice (e.g. support broken DOWN, then later broken back UP from below as it acted as resistance), the algorithm naturally tracks only the most recent break since `cluster.lastIndex` advances with each new pivot. `wasType` always reflects the IMMEDIATE prior polarity, `flippedAt` the latest break. |
| NIFTY spot index (volume = 0) | The algorithm uses body-size only — no volume gate. Works on any instrument that produces OHLC data. |
| Mixed-pivot cluster (rare; 1 low pivot at the same price as 1 high pivot, both inside the tolerance band) | Use the kind with MORE pivots; ties → `'support'`. Documented in the algorithm step 1 so a future maintainer doesn't think the choice is accidental. |
| Post-flip touch count grows | Each recompute re-derives `touchCount = floor(preFlip/2) + postFlipTouches`. The score rebuilds organically as the zone proves itself in its new role. |
| Very old break (cluster.lastIndex outside the 200-candle window) | The cluster itself stops being detected once its pivots scroll out of the lookback. Zone disappears entirely (existing behavior). The swap state goes with it. Acceptable. |
| Interaction with TP1-at-obstacle | Swap zones land in the same `zones` array `SignalGeneratorService.analyze` passes to the strategy. The TP1-at-obstacle filter is `(STRONG OR MEDIUM) AND touchCount >= 3`. Net effect: a fresh swap zone influences TP1 only if its pre-flip touchCount was ≥ 6 AND it was originally STRONG (post-flip: STRONG→MEDIUM via demotion, touchCount = floor(6/2)=3 ≥ 3 → passes filter). Fresh swaps from MEDIUM zones get demoted to WEAK and disappear from TP1 booking. Mature swaps (postFlipTouches ≥ 3) re-promote to their natural classification and behave like normal zones. Matches the "fresh swap = treat with caution, mature swap = trust normally" intuition. |
| Freshness demotion vs. mature swap | While `postFlipTouches < 3` the freshness rule demotes one tier (STRONG → MEDIUM, MEDIUM → WEAK, WEAK stays WEAK), independent of the underlying strength. Once `postFlipTouches >= 3`, demotion is removed and classification follows the score normally — a swap zone that has bounced 3+ times since the flip can re-promote to STRONG if the math supports it. |

---

## Test plan

Unit tests in `apps/api/src/modules/signal-generator/services/strong-zone-detector.service.spec.ts` (file already exists). Each test calls `detectZones` with a synthetic `candles15m` array and asserts on the returned `StrongZone[]`.

| # | Scenario | Expected |
|---|---|---|
| 1 | No subsequent bar closes beyond the zone (just consolidation) | `flippedAt` undefined; `type`, `touchCount`, `strength`, `classification` unchanged |
| 2 | Low-pivot cluster at 24000–24050; later bar closes at 23900 with body 60 > 0.5×100=50 | `flippedAt` populated; `wasType='support'`; `type='resistance'`; `preFlipTouchCount` = original; new `touchCount = floor(orig/2)` (no post-flip pivots in fixture) |
| 3 | High-pivot cluster at 24200–24250; later bar closes at 24350 with body 80 | `flippedAt` populated; `wasType='resistance'`; `type='support'` |
| 4 | Bar closes BEYOND the zone but body = 0.4×ATR (under threshold) | No flip — `flippedAt` undefined |
| 5 | Bar body > 0.5×ATR but close stays INSIDE the zone (intra-bar wick beyond) | No flip — close not strictly beyond |
| 6 | Two impulsive break bars — only the FIRST sets `flippedAt` | `flippedAt` = first bar's timestamp |
| 7 | STRONG zone (preFlipTouchCount=8) flipped with NO post-flip pivots | `touchCount=4`, `touchScore` stays at 100 (saturates), so `strength` is roughly unchanged → `baseClassification='STRONG'`, but freshness demotion fires (postFlipTouches=0 < 3) → final `classification='MEDIUM'` |
| 8 | MEDIUM zone (preFlipTouchCount=4) flipped with one post-flip pivot beyond the wall | `touchCount = floor(4/2) + 1 = 3`; freshness demotion still fires (postFlipTouches=1 < 3) → final `classification='WEAK'` |
| 9 | STRONG zone (preFlipTouchCount=8) flipped, then accumulates 3 post-flip pivots | `touchCount = 4 + 3 = 7`; postFlipTouches=3 ≥ 3, so freshness demotion is REMOVED → `classification` returns to `baseClassification` (likely STRONG again) |
| 10 | Re-flip: support broken DOWN at idx=50, then much later resistance broken UP at idx=120 | A second compute (with cluster.lastIndex advanced past 50 via new pivots) detects only the second break: `wasType='resistance'`, `type='support'`, `flippedAt` = candle[120].timestamp |

Plus a small frontend test (or visual smoke-check) for `ChartZoneOverlay.formatTitle`:

| Case | Expected label |
|---|---|
| Original support, price 24050, strength 60 | `S 24,050 (S60)` |
| Flipped support→resistance, same | `S→R 24,050 (S60)` |
| Original resistance, 24200, strength 70 | `R 24,200 (S70)` |
| Flipped resistance→support, same | `R→S 24,200 (S70)` |

---

## Out of scope (explicit)

- **Retest strategy (option 3 from the brainstorm)** — separate spec if the swap detector proves out on real data.
- **DB persistence of swap state** — per-compute re-derivation is intentional; mirrors the `tp1Source` decision.
- **Per-instrument breakthrough sensitivity** — fixed `BREAK_BODY_ATR = 0.5` for now. Tunable later if real data shows it over- or under-fires on specific symbols.
- **Visual chart styling beyond the label** — same color/dashes as today's zones; only the text label gets the `S→R` / `R→S` prefix.
- **Volume gate** — explicitly excluded for the NIFTY-spot-zero-volume reason.
- **Backtesting validation** — desirable, deferred. The change only adds metadata + slightly demotes some zones; doesn't introduce new failure modes.

---

## Roll-out

- All-zones, no flag. The detector applies the breakthrough check on every compute. Swap zones surface in the chart overlay and TP1-at-obstacle automatically.
- Reversion path: revert the detector commit. Frontend label change is forward-compatible — when `flippedAt` is undefined the prefix falls back to `S` / `R` exactly as today.
