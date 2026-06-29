# Context Scoring Engine — Design Spec

**Date:** 2026-05-07
**Status:** Approved (user picked recommendations across all 5 clarifying questions)
**Author:** Brainstorm session with Claude (Opus 4.7)
**Origin:** Mama's 10-factor stock-trading framework

---

## Goal

Compute a **context score** (-100 to +100) for every locked setup, representing how aligned current market conditions are with the setup's direction. The score combines multiple weighted **factors** (sector trend, volatility, MTF, OI, Greeks, Nasdaq, crude/gold correlation, FII flow). Each factor returns an alignment value relative to the trade side; the engine aggregates with weighted sum.

The score:
- Surfaces on the chart's analysis panel + signal card so the trader sees the basis for the recommendation
- Soft-gates the setup grade — strong supportive context promotes one tier; strong counter context demotes one tier
- Optionally hard-gates (env-toggled) — setups with score below a threshold reject outright

V1 ships with 3 real factors (MTF, Greeks, Volatility) and 6 stubs that contribute zero to the score. Each stub becomes a follow-up spec.

## Non-goals

- Re-deriving the existing reject-gate stack (regime, MTF, R:R, distance, grade-C). Those still gate setup creation; context score gates *grading and acceptance* of already-passing setups.
- Real-time tuning of weights via UI. Weights are hardcoded in v1; a settings page is a follow-up if needed.
- Implementing every stub factor in v1. Sector/OI-shift/FII/Nasdaq/Crude/Gold each have their own scope and become separate specs.
- Backtesting the score's predictive value. Acceptable for v1 to ship with weights based on Mama's prioritization; real data tunes them later.
- Auto-trade triggering off the score. Score informs/gates; execution remains user-driven.

---

## Why this design

The user's mentor ("Mama") laid out a 10-point pre-trade checklist via chat:

> 1st Sectoral analysis · Sector should be up if going for CALL · Volatility should be up · Atleast daily n hourly trend should be aligned · Last but not the least OI data · Delta and gamma · Nasdaq should be aligned · Crude going up means higher probability that market may go down · Gold prices going up means market may go down · FII withdrawal means market may go down · Allocate some percentage to calculate overall trend

This is a **weighted multi-factor scoring system**. Trying to ship all 10 factors at once would take weeks before any value appears in the UI. Instead we ship the **scoring framework** with 3 already-derivable factors as real, 6 as stubs. As each stub becomes a real factor (separate specs), it just slots in — no engine changes needed.

The framework is the foundation; the factors are pluggable.

---

## Architecture

```
                  SignalGeneratorService.analyze()
                              │
                              ▼
              LevelsContextStrategy.analyze() → setupOutput
                              │
                              ▼
              ┌──────────────────────────────────────┐
              │ ContextScoringService.score()         │
              │   for each ContextFactor:             │
              │     factor.compute(input)             │
              │   aggregate: weighted-sum + clamp     │
              │   coverage: realWeight / totalWeight  │
              │   tier: derived from score band       │
              └──────────────────┬───────────────────┘
                                 │ ContextScore
                                 ▼
              ┌──────────────────────────────────────┐
              │ Soft-gate: bump grade ±1 tier         │
              │   score >= +60 → C→B, B→A             │
              │   score <= -30 → A→B, B→C             │
              └──────────────────┬───────────────────┘
                                 │
                                 ▼
              ┌──────────────────────────────────────┐
              │ Hard-gate (opt-in via env):           │
              │   if CONTEXT_SCORE_REJECT_BELOW set   │
              │   AND score <= threshold              │
              │   → return 'reject:context-score'     │
              └──────────────────┬───────────────────┘
                                 │
                                 ▼
                        setupTracker.lock(setup)  (existing flow)
                                 │
                                 ▼
                  AnalyzeResult.setup with contextScore +
                  contextTier + contextCoverage + contextFactors
                                 │
                                 ▼
              Frontend: AnalysisPanel section + SignalCard chip
```

**Component responsibilities:**

| Component | Responsibility |
|---|---|
| `ContextScoringService` | Hold the registered `ContextFactor[]`, run them in parallel, aggregate results, derive tier + coverage. |
| `ContextFactor` interface | Each factor is a small class with `name`, `weight`, and an async `compute(input)` that returns `FactorResult`. |
| `MtfTrendFactor` (real, v1) | Reads `setupContext.higherTimeframeTrend.bias` (already computed) and converts to alignment-with-side value. |
| `GreeksFactor` (real, v1) | Reads `setupContext.recommendedStrike?.delta` and checks sign agreement with side. |
| `VolatilityFactor` (real, v1) | Reads VIX from `MarketContextService`, classifies as rising/falling, maps to alignment. Mama: "volatility should be up." |
| `SectorFactor`, `OiShiftFactor`, `FiiFactor`, `NasdaqFactor`, `CrudeOilFactor`, `GoldFactor` (stubs, v1) | Return `{ value: 0, tier: 'NEUTRAL_STUB', isStub: true }`. Real implementations are follow-up specs. |
| `SignalGeneratorService.analyze` | Calls `ContextScoringService.score(...)` after the strategy fires, applies soft-gate + hard-gate, threads `contextScore`/`contextTier`/`contextCoverage`/`contextFactors` onto `SetupContext` + `AnalyzeResult.setup`. |
| `AnalysisPanel` | New collapsible "Market Context" section showing score, tier, coverage, and per-factor breakdown. |
| `SignalCard` | New `Ctx +72 BULL` chip alongside existing grade badge. |

---

## Per-factor contract

```typescript
type Tier =
  | 'STRONG_BULL' | 'BULL' | 'NEUTRAL'
  | 'BEAR' | 'STRONG_BEAR'
  | 'NEUTRAL_STUB';

interface FactorInput {
  side: 'BUY' | 'SELL';
  token: string;
  symbol: string;
  exchange: string;
  setupContext: SetupContext;
}

interface FactorResult {
  value: number;          // -1.0 (counter) to +1.0 (supportive), alignment-with-side
  tier: Tier;
  isStub: boolean;
  detail?: Record<string, unknown>;
}

interface ContextFactor {
  readonly name: string;
  readonly weight: number;
  compute(input: FactorInput): Promise<FactorResult>;
}

// Tier derivation from value (only when isStub === false):
//   value >= +0.6  → STRONG_BULL
//   value >= +0.2  → BULL
//   value > -0.2 < +0.2 → NEUTRAL
//   value <= -0.2  → BEAR
//   value <= -0.6  → STRONG_BEAR
// When isStub === true → tier is always 'NEUTRAL_STUB'
```

A factor that throws is caught by the scoring service and treated as a stub for that call (returns `NEUTRAL_STUB` with the error in `detail.error`). One broken factor never blocks the score.

---

## Aggregation

```
Inputs: ContextFactor[] (registered factors), FactorInput

For each factor:
  result = await factor.compute(input)   (catches throws → stub result)

totalWeight = sum(factor.weight)
realWeight  = sum(factor.weight where result.isStub === false)

rawScore = sum(factor.weight × result.value × 100) over all factors
contextScore = clamp(round(rawScore), -100, +100)

contextTier:
  contextScore >= +60 → STRONG_BULL
  contextScore >= +20 → BULL
  -20 < contextScore < +20 → NEUTRAL
  contextScore <= -20 → BEAR
  contextScore <= -60 → STRONG_BEAR

contextCoverage = realWeight / totalWeight   (0.0 to 1.0)

Per-factor breakdown:
  factors[].contribution = round(weight × value × 100)
  factors[].tier = result.tier
  factors[].value = result.value
  factors[].isStub = result.isStub
  factors[].detail = result.detail
  factors[].weight = factor.weight
```

Note: tier thresholds for the **combined score** (±60, ±20) differ from per-factor tier thresholds (±0.6, ±0.2) because per-factor is on a -1..+1 scale and combined is -100..+100. They map proportionally.

---

## Weights (v1)

```typescript
const FACTOR_WEIGHTS = {
  mtfTrend:   0.20,  // "atleast daily n hourly should be aligned" — Mama's floor
  sector:     0.15,  // "1st sectoral analysis" — Mama
  fii:        0.15,  // "FII withdrawal means market may go down" — Mama
  oiShift:    0.15,  // "last but not least OI data" — Mama
  volatility: 0.10,  // "volatility should be up" — Mama
  nasdaq:     0.10,
  greeks:     0.05,  // already in recommendedStrike — avoid double-counting
  crudeOil:   0.05,  // inverse correlation — secondary
  gold:       0.05,  // inverse correlation — secondary
};
// Sum = 1.00
```

Hardcoded in `ContextScoringService` for v1. Tunable later via settings if needed.

---

## Real factor implementations (v1)

### `MtfTrendFactor`

Input: `setupContext.higherTimeframeTrend.bias` (already computed by SignalGeneratorService before strategy.analyze).

```
IF bias is null:
  value = 0, tier = NEUTRAL, detail = { reason: 'higher TF unavailable' }
ELSE:
  alignedWithSide =
    (side === 'BUY'  && bias === 'bullish') ||
    (side === 'SELL' && bias === 'bearish')
  oppositeSide =
    (side === 'BUY'  && bias === 'bearish') ||
    (side === 'SELL' && bias === 'bullish')

  IF alignedWithSide:  value = +1.0, tier = STRONG_BULL
  IF oppositeSide:     value = -1.0, tier = STRONG_BEAR
  IF bias === 'neutral': value = 0, tier = NEUTRAL

detail = { tf: higherTimeframeTrend.tf, bias, ema9, ema21 }
isStub = false
```

### `GreeksFactor`

Input: `setupContext.recommendedStrike` (already locked by the strategy when grade is high enough).

```
IF recommendedStrike is null:
  value = 0, tier = NEUTRAL, detail = { reason: 'no strike recommendation' }
ELSE:
  delta = recommendedStrike.delta   // signed; CE positive, PE negative
  expectedSign = side === 'BUY' ? +1 : -1
  actualSign = sign(delta)

  IF actualSign === expectedSign:
    value = min(1.0, abs(delta) / 0.6)  // ATM-ish has lower magnitude than deep ITM
    tier = derived from value
  ELSE:
    value = -min(1.0, abs(delta) / 0.6)
    tier = derived (negative)

detail = { strike, side, delta, gamma }
isStub = false
```

### `VolatilityFactor`

Input: VIX values from `MarketContextService` (existing service that exposes India VIX). We need today's VIX vs. yesterday's VIX (or a rolling 5-day average) to classify as rising / falling.

```
IF MarketContextService unavailable OR VIX history insufficient:
  value = 0, tier = NEUTRAL, detail = { reason: 'no VIX data' }
ELSE:
  vix = current VIX
  vixYesterday = VIX 1 trading day ago (from market-context cache)
  vixChange = (vix - vixYesterday) / vixYesterday   // fractional

  Mama's rule: "volatility should be up" — IV rising is a tailwind for both
  BUY and SELL setups (more option premium movement). Direction-symmetric:

  IF vixChange >= +0.05:   value = +1.0   (volatility rising 5%+)
  IF vixChange >= +0.02:   value = +0.5   (volatility rising 2-5%)
  IF -0.02 < vixChange < +0.02: value = 0  (flat)
  IF vixChange <= -0.02:   value = -0.5   (falling 2-5%)
  IF vixChange <= -0.05:   value = -1.0   (falling 5%+)

  tier = derived from value
  detail = { vix, vixYesterday, vixChange }
isStub = false
```

Note: this factor's value is **direction-agnostic** with respect to the setup's side — high VIX is good for both BUY and SELL. So we don't sign-flip based on side; the same value applies to either.

---

## Stub factors (v1)

Each stub returns `{ value: 0, tier: 'NEUTRAL_STUB', isStub: true, detail: { reason: 'stub — separate spec required' } }`.

Stub classes are tiny (~15 lines each) and exist purely so the engine can register them and report coverage correctly. Each stub becomes a follow-up spec → real implementation in subsequent sessions:

| Stub | Future spec scope |
|---|---|
| `SectorFactor` | Stock→sector mapping (NIFTY IT for tech, NIFTY BANK for banks, etc.) + sector-index trend (EMA9/21 on the sector's 1D or 1H). Direction-flipped per side. |
| `OiShiftFactor` | Read recent OI snapshots from `OISnapshot` table. Compute PCR delta over last N hours, max-pain shift, unusual call/put OI buildup. |
| `FiiFactor` | Daily FII cash + futures flow ingestion (NSE bulletin / Moneycontrol scrape). Net inflow → bullish, net outflow → bearish. |
| `NasdaqFactor` | Pre-market / close direction of Nasdaq futures via external API. Direction-flipped per side. |
| `CrudeOilFactor` | Today's intraday crude (we have token) — % move. Inverse correlation: crude up → bearish for NIFTY/BANKNIFTY equities. |
| `GoldFactor` | Same as crude — need to add gold to universe + same inverse correlation. |

---

## Integration with grade adjustment

```
After ContextScoringService.score() returns:

// Soft-gate (always on)
let adjustedGrade = setup.grade
IF contextScore >= +60: adjustedGrade = bumpUp(setup.grade)     // C→B, B→A, A unchanged
IF contextScore <= -30: adjustedGrade = bumpDown(setup.grade)   // A→B, B→C, C unchanged

setup.grade = adjustedGrade

// Hard-gate (opt-in via env)
const rejectBelow = parseInt(env.CONTEXT_SCORE_REJECT_BELOW ?? '', 10)
IF Number.isFinite(rejectBelow) AND contextScore <= rejectBelow:
  return AnalyzeResult.no-setup with:
    reason: `reject:context-score (score=${contextScore} <= ${rejectBelow})`
    rejections: [
      blockedAt: 'context-score',
      blockedReason: `Context score ${contextScore} below reject threshold ${rejectBelow}`,
      detail: { contextScore, factors }
    ]

// If neither gate vetoed, proceed with the existing setupTracker.lock(setup) flow.
```

The adjusted grade flows naturally through the existing locking + chartink-source enrichment + AnalyzeResult shape.

---

## Data shape changes

`SetupContext` (apps/api/src/modules/signal-generator/types/setup-context.types.ts) gains five optional fields:

```typescript
contextScore?: number;          // -100 to +100, alignment with side
contextTier?: 'STRONG_BULL' | 'BULL' | 'NEUTRAL' | 'BEAR' | 'STRONG_BEAR';
contextCoverage?: number;       // 0.0 to 1.0, fraction of weight from real (non-stub) factors
contextFactors?: Array<{
  name: string;
  weight: number;
  tier: Tier;
  value: number;
  contribution: number;        // round(weight × value × 100)
  isStub: boolean;
  detail?: Record<string, unknown>;
}>;
```

Note: `contextTier` excludes `NEUTRAL_STUB` since the combined score is never a stub itself (it's an aggregation; even if all factors are stubs, the score is 0 → NEUTRAL).

`AnalyzeResult.setup` mirrors all five.

Frontend `Signal` / `SetupAnalysis` (apps/web/src/types/index.ts and AnalysisPanel.tsx) mirrors all five.

All optional so existing tests + persisted setups continue to work unchanged.

---

## Frontend display

### `AnalysisPanel` — new "Market Context" section

Renders below the existing "Confluence" chips when `contextScore !== undefined`:

```
─────────────────────────────────────
Market Context             +72  BULL
3/9 factors active · coverage 35%
─────────────────────────────────────
  MTF Trend         BULL    +20    [real]   1H ema9>ema21
  Volatility        BULL    +10    [real]   VIX +3.2% vs yesterday
  Greeks            NEUTRAL  +0    [real]   Δ 0.18 (low conviction)
  Sector            STUB     +0    follow-up spec
  OI Shift          STUB     +0    follow-up spec
  FII               STUB     +0    follow-up spec
  Nasdaq            STUB     +0    follow-up spec
  Crude Oil         STUB     +0    follow-up spec
  Gold              STUB     +0    follow-up spec
─────────────────────────────────────
```

- Score color: green for `>= +30`, red for `<= -30`, grey for middle band.
- Per-factor row: contribution value coloured by sign; STUB rows greyed out.
- Detail strings come from each factor's `detail` field.

### `SignalCard` — new context chip

Alongside the existing grade badge:

```
[Grade A]  [Ctx +72 BULL]  [📊 Chartink: ...]
```

- Background: `bg-emerald-500/15 text-emerald-400` for `>= +30`
- Background: `bg-red-500/15 text-red-400` for `<= -30`
- Background: `bg-gray-500/15 text-gray-300` otherwise

---

## Edge cases

| Case | Behavior |
|---|---|
| `MarketContextService` unavailable (test wiring) | `VolatilityFactor` returns NEUTRAL with `detail.reason='no VIX data'`. Score still computes from MTF + Greeks. |
| All factors stub (e.g., minimal setupContext, no MTF trend computed) | Score = 0, tier = NEUTRAL, coverage = 0. Soft-gate doesn't fire (score not <= -30 nor >= +60). |
| Factor throws | Caught by ContextScoringService, treated as stub for that call: `{ value: 0, tier: 'NEUTRAL_STUB', isStub: true, detail: { error: err.message } }`. Other factors continue. |
| Hard-gate env var unset | Hard-gate skipped silently. Soft-gate still applies. |
| Hard-gate env var set to a non-numeric string | `parseInt` returns NaN, `Number.isFinite` filters out → hard-gate skipped silently. Logs a warning at startup if needed (optional for v1). |
| Setup grade C, soft-gate says "demote" | C→C (clamped). No change. |
| Setup grade A, soft-gate says "promote" | A→A (clamped). No change. |
| Score exactly equals a threshold (-30, +60, or hard-gate value) | `<=` and `>=` semantics — boundary belongs to the demote/reject side. Documented in the algorithm pseudocode. |
| `setupContext.recommendedStrike` is null (rare; happens when strike resolution fails) | `GreeksFactor` returns NEUTRAL, contributes 0. |

---

## Test plan

### Unit tests

| File | Coverage |
|---|---|
| `context-scoring.service.spec.ts` | Aggregation: weighted sum correctness, clamping at ±100, coverage computation, tier derivation from score, factor-throws-treated-as-stub, all-stubs-yields-zero. |
| `mtf-trend.factor.spec.ts` | Value mapping for each side × bias combo; null bias → NEUTRAL. |
| `greeks.factor.spec.ts` | Sign-agreement logic; missing recommendedStrike → NEUTRAL; magnitude scaling. |
| `volatility.factor.spec.ts` | VIX rising/falling thresholds; missing VIX history → NEUTRAL. |
| Per-stub factor specs (`sector.factor.spec.ts`, etc.) | Returns `{ value: 0, isStub: true, tier: 'NEUTRAL_STUB' }` regardless of input. Trivial. |

### Integration test

| Test | Coverage |
|---|---|
| `signal-generator.service.spec.ts` (extended) | Setup with bullish MTF + BUY side → contextScore positive; setup with bearish MTF + BUY side → contextScore negative; soft-gate promotes B→A when score ≥ 60; soft-gate demotes A→B when score ≤ -30; hard-gate rejects when env set + score below threshold. |

### Frontend smoke

The new `AnalysisPanel` section and the `SignalCard` chip are pure presentation (read from `setup.contextScore` etc.). Visual smoke check covers it; no automated test required for v1.

---

## Out of scope (explicit)

- **Real implementations of the 6 stub factors**: Sector, OI Shift, FII, Nasdaq, Crude, Gold. Each becomes its own spec.
- **Settings page for runtime weight tuning**: weights hardcoded in v1. Promote to settings only after observing real data.
- **Score persistence in DB**: contextScore lives only on the locked-setup in-memory tracker + the analyze response. Setup model in Prisma doesn't gain new columns. (Same per-compute approach as `tp1Source` / `flippedAt`.)
- **Backtest validation of weights**: the framework is the deliverable; weight calibration is a follow-up.
- **Cross-symbol / market-wide score** (e.g. "today's NIFTY context score"): per-setup only in v1. A market-wide aggregate is a follow-up.
- **Auto-trade triggering off score**: score informs grading and acceptance; execution remains user-driven.

---

## Roll-out

- Single Prisma-free change set. No schema migration.
- No env vars required for v1 to function. Hard-gate is opt-in via `CONTEXT_SCORE_REJECT_BELOW=...` (unset = no hard reject).
- All factors are registered in `ContextScoringService` constructor; adding a new real factor (replacing a stub) is one import + provider change.
- Reversion path: revert the commit. Optional fields on `SetupContext` go silently dormant; existing tests + persisted setups are unaffected.

---

## Follow-up specs (deferred from this design)

Each becomes its own brainstorm → spec → plan → ship cycle:

1. **Sector Factor**: stock→sector mapping + sector-index trend logic
2. **OI Shift Factor**: PCR delta, max-pain shift, unusual OI buildup detection
3. **FII Factor**: NSE bulletin / Moneycontrol ingestion + flow classification
4. **Nasdaq Factor**: external pre-market data source + direction-flipped correlation
5. **Crude/Gold Correlation Factor**: inverse-correlation logic (Crude existing token; Gold needs adding to universe)
6. **Settings page for weight tuning**: if/when real-data calibration suggests we want runtime adjustment
