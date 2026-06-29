# Chartink Scoring & Lot Sizing — Design Spec

**Date:** 2026-05-12
**Status:** Approved (user picked recommendations at every clarifying question)
**Author:** Brainstorm session with Claude (Opus 4.7)

---

## Goal

For each Chartink-sourced setup that passes the existing **MTF gate** and `analyze()` reject-stack, compute a **0–100 trade-quality score** from 8 technical/contextual checks, then map the score to a **lot count** (1–3 lots or skip). Persist the score + per-check breakdown on `ChartinkAlertSetup` and render as an outcomes table on `/chartink`.

This is **Chartink-specific** for v1. Cron-fired setups continue to use the existing flow unchanged. The new scoring lives *between* `analyze()` and the alert-setup persistence step.

## Non-goals

- Modifying the existing `MtfAlignmentService` (the 4-TF directional gate). Scoring runs on hits that pass it.
- Modifying the existing `context-scoring` engine (-100 to +100 alignment with stub factors). That's a different abstraction with different goals; we don't reuse it here because (a) its scale is alignment-centered ±100, (b) its mission is grade-adjustment, not lot-sizing, (c) the user's new checks are binary pass/fail with fixed point allocations — a fundamentally different scoring shape.
- Modifying `SignalScoringService` (the 40-floor ensemble score for signal acceptance). That's an entirely different scoring system.
- Auto-execution. The score + lot count surface on the UI as a recommendation; the user still triggers the trade.
- Universal scoring across all setups. Only Chartink-sourced for v1. Cron-fired path uses existing logic.
- Backtest validation of the weights. The point allocations are user-prescribed; calibration is a follow-up.

---

## Why this design

The user's Chartink pipeline has been producing 0 setups all day despite the MTF gate tuning — the underlying scanner picks pass MTF then get rejected by `analyze()` for legitimate trading reasons (round-number, VWAP confirmation, distance). The user wants:

1. **Quantification**: turn pass/fail into a 0–100 score so the trader sees *how good* a signal is, not just yes/no.
2. **Position sizing tied to conviction**: 3 lots when everything aligns, 1 lot when minimum criteria are met, skip otherwise.
3. **Sector + index emphasis**: macro context outweighs specific oscillator signals (matches Mama's framework).

The existing context-scoring engine doesn't satisfy these because its scale (±100 alignment) doesn't map cleanly to lot bands, and its factors (FII, Greeks, Nasdaq, Crude, Gold) are different from what the user wants for Chartink hits (MACD, EMA, SuperTrend, S/R distance).

A **separate** Chartink-specific scoring service is cleaner than retrofitting either existing system.

---

## Architecture

```
ChartinkProcessService.processOne(hit)
  │
  ├── resolve symbol → token  (existing)
  ├── MtfAlignmentService.check  (existing — gate, no change)
  │      └── on misalignment → persist mtf-misaligned, return
  ├── signalGeneratorService.analyze(...)  (existing)
  │      └── on no-setup → persist no-setup, return
  │
  ▼  setup found by analyze()
  │
  ▼
ChartinkScoringService.score(hit, instrument, setupResult)
  │      ├── for each of 9 checks:  pass/fail + points
  │      ├── total = sum(points)
  │      ├── lotCount = band(total)
  │      └── breakdown = { check_name → { passed, points, detail } }
  │
  ▼
ChartinkRepository.createAlertSetup with new fields:
  { ...existing, score, lotCount, scoreBreakdown }
```

**Component responsibilities:**

| Component | Responsibility |
|---|---|
| `ChartinkScoringService` (NEW) | Run all 9 checks against a setup, sum points, map to lot count, return breakdown. |
| Per-check helpers (private methods on the service) | Each check is a small async method returning `{ passed: bool, points: number, detail?: any }`. |
| `ChartinkProcessService` (MODIFIED) | After analyze() returns a setup, invoke the scoring service. Pass score + lotCount + breakdown to the repository. |
| `ChartinkRepository` (MODIFIED) | `createAlertSetup` accepts the three new fields. |
| Prisma `ChartinkAlertSetup` model (MODIFIED) | Add three columns: `score Int?`, `lotCount Int?`, `scoreBreakdown Json?`. Migration required. |
| `ChartinkPage.tsx` (MODIFIED) | When expanding an alert row, show the per-check table for each setup. Add a "Score / Lots" column to the per-setup line. |

---

## Scoring table (point allocations)

| # | Check | Points | Pass condition |
|---|---|---|---|
| 1 | **Sector aligned** | 20 | The stock's sector index (NIFTY IT, NIFTY BANK, etc.) has price > 20-EMA on 15m for long setups (< for short). |
| 2 | **Index aligned** | 20 | NIFTY 50 (or relevant index for the stock's exchange) has price > 20-EMA on 15m for long setups (< for short). |
| 3 | MACD on daily | 10 | MACD line > signal line on daily for long setups (< for short). |
| 4 | MACD on 1m | 7 | MACD line > signal line on 1m for long setups (< for short). |
| 5 | MACD on 5m | 8 | MACD line > signal line on 5m for long setups (< for short). |
| 6 | Price vs 20-EMA | 10 | Setup side = BUY → close > 20-EMA on 15m; SELL → close < 20-EMA on 15m. |
| 7 | SuperTrend match | 10 | SuperTrend(10, 3) color on 15m matches setup direction (green for BUY, red for SELL). |
| 8 | S/R room | 10 | Distance from entry to next opposing S/R level ≥ 40% of recent 20-bar ATR. |
| 9 | Volume confirmation | 5 | Today's cumulative volume > 1.2 × 20-day average daily volume. |
| | **Total possible** | **100** | |

## Lot-count mapping

```
score < 50         → 0 lots (skip — persist with lotCount=0 so it's visible on /chartink)
50 ≤ score < 65    → 1 lot
65 ≤ score < 80    → 2 lots
score ≥ 80         → 3 lots
```

The bands are tunable constants on `ChartinkScoringService` (not env-driven for v1; promote to env when we observe real data).

---

## Per-check algorithms

### #1 Sector aligned (20 pts)

1. Look up the stock's sector via a static `SYMBOL_TO_SECTOR_INDEX` map (e.g., `RELIANCE` → `NIFTY ENERGY`, `HDFCBANK` → `NIFTY BANK`). Map seeded from `packages/shared/src/constants/index.ts` `SECTOR_INDICES`.
2. If no sector mapping → mark as `passed: false, points: 0, detail: { reason: 'no sector mapping' }`.
3. Else fetch the sector index's last 25 15m candles via `AngelOneAdapterService.getHistoricalData`.
4. Compute 20-EMA on the close series.
5. Compare current price vs 20-EMA per setup side. Pass if aligned.

### #2 Index aligned (20 pts)

Same as #1 but always uses NIFTY 50 (token `99926000`, exchange `NSE`) as the index. No mapping needed.

### #3 MACD on daily (10 pts)

1. Fetch last 50 daily candles for the stock.
2. Compute MACD: EMA12, EMA26, MACD line (12-26), signal line (9-EMA of MACD).
3. Pass if MACD line > signal line (for BUY) or < (for SELL).

### #4 MACD on 1m (7 pts)

Same algorithm as #3 but with 1-minute candles, lookback 60 bars (1 hour).

### #5 MACD on 5m (8 pts)

Same as #3 with 5m candles, lookback 60 bars (5 hours).

### #6 Price vs 20-EMA (10 pts)

1. Fetch last 30 15m candles.
2. Compute 20-EMA on close.
3. Compare latest close vs 20-EMA per setup side.

### #7 SuperTrend match (10 pts)

1. Fetch last 30 15m candles.
2. Compute SuperTrend(period=10, multiplier=3) — standard formula using ATR.
3. SuperTrend's "direction" attribute is +1 (uptrend, green) or -1 (downtrend, red).
4. Pass if direction matches: +1 for BUY, -1 for SELL.

### #8 S/R room (10 pts)

1. Use `setupResult.setupContext.levelBookSnapshot` — already computed by analyze().
2. For a BUY setup: the next opposing S/R = nearest of PDH, ORH if > entry, else use a recent swing-high computed from last 50 15m bars.
3. For a SELL setup: nearest of PDL, ORL if < entry, else use a recent swing-low.
4. Compute `roomToBlocker = |nextSR - entryPrice|`.
5. Compute 20-bar ATR from the same 15m candles.
6. Pass if `roomToBlocker / atr20 >= 0.4`.

### #9 Volume confirmation (5 pts)

1. Today's cumulative volume — sum of all today's 5m bars.
2. 20-day average daily volume — fetch last 20 daily candles, average the volume.
3. Pass if `todayVolume > 1.2 × avgVolume`.

---

## Data model

### Prisma migration

`prisma/schema.prisma` — `ChartinkAlertSetup` gains three optional columns:

```prisma
model ChartinkAlertSetup {
  id            String   @id @default(cuid())
  alertId       String
  alert         ChartinkAlert @relation(fields: [alertId], references: [id])
  symbol        String
  token         String?
  hitPrice      Float
  kind          String
  setupId       String?
  rejectReason  String?
  processedAt   DateTime @default(now())

  // NEW v1.1 fields — Chartink scoring + lot sizing
  score          Int?
  lotCount       Int?
  scoreBreakdown Json?
  // shape: Array<{ name: string; points: number; passed: boolean; detail?: Record<string, unknown> }>

  @@index([alertId])
  @@index([token])
  @@map("chartink_alert_setups")
}
```

Migration: `prisma/migrations/20260512XXXXXX_add_chartink_scoring`. Single ALTER TABLE adding three nullable columns. No data backfill needed.

### TypeScript types

`apps/api/src/modules/chartink/services/chartink-scoring.service.ts` exports:

```typescript
interface ScoreCheckResult {
  name: string;             // human-readable, e.g. "Sector aligned"
  points: number;           // points awarded (0 if failed)
  pointsPossible: number;   // max points for this check
  passed: boolean;
  detail?: Record<string, unknown>;  // free-form diagnostic data
}

interface ScoringResult {
  score: number;            // 0-100, sum of awarded points
  lotCount: 0 | 1 | 2 | 3;
  checks: ScoreCheckResult[];
}
```

`ChartinkRepository.createAlertSetup` input shape extends with optional `score`, `lotCount`, `scoreBreakdown` fields. Existing call sites that don't supply them still work (Prisma writes nulls).

---

## Frontend

`apps/web/src/pages/chartink/ChartinkPage.tsx`:

1. **Recent alerts row**: add a `Score` column showing the highest score across all setups in that alert. E.g., `Score: 67 (2 lots)`. Color-coded:
   - 80+ → green
   - 65–79 → blue
   - 50–64 → orange
   - <50 → grey
   - No score (kind ≠ 'setup' or scoring failed) → "—"

2. **Expanded alert detail**: under each setup line, render a small per-check table:

```
RELIANCE @ 2885   kind: setup   score: 73 → 2 lots
  ✓ Sector aligned         20/20  NIFTY ENERGY > 20EMA
  ✓ Index aligned          20/20  NIFTY 50 > 20EMA
  ✓ MACD daily              10/10  +0.45 vs +0.42
  ✗ MACD 1m                  0/7   −0.02 vs +0.01
  ✓ MACD 5m                  8/8   +0.18 vs +0.15
  ✓ Price > 20-EMA          10/10  2885 > 2865
  ✓ SuperTrend (green)      10/10
  ✗ S/R room                 0/10  Only 25% of ATR (need 40%)
  ✗ Volume confirmation      0/5   0.98× 20-day avg
  ─────────────────────────────────
                            68/100 → 2 lots
```

Implementation: small `ChartinkScoreTable` component, rendered conditionally when `setup.scoreBreakdown` is non-null.

---

## Edge cases

| Case | Behavior |
|---|---|
| `analyze()` returned no setup | Scoring service never invoked. Persisted setup has `score=null, lotCount=null, scoreBreakdown=null`. Frontend shows "—" in score column. |
| One of the 9 broker fetches throws | That check returns `passed: false, points: 0, detail: { error: msg }`. Other checks continue. Score is computed from what we got. Coverage info in detail. |
| Symbol has no sector mapping (e.g., new IPO, indices themselves) | `SectorAligned` check: `passed: false, points: 0, detail: { reason: 'no sector mapping' }`. Total max is effectively 80. Lot bands still apply on the actual score (someone scoring 65 still gets 2 lots even without sector). |
| Setup is for an index (NIFTY, BANKNIFTY) | Index alignment check is meaningless (self-comparison). `IndexAligned` returns `passed: false, points: 0, detail: { reason: 'setup is on an index' }`. Same as above — lot bands still apply. |
| Setup direction missing/unknown | Scoring service returns `score=0, lotCount=0, checks=[]`. Logged as error. |
| Multiple setups in one alert | Each setup gets its own scoring + breakdown. Stored per-setup row in DB. |
| Score exactly 50, 65, or 80 | Inclusive-low / exclusive-high banding: 50→1 lot, 65→2 lots, 80→3 lots (the threshold itself belongs to the higher band). |
| Existing alerts in DB (pre-migration) | All three new columns null. Frontend handles null gracefully (no breakdown rendered). |

---

## Test plan

### Unit tests

| File | Coverage |
|---|---|
| `chartink-scoring.service.spec.ts` (NEW) | Each check tested with mocked broker data: pass case, fail case, missing-data case. Lot-band mapping for score = 0, 49, 50, 64, 65, 79, 80, 100. Total-score aggregation. One-check-throws-doesn't-blow-up. |
| `chartink-process.service.spec.ts` (EXTENDED) | Mock `ChartinkScoringService.score` returning a fixed result; assert `createAlertSetup` is called with the score/lotCount/breakdown fields populated. Mock returns null → fields are null. |
| `chartink-repository.spec.ts` (EXTENDED) | `createAlertSetup` accepts the new fields and persists them; reads back correctly. |

### Integration

| Test | Coverage |
|---|---|
| `chartink.e2e-spec.ts` (EXTENDED) | Fire a synthetic webhook for RELIANCE with a known up-trending setup; assert the resulting `ChartinkAlertSetup` row has `score > 50` and `lotCount > 0`. (Will be skipped in CI without broker access; manual run.) |

### Frontend smoke

`ChartinkPage.tsx` rendering: load with mock alert data including `score` + `scoreBreakdown`; verify the table renders correctly with color-coded score badge.

---

## File layout

```
apps/api/src/modules/chartink/services/
├── chartink-scoring.service.ts                 NEW (~250 lines)
├── chartink-scoring.service.spec.ts            NEW
├── chartink-process.service.ts                 MODIFIED (~10 lines added)
├── __tests__/
│   └── chartink-process.service.spec.ts        MODIFIED (1-2 test cases)
└── chartink-repository.ts                      MODIFIED (~3 lines for new fields)

apps/api/src/modules/chartink/repositories/
└── chartink.repository.spec.ts                 NEW or MODIFIED

prisma/
├── schema.prisma                                MODIFIED (3 columns on ChartinkAlertSetup)
└── migrations/
    └── 20260512XXXXXX_add_chartink_scoring/
        └── migration.sql                        NEW

apps/web/src/
├── components/charts/
│   └── ChartinkScoreTable.tsx                  NEW (small component)
├── pages/chartink/
│   └── ChartinkPage.tsx                         MODIFIED (score column + breakdown rendering)
└── types/index.ts                               MODIFIED (ChartinkAlertSetup type)
```

---

## Out of scope (deferred)

1. **Tuning the 9 weights based on real-data** — v1 ships with user-prescribed allocations.
2. **Per-scanner override of bands** — all Chartink scanners use the same bands in v1. Per-scanner thresholds = follow-up if needed.
3. **Sector mapping for stocks not in the static map** — v1 uses the existing `SECTOR_INDICES` constant. Stocks without sector mapping just fail check #1.
4. **Universal scoring (cron-fired setups too)** — Chartink-only for v1. Migrating cron setups to the same scoring is a v2 design.
5. **Auto-execution of high-score signals** — v1 only displays the score + lot recommendation. The user triggers the trade.
6. **MACD parameter tuning** — v1 uses standard (12, 26, 9). User-tunable parameters = follow-up.
7. **SuperTrend parameter tuning** — v1 uses standard (10, 3). Same as above.
8. **Score persistence in the `Setup` model** — score lives only on `ChartinkAlertSetup` for v1. Crons setups don't get it.

---

## Roll-out

1. **DB migration**: single ALTER TABLE adding 3 nullable columns. No backfill. Safe to deploy live.
2. **Backend**: new service registered in the Chartink module. Process service updated to call it after analyze() returns a setup.
3. **Frontend**: ChartinkPage shows score column + expanded breakdown when scoreBreakdown is non-null. Backward-compatible with old setups that have null score.
4. **Verification**: trigger a synthetic webhook and observe the score in DB + UI.
5. **Reversion**: revert the migration + code changes. The 3 new columns are nullable so existing data is unaffected.

---

## Success criteria

- A real Chartink fire that passes MTF + analyze() produces a setup row with a non-null `score` between 0 and 100.
- The `lotCount` correctly maps from the score per the bands.
- The `/chartink` page renders the per-check breakdown table when an alert row is expanded.
- All 9 checks have unit-test coverage for pass / fail / missing-data cases.
- No regression: existing setups (cron, pre-migration) still render and process correctly.
