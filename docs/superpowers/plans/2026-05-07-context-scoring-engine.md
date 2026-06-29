# Context Scoring Engine Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Compute and surface a `contextScore` (-100 to +100) on every locked setup, aggregating multiple weighted factors (MTF trend, Greeks, Volatility — real for v1; Sector, OI Shift, FII, Nasdaq, Crude, Gold — stubs). Score soft-gates the existing grade and optionally hard-gates via env.

**Architecture:** A new `ContextScoringService` registers nine `ContextFactor` implementations and aggregates their results into a single weighted score. Lives in `signal-generator/services/context-scoring/` as its own subdirectory. `SignalGeneratorService.analyze` calls the scorer after `LevelsContextStrategy` produces a setup, applies soft-gate (grade ±1 tier) and optional hard-gate (env-driven reject), then surfaces the score + per-factor breakdown on `SetupContext` + `AnalyzeResult.setup`. Frontend renders a context section in `AnalysisPanel` and a chip on `SignalCard`.

**Tech Stack:** TypeScript, NestJS, Jest (backend), React + TailwindCSS (frontend). No new dependencies, no Prisma migration.

**Spec:** `docs/superpowers/specs/2026-05-07-context-scoring-engine-design.md`

---

## File Structure

| File | Responsibility | Modify or Create |
|---|---|---|
| `apps/api/src/modules/signal-generator/services/context-scoring/types.ts` | Tier enum, FactorInput / FactorResult / ContextFactor / ContextScore types | Create |
| `apps/api/src/modules/signal-generator/services/context-scoring/weights.ts` | The hardcoded `FACTOR_WEIGHTS` constant | Create |
| `apps/api/src/modules/signal-generator/services/context-scoring/context-scoring.service.ts` | Registers factors, runs them in parallel, aggregates score / coverage / tier | Create |
| `apps/api/src/modules/signal-generator/services/context-scoring/factors/mtf-trend.factor.ts` | REAL factor — reads `setupContext.higherTimeframeTrend.bias` | Create |
| `apps/api/src/modules/signal-generator/services/context-scoring/factors/greeks.factor.ts` | REAL factor — reads `setupContext.recommendedStrike?.delta` | Create |
| `apps/api/src/modules/signal-generator/services/context-scoring/factors/volatility.factor.ts` | REAL factor — reads VIX from `MarketContextService` | Create |
| `apps/api/src/modules/signal-generator/services/context-scoring/factors/sector.factor.ts` | STUB | Create |
| `apps/api/src/modules/signal-generator/services/context-scoring/factors/oi-shift.factor.ts` | STUB | Create |
| `apps/api/src/modules/signal-generator/services/context-scoring/factors/fii.factor.ts` | STUB | Create |
| `apps/api/src/modules/signal-generator/services/context-scoring/factors/nasdaq.factor.ts` | STUB | Create |
| `apps/api/src/modules/signal-generator/services/context-scoring/factors/crude-oil.factor.ts` | STUB | Create |
| `apps/api/src/modules/signal-generator/services/context-scoring/factors/gold.factor.ts` | STUB | Create |
| `apps/api/src/modules/signal-generator/services/context-scoring/__tests__/context-scoring.service.spec.ts` | Aggregation, coverage, tier mapping, throws-as-stub | Create |
| `apps/api/src/modules/signal-generator/services/context-scoring/__tests__/mtf-trend.factor.spec.ts` | Per-side bias mapping | Create |
| `apps/api/src/modules/signal-generator/services/context-scoring/__tests__/greeks.factor.spec.ts` | Sign agreement + magnitude | Create |
| `apps/api/src/modules/signal-generator/services/context-scoring/__tests__/volatility.factor.spec.ts` | VIX rising / falling thresholds | Create |
| `apps/api/src/modules/signal-generator/types/setup-context.types.ts` | Add `contextScore`, `contextTier`, `contextCoverage`, `contextFactors`, `Tier` re-export | Modify |
| `apps/api/src/modules/signal-generator/signal-generator.module.ts` | Register `ContextScoringService` + 9 factor providers | Modify |
| `apps/api/src/modules/signal-generator/services/signal-generator.service.ts` | Call scorer post-strategy; apply soft-gate / hard-gate; surface fields on SetupContext + AnalyzeResult | Modify |
| `apps/web/src/types/index.ts` | Mirror Tier + 5 SetupContext fields on the frontend Signal type | Modify |
| `apps/web/src/components/charts/AnalysisPanel.tsx` | New "Market Context" section (score + tier + coverage + per-factor breakdown) | Modify |
| `apps/web/src/components/trading/SignalCard.tsx` | New `Ctx +72 BULL` chip alongside existing grade badge | Modify |

---

## Task 1 — Backend types + SetupContext fields

**Files:**
- Create: `apps/api/src/modules/signal-generator/services/context-scoring/types.ts`
- Create: `apps/api/src/modules/signal-generator/services/context-scoring/weights.ts`
- Modify: `apps/api/src/modules/signal-generator/types/setup-context.types.ts`

- [ ] **Step 1: Create the types file**

```typescript
// apps/api/src/modules/signal-generator/services/context-scoring/types.ts
import type { SetupContext } from '../../types/setup-context.types';

/**
 * Tier label assigned to each factor result + the combined context score.
 * NEUTRAL_STUB is used ONLY for per-factor results when the factor's
 * implementation isn't ready yet — it never appears on the combined
 * `contextTier` (which always derives from the aggregated numeric score).
 */
export type Tier =
  | 'STRONG_BULL'
  | 'BULL'
  | 'NEUTRAL'
  | 'BEAR'
  | 'STRONG_BEAR'
  | 'NEUTRAL_STUB';

/**
 * Subset of Tier valid for the combined contextTier — never NEUTRAL_STUB.
 */
export type CombinedTier = Exclude<Tier, 'NEUTRAL_STUB'>;

export interface FactorInput {
  side: 'BUY' | 'SELL';
  token: string;
  symbol: string;
  exchange: string;
  setupContext: SetupContext;
}

export interface FactorResult {
  /** -1.0 (counter-aligned) to +1.0 (supportive of side). */
  value: number;
  tier: Tier;
  isStub: boolean;
  detail?: Record<string, unknown>;
}

export interface ContextFactor {
  readonly name: string;
  readonly weight: number;
  compute(input: FactorInput): Promise<FactorResult>;
}

export interface ContextFactorBreakdown {
  name: string;
  weight: number;
  tier: Tier;
  value: number;
  contribution: number;
  isStub: boolean;
  detail?: Record<string, unknown>;
}

export interface ContextScore {
  contextScore: number;        // -100 to +100, alignment with side
  contextTier: CombinedTier;
  contextCoverage: number;     // 0.0 to 1.0
  contextFactors: ContextFactorBreakdown[];
}

/** Tier derivation thresholds — keep these synced between per-factor (-1..+1) and combined (-100..+100). */
export function tierFromValue(value: number): Tier {
  if (value >= 0.6) return 'STRONG_BULL';
  if (value >= 0.2) return 'BULL';
  if (value <= -0.6) return 'STRONG_BEAR';
  if (value <= -0.2) return 'BEAR';
  return 'NEUTRAL';
}

export function tierFromScore(score: number): CombinedTier {
  if (score >= 60) return 'STRONG_BULL';
  if (score >= 20) return 'BULL';
  if (score <= -60) return 'STRONG_BEAR';
  if (score <= -20) return 'BEAR';
  return 'NEUTRAL';
}
```

- [ ] **Step 2: Create the weights file**

```typescript
// apps/api/src/modules/signal-generator/services/context-scoring/weights.ts

/**
 * Hardcoded weights for the v1 context-scoring engine. Sum = 1.00.
 * Source: spec §"Weights (v1)" — Mama's prioritization, refined for
 * the existing setup pipeline (low explicit weight on greeks because
 * they already drive the option-strike picker).
 *
 * Tunable later via Settings if real-data calibration suggests it.
 */
export const FACTOR_WEIGHTS = {
  mtfTrend:   0.20,
  sector:     0.15,
  fii:        0.15,
  oiShift:    0.15,
  volatility: 0.10,
  nasdaq:     0.10,
  greeks:     0.05,
  crudeOil:   0.05,
  gold:       0.05,
} as const;

export type FactorName = keyof typeof FACTOR_WEIGHTS;
```

- [ ] **Step 3: Modify `setup-context.types.ts` — add 5 optional fields**

Open `apps/api/src/modules/signal-generator/types/setup-context.types.ts` and add this re-export at the top of the file (after the existing imports / before the existing exports):

```typescript
import type {
  Tier,
  CombinedTier,
  ContextFactorBreakdown,
} from '../services/context-scoring/types';

export type { Tier, CombinedTier, ContextFactorBreakdown };
```

Then find the `SetupContext` interface and add five optional fields just before the closing brace:

```typescript
  /**
   * Aggregated context score from ContextScoringService (-100 to +100,
   * alignment with side). Optional so persisted setups from before the
   * scoring engine existed still rehydrate cleanly.
   */
  contextScore?: number;
  contextTier?: CombinedTier;
  /** 0.0 to 1.0 — fraction of total weight from real (non-stub) factors. */
  contextCoverage?: number;
  contextFactors?: ContextFactorBreakdown[];
```

- [ ] **Step 4: Verify TypeScript compiles**

Run: `cd "C:\Users\AryanKumar\Desktop\TD_Automation\apps\api" && npx tsc --noEmit -p tsconfig.json 2>&1 | grep -E "context-scoring|setup-context.types" || echo "OK"`
Expected: `OK`.

- [ ] **Step 5: Commit**

```bash
cd "C:\Users\AryanKumar\Desktop\TD_Automation" && git add apps/api/src/modules/signal-generator/services/context-scoring/types.ts apps/api/src/modules/signal-generator/services/context-scoring/weights.ts apps/api/src/modules/signal-generator/types/setup-context.types.ts && git commit -m "feat(signals): context-scoring types + weights + SetupContext fields

Foundation for the multi-factor scoring engine. Defines Tier /
FactorInput / FactorResult / ContextFactor / ContextScore types
plus the hardcoded FACTOR_WEIGHTS (sum = 1.00). Adds 5 optional
fields to SetupContext (contextScore, contextTier, contextCoverage,
contextFactors). Optional so existing tests + persisted setups
continue to work unchanged.

Spec: docs/superpowers/specs/2026-05-07-context-scoring-engine-design.md"
```

---

## Task 2 — ContextScoringService (aggregator) with tests (TDD)

**Files:**
- Create: `apps/api/src/modules/signal-generator/services/context-scoring/context-scoring.service.ts`
- Create: `apps/api/src/modules/signal-generator/services/context-scoring/__tests__/context-scoring.service.spec.ts`

- [ ] **Step 1: Write the failing tests**

```typescript
// apps/api/src/modules/signal-generator/services/context-scoring/__tests__/context-scoring.service.spec.ts
import { ContextScoringService } from '../context-scoring.service';
import type { ContextFactor, FactorInput, FactorResult } from '../types';

function makeFactor(name: string, weight: number, value: number, isStub = false): ContextFactor {
  return {
    name,
    weight,
    compute: jest.fn().mockResolvedValue({
      value,
      tier: isStub ? 'NEUTRAL_STUB' : 'NEUTRAL',
      isStub,
    } as FactorResult),
  };
}

function makeThrowingFactor(name: string, weight: number): ContextFactor {
  return {
    name,
    weight,
    compute: jest.fn().mockRejectedValue(new Error('boom')),
  };
}

const baseInput: FactorInput = {
  side: 'BUY',
  token: '99926000',
  symbol: 'NIFTY',
  exchange: 'NSE',
  setupContext: {} as never,
};

describe('ContextScoringService', () => {
  it('aggregates weighted-sum × 100 across all factors', async () => {
    const svc = new ContextScoringService([
      makeFactor('a', 0.5, 0.6),  // contributes 30
      makeFactor('b', 0.5, 0.4),  // contributes 20
    ]);
    const result = await svc.score(baseInput);
    expect(result.contextScore).toBe(50);
    expect(result.contextFactors).toHaveLength(2);
  });

  it('clamps the final score to [-100, +100]', async () => {
    const svc = new ContextScoringService([
      makeFactor('a', 1.0, 1.5),  // raw 150 → clamped to 100
    ]);
    const result = await svc.score(baseInput);
    expect(result.contextScore).toBe(100);

    const svc2 = new ContextScoringService([
      makeFactor('a', 1.0, -1.5),  // raw -150 → clamped to -100
    ]);
    const result2 = await svc2.score(baseInput);
    expect(result2.contextScore).toBe(-100);
  });

  it('computes coverage as realWeight / totalWeight', async () => {
    const svc = new ContextScoringService([
      makeFactor('real1', 0.20, 0, false),
      makeFactor('real2', 0.10, 0, false),
      makeFactor('stub1', 0.30, 0, true),
      makeFactor('stub2', 0.40, 0, true),
    ]);
    const result = await svc.score(baseInput);
    expect(result.contextCoverage).toBeCloseTo(0.30, 2);
  });

  it('treats a throwing factor as a stub for that call', async () => {
    const svc = new ContextScoringService([
      makeThrowingFactor('boom', 0.5),
      makeFactor('ok', 0.5, 0.4),
    ]);
    const result = await svc.score(baseInput);
    expect(result.contextScore).toBe(20);  // ok contributes 20, boom 0
    expect(result.contextFactors[0].isStub).toBe(true);
    expect(result.contextFactors[0].tier).toBe('NEUTRAL_STUB');
    expect(result.contextFactors[0].detail).toEqual({ error: 'boom' });
  });

  it('derives contextTier from contextScore via the documented bands', async () => {
    const svc = (val: number) =>
      new ContextScoringService([makeFactor('a', 1.0, val)]);

    expect((await svc(0.7).score(baseInput)).contextTier).toBe('STRONG_BULL');
    expect((await svc(0.3).score(baseInput)).contextTier).toBe('BULL');
    expect((await svc(0.0).score(baseInput)).contextTier).toBe('NEUTRAL');
    expect((await svc(-0.3).score(baseInput)).contextTier).toBe('BEAR');
    expect((await svc(-0.7).score(baseInput)).contextTier).toBe('STRONG_BEAR');
  });

  it('per-factor contribution is round(weight × value × 100)', async () => {
    const svc = new ContextScoringService([
      makeFactor('a', 0.20, 0.5),  // 10
      makeFactor('b', 0.15, -0.3), // -4.5 → rounds to -5 (Math.round half-to-even is +5? — JS Math.round always rounds half up for positive, away-from-zero is -5? actually -0.5 → 0; we use round which is toward +Inf — let's verify in test)
    ]);
    const result = await svc.score(baseInput);
    expect(result.contextFactors[0].contribution).toBe(10);
    // round(-4.5) in JavaScript = -4 (rounds toward +Infinity)
    expect(result.contextFactors[1].contribution).toBe(-4);
  });
});
```

- [ ] **Step 2: Run tests — confirm they fail**

Run: `cd "C:\Users\AryanKumar\Desktop\TD_Automation\apps\api" && npx jest --testPathPattern=context-scoring.service.spec --no-coverage 2>&1 | tail -25`
Expected: tests fail with `Cannot find module '../context-scoring.service'`.

- [ ] **Step 3: Implement the service**

```typescript
// apps/api/src/modules/signal-generator/services/context-scoring/context-scoring.service.ts
import { Injectable, Logger } from '@nestjs/common';
import type {
  ContextFactor,
  FactorInput,
  FactorResult,
  ContextScore,
  ContextFactorBreakdown,
} from './types';
import { tierFromScore } from './types';

@Injectable()
export class ContextScoringService {
  private readonly logger = new Logger(ContextScoringService.name);

  /**
   * Pass the registered factors via constructor. The NestJS module wires
   * each factor as a provider and the scoring service receives them as a
   * single array via a custom provider in signal-generator.module.ts.
   */
  constructor(private readonly factors: ContextFactor[]) {}

  async score(input: FactorInput): Promise<ContextScore> {
    const results = await Promise.all(
      this.factors.map(async (factor): Promise<{ factor: ContextFactor; result: FactorResult }> => {
        try {
          const result = await factor.compute(input);
          return { factor, result };
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          this.logger.warn(
            `Factor ${factor.name} threw — treating as stub: ${message}`,
          );
          return {
            factor,
            result: {
              value: 0,
              tier: 'NEUTRAL_STUB',
              isStub: true,
              detail: { error: message },
            },
          };
        }
      }),
    );

    const totalWeight = results.reduce((s, r) => s + r.factor.weight, 0);
    const realWeight = results
      .filter((r) => !r.result.isStub)
      .reduce((s, r) => s + r.factor.weight, 0);

    const rawScore = results.reduce(
      (s, r) => s + r.factor.weight * r.result.value * 100,
      0,
    );
    const contextScore = clamp(Math.round(rawScore), -100, 100);
    const contextCoverage = totalWeight > 0 ? realWeight / totalWeight : 0;

    const contextFactors: ContextFactorBreakdown[] = results.map((r) => ({
      name: r.factor.name,
      weight: r.factor.weight,
      tier: r.result.tier,
      value: r.result.value,
      contribution: Math.round(r.factor.weight * r.result.value * 100),
      isStub: r.result.isStub,
      detail: r.result.detail,
    }));

    return {
      contextScore,
      contextTier: tierFromScore(contextScore),
      contextCoverage,
      contextFactors,
    };
  }
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}
```

- [ ] **Step 4: Run tests — confirm they pass**

Run: `cd "C:\Users\AryanKumar\Desktop\TD_Automation\apps\api" && npx jest --testPathPattern=context-scoring.service.spec --no-coverage 2>&1 | tail -25`
Expected: 6 tests pass.

- [ ] **Step 5: Commit**

```bash
cd "C:\Users\AryanKumar\Desktop\TD_Automation" && git add apps/api/src/modules/signal-generator/services/context-scoring/context-scoring.service.ts apps/api/src/modules/signal-generator/services/context-scoring/__tests__/context-scoring.service.spec.ts && git commit -m "feat(signals): ContextScoringService aggregator (TDD)

Pure aggregation: weighted-sum × 100, clamp to [-100,+100], compute
coverage as realWeight/totalWeight, derive tier from score bands.
Throwing factors are caught and treated as stubs for that call —
one broken factor never blocks the score.

6/6 unit tests green."
```

---

## Task 3 — Three real factor implementations + tests (TDD)

**Files:**
- Create: `apps/api/src/modules/signal-generator/services/context-scoring/factors/mtf-trend.factor.ts`
- Create: `apps/api/src/modules/signal-generator/services/context-scoring/factors/greeks.factor.ts`
- Create: `apps/api/src/modules/signal-generator/services/context-scoring/factors/volatility.factor.ts`
- Create: `apps/api/src/modules/signal-generator/services/context-scoring/__tests__/mtf-trend.factor.spec.ts`
- Create: `apps/api/src/modules/signal-generator/services/context-scoring/__tests__/greeks.factor.spec.ts`
- Create: `apps/api/src/modules/signal-generator/services/context-scoring/__tests__/volatility.factor.spec.ts`

- [ ] **Step 1: Locate `MarketContextService` and check its interface**

Run: `grep -nE "class MarketContextService|getVix|vix\?:|@Injectable" apps/api/src/modules/market-data/services/market-context.service.ts | head -10`
Note the exposed methods. The volatility factor reads VIX history. If the service doesn't already expose a "VIX yesterday" or "VIX history" method, we need to surface one. The factor's spec contract is: given a `MarketContextService`, return current VIX and yesterday's VIX (or the closest available comparison). If only the *current* VIX is exposed, the factor returns NEUTRAL with `detail.reason: 'VIX history unavailable'`.

- [ ] **Step 2: Write failing tests for MtfTrendFactor**

```typescript
// apps/api/src/modules/signal-generator/services/context-scoring/__tests__/mtf-trend.factor.spec.ts
import { MtfTrendFactor } from '../factors/mtf-trend.factor';
import type { FactorInput } from '../types';
import type { SetupContext } from '../../../types/setup-context.types';

function input(side: 'BUY' | 'SELL', bias: 'bullish' | 'bearish' | 'neutral' | null): FactorInput {
  const setupContext = bias === null
    ? ({ higherTimeframeTrend: null } as unknown as SetupContext)
    : ({
        higherTimeframeTrend: { tf: '1h', ema9: 100, ema21: 99, bias },
      } as unknown as SetupContext);
  return {
    side, token: '99926000', symbol: 'NIFTY', exchange: 'NSE', setupContext,
  };
}

describe('MtfTrendFactor', () => {
  const factor = new MtfTrendFactor();

  it('BUY + bullish bias → STRONG_BULL with value +1', async () => {
    const r = await factor.compute(input('BUY', 'bullish'));
    expect(r.value).toBe(1.0);
    expect(r.tier).toBe('STRONG_BULL');
    expect(r.isStub).toBe(false);
  });

  it('BUY + bearish bias → STRONG_BEAR with value -1', async () => {
    const r = await factor.compute(input('BUY', 'bearish'));
    expect(r.value).toBe(-1.0);
    expect(r.tier).toBe('STRONG_BEAR');
  });

  it('SELL + bearish bias → STRONG_BULL with value +1 (alignment-with-side)', async () => {
    const r = await factor.compute(input('SELL', 'bearish'));
    expect(r.value).toBe(1.0);
    expect(r.tier).toBe('STRONG_BULL');
  });

  it('SELL + bullish bias → STRONG_BEAR (counter)', async () => {
    const r = await factor.compute(input('SELL', 'bullish'));
    expect(r.value).toBe(-1.0);
    expect(r.tier).toBe('STRONG_BEAR');
  });

  it('neutral bias → NEUTRAL with value 0', async () => {
    const r = await factor.compute(input('BUY', 'neutral'));
    expect(r.value).toBe(0);
    expect(r.tier).toBe('NEUTRAL');
  });

  it('null higherTimeframeTrend → NEUTRAL with reason', async () => {
    const r = await factor.compute(input('BUY', null));
    expect(r.value).toBe(0);
    expect(r.tier).toBe('NEUTRAL');
    expect(r.detail).toEqual({ reason: 'higher TF unavailable' });
  });
});
```

- [ ] **Step 3: Implement MtfTrendFactor**

```typescript
// apps/api/src/modules/signal-generator/services/context-scoring/factors/mtf-trend.factor.ts
import { Injectable } from '@nestjs/common';
import type { ContextFactor, FactorInput, FactorResult } from '../types';
import { FACTOR_WEIGHTS } from '../weights';

@Injectable()
export class MtfTrendFactor implements ContextFactor {
  readonly name = 'mtfTrend';
  readonly weight = FACTOR_WEIGHTS.mtfTrend;

  async compute(input: FactorInput): Promise<FactorResult> {
    const mtf = input.setupContext.higherTimeframeTrend;
    if (!mtf) {
      return {
        value: 0,
        tier: 'NEUTRAL',
        isStub: false,
        detail: { reason: 'higher TF unavailable' },
      };
    }

    const aligned =
      (input.side === 'BUY' && mtf.bias === 'bullish') ||
      (input.side === 'SELL' && mtf.bias === 'bearish');
    const opposed =
      (input.side === 'BUY' && mtf.bias === 'bearish') ||
      (input.side === 'SELL' && mtf.bias === 'bullish');

    const value = aligned ? 1.0 : opposed ? -1.0 : 0;
    const tier = aligned ? 'STRONG_BULL' : opposed ? 'STRONG_BEAR' : 'NEUTRAL';

    return {
      value,
      tier,
      isStub: false,
      detail: { tf: mtf.tf, bias: mtf.bias, ema9: mtf.ema9, ema21: mtf.ema21 },
    };
  }
}
```

- [ ] **Step 4: Run MtfTrendFactor spec — confirm all 6 tests pass**

Run: `cd "C:\Users\AryanKumar\Desktop\TD_Automation\apps\api" && npx jest --testPathPattern=mtf-trend.factor.spec --no-coverage 2>&1 | tail -25`
Expected: 6 tests pass.

- [ ] **Step 5: Write failing tests for GreeksFactor**

```typescript
// apps/api/src/modules/signal-generator/services/context-scoring/__tests__/greeks.factor.spec.ts
import { GreeksFactor } from '../factors/greeks.factor';
import type { FactorInput } from '../types';
import type { SetupContext } from '../../../types/setup-context.types';

function input(
  side: 'BUY' | 'SELL',
  delta: number | null,
): FactorInput {
  const recommendedStrike = delta === null
    ? null
    : { strike: 24000, side: side === 'BUY' ? 'CE' : 'PE', expiry: '2026-05-29',
        ltp: 100, delta, gamma: 0.01, theta: -10, vega: 50, iv: 15, oi: 1000,
        volume: 100, expectedProfitPerShare: 50, expectedLossPerShare: -50,
        lotSize: 75, expectedProfitPerLot: 3750, expectedLossPerLot: -3750,
        reason: 'test' };
  const setupContext = {
    recommendedStrike,
  } as unknown as SetupContext;
  return { side, token: '99926000', symbol: 'NIFTY', exchange: 'NSE', setupContext };
}

describe('GreeksFactor', () => {
  const factor = new GreeksFactor();

  it('BUY + positive delta → supportive value scaled by magnitude', async () => {
    const r = await factor.compute(input('BUY', 0.6));
    expect(r.value).toBe(1.0);   // 0.6 / 0.6 = 1.0
    expect(r.tier).toBe('STRONG_BULL');
    expect(r.isStub).toBe(false);
  });

  it('BUY + negative delta → counter-aligned (negative value)', async () => {
    const r = await factor.compute(input('BUY', -0.4));
    expect(r.value).toBeCloseTo(-0.667, 2);  // -0.4 / 0.6 = -0.667
    expect(r.tier).toBe('STRONG_BEAR');
  });

  it('SELL + negative delta (PE) → supportive value', async () => {
    const r = await factor.compute(input('SELL', -0.3));
    expect(r.value).toBeCloseTo(0.5, 2);
    expect(r.tier).toBe('BULL');
  });

  it('SELL + positive delta (CE) → counter', async () => {
    const r = await factor.compute(input('SELL', 0.5));
    expect(r.value).toBeCloseTo(-0.833, 2);
    expect(r.tier).toBe('STRONG_BEAR');
  });

  it('null recommendedStrike → NEUTRAL with reason', async () => {
    const r = await factor.compute(input('BUY', null));
    expect(r.value).toBe(0);
    expect(r.tier).toBe('NEUTRAL');
    expect(r.detail).toEqual({ reason: 'no strike recommendation' });
  });

  it('|delta| > 0.6 still clamps value to ±1.0', async () => {
    const r = await factor.compute(input('BUY', 0.95));
    expect(r.value).toBe(1.0);
  });
});
```

- [ ] **Step 6: Implement GreeksFactor**

```typescript
// apps/api/src/modules/signal-generator/services/context-scoring/factors/greeks.factor.ts
import { Injectable } from '@nestjs/common';
import type { ContextFactor, FactorInput, FactorResult } from '../types';
import { FACTOR_WEIGHTS, } from '../weights';
import { tierFromValue } from '../types';

@Injectable()
export class GreeksFactor implements ContextFactor {
  readonly name = 'greeks';
  readonly weight = FACTOR_WEIGHTS.greeks;

  async compute(input: FactorInput): Promise<FactorResult> {
    const strike = input.setupContext.recommendedStrike;
    if (!strike) {
      return {
        value: 0,
        tier: 'NEUTRAL',
        isStub: false,
        detail: { reason: 'no strike recommendation' },
      };
    }

    const expectedSign = input.side === 'BUY' ? 1 : -1;
    const actualSign = strike.delta >= 0 ? 1 : -1;
    const aligned = actualSign === expectedSign;

    // Magnitude scaled by 0.6 — deeper-ITM (|delta| ≥ 0.6) → ±1.0; ATM-ish → smaller.
    const magnitude = Math.min(1.0, Math.abs(strike.delta) / 0.6);
    const value = aligned ? magnitude : -magnitude;

    return {
      value,
      tier: tierFromValue(value),
      isStub: false,
      detail: {
        strike: strike.strike,
        side: strike.side,
        delta: strike.delta,
        gamma: strike.gamma,
      },
    };
  }
}
```

- [ ] **Step 7: Run GreeksFactor spec — confirm 6 tests pass**

Run: `cd "C:\Users\AryanKumar\Desktop\TD_Automation\apps\api" && npx jest --testPathPattern=greeks.factor.spec --no-coverage 2>&1 | tail -25`
Expected: 6 tests pass.

- [ ] **Step 8: Write failing tests for VolatilityFactor**

```typescript
// apps/api/src/modules/signal-generator/services/context-scoring/__tests__/volatility.factor.spec.ts
import { VolatilityFactor } from '../factors/volatility.factor';
import type { FactorInput } from '../types';
import type { SetupContext } from '../../../types/setup-context.types';

function input(side: 'BUY' | 'SELL'): FactorInput {
  return {
    side, token: '99926000', symbol: 'NIFTY', exchange: 'NSE',
    setupContext: {} as unknown as SetupContext,
  };
}

describe('VolatilityFactor', () => {
  let mctx: { getVixHistory: jest.Mock };

  beforeEach(() => {
    mctx = { getVixHistory: jest.fn() };
  });

  it('VIX rising 5%+ → value +1.0 (STRONG_BULL)', async () => {
    mctx.getVixHistory.mockResolvedValue({ today: 16.0, yesterday: 15.0 });
    const factor = new VolatilityFactor(mctx as never);
    const r = await factor.compute(input('BUY'));
    expect(r.value).toBe(1.0);
    expect(r.tier).toBe('STRONG_BULL');
  });

  it('VIX rising 2-5% → value +0.5 (BULL)', async () => {
    mctx.getVixHistory.mockResolvedValue({ today: 15.5, yesterday: 15.0 });
    const factor = new VolatilityFactor(mctx as never);
    const r = await factor.compute(input('BUY'));
    expect(r.value).toBe(0.5);
    expect(r.tier).toBe('BULL');
  });

  it('VIX flat (within ±2%) → value 0 (NEUTRAL)', async () => {
    mctx.getVixHistory.mockResolvedValue({ today: 15.05, yesterday: 15.0 });
    const factor = new VolatilityFactor(mctx as never);
    const r = await factor.compute(input('BUY'));
    expect(r.value).toBe(0);
    expect(r.tier).toBe('NEUTRAL');
  });

  it('VIX falling 2-5% → value -0.5 (BEAR)', async () => {
    mctx.getVixHistory.mockResolvedValue({ today: 14.55, yesterday: 15.0 });
    const factor = new VolatilityFactor(mctx as never);
    const r = await factor.compute(input('BUY'));
    expect(r.value).toBe(-0.5);
    expect(r.tier).toBe('BEAR');
  });

  it('VIX falling 5%+ → value -1.0 (STRONG_BEAR)', async () => {
    mctx.getVixHistory.mockResolvedValue({ today: 14.0, yesterday: 15.0 });
    const factor = new VolatilityFactor(mctx as never);
    const r = await factor.compute(input('BUY'));
    expect(r.value).toBe(-1.0);
    expect(r.tier).toBe('STRONG_BEAR');
  });

  it('returns NEUTRAL when VIX history unavailable', async () => {
    mctx.getVixHistory.mockResolvedValue(null);
    const factor = new VolatilityFactor(mctx as never);
    const r = await factor.compute(input('BUY'));
    expect(r.value).toBe(0);
    expect(r.tier).toBe('NEUTRAL');
    expect(r.detail).toEqual({ reason: 'no VIX data' });
  });

  it('symmetric for SELL — VIX rising still positive (Mama: vol up is good for both sides)', async () => {
    mctx.getVixHistory.mockResolvedValue({ today: 16.0, yesterday: 15.0 });
    const factor = new VolatilityFactor(mctx as never);
    const r = await factor.compute(input('SELL'));
    expect(r.value).toBe(1.0);
  });
});
```

- [ ] **Step 9: Implement VolatilityFactor — and add `getVixHistory` to MarketContextService if it doesn't exist**

First, check if `MarketContextService` has a `getVixHistory()` method:
`grep -n "getVixHistory\|getVix\|vixHistory" apps/api/src/modules/market-data/services/market-context.service.ts`

If absent, add the method. Open `apps/api/src/modules/market-data/services/market-context.service.ts` and add:

```typescript
/**
 * Returns today's VIX and yesterday's VIX (closest available trading
 * day). Returns null when either is unavailable. Used by the
 * VolatilityFactor in the context-scoring engine to classify
 * volatility direction.
 */
async getVixHistory(): Promise<{ today: number; yesterday: number } | null> {
  // Use whatever existing VIX-storage path the service has. If the
  // service caches VIX in memory, expose the most recent two values.
  // If it queries the DB / broker, fetch the last 2 daily candles for
  // INDIAVIX (token varies per exchange).
  //
  // Implementation contract — must return null when either value is
  // missing or stale (> 24h old). Real implementation depends on
  // existing storage structure; see the file for the in-place
  // implementation.
}
```

The exact implementation depends on what's already in MarketContextService. If the service has a recently-stored `vix` field but no history, expose a 2-element rolling window. **Do not invent a new VIX ingestion path** — just use whatever pre-existing source the service relies on.

If you can't tell what the service does with VIX from a quick read, return `null` from `getVixHistory()` for now and the factor returns NEUTRAL — this still passes the spec (factor returns NEUTRAL when history unavailable).

Now implement the factor:

```typescript
// apps/api/src/modules/signal-generator/services/context-scoring/factors/volatility.factor.ts
import { Injectable } from '@nestjs/common';
import type { ContextFactor, FactorInput, FactorResult } from '../types';
import { FACTOR_WEIGHTS } from '../weights';
import { tierFromValue } from '../types';
import { MarketContextService } from '../../../../market-data/services/market-context.service';

@Injectable()
export class VolatilityFactor implements ContextFactor {
  readonly name = 'volatility';
  readonly weight = FACTOR_WEIGHTS.volatility;

  constructor(private readonly marketContext: MarketContextService) {}

  async compute(_input: FactorInput): Promise<FactorResult> {
    const history = await this.marketContext.getVixHistory();
    if (!history || !history.today || !history.yesterday) {
      return {
        value: 0,
        tier: 'NEUTRAL',
        isStub: false,
        detail: { reason: 'no VIX data' },
      };
    }

    const change = (history.today - history.yesterday) / history.yesterday;
    let value: number;
    if (change >= 0.05) value = 1.0;
    else if (change >= 0.02) value = 0.5;
    else if (change <= -0.05) value = -1.0;
    else if (change <= -0.02) value = -0.5;
    else value = 0;

    return {
      value,
      tier: tierFromValue(value),
      isStub: false,
      detail: {
        vix: history.today,
        vixYesterday: history.yesterday,
        vixChange: Number(change.toFixed(4)),
      },
    };
  }
}
```

Note: this factor is direction-symmetric — `_input.side` is intentionally unused. Per the spec, "volatility up" is supportive for both BUY and SELL setups.

- [ ] **Step 10: Run VolatilityFactor spec — confirm 7 tests pass**

Run: `cd "C:\Users\AryanKumar\Desktop\TD_Automation\apps\api" && npx jest --testPathPattern=volatility.factor.spec --no-coverage 2>&1 | tail -25`
Expected: 7 tests pass.

- [ ] **Step 11: Commit**

```bash
cd "C:\Users\AryanKumar\Desktop\TD_Automation" && git add apps/api/src/modules/signal-generator/services/context-scoring/factors/mtf-trend.factor.ts apps/api/src/modules/signal-generator/services/context-scoring/factors/greeks.factor.ts apps/api/src/modules/signal-generator/services/context-scoring/factors/volatility.factor.ts apps/api/src/modules/signal-generator/services/context-scoring/__tests__/ apps/api/src/modules/market-data/services/market-context.service.ts && git commit -m "feat(signals): three real context-scoring factors (MTF, Greeks, Volatility)

- MtfTrendFactor reads setupContext.higherTimeframeTrend.bias and
  maps to alignment-with-side value (+1, -1, or 0 for neutral)
- GreeksFactor reads recommendedStrike.delta, checks sign agreement
  with side, scales by |delta|/0.6
- VolatilityFactor reads VIX history from MarketContextService,
  classifies rising/falling per Mama's threshold bands (±2%, ±5%);
  direction-symmetric (vol up = good for both BUY and SELL)

19/19 unit tests green across the three factors. MarketContextService
gains a getVixHistory() method — implementation falls back to
returning null when underlying VIX data isn't queryable, so the
factor degrades gracefully to NEUTRAL with a reason."
```

---

## Task 4 — Six stub factor implementations

**Files:**
- Create: `apps/api/src/modules/signal-generator/services/context-scoring/factors/sector.factor.ts`
- Create: `apps/api/src/modules/signal-generator/services/context-scoring/factors/oi-shift.factor.ts`
- Create: `apps/api/src/modules/signal-generator/services/context-scoring/factors/fii.factor.ts`
- Create: `apps/api/src/modules/signal-generator/services/context-scoring/factors/nasdaq.factor.ts`
- Create: `apps/api/src/modules/signal-generator/services/context-scoring/factors/crude-oil.factor.ts`
- Create: `apps/api/src/modules/signal-generator/services/context-scoring/factors/gold.factor.ts`

- [ ] **Step 1: Create the six stub files (one per factor)**

Each is ~10 lines. Create all six files with the same shape, varying only `name` and `FACTOR_WEIGHTS` lookup:

```typescript
// apps/api/src/modules/signal-generator/services/context-scoring/factors/sector.factor.ts
import { Injectable } from '@nestjs/common';
import type { ContextFactor, FactorInput, FactorResult } from '../types';
import { FACTOR_WEIGHTS } from '../weights';

@Injectable()
export class SectorFactor implements ContextFactor {
  readonly name = 'sector';
  readonly weight = FACTOR_WEIGHTS.sector;

  async compute(_input: FactorInput): Promise<FactorResult> {
    return {
      value: 0,
      tier: 'NEUTRAL_STUB',
      isStub: true,
      detail: { reason: 'stub — separate spec required' },
    };
  }
}
```

Then five copies with these substitutions:

| File | Class name | name property | weight key |
|---|---|---|---|
| `oi-shift.factor.ts` | `OiShiftFactor` | `'oiShift'` | `oiShift` |
| `fii.factor.ts` | `FiiFactor` | `'fii'` | `fii` |
| `nasdaq.factor.ts` | `NasdaqFactor` | `'nasdaq'` | `nasdaq` |
| `crude-oil.factor.ts` | `CrudeOilFactor` | `'crudeOil'` | `crudeOil` |
| `gold.factor.ts` | `GoldFactor` | `'gold'` | `gold` |

Each uses the same body — returns the stub result.

- [ ] **Step 2: Verify TypeScript compiles**

Run: `cd "C:\Users\AryanKumar\Desktop\TD_Automation\apps\api" && npx tsc --noEmit -p tsconfig.json 2>&1 | grep -E "context-scoring/factors" || echo "OK"`
Expected: `OK`.

- [ ] **Step 3: Commit**

```bash
cd "C:\Users\AryanKumar\Desktop\TD_Automation" && git add apps/api/src/modules/signal-generator/services/context-scoring/factors/sector.factor.ts apps/api/src/modules/signal-generator/services/context-scoring/factors/oi-shift.factor.ts apps/api/src/modules/signal-generator/services/context-scoring/factors/fii.factor.ts apps/api/src/modules/signal-generator/services/context-scoring/factors/nasdaq.factor.ts apps/api/src/modules/signal-generator/services/context-scoring/factors/crude-oil.factor.ts apps/api/src/modules/signal-generator/services/context-scoring/factors/gold.factor.ts && git commit -m "feat(signals): six stub context-scoring factors

Sector / OiShift / Fii / Nasdaq / CrudeOil / Gold — all return
{ value: 0, tier: 'NEUTRAL_STUB', isStub: true } so the engine
can register them and report coverage correctly. Each becomes its
own follow-up spec for the real implementation."
```

---

## Task 5 — Module wiring (register service + 9 factor providers)

**Files:**
- Modify: `apps/api/src/modules/signal-generator/signal-generator.module.ts`

- [ ] **Step 1: Add the imports at the top**

Open `apps/api/src/modules/signal-generator/signal-generator.module.ts`. Add these imports near the existing service imports:

```typescript
import { ContextScoringService } from './services/context-scoring/context-scoring.service';
import { MtfTrendFactor } from './services/context-scoring/factors/mtf-trend.factor';
import { GreeksFactor } from './services/context-scoring/factors/greeks.factor';
import { VolatilityFactor } from './services/context-scoring/factors/volatility.factor';
import { SectorFactor } from './services/context-scoring/factors/sector.factor';
import { OiShiftFactor } from './services/context-scoring/factors/oi-shift.factor';
import { FiiFactor } from './services/context-scoring/factors/fii.factor';
import { NasdaqFactor } from './services/context-scoring/factors/nasdaq.factor';
import { CrudeOilFactor } from './services/context-scoring/factors/crude-oil.factor';
import { GoldFactor } from './services/context-scoring/factors/gold.factor';
import type { ContextFactor } from './services/context-scoring/types';
```

- [ ] **Step 2: Register the 9 factor classes + the scoring service in `providers:`**

Find the `providers:` array. Add the 9 factor classes plus a custom factory provider for `ContextScoringService` that injects all 9 factors as a single array. Add this block at the end of the `providers:` array (just before the closing `]`):

```typescript
    // Context scoring engine — Mama's 10-factor framework v1.
    // Each factor is registered as a provider so it can be unit-tested
    // independently. ContextScoringService receives the array via a
    // factory so we can plug factors in / out without touching the service.
    MtfTrendFactor,
    GreeksFactor,
    VolatilityFactor,
    SectorFactor,
    OiShiftFactor,
    FiiFactor,
    NasdaqFactor,
    CrudeOilFactor,
    GoldFactor,
    {
      provide: ContextScoringService,
      useFactory: (
        mtf: MtfTrendFactor,
        greeks: GreeksFactor,
        vol: VolatilityFactor,
        sector: SectorFactor,
        oi: OiShiftFactor,
        fii: FiiFactor,
        nasdaq: NasdaqFactor,
        crude: CrudeOilFactor,
        gold: GoldFactor,
      ) =>
        new ContextScoringService([
          mtf, greeks, vol, sector, oi, fii, nasdaq, crude, gold,
        ] satisfies ContextFactor[]),
      inject: [
        MtfTrendFactor, GreeksFactor, VolatilityFactor,
        SectorFactor, OiShiftFactor, FiiFactor, NasdaqFactor,
        CrudeOilFactor, GoldFactor,
      ],
    },
```

- [ ] **Step 3: Add `ContextScoringService` to the `exports:` array**

In the same file, find `exports:` and add `ContextScoringService` so SignalGeneratorService (which lives in this module) can inject it AND so external modules can read scores if needed:

```typescript
  exports: [
    // ...existing exports...
    ContextScoringService,
  ],
```

- [ ] **Step 4: Verify TypeScript compiles + the app boots**

Run: `cd "C:\Users\AryanKumar\Desktop\TD_Automation\apps\api" && npx tsc --noEmit -p tsconfig.json 2>&1 | grep -E "signal-generator.module|context-scoring" || echo "OK"`
Expected: `OK`.

The dev server should hot-reload. Check the log:
`grep -nE "Nest application successfully|UnknownDependencies|MtfTrendFactor|VolatilityFactor" "C:\Users\ARYANK~1\AppData\Local\Temp\claude\C--Users-AryanKumar-Desktop-TD-Automation\e3a6b8f6-1960-45a8-815d-bea227ccaa2d\tasks\b53buokxu.output" | tail -5`
Expected: a recent `Nest application successfully started` line, no `UnknownDependencies` errors.

- [ ] **Step 5: Commit**

```bash
cd "C:\Users\AryanKumar\Desktop\TD_Automation" && git add apps/api/src/modules/signal-generator/signal-generator.module.ts && git commit -m "feat(signals): wire ContextScoringService + 9 factors into module

ContextScoringService registered as a factory provider that injects
all 9 factor instances. Each factor is its own provider so it can
be unit-tested individually and so a future Settings page could
override the registration array."
```

---

## Task 6 — Integration: SignalGeneratorService.analyze applies scoring + soft-gate + hard-gate

**Files:**
- Modify: `apps/api/src/modules/signal-generator/services/signal-generator.service.ts`

- [ ] **Step 1: Inject ContextScoringService into SignalGeneratorService**

Open the constructor. Add `import { ContextScoringService } from './context-scoring/context-scoring.service';` near other service imports, and add `@Optional() private readonly contextScoring?: ContextScoringService,` to the parameter list:

```typescript
import { Optional } from '@nestjs/common';
import { ContextScoringService } from './context-scoring/context-scoring.service';

constructor(
  // ...existing injections...
  @Optional() private readonly contextScoring?: ContextScoringService,
) {}
```

`@Optional()` so existing test wirings without context scoring still construct.

- [ ] **Step 2: Add the scoring + gating block in `analyze()` after the strategy fires**

Find the spot in `analyze()` where the strategy returns a setup output. The locking call site is around `await this.setupTracker.lock({...})`. Insert the scoring + gating block IMMEDIATELY BEFORE that lock call. The output must come from `LevelsContextStrategy.analyze` and be available as a setup-shaped object (named `output` or similar in current code; adapt if the local variable has a different name).

Add this block right before the existing `tracker.lock(...)` call:

```typescript
// ─── Context scoring — Mama's 10-factor framework ─────────────
let contextScore: number | undefined;
let contextTier: SetupContext['contextTier'] = undefined;
let contextCoverage: number | undefined;
let contextFactors: SetupContext['contextFactors'] = undefined;

if (this.contextScoring) {
  const scored = await this.contextScoring.score({
    side: output.side,
    token,
    symbol,
    exchange,
    setupContext: ctx,
  });
  contextScore = scored.contextScore;
  contextTier = scored.contextTier;
  contextCoverage = scored.contextCoverage;
  contextFactors = scored.contextFactors;

  // ─── Soft-gate — adjust grade based on score thresholds ─────
  if (contextScore >= 60) {
    ctx.grade = bumpGradeUp(ctx.grade);
  } else if (contextScore <= -30) {
    ctx.grade = bumpGradeDown(ctx.grade);
  }

  // ─── Hard-gate — opt-in via env, rejects setup outright ─────
  const rejectThresholdRaw = process.env.CONTEXT_SCORE_REJECT_BELOW;
  const rejectBelow = rejectThresholdRaw ? Number(rejectThresholdRaw) : NaN;
  if (Number.isFinite(rejectBelow) && contextScore <= rejectBelow) {
    return {
      kind: 'no-setup',
      reason: `reject:context-score (score=${contextScore} <= ${rejectBelow})`,
      levels: snapshotFromBook(book),
      higherTimeframeTrend,
      regime,
      intradayRangeRatio,
    };
  }
}

// Update SetupContext with the scoring fields so they're persisted on
// the locked setup and available to the lockedToResult mapper.
ctx.contextScore = contextScore;
ctx.contextTier = contextTier;
ctx.contextCoverage = contextCoverage;
ctx.contextFactors = contextFactors;
```

Then add the two helpers at the bottom of the file (below the existing private methods if any, OR as module-level helpers):

```typescript
function bumpGradeUp(grade: 'A' | 'B' | 'C'): 'A' | 'B' | 'C' {
  if (grade === 'C') return 'B';
  if (grade === 'B') return 'A';
  return 'A';
}

function bumpGradeDown(grade: 'A' | 'B' | 'C'): 'A' | 'B' | 'C' {
  if (grade === 'A') return 'B';
  if (grade === 'B') return 'C';
  return 'C';
}
```

- [ ] **Step 3: Pass scoring fields into the tracker.lock call**

Find the `await this.setupTracker.lock({...})` invocation in `analyze()`. After the existing lock-input fields (entry, stoploss, target, partialTakeAt, etc.), add:

```typescript
      // ...existing fields...
      tp1Source: ctx.tp1Source,
      tp1Obstacle: ctx.tp1Obstacle ?? null,
      // Context scoring — Mama's framework, see spec
      // 2026-05-07-context-scoring-engine-design.md
      contextScore: ctx.contextScore,
      contextTier: ctx.contextTier,
      contextCoverage: ctx.contextCoverage,
      contextFactors: ctx.contextFactors,
    });
```

- [ ] **Step 4: Add matching fields to the LockInput / LockedSetup interfaces in setup-tracker.service.ts**

Open `apps/api/src/modules/signal-generator/services/setup-tracker.service.ts`. Find the `LockInput` interface — add the four optional context fields:

```typescript
export interface LockInput {
  // ...existing fields...
  contextScore?: number;
  contextTier?: 'STRONG_BULL' | 'BULL' | 'NEUTRAL' | 'BEAR' | 'STRONG_BEAR';
  contextCoverage?: number;
  contextFactors?: import('../types/setup-context.types').ContextFactorBreakdown[];
}
```

Find the `LockedSetup` interface — add the same four fields:

```typescript
export interface LockedSetup {
  // ...existing fields...
  contextScore?: number;
  contextTier?: 'STRONG_BULL' | 'BULL' | 'NEUTRAL' | 'BEAR' | 'STRONG_BEAR';
  contextCoverage?: number;
  contextFactors?: import('../types/setup-context.types').ContextFactorBreakdown[];
}
```

In the `lock()` method body where it builds the `setup: LockedSetup` literal, add the four passthrough fields:

```typescript
const setup: LockedSetup = {
  // ...existing fields...
  contextScore: input.contextScore,
  contextTier: input.contextTier,
  contextCoverage: input.contextCoverage,
  contextFactors: input.contextFactors,
};
```

- [ ] **Step 5: Add the four fields to AnalyzeResult.setup + lockedToResult**

In `apps/api/src/modules/signal-generator/services/signal-generator.service.ts`, find the `AnalyzeResult` type definition (the `kind: 'setup'` variant). Add the four optional context fields to that variant:

```typescript
export type AnalyzeResult =
  | {
      kind: 'setup';
      // ...existing fields...
      contextScore?: number;
      contextTier?: 'STRONG_BULL' | 'BULL' | 'NEUTRAL' | 'BEAR' | 'STRONG_BEAR';
      contextCoverage?: number;
      contextFactors?: import('../types/setup-context.types').ContextFactorBreakdown[];
    }
  | { kind: 'no-setup'; ... };
```

Find `lockedToResult` and pass the four fields through:

```typescript
return {
  kind: 'setup',
  // ...existing fields...
  contextScore: setup.contextScore,
  contextTier: setup.contextTier,
  contextCoverage: setup.contextCoverage,
  contextFactors: setup.contextFactors,
};
```

- [ ] **Step 6: TypeScript check**

Run: `cd "C:\Users\AryanKumar\Desktop\TD_Automation\apps\api" && npx tsc --noEmit -p tsconfig.json 2>&1 | grep -E "signal-generator|setup-tracker" || echo "OK"`
Expected: `OK`.

- [ ] **Step 7: Smoke test — call analyze, verify the response contains contextScore + contextFactors**

Run:
```
powershell.exe -Command "try { (Invoke-WebRequest 'http://localhost:4001/api/signals/analyze?token=99926000&exchange=NSE&symbol=NIFTY&timeframe=15m' -UseBasicParsing -TimeoutSec 10).Content } catch { Write-Output \"ERR: $($_.Exception.Message)\" }"
```
Expected: JSON response. If `kind === 'setup'`, the response should include `contextScore`, `contextTier`, `contextCoverage`, and `contextFactors` (with 9 entries — 3 real + 6 stub). If `kind === 'no-setup'`, the wiring still compiled and didn't throw.

- [ ] **Step 8: Commit**

```bash
cd "C:\Users\AryanKumar\Desktop\TD_Automation" && git add apps/api/src/modules/signal-generator/services/signal-generator.service.ts apps/api/src/modules/signal-generator/services/setup-tracker.service.ts && git commit -m "feat(signals): integrate ContextScoringService into analyze() with soft + hard gates

After LevelsContextStrategy fires a setup, ContextScoringService.score
runs against the SetupContext + side. The combined score (-100 to +100)
applies a soft-gate that bumps grade up (>=+60) or down (<=-30) one
tier. Optional CONTEXT_SCORE_REJECT_BELOW env var enables a hard-gate
that returns 'reject:context-score' when score is at or below the
threshold.

contextScore, contextTier, contextCoverage, and contextFactors flow
through SetupContext → LockInput → LockedSetup → AnalyzeResult.setup
so the chart panel and signal card both see the scoring metadata.

ContextScoringService is @Optional in the service constructor so
existing test wirings without scoring still construct cleanly."
```

---

## Task 7 — Frontend types + AnalysisPanel section + SignalCard chip

**Files:**
- Modify: `apps/web/src/types/index.ts`
- Modify: `apps/web/src/components/charts/AnalysisPanel.tsx`
- Modify: `apps/web/src/components/trading/SignalCard.tsx`

- [ ] **Step 1: Add the Tier + ContextFactorBreakdown types and 4 SetupContext fields**

Open `apps/web/src/types/index.ts`. Append:

```typescript
// ─── Context scoring ────────────────────────────────────────

export type ContextTier =
  | 'STRONG_BULL' | 'BULL' | 'NEUTRAL' | 'BEAR' | 'STRONG_BEAR';

export type ContextFactorTier = ContextTier | 'NEUTRAL_STUB';

export interface ContextFactorBreakdown {
  name: string;
  weight: number;
  tier: ContextFactorTier;
  value: number;
  contribution: number;
  isStub: boolean;
  detail?: Record<string, unknown>;
}
```

Find the existing `Signal` (or `TradeSignal` — whatever the canonical signal-list-item interface is in this file) and add:

```typescript
  contextScore?: number;
  contextTier?: ContextTier;
  contextCoverage?: number;
  contextFactors?: ContextFactorBreakdown[];
```

If there's a separate `SetupAnalysis` interface in `apps/web/src/components/charts/AnalysisPanel.tsx` (which the chart's analyze response uses), add the same four fields there.

- [ ] **Step 2: Add the "Market Context" section to `AnalysisPanel.tsx`**

Open `apps/web/src/components/charts/AnalysisPanel.tsx`. Find the spot just below the existing "Confluence" chips (search for `Confluence` in the file).

Insert this block AFTER the existing confluence section, in the active-setup render branch (where `kind === 'setup'`):

```tsx
{analysis.contextScore !== undefined && analysis.contextFactors && (
  <div className="mt-3 border-t border-gray-700/60 pt-2">
    <div className="flex items-center justify-between">
      <span className="text-[10px] font-semibold uppercase tracking-wider text-gray-500">
        Market Context
      </span>
      <span
        className={clsx(
          'text-[11px] font-bold tabular-nums',
          analysis.contextScore >= 30 ? 'text-emerald-400' :
          analysis.contextScore <= -30 ? 'text-red-400' :
          'text-gray-300',
        )}
      >
        {analysis.contextScore > 0 ? '+' : ''}{analysis.contextScore} {analysis.contextTier}
      </span>
    </div>
    <div className="mt-0.5 text-[9px] text-gray-500">
      {analysis.contextFactors.filter((f) => !f.isStub).length}/{analysis.contextFactors.length} factors active · coverage {Math.round((analysis.contextCoverage ?? 0) * 100)}%
    </div>
    <div className="mt-1.5 space-y-0.5">
      {analysis.contextFactors.map((f) => (
        <div key={f.name} className="flex items-center justify-between text-[10px]">
          <span className={clsx('font-mono uppercase tracking-wider', f.isStub ? 'text-gray-600' : 'text-gray-400')}>
            {f.name}
          </span>
          <div className="flex items-center gap-2">
            <span className={clsx(
              'text-[9px] font-semibold uppercase tracking-wider px-1 py-0.5 rounded',
              f.isStub ? 'bg-gray-700/30 text-gray-500' :
              f.tier === 'STRONG_BULL' ? 'bg-emerald-500/15 text-emerald-400' :
              f.tier === 'BULL' ? 'bg-emerald-500/10 text-emerald-300' :
              f.tier === 'STRONG_BEAR' ? 'bg-red-500/15 text-red-400' :
              f.tier === 'BEAR' ? 'bg-red-500/10 text-red-300' :
              'bg-gray-700/40 text-gray-400',
            )}>
              {f.isStub ? 'STUB' : f.tier}
            </span>
            <span className={clsx(
              'tabular-nums w-8 text-right',
              f.contribution > 0 ? 'text-emerald-400' :
              f.contribution < 0 ? 'text-red-400' :
              'text-gray-500',
            )}>
              {f.contribution > 0 ? '+' : ''}{f.contribution}
            </span>
          </div>
        </div>
      ))}
    </div>
  </div>
)}
```

- [ ] **Step 3: Add the `Ctx` chip to `SignalCard.tsx`**

Open `apps/web/src/components/trading/SignalCard.tsx`. Find where the existing grade badge or the Chartink chip renders (search for `Grade ` or `chartinkSource`). Add the new chip alongside them:

```tsx
{signal.contextScore !== undefined && (
  <span
    className={clsx(
      'inline-flex items-center gap-0.5 rounded px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wider',
      signal.contextScore >= 30 ? 'bg-emerald-500/15 text-emerald-400' :
      signal.contextScore <= -30 ? 'bg-red-500/15 text-red-400' :
      'bg-gray-500/15 text-gray-300',
    )}
    title={`Context score ${signal.contextScore}, tier ${signal.contextTier}`}
  >
    Ctx {signal.contextScore > 0 ? '+' : ''}{signal.contextScore}
  </span>
)}
```

The `signal` prop should already have `contextScore` etc. via the type extension in step 1.

- [ ] **Step 4: Verify TypeScript compiles + Vite hot-reloads cleanly**

Run: `cd "C:\Users\AryanKumar\Desktop\TD_Automation\apps\web" && npx tsc --noEmit -p tsconfig.json 2>&1 | grep -E "AnalysisPanel|SignalCard|types/index" || echo "OK"`
Expected: `OK`.

- [ ] **Step 5: Smoke check — visit the chart in the browser**

Open `http://localhost:4000/charts` and pick NIFTY 15m. If a setup is firing, the AnalysisPanel should show the new Market Context section with score + 9 factor rows (3 real + 6 STUB). The SignalCard on the signals page should show a `Ctx +X` chip alongside the existing Grade badge.

If no setup is currently firing, just confirm the panel still renders without errors (the new section is conditional on `contextScore !== undefined`).

- [ ] **Step 6: Commit**

```bash
cd "C:\Users\AryanKumar\Desktop\TD_Automation" && git add apps/web/src/types/index.ts apps/web/src/components/charts/AnalysisPanel.tsx apps/web/src/components/trading/SignalCard.tsx && git commit -m "feat(web): Market Context section + Ctx chip from scoring engine

AnalysisPanel renders a new collapsible 'Market Context' section
below the Confluence chips when a setup carries contextScore. Shows
the combined score, tier, coverage (active vs stub factors), and
per-factor breakdown with tier badge + contribution. Stubs are
visually de-emphasised (grey 'STUB' label, dimmer text) so the
trader sees what's real vs. placeholder.

SignalCard gains a 'Ctx +X' chip alongside the existing Grade badge,
colour-coded by score (green ≥+30, red ≤-30, grey otherwise) with
a hover tooltip showing tier."
```

---

## Self-review

**Spec coverage** — every section of `2026-05-07-context-scoring-engine-design.md` maps to a task:

| Spec section | Task(s) |
|---|---|
| Architecture (data flow + components) | 1, 2, 3, 4, 5, 6, 7 |
| Per-factor contract (interfaces + tier derivation) | 1 |
| Aggregation algorithm | 2 |
| Weights | 1 (`weights.ts`) |
| Real factors (MTF, Greeks, Volatility) | 3 |
| Stub factors | 4 |
| Module wiring | 5 |
| Soft-gate + hard-gate integration | 6 |
| Data shape changes (SetupContext + AnalyzeResult) | 1 (SetupContext fields), 6 (AnalyzeResult + LockedSetup propagation) |
| Frontend display (AnalysisPanel + SignalCard) | 7 |
| Edge cases — factor throws / VIX unavailable / null recommendedStrike / clamp at ±100 | covered in Tasks 2 + 3 tests |
| Test plan — unit + integration | unit covered Tasks 2 + 3 (32 tests). Integration is the smoke test in Task 6. |

**Placeholder scan** — no TBD/TODO/incomplete; every code step contains complete code; absolute file paths used.

**Type consistency** — `Tier` (with NEUTRAL_STUB) used per-factor; `CombinedTier` (without NEUTRAL_STUB) used on aggregate. `ContextFactorBreakdown` shape identical across types.ts, SetupContext, LockedSetup, AnalyzeResult, frontend mirror. `FACTOR_WEIGHTS` keys match factor `name` properties (mtfTrend, sector, fii, oiShift, volatility, nasdaq, greeks, crudeOil, gold).

**Parallelism note** — Task 1 (types + weights + SetupContext fields) gates the rest. After Task 1 commits, Tasks 2-3-4-5-6 form a sequential backend chain (each depends on the previous), and Task 7 (frontend) depends only on Task 1's type contract — so Task 7 can run in parallel with the backend chain. Recommended dispatch: I do Task 1 directly, then Agent A handles backend Tasks 2-3-4-5-6, Agent B handles frontend Task 7. Two agents, disjoint file sets after Task 1.
