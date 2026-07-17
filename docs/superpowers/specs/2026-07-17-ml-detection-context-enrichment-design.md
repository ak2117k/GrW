# ML Detection-Context Enrichment — Design Spec

**Date:** 2026-07-17
**Depends on:** `2026-07-14-ml-pattern-quality-pipeline-design.md` (Phase 1 data capture, done)
**Phase:** 1½ — enrich observations with the context that makes them trainable.

## 1. Problem & Goal

Phase 1 captures every detected pattern with a candle window + ATR-follow-through
label. But a candle's *shape* is a weak signal — "a hammer only means reversal
**after a downtrend**; the identical shape mid-rally is just a bar with a long
lower wick" (lesson 01). Without **context**, two geometrically identical hammers
— one a WIN, one a LOSS — have identical features, and no model can separate them.

Goal: attach the context that actually separates signal from noise, correctly and
without lookahead, so the dataset is trainable.

## 2. Feature split (hybrid)

Features fall into two buckets by whether they can be safely recomputed from data
already in the row:

- **Bucket A — captured at detection time** (external state the window does not
  hold): MTF/higher-TF alignment, S/R location, sector alignment.
- **Bucket B — computed in Python at train time** (pure functions of the stored
  window; nothing to capture): ATR percentile, volume-vs-average, RSI,
  position-in-range, geometry (body/range, wick ratios, gap).

**This spec implements Bucket A capture only.** Bucket B is Phase 2 training-time
feature engineering and is out of scope here.

## 3. The correctness constraint (why a live-edge scan)

The context services (`MtfAlignmentService`, `LevelBookService`,
`NseSectorIndexService`) compute **as of now** — they take no historical
timestamp. So external context is only correct when the detection is at the
**live edge** (decision bar == latest completed bar). Computing it for an older
pattern (e.g. a chart load surfacing a pattern from hours ago) would encode price
action that had not happened when the pattern formed — textbook lookahead.

Therefore Bucket A is captured by a **dedicated live-edge scan**, not the
chart-load capture path:

```
heartbeat (each bar-close) → POST /webhooks/ml/scan   [X-ML-Trigger-Secret]
   for each target instrument:
     fetch recent candles (bulk priority lane — cache-safe, mirrors backfill)
     detect patterns
     KEEP ONLY patterns whose decision bar == latest completed bar   ← correctness gate
     enrich each via DetectionContextService (MTF + SR + sector)     ← as-of-now == as-of-decision-bar
     saveMany  → rich pattern_observations
   returns 202, detached, in-flight guard (mirrors backfill)
```

The chart-load capture (existing) and backfill are **unchanged**: they keep
producing window-features + label rows (`detectionContext = null`). Backfill is
for volume; the scan is for meaning.

## 4. Storage

Add one nullable column to `pattern_observations`:

```prisma
detectionContext  Json?   // Bucket A snapshot; null for backfill & non-live-edge rows
```

Versioned snapshot shape (each sub-object independently nullable so one failing
service does not null the whole snapshot — fail-open per signal):

```ts
interface DetectionContext {
  v: 1;
  mtf:    { aligned: boolean; direction: 'UP' | 'DOWN' | null } | null;
  sr:     { distanceAtr: number; atLevel: boolean } | null;
  sector: { trend: 'UP' | 'DOWN' | 'NEUTRAL' | null; alignment: 'with' | 'against' | 'neutral' } | null;
}
```

JSON not columns: the context set will grow in Phase 2 (avoid a migration per
feature), it is read wholesale at train time, and it mirrors `candleWindow`.
`v` lets Python interpret snapshots as the shape evolves. **Nullable is
load-bearing** — it is how a row honestly says "no trustworthy external context".

S/R distance is expressed in **ATR units** (not rupees) so it is comparable
across instruments — same principle as the label.

## 5. Components

1. **`DetectionContextService`** (new, `signal-generator/ml/`) — the single point
   of context computation. `compute(token, exchange, symbol, bias, atr):
   Promise<DetectionContext>`. Wraps the three existing services; each sub-signal
   in its own try/catch → null on failure (fail-open). This same service is
   reused at Phase 3 serving time, which is what guarantees train/serve parity.
   - `mtf`: `MtfAlignmentService.check(token, exchange)` → `{ aligned, direction:
     agreedDirection }`.
   - `sr`: `LevelBookService.lazyLoad(token, exchange, symbol, 'bulk')` → nearest
     level distance / `atr` → `distanceAtr`; `atLevel = distanceAtr <= threshold`.
   - `sector`: `NseSectorIndexService.getSectorIndexForSymbol(symbol)` → sector
     index token → trend (mirror how `chartink-process.service.ts` classifies
     sector trend) → `alignment` vs `bias`.

2. **Schema + persist plumbing** — add `detectionContext Json?` (migration +
   schema), thread an optional `detectionContext` through
   `PatternObservationInput`, the observation assembler (passthrough, default
   null), and `PatternObservationRepository.saveMany` (persist it).

3. **`PatternScanService`** (new) — `scan(targets)`: per target, fetch recent
   candles (bulk lane), run `buildObservationInputs`, keep only observations whose
   decision bar == latest completed bar, enrich each via `DetectionContextService`,
   `saveMany`. Fail-open per target. Reuses `PatternBackfillService`'s candle-fetch
   approach; does NOT read/poison the live cache.

4. **Trigger endpoint** — `POST /webhooks/ml/scan` on `MlTriggerController`,
   `X-ML-Trigger-Secret` header auth, 202 detached with in-flight guard, body
   `{ targets: [{token, exchange, symbol}] }` (explicit, like backfill).

5. **Module wiring** — register `DetectionContextService`, `PatternScanService`;
   `MlTriggerController` gains the scan dependency (`@Optional()`).

## 6. Error handling

- Every context sub-signal fails open to `null`; a downstream service being down
  never blocks capture.
- The scan is fail-open per target and detached (202); one target's failure never
  aborts the rest (mirrors backfill).
- `detectionContext` absent/null is a first-class state, not an error.

## 7. Testing

- `DetectionContextService`: mock the three services; assert snapshot shape,
  per-signal fail-open (one service throws → that sub-object null, others intact),
  sector alignment vs bias, S/R distance in ATR units.
- Persist plumbing: `saveMany` persists `detectionContext`; assembler defaults it
  to null.
- `PatternScanService`: only live-edge observations are kept and enriched; older
  ones dropped; fail-open per target.
- Trigger endpoint: auth (mirror existing `MlTriggerController` auth tests), 202,
  in-flight guard, 503 unwired.

## 8. Out of scope

- Bucket B Python feature engineering + XGBoost training (Phase 2 proper).
- Teaching the context services to compute *as-of a historical bar* (would let
  backfill get external context too) — a larger lift, deferred.
- Any change to chart-load capture or backfill behaviour.
