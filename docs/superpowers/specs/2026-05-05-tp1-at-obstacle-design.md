# TP1 at Obstacle — Design Spec

**Date:** 2026-05-05
**Status:** Approved (user picked Approach A)
**Author:** Brainstorm session with Claude (Opus 4.7)

---

## Goal

Make the locked-setup TP1 placement **obstacle-aware** so partial profit books at the first real intermediate support/resistance band the price will hit, instead of at a fixed `1×R` distance. Captures the realized-profit-on-bounce that today's strategy gives back.

## Non-goals

- Do NOT change entry, stoploss, target, or trailing-stop logic. The runner stays exactly as it is.
- Do NOT introduce a new strategy. This is a refinement to `LevelsContextStrategy.computeSlAndTarget`.
- Do NOT degrade or reject setups based on intermediate obstacles (Approach B from the brainstorm — deferred; revisit if the change over-fires near close obstacles).
- Do NOT touch zone detection itself (`StrongZoneDetectorService` stays unchanged).

---

## Why this design

The user observed that on real NIFTY trades the price often hits a strong/medium S-R band **between entry and TP1** and bounces back. The bounce stays inside SL — the trade isn't getting killed, but realized partial doesn't book before the bounce, so paper profit gets handed back. After some time price resumes toward the original target without the trader.

Today's `computeSlAndTarget` (apps/api/src/modules/signal-generator/strategies/levels-context.strategy.ts:459) places TP1 at a hard `entry ± slDist` (1×R), regardless of what's between entry and target. The strong-zone detector already knows where the bounce-prone bands are; we just don't consult it when sizing TP1.

This change wires the existing zone data into TP1 placement only. Minimal surface, minimal risk, directly addresses the pain.

---

## Architecture

```
┌────────────────────────┐     ┌──────────────────────────────┐
│ StrongZoneDetector     │ ──→ │ SignalGeneratorService.      │
│ (existing, untouched)  │     │   analyze()                  │
└────────────────────────┘     └──────────────────────────────┘
                                            │
                                            │ pass StrongZone[]
                                            ▼
                               ┌──────────────────────────────┐
                               │ LevelsContextStrategy.       │
                               │   computeSlAndTarget()       │ ← change here
                               │   - obstacle-aware TP1       │
                               └──────────────────────────────┘
                                            │
                                            ▼
                               ┌──────────────────────────────┐
                               │ Setup payload                │
                               │   + tp1Source                │ ← new field
                               │   + tp1Obstacle              │ ← new field
                               └──────────────────────────────┘
                                            │
                                            ▼
                               ┌──────────────────────────────┐
                               │ AnalysisPanel TP1 row        │
                               │   subtitle when from obstacle│
                               └──────────────────────────────┘
```

**Component responsibilities:**

| Component | What changes |
|---|---|
| `StrongZoneDetectorService` | Nothing — caller already has access. |
| `SignalGeneratorService.analyze` | Fetch the active zone set for the token (cheapest path: `strongZoneDetector.detectZones({...})` reuses its 15-min cache) and pass to the strategy. |
| `LevelsContextStrategy.detect` | Accept `zones: StrongZone[]` in its input snapshot, forward to `computeSlAndTarget`. |
| `LevelsContextStrategy.computeSlAndTarget` | Implement the algorithm in §"Algorithm" below. |
| `SetupContext` type | Add `tp1Source` and `tp1Obstacle` optional fields. |
| `AnalysisPanel.tsx` | Render obstacle subtitle on the TP1 row when present. |

---

## Algorithm

```
Inputs (additions to computeSlAndTarget): zones: StrongZone[]
Constants:
  TP1_OBSTACLE_BUFFER_ATR = 0.1   // exit slightly BEFORE the band
  MIN_TP1_R               = 0.4   // skip obstacle if partial would be < 0.4×R

1. Compute defaults exactly as today:
     entry, stoploss, slDist, target unchanged
     defaultTp1 = isLong ? entry + slDist : entry - slDist        // existing 1×R

2. Filter obstacle candidates:
     candidates = zones.filter(z =>
       (z.classification === 'STRONG' || z.classification === 'MEDIUM') &&
       z.touchCount >= 3
     )

3. For each candidate, compute the "near edge" — the side price hits first
   when moving in the trade direction:
     SELL (price falling): nearEdge = z.upper
     BUY  (price rising):  nearEdge = z.lower

4. Filter to obstacles strictly inside the trade path:
     SELL: keep candidates where nearEdge < entry  AND  nearEdge > target
     BUY:  keep candidates where nearEdge > entry  AND  nearEdge < target

5. Pick the closest to entry (the wall price hits first):
     SELL: pick candidate maximising nearEdge
     BUY:  pick candidate minimising nearEdge

6. Compute obstacleTp1 with a buffer so we exit BEFORE the band's chop:
     buffer = TP1_OBSTACLE_BUFFER_ATR * atr
     SELL: obstacleTp1 = nearEdge + buffer
     BUY:  obstacleTp1 = nearEdge - buffer

7. Defensive clamp (should be unreachable given step 4 — keep as a safety net):
     SELL: obstacleTp1 = max(obstacleTp1, target + epsilon)
     BUY:  obstacleTp1 = min(obstacleTp1, target - epsilon)

8. Useful-partial floor:
     obstacleR = |obstacleTp1 - entry| / slDist
     if obstacleR >= MIN_TP1_R:
       TP1         = obstacleTp1
       tp1Source   = 'obstacle'
       tp1Obstacle = { classification, touchCount, nearEdge }
     else:
       TP1         = defaultTp1
       tp1Source   = 'fixed'
       tp1Obstacle = null

9. Return { entry, stoploss, target, partialTakeAt: TP1, tp1Source, tp1Obstacle }.
```

---

## Data shape changes

**`SetupContext` (apps/api/src/modules/signal-generator/types/setup-context.types.ts)** — two new optional fields:

```typescript
tp1Source?: 'obstacle' | 'fixed';
tp1Obstacle?: {
  classification: 'STRONG' | 'MEDIUM';
  touchCount: number;
  nearEdge: number;
} | null;
```

Both optional so older persisted setups (DB rows without these fields) still rehydrate.

**Mirror in `apps/web/src/types/index.ts` and `apps/web/src/components/charts/AnalysisPanel.tsx#SetupAnalysis`** — same two optional fields.

**`AnalysisPanel.tsx` TP1 row** — when `tp1Source === 'obstacle' && tp1Obstacle`, render a small grey sublabel under or beside the TP1 value:

```
TP1   23,950.40   at MEDIUM zone · 19 touches
```

No layout change beyond a `<span class="text-[9px] text-gray-500">…</span>`.

---

## Edge cases

| Case | Behavior |
|---|---|
| Setup is locked (already fired) | TP1 is frozen at lock time. Zones changing afterwards do NOT re-adjust TP1. The setup-tracker persists `tp1Source` + `tp1Obstacle` alongside the locked entry/SL/target. |
| No zones loaded for token (detector returned `[]`) | `tp1Source = 'fixed'`, `tp1Obstacle = null`. Fall back silently. |
| All candidates filtered out (touchCount < 3 or only WEAK) | Same — fall back to defaultTp1. |
| Multiple obstacles in the path | Use only the closest (step 5). Don't try to multi-stage TP — out of scope. |
| Obstacle ≥ target (zone center sits at or beyond the target) | Step 4's strict bounds drop it; defaultTp1 wins. |
| Obstacle would push TP1 closer than `0.4×R` | Step 8 floor — fallback to defaultTp1. UI shows `tp1Source = 'fixed'` so the trader can see no useful obstacle was found. |
| Obstacle would push TP1 past the target | Defensive clamp in step 7 (should be unreachable due to step 4 filter). |
| Re-evaluation 60s later with mutated zone set | The locked-setup tracker returns the persisted values — re-running `computeSlAndTarget` only happens for NEW setups, not active ones. |

---

## Test plan

Unit tests in `apps/api/src/modules/signal-generator/strategies/levels-context.strategy.spec.ts` (file already exists; extend it). Each test calls `computeSlAndTarget` directly with a synthesised `StrongZone[]` array.

| # | Setup | Zones | Expected TP1 |
|---|---|---|---|
| 1 | SELL, entry=24000, sl=24100, target=23800 | none | `23900` (default 1×R), `tp1Source='fixed'` |
| 2 | SELL, same | STRONG band 23930–23970, touchCount=5 | `23970 + 0.1×ATR` (`upper + buffer`), `tp1Source='obstacle'`, classification `STRONG`, touchCount `5` |
| 3 | SELL, same | MEDIUM band 23930–23970, touchCount=2 | default `23900` (touchCount filter) |
| 4 | SELL, same | WEAK band 23930–23970, touchCount=10 | default `23900` (classification filter) |
| 5 | SELL, same | MEDIUM band 23990–23995, touchCount=4 | default `23900` (obstacleR < 0.4) |
| 6 | BUY, entry=24000, sl=23900, target=24200 | MEDIUM band 24050–24080, touchCount=4 | `24050 − 0.1×ATR`, `tp1Source='obstacle'` |
| 7 | BUY, two MEDIUM bands at 24050–24080 (tc=4) and 24120–24150 (tc=4) | both | TP1 keyed off the 24050–24080 band (closest) |
| 8 | BUY, MEDIUM band 24220–24240 (touchCount=4) | beyond target | default 1×R, `tp1Source='fixed'` |
| 9 | Setup locked at T0 with `tp1Source='obstacle'`; at T1 the zone disappears from the active set | re-evaluate via setup tracker | Persisted `tp1Source` + value unchanged |

One integration touch: extend an existing setup-tracker spec (or add a focused one) to confirm the two new fields persist across the lock → re-evaluate path.

---

## Out of scope (explicit)

- **Approach B grade-degrade** — if the first obstacle is `< 0.3×R` we fall back to fixed TP1 silently. We do NOT lower the grade. Revisit only if the change over-fires on near-obstacle setups.
- **Multi-stage TPs** (TP1 at first obstacle, TP2 at second, runner beyond) — out of scope. We keep one TP1 + one final target.
- **Adjusting `target` based on obstacles** — target stays computed by today's logic (nearest opposing level ≥ 2×R else 2×R fallback).
- **Adjusting SL based on obstacles in the wrong direction** — out of scope.
- **Backtesting validation** — desirable, deferred. The change is symmetric (only moves TP1 closer to entry) so worst case it books smaller partial; doesn't introduce new failure modes.

---

## Roll-out

- All-strategies, no flag. The change applies to every locked setup `LevelsContextStrategy` produces. Behavior change is visible in the AnalysisPanel TP1 row immediately.
- Reversion path: revert the strategy commit. SetupContext rows persisted with the new fields stay valid (fields are optional).
