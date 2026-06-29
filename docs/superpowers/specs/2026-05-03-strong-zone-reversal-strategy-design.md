# Strong Zone Reversal Strategy — Design Spec

**Date:** 2026-05-03
**Status:** Approved (user authorized parallel agent build)
**Author:** Brainstorm session with Claude (Opus 4.7)

---

## Goal

Replicate the *behavior* of the Booming Bulls "Sonic Bull 2" indicator: identify **strong support/resistance zones** where the market is statistically likely to reverse, render them on the chart, and **auto-fire reversal signals** when price touches a strong zone with a confirming reversal candle.

This is **not** a multi-confluence "sniper entry" indicator. It is a **zone detector + reversal trigger**.

## Non-goals

- Replacing existing strategies (vwap-deviation, rsi-reversal, levels-context, anand-sniper, asymmetric-edge — all stay).
- Pixel-perfect Sonic Bull 2 replica — we don't have its source.
- Backtesting framework changes — we use what exists.

---

## Why this design

The user observed that Sonic Bull 2 "marks the strong resistance and support area from where the market reverses." This places it in the **supply/demand zone detector** category (Sam Seiden / ICT order block lineage), not the multi-indicator confluence category.

Our codebase already has:
- `level-book.service.ts` tracking PDH/PDL/ORH/ORL/VWAP/ROUND
- `setupType: 'REVERSAL'` exists but rarely fires (4 of 53 in last 20 days — forensics)
- `setup-tracker` with full lifecycle (entry, SL, partial, trail, adaptive invalidation, persistence — added today)
- `SetupMarker` chart component

What's MISSING:
- Swing-pivot detection
- Strength scoring (touch count + volume + recency + reversal magnitude + wick density + confluence)
- Zone-touch + reversal-candle trigger
- Chart band overlay

This design fills only those gaps.

---

## Architecture

```
┌──────────────────────┐     ┌────────────────────────┐     ┌──────────────────┐
│ StrongZoneDetector   │ ──→ │ ZoneReversalStrategy   │ ──→ │ setup-tracker    │
│ (computes zones)     │     │ (fires on touch+rev)   │     │ (lifecycle)      │
└──────────────────────┘     └────────────────────────┘     └──────────────────┘
         │                                                         │
         └─→ ZoneRepository ─→ /api/zones endpoint ─→ ChartZoneOverlay
                                                       (bands + lines)
```

**Component responsibilities:**

| Component | Responsibility | Input | Output |
|---|---|---|---|
| `StrongZoneDetector` | Pure detection algorithm | `CandleData[]`, `LevelBook` | `StrongZone[]` |
| `ZoneRepository` | Persist computed zones for chart consumption | `StrongZone[]` | DB |
| `ZoneReversalStrategy` | Fire signal when price reacts to zone | `MarketSnapshot`, zones | `SignalOutput \| null` |
| `ChartZoneOverlay` | Render zones on chart | API zones | Visual |

---

## Shared contract (locked)

```typescript
// apps/api/src/modules/signal-generator/types/zone.types.ts
// Mirror in apps/web/src/types/index.ts

export interface StrongZone {
  id: string;                  // stable id (token + zone center hash)
  token: string;               // instrument token
  symbol: string;
  exchange: string;
  type: 'support' | 'resistance';
  upper: number;               // zone top price
  lower: number;               // zone bottom price (== upper if isLine)
  isLine: boolean;             // true = single horizontal line, false = band
  strength: number;            // 0-100 normalized
  classification: 'STRONG' | 'MEDIUM' | 'WEAK';
  touchCount: number;
  lastTouchTimestamp: number;  // unix ms
  scoreBreakdown: ZoneScoreBreakdown;
  computedAt: number;
  expiresAt: number;           // when to recompute
}

export interface ZoneScoreBreakdown {
  touchCount: number;          // 0-100 score for this dimension
  reversalScore: number;       // 0-100
  volumeScore: number;         // 0-100
  recencyScore: number;        // 0-100
  confluenceBonus: number;     // 0-100
  wickDensity: number;         // 0-100
}
```

**Strength weights** (sum to 1.0, tunable in settings):
- `touchCount`: 0.25
- `reversalScore`: 0.25
- `volumeScore`: 0.15
- `recencyScore`: 0.15
- `confluenceBonus`: 0.10
- `wickDensity`: 0.10

`strength = round(Σ weight_i × dimension_i)`

**Classification thresholds:**
- STRONG: strength ≥ 70
- MEDIUM: 40 ≤ strength < 70
- WEAK: strength < 40

---

## Component 1: StrongZoneDetector

**Path:** `apps/api/src/modules/signal-generator/services/strong-zone-detector.service.ts`

**Method signature:**
```typescript
detectZones(input: {
  token: string;
  symbol: string;
  exchange: string;
  candles15m: CandleData[];   // last 200 bars minimum
  candles1h?: CandleData[];   // last 50 bars (HTF confluence)
  levelBook?: LevelBook;      // for PDH/PDL/round/VWAP confluence
  ltp: number;
  atr14: number;
}): StrongZone[]
```

### Algorithm

**Step 1: Pivot detection**
- 3-bar fractal: bar `i` is a swing high if `high[i] > high[i-3..i-1]` AND `high[i] > high[i+1..i+3]`
- Same logic mirrored for swing lows
- Skip the most recent 3 bars (can't confirm pivot yet)

**Step 2: Cluster pivots into zones**
- Sort pivot prices ascending
- Walk the list: if next pivot is within `clusterTolerance = max(0.4 * atr14, lastPivotPrice * 0.003)` of the current cluster's price range, add to cluster
- Else start a new cluster
- Each cluster becomes a zone:
  - `upper = max(pivot prices in cluster)`
  - `lower = min(pivot prices in cluster)`
  - `isLine = pivots.length <= 2`
  - `type = 'resistance'` if zone center > current LTP, else `'support'`
- Discard clusters with only 1 pivot AND age > 50 bars (too old, single touch — noise)

**Step 3: Score each zone**

For each zone, compute the 6 dimensions (each normalized 0-100):

```
touchCount:    min(100, pivots.length * 25)  // 4+ touches = max
reversalScore: clamp(0-100, avg(post-touch move in ATR) / 3 * 100)
                // 3 ATR move = max score
volumeScore:   clamp(0-100, avg(volume[touchBar] / volMA20) / 2 * 100)
                // 2x avg vol = max
recencyScore:  exp(-barsSinceLastTouch / 50) * 100
                // half-life ~35 bars
confluenceBonus:
  +30 if zone overlaps PDH/PDL/round/VWAP (within 0.2 * atr)
  +20 if zone overlaps a 1H pivot at same level
  +10 if HTF trend agrees (bias from MTF filter)
  cap at 100
wickDensity:   clamp(0-100, avg(touchBar wick / touchBar body) * 50)
                // 2x wick:body = max
```

**Step 4: Apply weights, classify, filter**
- `strength = round(0.25 * touchCount + 0.25 * reversalScore + 0.15 * volumeScore + 0.15 * recencyScore + 0.10 * confluenceBonus + 0.10 * wickDensity)`
- Classify (STRONG/MEDIUM/WEAK)
- Filter: drop zones with `strength < 40` (below WEAK threshold)
- Return top 5 zones above LTP + top 5 below LTP, sorted by distance from LTP

### Caching
- Compute results cached in-memory keyed by `token`, expires after 15 min OR when a new 15m candle closes
- Persist to `Zone` table (new — see Persistence section) for frontend consumption

---

## Component 2: ZoneReversalStrategy

**Path:** `apps/api/src/modules/signal-generator/strategies/zone-reversal.strategy.ts`

Implements the existing `TradingStrategy` interface. Registered via `StrategyRegistryService`.

### Trigger conditions (ALL must be true on a closed 15m bar)

1. **Price touched a STRONG zone in the last 1-2 bars**
   - For resistance: `bar.high >= zone.lower` (intra-zone touch)
   - For support: `bar.low <= zone.upper`

2. **Reversal candle closes opposite to zone direction**
   - Resistance zone → bar must close BELOW zone center (rejection)
   - Support zone → bar must close ABOVE zone center (rejection)

3. **Reversal candle pattern** — must be one of:
   - **Pin bar**: wick toward zone is ≥ 2× body length, body opposite zone
   - **Engulfing**: body fully engulfs prior bar's body, opposite direction
   - **Strong rejection**: body ≥ 60% of bar range, opposite direction, with wick ≥ 25% of body length pointing into zone

4. **Anti-rules** (any of these = reject):
   - Zone has been touched > 6 times (level is breaking down)
   - LTP > 0.5 × ATR away from zone (chasing — wait for re-entry)
   - Within first 5 min or last 5 min of session (open/close volatility)

### Output

```typescript
{
  side: 'BUY' (support) | 'SELL' (resistance),
  entry: bar.close (or limit at zone edge),
  stoploss: zone.upper + 0.3*ATR (resistance) | zone.lower - 0.3*ATR (support),
  target: nearest opposite STRONG zone OR entry + 2.0R, whichever is FIRST,
  partialTakeAt: entry + 1.0R,
  setupType: 'REVERSAL',
  levelType: 'STRONG_ZONE' (new value — see Schema changes),
  levelValue: zone center,
  grade: 'A' if strength >= 80 else 'B',
  reason: `Strong ${zone.type} at ${zone.lower}-${zone.upper} (strength ${zone.strength}). ${candlePattern} rejection.`,
}
```

Locks via `setupTrackerService.lock()` — reuses the entire existing lifecycle.

---

## Component 3: ChartZoneOverlay

**Path:** `apps/web/src/components/charts/ChartZoneOverlay.tsx` (new)

Consumes `/api/signals/zones?token=X&exchange=Y` (new endpoint).

### Rendering

For each zone:
- **isLine: true** → single `priceLine` (lightweight-charts API)
- **isLine: false** → two `priceLine` (upper + lower) + a custom rectangle overlay drawn on a canvas layer above the chart
- Color:
  - STRONG: red (#ef4444 resistance) / green (#22c55e support), opacity 0.3 fill, opacity 0.8 line
  - MEDIUM: orange (#f97316) / blue (#3b82f6), opacity 0.2 fill
  - WEAK: hidden by default (toggle in settings)
- Label: `R 24,750 (S87)` or `S 24,500 (S72)` at the zone right edge

### Integration
- New endpoint: `GET /api/signals/zones?token=X&exchange=Y` returns `StrongZone[]`
- Hook: `useZones(token, exchange)` — polls every 60s
- Mounted in `ChartsPage.tsx` alongside existing chart

---

## Persistence

### New Prisma model: `Zone`

```prisma
model Zone {
  id                  String   @id @default(cuid())
  token               String
  symbol              String
  exchange            String
  type                String   // 'support' | 'resistance'
  upper               Float
  lower               Float
  isLine              Boolean
  strength            Int
  classification      String   // 'STRONG' | 'MEDIUM' | 'WEAK'
  touchCount          Int
  lastTouchTimestamp  DateTime
  scoreBreakdown      Json
  computedAt          DateTime @default(now())
  expiresAt           DateTime

  @@index([token, classification])
  @@index([expiresAt])
  @@map("zones")
}
```

`ZoneRepository` at `apps/api/src/modules/signal-generator/repositories/zone.repository.ts`:
- `upsertMany(zones: StrongZone[])` — batch upsert (delete previous for token, insert fresh)
- `findActiveByToken(token: string): Promise<Zone[]>` — returns non-expired zones

### Migration
`npx prisma migrate dev --name add_zones`

(Note: previous data-pipeline work hit drift — handle similarly with manual application via psql if needed.)

### Setup model extension

The `Setup` model added today already supports arbitrary `levelType`. Add `'STRONG_ZONE'` as a valid string value (no schema change needed since `levelType` is `String` not enum).

---

## Touch points summary

### NEW files (~9)

1. `apps/api/src/modules/signal-generator/types/zone.types.ts` — shared types
2. `apps/api/src/modules/signal-generator/services/strong-zone-detector.service.ts` — detection
3. `apps/api/src/modules/signal-generator/services/strong-zone-detector.service.spec.ts` — tests
4. `apps/api/src/modules/signal-generator/repositories/zone.repository.ts` — persistence
5. `apps/api/src/modules/signal-generator/strategies/zone-reversal.strategy.ts` — strategy
6. `apps/api/src/modules/signal-generator/strategies/zone-reversal.strategy.spec.ts` — tests
7. `apps/web/src/components/charts/ChartZoneOverlay.tsx` — chart overlay
8. `apps/web/src/hooks/useZones.ts` — data hook
9. `prisma/migrations/<timestamp>_add_zones/migration.sql` — DB migration

### MODIFIED files (~7)

1. `prisma/schema.prisma` — add `Zone` model
2. `apps/api/src/modules/signal-generator/signal-generator.module.ts` — register new service + strategy + repo
3. `apps/api/src/modules/signal-generator/services/strategy-registry.service.ts` — register `ZoneReversalStrategy`
4. `apps/api/src/modules/signal-generator/controllers/signal-generator.controller.ts` — add `GET /zones` endpoint
5. `apps/api/src/modules/signal-generator/types/setup-context.types.ts` — extend `levelType` union to include `'STRONG_ZONE'`
6. `apps/web/src/types/index.ts` — mirror `StrongZone` interface + `levelType` extension
7. `apps/web/src/pages/charts/ChartsPage.tsx` — mount `ChartZoneOverlay`

### UNCHANGED (explicitly preserved)

- All existing strategies (vwap-deviation, rsi-reversal, levels-context, anand-sniper, asymmetric-edge — all keep firing)
- `setup-tracker.service.ts` — reused as-is (already supports the contract)
- `level-book.service.ts` — read-only consumer
- `asymmetric-scanner.service.ts` (untracked, in-flight) — not touched

---

## Test plan

### Unit tests (Jest)

**StrongZoneDetector** (`strong-zone-detector.service.spec.ts`) — cover at minimum:
1. Detects swing high/low correctly on synthetic data
2. Clusters nearby pivots into one zone
3. Treats single isolated old pivot as discardable
4. `isLine` true for ≤2 pivot cluster, false for 3+
5. Strength scoring monotonic — more touches → higher score
6. Confluence bonus triggers when zone overlaps PDH/PDL
7. Recency weighting decays old touches
8. Returns top 5 above + 5 below LTP

**ZoneReversalStrategy** (`zone-reversal.strategy.spec.ts`):
1. Fires on STRONG zone touch + pin bar reversal
2. Fires on STRONG zone touch + engulfing reversal
3. Does NOT fire on MEDIUM zone (only STRONG triggers)
4. Does NOT fire if no reversal candle pattern
5. Does NOT fire if zone touched > 6 times (anti-rule)
6. Does NOT fire if LTP > 0.5 ATR from zone (chasing anti-rule)
7. SL placement: 0.3 ATR beyond zone edge
8. Target: nearest opposite STRONG zone OR 2R, whichever first
9. Grade A if strength >= 80, else B

### Integration

- Frontend renders STRONG zones as bands with correct color
- API endpoint returns expected zone shape
- E2E manual test: load chart → see zones drawn → wait for live tick to enter zone → see signal appear in SignalsPage

### Acceptance criteria

- [ ] All new unit tests pass
- [ ] No regression in existing tests (`npm test` in `apps/api/` shows same baseline as before — currently 93/98)
- [ ] At least one zone drawn on Nifty 15m chart on live load
- [ ] Zone overlay survives chart resize, timeframe switch, symbol switch
- [ ] One end-to-end signal fires on a backfilled or live touch+reversal scenario

---

## Risks & mitigations

| Risk | Mitigation |
|---|---|
| Zone detector overfits on synthetic patterns, misses real ones | Test with 200+ bars of real Nifty data, eyeball the zones, tune weights |
| Too many MEDIUM zones clutter the chart | Hide MEDIUM/WEAK by default, toggle in settings |
| ZoneReversalStrategy fires too often (drowns sniper-quality intent) | STRONG-only gate + anti-rules + max-once-per-zone-per-day rule (TODO if seen) |
| Zone scoring weights are wrong | Make weights configurable in settings, allow live tuning |
| Migration drift (Prisma) blocks `migrate dev` | Apply manually via `psql`, patch `_prisma_migrations` (same pattern as Setup persistence) |

---

## Out of scope (deferred)

- Backtesting the strategy on historical data (use existing backtest framework once it's stable)
- Tuning weight defaults from journal data (need more closed trades first)
- Multi-timeframe zone fusion (15m + 1H + 1D layered) — single-TF first, add later
- Auto-disabling noise strategies (vwap-deviation, rsi-reversal) — separate settings change

---

## Implementation plan

Three parallel agents, then integration:

1. **Agent A** — backend detection (StrongZoneDetector + Zone model + ZoneRepository + endpoint)
2. **Agent B** — strategy + setup integration (ZoneReversalStrategy + module wiring + tests)
3. **Agent C** — frontend (ChartZoneOverlay + useZones hook + ChartsPage integration)

After all three complete:
4. Wiring pass — verify shared contract matches across all three
5. Manual E2E test on live chart
6. User reviews and decides whether to commit
