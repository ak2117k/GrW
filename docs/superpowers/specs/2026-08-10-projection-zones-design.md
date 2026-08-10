# Projection Zones — Entry Boxes With A Measured Target

**Date:** 2026-08-10
**Status:** Approved, ready for implementation

---

## 1. Problem

The chart draws support and resistance as lines. A trader looking at a line
still has to answer two questions the engine is capable of answering:

1. **If this breaks, how far can I still enter?** A line says nothing about
   where entering stops being worth the risk.
2. **If this breaks, how far does price actually go?** And — the part that
   decides whether the answer is worth anything — **how often has that
   actually happened before?**

"It will surely go there" is not available from any signal set. What is
available is a target with a *measured* hit-rate. The design below refuses to
show a projection without saying how confident it is, including saying "no
measured history yet" when that is the truth.

---

## 2. Goals

1. A green box above a broken resistance and a red box below a broken support,
   marking where entry is still valid.
2. A target edge derived from real structure, capped by the higher timeframe.
3. A hit-rate measured from this platform's own history, scoped honestly to
   the symbol or to a cohort.
4. Correct per timeframe, and never contradicted by the timeframe above it.

### Non-goals

- Predicting direction. A box is drawn for a break that has happened or is
  armed; it never claims the break will occur.
- Replacing the TradePlan. The box is its geometric expression, built from the
  same arithmetic.
- Any new broker call on the chart request path.

---

## 3. Design

### 3.1 The box geometry

```
target ─────────────────────────  next opposing structure (HTF-capped)
                ↑ reward
┌─────────────────────────────┐
│  ENTRY BOX                  │  far edge: reward:risk == RR_FLOOR_STRICT
└─────────────────────────────┘  near edge: the broken level
═══ broken zone ═════════════════
                ↓ risk
stop ────────────────────────────  zone far side + SL_BUFFER_ATR
```

| Edge | Source |
|---|---|
| Near edge | The broken zone's edge (`StrongZone.upper` for an up-break, `.lower` for a down-break) |
| Far edge | The entry price at which `rewardRisk(entry, stop, target)` falls to `RR_FLOOR_STRICT` |
| Target | Nearest opposing structure, capped by HTF (§3.3) |
| Stop | Zone's far side ± `SL_BUFFER_ATR × atr` — as `computeSetupPrices` already does |

The far edge is solved, not guessed. With stop and target fixed, reward:risk is
monotonic in entry, so:

```
farEdge = target ∓ RR_FLOOR_STRICT × |target − stop| / (1 + RR_FLOOR_STRICT)
```

(minus for an up-break, plus for a down-break). Derived once in code, never
hand-tuned. Two consequences, both intended: the box **shrinks as price
advances**, vanishing exactly when entry stops qualifying; and because stop and
target come from the shared setup arithmetic, a box and the `TradeTrigger` it
becomes cannot disagree.

If `farEdge` is already below the near edge, there is no enterable region: the
box is `null`. That is a legitimate answer, rendered as "already extended —
no entry left", never a zero-width box.

### 3.2 Target selection

First qualifying candidate, nearest first, on the break side:

1. Opposing `StrongZone` near edge (`classification` STRONG or MEDIUM)
2. Evidence cluster with `score ≥ 60` (`EvidenceLevel`, any `kinds`)
3. `POC` / `VALUE_AREA` / `MAX_PAIN` evidence levels
4. Fallback with nothing ahead: `breakLevel ± 3 × |breakLevel − stop|`

**Corrected during implementation.** This originally read
`entry ± 2 × |entry − stop|`, which was wrong twice over. It anchored on the
breakout entry (just past the zone's FAR side) while the entry region starts at
the BREAK level, putting the whole reward inside the zone — the solved far edge
landed below the break level and every fallback box came out null for any zone
wider than `0.15 × ATR`. And the multiple could not be 2: substituting a target
`n` risk-units away into the far-edge solve gives a box exactly `(n − 2) / 3`
risk-units wide, so `n = 2` is a zero-width box by construction. Three is the
smallest whole multiple leaving a region.

`targetSource` records which fired, so the UI can say *why* that price. The ATR
fallback is labelled as such — a fallback must never be presented as structure.

### 3.3 Higher-timeframe capping

Each timeframe maps to one higher timeframe:

| Chart | HTF |
|---|---|
| 1m | 15m |
| 5m | 1h |
| 15m | 1h |
| 1h | 1d |
| 1d | 1w |
| 1w, 1mo | none |

If a STRONG/MEDIUM HTF zone lies strictly between the break level and the
target, the target is capped to that zone's near edge and `cappedByHtf` is set.
A cap can push reward:risk below the floor — in which case the box is `null`,
which is the point: the higher timeframe says this trade has no room.

Capping only ever moves the target CLOSER. It can never extend a projection.

### 3.4 The measured hit-rate

A new observation, separate from `PatternObservation` — that table's follow-
through is defined at a fixed `k = 1.5` ATR, whereas each projection resolves
against its OWN target distance. Overloading it would corrupt both.

```prisma
model ZoneBreakObservation {
  id                String   @id @default(cuid())
  token             String
  exchange          String
  timeframe         String
  side              String   // UP | DOWN
  barTime           DateTime
  // Cohort key
  zoneClassification String  // STRONG | MEDIUM | WEAK
  touchCount        Int
  volumeBucket      String   // LOW | NORMAL | HIGH | UNKNOWN
  htfAgreed         Boolean
  // Geometry at detection, in ATR units so it is comparable across symbols
  atrAtDetection    Float
  targetDistAtr     Float
  stopDistAtr       Float
  targetSource      String
  // Outcome
  outcome           String   @default("PENDING") // WIN | LOSS | TIMEOUT | PENDING
  label             Int?
  resolvedAt        DateTime?
  createdAt         DateTime @default(now())

  @@unique([token, exchange, timeframe, side, barTime])
  @@index([timeframe, zoneClassification, volumeBucket])
  @@index([token, exchange, timeframe])
  @@index([outcome])
}
```

Resolution reuses `resolveFollowThrough` with per-row params:
`k = targetDistAtr`, `m = stopDistAtr`, `n` = horizon bars for the timeframe
(1m:30, 5m:24, 15m:16, 1h:12, 1d:10). WIN means the target was reached before
the stop. No new labelling logic.

**Scoping.** Symbol-specific when `n ≥ 30` resolved observations exist for
(token, timeframe); otherwise the cohort (timeframe + classification +
volumeBucket + htfAgreed). The response always carries which was used and the
sample size — a percentage without its `n` is not reportable.

**Cold start.** `PatternBackfillService` already replays stored candles; a
sibling pass generates `ZoneBreakObservation` rows from history. It is ~527
serialized broker calls behind the 350ms historical gate, so it runs off-hours
only and NEVER on a chart request. See §5.

### 3.5 The wire object

Rides `ChartContextDto` alongside `tradePlan`, with its own `SourceState`.

```ts
export interface HitRate {
  pct: number;            // 0–100
  sample: number;         // resolved observations behind pct
  scope: 'symbol' | 'cohort';
}

export interface ProjectionBox {
  side: 'UP' | 'DOWN';
  state: 'armed' | 'confirmed';
  /** Broken level — the box's near edge. */
  breakLevel: number;
  /** Entry region. nearEdge is always the side closest to breakLevel. */
  entryNear: number;
  entryFar: number;
  stop: number;
  target: number;
  targetSource: 'ZONE' | 'EVIDENCE' | 'POC' | 'VALUE_AREA' | 'MAX_PAIN' | 'ATR';
  cappedByHtf: boolean;
  rr: number;
  /** null = no measured history yet. NEVER a fabricated number. */
  hitRate: HitRate | null;
  reason: string;
}

export interface ProjectionZones {
  up: ProjectionBox | null;
  down: ProjectionBox | null;
}
```

`sources.projections` follows the existing convention: `'empty'` = ran, nothing
qualified; `'failed'` = we don't know.

### 3.6 Rendering

A new `ProjectionBoxOverlay` draws the entry box as a filled band (green for
`up`, red for `down`) plus a distinct dashed target line. `armed` renders at
reduced opacity with a dashed border; `confirmed` renders solid. The two states
must be distinguishable at a glance without reading a label.

The Setup & Context card reads the SAME `ProjectionZones` object and states the
numbers in words, including the hit-rate and its scope, or "no measured history
yet" when `hitRate` is null.

---

## 4. Honest degradation

Every input can be absent, and each absence has a stated answer:

| Missing | Behaviour |
|---|---|
| No opposing structure | ATR fallback target, `targetSource: 'ATR'`, labelled in the reason |
| No OI (equity without F&O) | OI factor SKIPPED, not scored 0 — the volume tri-state rule |
| No volume reading | `volumeBucket: 'UNKNOWN'`; gates via the option-chain proxy where available |
| No measured history | `hitRate: null` → "no measured history yet". Never an invented percentage |
| HTF zones unavailable | `cappedByHtf: false` and the reason says the HTF was not checked — not a silent uncapped projection |
| Break not confirmed | `state: 'armed'` |
| Builder throws | `sources.projections = 'failed'`, boxes null |

The rule this table encodes: an absent input degrades the box's *claims*, never
its *correctness*. A box is never drawn on a number the engine does not have.

---

## 5. Performance constraints

- `buildProjectionZones` is PURE and composes from what `/chart-context` has
  already fetched. No broker call, exactly as `buildTradePlan` does.
- The hit-rate is ONE indexed DB read, served through the composite's existing
  60s cache.
- HTF zones come from the zone cache/detector, not a new broker fetch.
- Backfill runs off-hours only. A multi-day sub-hour broker window costs one
  chunked, rate-limited call PER DAY on a queue shared with the chart — the
  regression in 49d1fc1. Nothing on the request path may widen a sub-hour
  broker window.

---

## 6. Testing

| Unit | Tests |
|---|---|
| Far-edge solve | reward:risk at the far edge equals `RR_FLOOR_STRICT` exactly, both directions; box is null when the region collapses |
| Target selection | each source in priority order; ATR fallback labelled; never selects a level on the wrong side |
| HTF capping | caps to an intervening zone; never extends; a cap that breaks the R:R floor yields a null box |
| Geometry parity | a box's stop/target equal `computeSetupPrices` for the same level |
| Hit-rate scoping | symbol at n≥30; cohort below; null when neither has data; sample size always accompanies pct |
| Observation resolution | WIN/LOSS/TIMEOUT via `resolveFollowThrough` at per-row k/m |
| Degradation | every row of §4 |

---

## 7. Delivery slices

**Slice A — geometry.** Pure `zone-projection.ts`: far-edge solve, target
selection, HTF capping, `ProjectionZones` shape. Ships with `hitRate: null`.

**Slice B — statistics.** `ZoneBreakObservation` model, repository, live-edge
capture, off-hours backfill, hit-rate lookup with scoping.

**Slice C — UI.** `ProjectionBoxOverlay`, card rendering, armed/confirmed
states.

A and C are independent given the §3.5 shape. B is additive: it fills in
`hitRate`, which A already models as nullable.
