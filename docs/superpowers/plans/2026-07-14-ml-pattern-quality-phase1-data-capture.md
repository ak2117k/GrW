# ML Pattern-Quality Pipeline — Phase 1 (Data Capture) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Capture every detected chart/candlestick pattern as a labeled `pattern_observations` row — tagged with its timeframe and scored with an ATR-follow-through outcome — via both a historical backfill (all timeframes) and a live capture hook, producing the training dataset for later ML phases.

**Architecture:** Detection stays in the existing TS detectors (`buildPatternMarkers`). A new cohesive `ml/` folder under `signal-generator/` adds: a pure ATR-follow-through label resolver, a pure observation assembler (window + ATR + label), a Prisma-backed repository, a backfill service (instruments × all timeframes), and a live capture service. No Python in Phase 1 — this phase only produces the dataset.

**Tech Stack:** NestJS + TypeScript, Prisma + PostgreSQL (Neon), Jest. Reuses `computeAtrFromCandles` (`services/per-tf-atr.ts`) and `buildPatternMarkers` (`patterns/to-markers.ts`).

## Global Constraints

- Label defaults (verbatim from spec): `k = 1.5`, `m = 1.0`, `N = 10 bars`. Config-driven, tunable.
- Label is timeframe-relative by construction (N in bars, ATR per-timeframe) — one definition for every timeframe.
- Supported timeframes (Angel-native): `1m, 3m, 5m, 10m, 15m, 30m, 1h, 1d`. (4h/1w deferred — not in this phase.)
- NEUTRAL-bias patterns (e.g. DOJI) have no follow-through direction → excluded from the labeled dataset.
- Every row is tagged with its `timeframe`. Dataset must span all supported timeframes from the backfill.
- Fail-open: nothing here may break the existing `/patterns` overlay or the scan. Capture failures are logged, never thrown to callers.
- `PrismaService` import path from `ml/`: `../../../common/prisma/prisma.service`.
- Migrations run OUT-OF-BAND on Neon (see `docs/deploy/FREE-DEPLOY-RUNBOOK.md`); the plan generates the migration but does not run `migrate deploy` against prod.

---

## File Structure

- `prisma/schema.prisma` — **Modify:** add `PatternObservation` model + `PatternOutcome` enum.
- `apps/api/src/modules/signal-generator/ml/pattern-observation.types.ts` — **Create:** shared types (`OhlcvCandle`, `FollowThroughParams`, `FollowThroughResult`, `PatternObservationInput`, defaults).
- `apps/api/src/modules/signal-generator/ml/follow-through.ts` — **Create:** pure `resolveFollowThrough(...)`.
- `apps/api/src/modules/signal-generator/ml/follow-through.spec.ts` — **Create:** resolver tests.
- `apps/api/src/modules/signal-generator/ml/observation-assembler.ts` — **Create:** pure `buildObservationInputs(...)`.
- `apps/api/src/modules/signal-generator/ml/observation-assembler.spec.ts` — **Create:** assembler tests.
- `apps/api/src/modules/signal-generator/ml/pattern-observation.repository.ts` — **Create:** Prisma repo.
- `apps/api/src/modules/signal-generator/ml/pattern-observation.repository.spec.ts` — **Create:** repo tests (mocked Prisma).
- `apps/api/src/modules/signal-generator/ml/pattern-backfill.service.ts` — **Create:** backfill orchestrator.
- `apps/api/src/modules/signal-generator/ml/pattern-backfill.service.spec.ts` — **Create:** backfill tests (mocked adapter/repo).
- `apps/api/src/modules/signal-generator/ml/pattern-capture.service.ts` — **Create:** live capture + resolvePending.
- `apps/api/src/modules/signal-generator/ml/pattern-capture.service.spec.ts` — **Create:** capture tests.
- `apps/api/src/modules/signal-generator/signal-generator.module.ts` — **Modify:** register the 3 providers.
- `docs/learning/ml/01-what-is-a-pattern-quality-scorer.md` — **Create:** Lesson 01.
- `docs/learning/ml/02-features-and-the-atr-follow-through-label.md` — **Create:** Lesson 02.

**Parallelization for the agent team:** Tasks 1, 2, and 7 have no inter-dependencies and can start together. Task 3 depends on Task 2. Task 4 depends on Task 1. Tasks 5 and 6 depend on Tasks 3 + 4.

---

## Task 1: Prisma `PatternObservation` model + migration

**Files:**
- Modify: `prisma/schema.prisma` (append a new model + enum near the other analysis models)

**Interfaces:**
- Produces: table `pattern_observations` with unique key `(token, exchange, timeframe, patternName, barTime)`; enum `PatternOutcome { WIN LOSS TIMEOUT PENDING }`. Prisma model name `PatternObservation`.

- [ ] **Step 1: Add the enum + model to `prisma/schema.prisma`** (append at end of file)

```prisma
enum PatternOutcome {
  WIN
  LOSS
  TIMEOUT
  PENDING
}

/// One detected pattern instance + its realized ATR-follow-through outcome.
/// Feeds the ML pattern-quality scorer (see
/// docs/superpowers/specs/2026-07-14-ml-pattern-quality-pipeline-design.md).
model PatternObservation {
  id             String         @id @default(cuid())
  token          String
  exchange       String
  timeframe      String         // 1m, 3m, 5m, 10m, 15m, 30m, 1h, 1d
  patternName    String         // e.g. BULLISH_ENGULFING, DOUBLE_TOP
  category       String         // CANDLESTICK | CHART
  bias           String         // BULLISH | BEARISH
  barTime        DateTime       // anchor (signal) candle time, IST-correct instant
  candleWindow   Json           // OhlcvCandle[] up to & including the anchor bar
  atrAtDetection Float
  outcome        PatternOutcome @default(PENDING)
  label          Int?           // WIN=1, LOSS=0, null while PENDING/TIMEOUT
  resolvedAt     DateTime?
  modelScore     Float?         // filled by later phases
  modelVersion   String?
  createdAt      DateTime       @default(now())

  @@unique([token, exchange, timeframe, patternName, barTime])
  @@index([outcome])
  @@index([timeframe])
  @@map("pattern_observations")
}
```

- [ ] **Step 2: Generate the migration (against the DIRECT Neon URL)**

Run: `cd apps/api && npx prisma migrate dev --name add_pattern_observations --create-only`
Expected: a new folder under `prisma/migrations/<timestamp>_add_pattern_observations/` containing `migration.sql` with `CREATE TABLE "pattern_observations"` and `CREATE TYPE "PatternOutcome"`.

- [ ] **Step 3: Regenerate the Prisma client**

Run: `cd apps/api && npx prisma generate`
Expected: completes; `PatternObservation` + `PatternOutcome` now available on the client.

- [ ] **Step 4: Type-check that the client picked up the model**

Create a throwaway check: Run `cd apps/api && node -e "const {PrismaClient}=require('@prisma/client'); const p=new PrismaClient(); console.log(typeof p.patternObservation.findMany)"`
Expected: prints `function`.

- [ ] **Step 5: Commit**

```bash
git add prisma/schema.prisma prisma/migrations
git commit -m "feat(ml): add pattern_observations model + migration"
```

---

## Task 2: ATR-follow-through label resolver (pure)

**Files:**
- Create: `apps/api/src/modules/signal-generator/ml/pattern-observation.types.ts`
- Create: `apps/api/src/modules/signal-generator/ml/follow-through.ts`
- Test: `apps/api/src/modules/signal-generator/ml/follow-through.spec.ts`

**Interfaces:**
- Consumes: `OhlcvCandle` (defined here).
- Produces:
  - `type PatternOutcomeName = 'WIN' | 'LOSS' | 'TIMEOUT' | 'PENDING'`
  - `interface FollowThroughParams { k: number; m: number; n: number }`
  - `const DEFAULT_FT_PARAMS: FollowThroughParams` = `{ k: 1.5, m: 1.0, n: 10 }`
  - `interface FollowThroughResult { outcome: PatternOutcomeName; label: 0 | 1 | null; resolvedIndex: number | null }`
  - `function resolveFollowThrough(candles: OhlcvCandle[], index: number, dir: 1 | -1, atrAtDetection: number, params?: FollowThroughParams): FollowThroughResult`

- [ ] **Step 1: Create the shared types file**

```typescript
// apps/api/src/modules/signal-generator/ml/pattern-observation.types.ts

/** OHLCV candle — superset of the detector `Candle` (adds volume for features). */
export interface OhlcvCandle {
  time: number; // epoch ms
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export type PatternOutcomeName = 'WIN' | 'LOSS' | 'TIMEOUT' | 'PENDING';

/** ATR-follow-through label parameters. */
export interface FollowThroughParams {
  /** favorable move required, in ATR multiples. */
  k: number;
  /** adverse move that fails the pattern, in ATR multiples. */
  m: number;
  /** horizon in bars. */
  n: number;
}

export const DEFAULT_FT_PARAMS: FollowThroughParams = { k: 1.5, m: 1.0, n: 10 };

export interface FollowThroughResult {
  outcome: PatternOutcomeName;
  /** WIN=1, LOSS=0, null for TIMEOUT/PENDING. */
  label: 0 | 1 | null;
  /** index where WIN/LOSS was decided; null otherwise. */
  resolvedIndex: number | null;
}

/** A row ready to persist to `pattern_observations`. */
export interface PatternObservationInput {
  token: string;
  exchange: string;
  timeframe: string;
  patternName: string;
  category: 'CANDLESTICK' | 'CHART';
  bias: 'BULLISH' | 'BEARISH';
  barTime: Date;
  candleWindow: OhlcvCandle[];
  atrAtDetection: number;
  outcome: PatternOutcomeName;
  label: 0 | 1 | null;
}
```

- [ ] **Step 2: Write the failing test**

```typescript
// apps/api/src/modules/signal-generator/ml/follow-through.spec.ts
import { resolveFollowThrough } from './follow-through';
import type { OhlcvCandle } from './pattern-observation.types';

// Helper: a flat candle at a given close (high/low straddle it by `spread`).
function bar(time: number, close: number, spread = 0): OhlcvCandle {
  return { time, open: close, high: close + spread, low: close - spread, close, volume: 0 };
}

describe('resolveFollowThrough', () => {
  const params = { k: 1.5, m: 1.0, n: 10 };
  const atr = 2; // favorable = close + 3, adverse = close - 2 (bullish)

  it('WIN: bullish price reaches +k*ATR before -m*ATR', () => {
    // entry close=100 at index 0; favorable=103, adverse=98.
    const candles = [bar(0, 100), bar(1, 101), bar(2, 103.5, 0)]; // high 103.5 >= 103
    const r = resolveFollowThrough(candles, 0, 1, atr, params);
    expect(r.outcome).toBe('WIN');
    expect(r.label).toBe(1);
    expect(r.resolvedIndex).toBe(2);
  });

  it('LOSS: bullish adverse level hit first', () => {
    const candles = [bar(0, 100), bar(1, 97.5, 0)]; // low 97.5 <= 98
    const r = resolveFollowThrough(candles, 0, 1, atr, params);
    expect(r.outcome).toBe('LOSS');
    expect(r.label).toBe(0);
    expect(r.resolvedIndex).toBe(1);
  });

  it('LOSS: both levels touched in the SAME bar → conservative LOSS', () => {
    // wide bar hits both 103 and 98.
    const candles = [bar(0, 100), { time: 1, open: 100, high: 104, low: 97, close: 100, volume: 0 }];
    const r = resolveFollowThrough(candles, 0, 1, atr, params);
    expect(r.outcome).toBe('LOSS');
  });

  it('TIMEOUT: full horizon available, neither level hit', () => {
    const candles = [bar(0, 100), bar(1, 100), bar(2, 100), bar(3, 100), bar(4, 100),
      bar(5, 100), bar(6, 100), bar(7, 100), bar(8, 100), bar(9, 100), bar(10, 100)];
    const r = resolveFollowThrough(candles, 0, 1, atr, params);
    expect(r.outcome).toBe('TIMEOUT');
    expect(r.label).toBeNull();
  });

  it('PENDING: not enough forward bars yet and no hit', () => {
    const candles = [bar(0, 100), bar(1, 100), bar(2, 100)]; // only 2 forward bars < n=10
    const r = resolveFollowThrough(candles, 0, 1, atr, params);
    expect(r.outcome).toBe('PENDING');
  });

  it('bearish mirror: WIN when price falls -k*ATR first', () => {
    // dir=-1, entry=100, favorable=97 (close-3), adverse=102 (close+2).
    const candles = [bar(0, 100), bar(1, 96.5, 0)]; // low 96.5 <= 97
    const r = resolveFollowThrough(candles, 0, -1, atr, params);
    expect(r.outcome).toBe('WIN');
    expect(r.label).toBe(1);
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `cd apps/api && npx jest follow-through -t "resolveFollowThrough" -v`
Expected: FAIL — "Cannot find module './follow-through'".

- [ ] **Step 4: Write the implementation**

```typescript
// apps/api/src/modules/signal-generator/ml/follow-through.ts
import {
  DEFAULT_FT_PARAMS,
  type FollowThroughParams,
  type FollowThroughResult,
  type OhlcvCandle,
} from './pattern-observation.types';

/**
 * ATR-follow-through label. From the detection bar at `index` (entry = its
 * close) scan the next `n` bars: WIN if price reaches entry + dir*k*ATR before
 * entry - dir*m*ATR; LOSS if the adverse level is hit first (or both in one
 * bar — conservative). If the full `n`-bar horizon exists and neither level is
 * hit → TIMEOUT. If fewer than `n` forward bars exist and nothing hit → PENDING
 * (resolve later when more bars arrive). See the design spec §4.1.
 */
export function resolveFollowThrough(
  candles: OhlcvCandle[],
  index: number,
  dir: 1 | -1,
  atrAtDetection: number,
  params: FollowThroughParams = DEFAULT_FT_PARAMS,
): FollowThroughResult {
  const entry = candles[index].close;
  const favorable = entry + dir * params.k * atrAtDetection;
  const adverse = entry - dir * params.m * atrAtDetection;

  const last = candles.length - 1;
  const horizonEnd = index + params.n;
  const scanEnd = Math.min(horizonEnd, last);

  for (let i = index + 1; i <= scanEnd; i++) {
    const c = candles[i];
    const hitFav = dir === 1 ? c.high >= favorable : c.low <= favorable;
    const hitAdv = dir === 1 ? c.low <= adverse : c.high >= adverse;
    if (hitFav && hitAdv) return { outcome: 'LOSS', label: 0, resolvedIndex: i };
    if (hitFav) return { outcome: 'WIN', label: 1, resolvedIndex: i };
    if (hitAdv) return { outcome: 'LOSS', label: 0, resolvedIndex: i };
  }

  // Nothing hit. Distinguish "full horizon seen" (TIMEOUT) from "need more bars" (PENDING).
  const haveFullHorizon = horizonEnd <= last;
  return haveFullHorizon
    ? { outcome: 'TIMEOUT', label: null, resolvedIndex: null }
    : { outcome: 'PENDING', label: null, resolvedIndex: null };
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `cd apps/api && npx jest follow-through -v`
Expected: PASS (6 tests).

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/modules/signal-generator/ml/pattern-observation.types.ts apps/api/src/modules/signal-generator/ml/follow-through.ts apps/api/src/modules/signal-generator/ml/follow-through.spec.ts
git commit -m "feat(ml): ATR-follow-through label resolver"
```

---

## Task 3: Observation assembler (pure)

**Files:**
- Create: `apps/api/src/modules/signal-generator/ml/observation-assembler.ts`
- Test: `apps/api/src/modules/signal-generator/ml/observation-assembler.spec.ts`

**Interfaces:**
- Consumes: `resolveFollowThrough` (Task 2), `computeAtrFromCandles` (`../services/per-tf-atr`), `buildPatternMarkers` (`../patterns/to-markers`), `PatternMarkerDto` (`../dto/pattern-marker.dto`), `OhlcvCandle`/`PatternObservationInput`/`DEFAULT_FT_PARAMS` (Task 2).
- Produces:
  - `interface AssembleOpts { windowBars?: number; atrPeriod?: number; params?: FollowThroughParams }`
  - `interface ObservationMeta { token: string; exchange: string; timeframe: string }`
  - `function buildObservationInputs(candles: OhlcvCandle[], markers: PatternMarkerDto[], meta: ObservationMeta, opts?: AssembleOpts): PatternObservationInput[]`

- [ ] **Step 1: Write the failing test**

```typescript
// apps/api/src/modules/signal-generator/ml/observation-assembler.spec.ts
import { buildObservationInputs } from './observation-assembler';
import type { OhlcvCandle } from './pattern-observation.types';
import type { PatternMarkerDto } from '../dto/pattern-marker.dto';

function bar(time: number, o: number, h: number, l: number, c: number): OhlcvCandle {
  return { time, open: o, high: h, low: l, close: c, volume: 100 };
}

describe('buildObservationInputs', () => {
  // 20 flat-ish candles so ATR>0, then a bullish marker at index 15.
  const candles: OhlcvCandle[] = Array.from({ length: 30 }, (_, i) =>
    bar(i * 1000, 100, 101, 99, 100),
  );

  const bullMarker: PatternMarkerDto = {
    category: 'CANDLESTICK', name: 'HAMMER', bias: 'BULLISH',
    time: 15 * 1000, points: [], necklinePrice: null, confirmed: null, confirmTime: null,
  };
  const neutralMarker: PatternMarkerDto = {
    category: 'CANDLESTICK', name: 'DOJI', bias: 'NEUTRAL',
    time: 15 * 1000, points: [], necklinePrice: null, confirmed: null, confirmTime: null,
  };

  const meta = { token: '2885', exchange: 'NSE', timeframe: '15m' };

  it('produces one observation per non-neutral marker, tagged with timeframe', () => {
    const out = buildObservationInputs(candles, [bullMarker], meta, { windowBars: 10 });
    expect(out).toHaveLength(1);
    expect(out[0].timeframe).toBe('15m');
    expect(out[0].token).toBe('2885');
    expect(out[0].patternName).toBe('HAMMER');
    expect(out[0].bias).toBe('BULLISH');
    expect(out[0].barTime.getTime()).toBe(15 * 1000);
  });

  it('window is the last `windowBars` candles up to & including the anchor', () => {
    const out = buildObservationInputs(candles, [bullMarker], meta, { windowBars: 10 });
    expect(out[0].candleWindow).toHaveLength(10);
    expect(out[0].candleWindow[9].time).toBe(15 * 1000); // last = anchor
    expect(out[0].candleWindow[0].time).toBe(6 * 1000); // 15-10+1 = index 6
  });

  it('skips NEUTRAL-bias markers (no follow-through direction)', () => {
    const out = buildObservationInputs(candles, [neutralMarker], meta);
    expect(out).toHaveLength(0);
  });

  it('computes an outcome and a numeric ATR', () => {
    const out = buildObservationInputs(candles, [bullMarker], meta, { windowBars: 10 });
    expect(out[0].atrAtDetection).toBeGreaterThan(0);
    expect(['WIN', 'LOSS', 'TIMEOUT', 'PENDING']).toContain(out[0].outcome);
  });

  it('drops a marker whose time has no matching candle', () => {
    const orphan: PatternMarkerDto = { ...bullMarker, time: 99999999 };
    const out = buildObservationInputs(candles, [orphan], meta);
    expect(out).toHaveLength(0);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/api && npx jest observation-assembler -v`
Expected: FAIL — "Cannot find module './observation-assembler'".

- [ ] **Step 3: Write the implementation**

```typescript
// apps/api/src/modules/signal-generator/ml/observation-assembler.ts
import { computeAtrFromCandles } from '../services/per-tf-atr';
import type { PatternMarkerDto } from '../dto/pattern-marker.dto';
import { resolveFollowThrough } from './follow-through';
import {
  DEFAULT_FT_PARAMS,
  type FollowThroughParams,
  type OhlcvCandle,
  type PatternObservationInput,
} from './pattern-observation.types';

export interface AssembleOpts {
  /** bars of history stored as the feature window (incl. anchor). Default 50. */
  windowBars?: number;
  /** ATR period. Default 14. */
  atrPeriod?: number;
  params?: FollowThroughParams;
}

export interface ObservationMeta {
  token: string;
  exchange: string;
  timeframe: string;
}

/**
 * Turn detector markers into persistable observations. For each non-neutral
 * marker we locate its anchor candle, slice the feature window, compute ATR at
 * the anchor, and resolve the ATR-follow-through outcome. NEUTRAL patterns are
 * skipped (no direction to follow). Markers whose `time` doesn't match a candle
 * are dropped. Pure — deterministic given inputs.
 */
export function buildObservationInputs(
  candles: OhlcvCandle[],
  markers: PatternMarkerDto[],
  meta: ObservationMeta,
  opts: AssembleOpts = {},
): PatternObservationInput[] {
  const windowBars = opts.windowBars ?? 50;
  const atrPeriod = opts.atrPeriod ?? 14;
  const params = opts.params ?? DEFAULT_FT_PARAMS;

  const indexByTime = new Map<number, number>();
  for (let i = 0; i < candles.length; i++) indexByTime.set(candles[i].time, i);

  const out: PatternObservationInput[] = [];
  for (const marker of markers) {
    if (marker.bias !== 'BULLISH' && marker.bias !== 'BEARISH') continue;
    const anchor = indexByTime.get(marker.time);
    if (anchor === undefined) continue;

    const dir: 1 | -1 = marker.bias === 'BULLISH' ? 1 : -1;
    const atr = computeAtrFromCandles(candles.slice(0, anchor + 1), atrPeriod);
    if (atr <= 0) continue; // can't scale a follow-through target without ATR

    const ft = resolveFollowThrough(candles, anchor, dir, atr, params);
    const window = candles.slice(Math.max(0, anchor - windowBars + 1), anchor + 1);

    out.push({
      token: meta.token,
      exchange: meta.exchange,
      timeframe: meta.timeframe,
      patternName: marker.name,
      category: marker.category,
      bias: marker.bias,
      barTime: new Date(marker.time),
      candleWindow: window,
      atrAtDetection: atr,
      outcome: ft.outcome,
      label: ft.label,
    });
  }
  return out;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd apps/api && npx jest observation-assembler -v`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/modules/signal-generator/ml/observation-assembler.ts apps/api/src/modules/signal-generator/ml/observation-assembler.spec.ts
git commit -m "feat(ml): observation assembler (window + ATR + label)"
```

---

## Task 4: `PatternObservationRepository`

**Files:**
- Create: `apps/api/src/modules/signal-generator/ml/pattern-observation.repository.ts`
- Test: `apps/api/src/modules/signal-generator/ml/pattern-observation.repository.spec.ts`

**Interfaces:**
- Consumes: `PrismaService` (`../../../common/prisma/prisma.service`), `PatternObservationInput` (Task 2).
- Produces:
  - `saveMany(inputs: PatternObservationInput[]): Promise<number>` — returns count inserted; idempotent (skipDuplicates on the unique key).
  - `findPending(limit: number): Promise<Array<{ id: string; token: string; exchange: string; timeframe: string; barTime: Date }>>`
  - `updateOutcome(id: string, outcome: 'WIN' | 'LOSS' | 'TIMEOUT', label: 0 | 1 | null): Promise<void>`

- [ ] **Step 1: Write the failing test**

```typescript
// apps/api/src/modules/signal-generator/ml/pattern-observation.repository.spec.ts
import { PatternObservationRepository } from './pattern-observation.repository';
import type { PatternObservationInput } from './pattern-observation.types';

function fakePrisma() {
  return {
    patternObservation: {
      createMany: jest.fn().mockResolvedValue({ count: 2 }),
      findMany: jest.fn().mockResolvedValue([]),
      update: jest.fn().mockResolvedValue({}),
    },
  } as any;
}

const input: PatternObservationInput = {
  token: '2885', exchange: 'NSE', timeframe: '15m', patternName: 'HAMMER',
  category: 'CANDLESTICK', bias: 'BULLISH', barTime: new Date(1000),
  candleWindow: [{ time: 1000, open: 1, high: 2, low: 0.5, close: 1.5, volume: 10 }],
  atrAtDetection: 2, outcome: 'WIN', label: 1,
};

describe('PatternObservationRepository', () => {
  it('saveMany inserts with skipDuplicates and returns the count', async () => {
    const prisma = fakePrisma();
    const repo = new PatternObservationRepository(prisma);
    const n = await repo.saveMany([input, { ...input, barTime: new Date(2000) }]);
    expect(n).toBe(2);
    expect(prisma.patternObservation.createMany).toHaveBeenCalledWith(
      expect.objectContaining({ skipDuplicates: true }),
    );
  });

  it('saveMany with empty input does not hit the db', async () => {
    const prisma = fakePrisma();
    const repo = new PatternObservationRepository(prisma);
    const n = await repo.saveMany([]);
    expect(n).toBe(0);
    expect(prisma.patternObservation.createMany).not.toHaveBeenCalled();
  });

  it('updateOutcome writes outcome, label, resolvedAt', async () => {
    const prisma = fakePrisma();
    const repo = new PatternObservationRepository(prisma);
    await repo.updateOutcome('id1', 'LOSS', 0);
    expect(prisma.patternObservation.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'id1' },
        data: expect.objectContaining({ outcome: 'LOSS', label: 0 }),
      }),
    );
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/api && npx jest pattern-observation.repository -v`
Expected: FAIL — "Cannot find module './pattern-observation.repository'".

- [ ] **Step 3: Write the implementation**

```typescript
// apps/api/src/modules/signal-generator/ml/pattern-observation.repository.ts
import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../../common/prisma/prisma.service';
import type { PatternObservationInput } from './pattern-observation.types';

export interface PendingObservation {
  id: string;
  token: string;
  exchange: string;
  timeframe: string;
  barTime: Date;
}

@Injectable()
export class PatternObservationRepository {
  constructor(private readonly prisma: PrismaService) {}

  /** Insert observations, ignoring rows that collide on the unique key. */
  async saveMany(inputs: PatternObservationInput[]): Promise<number> {
    if (inputs.length === 0) return 0;
    const res = await this.prisma.patternObservation.createMany({
      data: inputs.map((i) => ({
        token: i.token,
        exchange: i.exchange,
        timeframe: i.timeframe,
        patternName: i.patternName,
        category: i.category,
        bias: i.bias,
        barTime: i.barTime,
        candleWindow: i.candleWindow as unknown as object,
        atrAtDetection: i.atrAtDetection,
        outcome: i.outcome === 'PENDING' ? 'PENDING' : i.outcome,
        label: i.label,
      })),
      skipDuplicates: true,
    });
    return res.count;
  }

  /** Oldest still-PENDING observations, for the resolver job. */
  async findPending(limit: number): Promise<PendingObservation[]> {
    const rows = await this.prisma.patternObservation.findMany({
      where: { outcome: 'PENDING' },
      orderBy: { barTime: 'asc' },
      take: limit,
      select: { id: true, token: true, exchange: true, timeframe: true, barTime: true },
    });
    return rows;
  }

  /** Finalize a PENDING row once its horizon has resolved. */
  async updateOutcome(
    id: string,
    outcome: 'WIN' | 'LOSS' | 'TIMEOUT',
    label: 0 | 1 | null,
  ): Promise<void> {
    await this.prisma.patternObservation.update({
      where: { id },
      data: { outcome, label, resolvedAt: new Date() },
    });
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd apps/api && npx jest pattern-observation.repository -v`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/modules/signal-generator/ml/pattern-observation.repository.ts apps/api/src/modules/signal-generator/ml/pattern-observation.repository.spec.ts
git commit -m "feat(ml): PatternObservation repository"
```

---

## Task 5: `PatternBackfillService` (all timeframes)

**Files:**
- Create: `apps/api/src/modules/signal-generator/ml/pattern-backfill.service.ts`
- Test: `apps/api/src/modules/signal-generator/ml/pattern-backfill.service.spec.ts`

**Interfaces:**
- Consumes: `AngelOneAdapterService.getHistoricalData(token, exchange, timeframe, from, to, priority)` (returns `Array<{ timestamp: Date; open; high; low; close; volume }>`), `buildPatternMarkers` (`../patterns/to-markers`), `buildObservationInputs` (Task 3), `PatternObservationRepository` (Task 4).
- Produces:
  - `const BACKFILL_TIMEFRAMES: string[]` = `['1m','3m','5m','10m','15m','30m','1h','1d']`
  - `interface BackfillTarget { token: string; exchange: string; symbol: string }`
  - `interface BackfillResult { target: string; timeframe: string; observations: number }`
  - `run(targets: BackfillTarget[], opts?: { timeframes?: string[]; lookbackDays?: number }): Promise<BackfillResult[]>`

- [ ] **Step 1: Write the failing test**

```typescript
// apps/api/src/modules/signal-generator/ml/pattern-backfill.service.spec.ts
import { PatternBackfillService, BACKFILL_TIMEFRAMES } from './pattern-backfill.service';

function makeCandles(n: number) {
  // Rising then dipping series so detectors + labels have something to chew on.
  return Array.from({ length: n }, (_, i) => ({
    timestamp: new Date(i * 900_000),
    open: 100 + Math.sin(i / 3) * 2,
    high: 101 + Math.sin(i / 3) * 2,
    low: 99 + Math.sin(i / 3) * 2,
    close: 100 + Math.sin(i / 3) * 2,
    volume: 1000,
  }));
}

describe('PatternBackfillService', () => {
  it('runs each target across all timeframes and saves observations', async () => {
    const adapter = { getHistoricalData: jest.fn().mockResolvedValue(makeCandles(120)) } as any;
    const repo = { saveMany: jest.fn().mockResolvedValue(3) } as any;
    const svc = new PatternBackfillService(adapter, repo);

    const results = await svc.run([{ token: '2885', exchange: 'NSE', symbol: 'RELIANCE' }]);

    // one result per (target × timeframe)
    expect(results).toHaveLength(BACKFILL_TIMEFRAMES.length);
    expect(adapter.getHistoricalData).toHaveBeenCalledTimes(BACKFILL_TIMEFRAMES.length);
    // each timeframe passed through to the adapter
    const tfsCalled = adapter.getHistoricalData.mock.calls.map((c: any[]) => c[2]);
    expect(tfsCalled.sort()).toEqual([...BACKFILL_TIMEFRAMES].sort());
    expect(repo.saveMany).toHaveBeenCalled();
  });

  it('skips a timeframe with too few candles without throwing', async () => {
    const adapter = { getHistoricalData: jest.fn().mockResolvedValue(makeCandles(5)) } as any;
    const repo = { saveMany: jest.fn().mockResolvedValue(0) } as any;
    const svc = new PatternBackfillService(adapter, repo);
    const results = await svc.run([{ token: '2885', exchange: 'NSE', symbol: 'RELIANCE' }], {
      timeframes: ['15m'],
    });
    expect(results[0].observations).toBe(0);
  });

  it('continues to the next timeframe when the adapter throws', async () => {
    const adapter = {
      getHistoricalData: jest
        .fn()
        .mockRejectedValueOnce(new Error('throttled'))
        .mockResolvedValue(makeCandles(120)),
    } as any;
    const repo = { saveMany: jest.fn().mockResolvedValue(2) } as any;
    const svc = new PatternBackfillService(adapter, repo);
    const results = await svc.run([{ token: '2885', exchange: 'NSE', symbol: 'RELIANCE' }], {
      timeframes: ['1m', '15m'],
    });
    expect(results).toHaveLength(2);
    expect(results[0].observations).toBe(0); // first threw → 0
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/api && npx jest pattern-backfill -v`
Expected: FAIL — "Cannot find module './pattern-backfill.service'".

- [ ] **Step 3: Write the implementation**

```typescript
// apps/api/src/modules/signal-generator/ml/pattern-backfill.service.ts
import { Injectable, Logger } from '@nestjs/common';
import { AngelOneAdapterService } from '../../market-data/services/angel-one-adapter.service';
import { buildPatternMarkers } from '../patterns/to-markers';
import { buildObservationInputs } from './observation-assembler';
import { PatternObservationRepository } from './pattern-observation.repository';
import type { OhlcvCandle } from './pattern-observation.types';

export const BACKFILL_TIMEFRAMES = ['1m', '3m', '5m', '10m', '15m', '30m', '1h', '1d'];

/** Per-timeframe calendar-day lookback for the backfill window. */
const LOOKBACK_DAYS: Record<string, number> = {
  '1m': 30, '3m': 45, '5m': 60, '10m': 90, '15m': 120, '30m': 180, '1h': 365, '1d': 365,
};

export interface BackfillTarget {
  token: string;
  exchange: string;
  symbol: string;
}

export interface BackfillResult {
  target: string;
  timeframe: string;
  observations: number;
}

@Injectable()
export class PatternBackfillService {
  private readonly logger = new Logger(PatternBackfillService.name);

  constructor(
    private readonly adapter: AngelOneAdapterService,
    private readonly repo: PatternObservationRepository,
  ) {}

  /**
   * Replay history for each target across all (or the given) timeframes,
   * detect patterns, assemble labeled observations, and persist. One adapter
   * call per (target × timeframe); failures for one timeframe never abort the
   * rest. Uses the 'background' priority lane so it never contends with live
   * chart fetches.
   */
  async run(
    targets: BackfillTarget[],
    opts: { timeframes?: string[]; lookbackDays?: number } = {},
  ): Promise<BackfillResult[]> {
    const timeframes = opts.timeframes ?? BACKFILL_TIMEFRAMES;
    const results: BackfillResult[] = [];

    for (const target of targets) {
      for (const tf of timeframes) {
        const result: BackfillResult = { target: target.symbol, timeframe: tf, observations: 0 };
        try {
          const lookback = opts.lookbackDays ?? LOOKBACK_DAYS[tf] ?? 120;
          const to = new Date();
          const from = new Date(to.getTime() - lookback * 24 * 60 * 60 * 1000);

          const raw = await this.adapter.getHistoricalData(
            target.token, target.exchange, tf, from, to, 'background',
          );
          const candles: OhlcvCandle[] = (raw ?? []).map((c: any) => ({
            time: c.timestamp.getTime(),
            open: c.open, high: c.high, low: c.low, close: c.close,
            volume: Number(c.volume ?? 0),
          }));

          if (candles.length >= 25) {
            const markers = buildPatternMarkers(candles);
            const inputs = buildObservationInputs(candles, markers, {
              token: target.token, exchange: target.exchange, timeframe: tf,
            });
            result.observations = await this.repo.saveMany(inputs);
          }
        } catch (err) {
          this.logger.warn(
            `backfill ${target.symbol} ${tf} failed: ${err instanceof Error ? err.message : err}`,
          );
        }
        this.logger.log(`backfill ${target.symbol} ${tf}: ${result.observations} observations`);
        results.push(result);
      }
    }
    return results;
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd apps/api && npx jest pattern-backfill -v`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/modules/signal-generator/ml/pattern-backfill.service.ts apps/api/src/modules/signal-generator/ml/pattern-backfill.service.spec.ts
git commit -m "feat(ml): pattern backfill service across all timeframes"
```

---

## Task 6: `PatternCaptureService` (live capture + resolvePending) + module wiring

**Files:**
- Create: `apps/api/src/modules/signal-generator/ml/pattern-capture.service.ts`
- Test: `apps/api/src/modules/signal-generator/ml/pattern-capture.service.spec.ts`
- Modify: `apps/api/src/modules/signal-generator/signal-generator.module.ts` (register `PatternObservationRepository`, `PatternBackfillService`, `PatternCaptureService` as providers)

**Interfaces:**
- Consumes: `buildObservationInputs` (Task 3), `PatternObservationRepository` (Task 4), `AngelOneAdapterService`, `resolveFollowThrough` (Task 2).
- Produces:
  - `capture(candles: OhlcvCandle[], markers: PatternMarkerDto[], meta: ObservationMeta): Promise<number>` — writes observations (PENDING or resolved) for a live detection; **never throws** (fail-open).
  - `resolvePending(limit?: number): Promise<number>` — re-fetches recent candles for each PENDING row's (token,exchange,timeframe), recomputes the outcome, and finalizes non-PENDING ones. Returns count resolved.

- [ ] **Step 1: Write the failing test**

```typescript
// apps/api/src/modules/signal-generator/ml/pattern-capture.service.spec.ts
import { PatternCaptureService } from './pattern-capture.service';
import type { OhlcvCandle } from './pattern-observation.types';
import type { PatternMarkerDto } from '../dto/pattern-marker.dto';

function flat(n: number): OhlcvCandle[] {
  return Array.from({ length: n }, (_, i) => ({
    time: i * 1000, open: 100, high: 101, low: 99, close: 100, volume: 10,
  }));
}

const marker: PatternMarkerDto = {
  category: 'CANDLESTICK', name: 'HAMMER', bias: 'BULLISH',
  time: 20 * 1000, points: [], necklinePrice: null, confirmed: null, confirmTime: null,
};

describe('PatternCaptureService', () => {
  it('capture saves observations and returns the count', async () => {
    const repo = { saveMany: jest.fn().mockResolvedValue(1), findPending: jest.fn(), updateOutcome: jest.fn() } as any;
    const adapter = {} as any;
    const svc = new PatternCaptureService(adapter, repo);
    const n = await svc.capture(flat(30), [marker], { token: '2885', exchange: 'NSE', timeframe: '15m' });
    expect(n).toBe(1);
    expect(repo.saveMany).toHaveBeenCalled();
  });

  it('capture never throws — returns 0 if the repo fails (fail-open)', async () => {
    const repo = { saveMany: jest.fn().mockRejectedValue(new Error('db down')) } as any;
    const svc = new PatternCaptureService({} as any, repo);
    await expect(
      svc.capture(flat(30), [marker], { token: '2885', exchange: 'NSE', timeframe: '15m' }),
    ).resolves.toBe(0);
  });

  it('resolvePending finalizes a row whose horizon has now resolved', async () => {
    // A pending hammer at barTime index 5; fresh candles show a +ATR move → WIN.
    const rising: OhlcvCandle[] = Array.from({ length: 30 }, (_, i) => ({
      time: i * 1000, open: 100 + i, high: 102 + i, low: 99 + i, close: 100 + i, volume: 10,
    }));
    const repo = {
      findPending: jest.fn().mockResolvedValue([
        { id: 'p1', token: '2885', exchange: 'NSE', timeframe: '15m', barTime: new Date(5 * 1000) },
      ]),
      updateOutcome: jest.fn().mockResolvedValue(undefined),
    } as any;
    const adapter = { getHistoricalData: jest.fn().mockResolvedValue(
      rising.map((c) => ({ timestamp: new Date(c.time), open: c.open, high: c.high, low: c.low, close: c.close, volume: c.volume })),
    ) } as any;
    const svc = new PatternCaptureService(adapter, repo);
    const n = await svc.resolvePending(10);
    expect(n).toBe(1);
    expect(repo.updateOutcome).toHaveBeenCalledWith('p1', expect.any(String), expect.anything());
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/api && npx jest pattern-capture -v`
Expected: FAIL — "Cannot find module './pattern-capture.service'".

- [ ] **Step 3: Write the implementation**

```typescript
// apps/api/src/modules/signal-generator/ml/pattern-capture.service.ts
import { Injectable, Logger } from '@nestjs/common';
import { AngelOneAdapterService } from '../../market-data/services/angel-one-adapter.service';
import type { PatternMarkerDto } from '../dto/pattern-marker.dto';
import { buildObservationInputs, type ObservationMeta } from './observation-assembler';
import { resolveFollowThrough } from './follow-through';
import { computeAtrFromCandles } from '../services/per-tf-atr';
import { PatternObservationRepository } from './pattern-observation.repository';
import { DEFAULT_FT_PARAMS, type OhlcvCandle } from './pattern-observation.types';

/** Bars of fresh history to pull when resolving a pending observation. */
const RESOLVE_LOOKBACK_DAYS: Record<string, number> = {
  '1m': 2, '3m': 3, '5m': 5, '10m': 7, '15m': 10, '30m': 20, '1h': 40, '1d': 90,
};

@Injectable()
export class PatternCaptureService {
  private readonly logger = new Logger(PatternCaptureService.name);

  constructor(
    private readonly adapter: AngelOneAdapterService,
    private readonly repo: PatternObservationRepository,
  ) {}

  /**
   * Persist observations for a LIVE detection. Rows whose horizon isn't complete
   * are stored PENDING and finalized later by resolvePending(). Fail-open:
   * capture must never break the /patterns response, so all errors are swallowed.
   */
  async capture(
    candles: OhlcvCandle[],
    markers: PatternMarkerDto[],
    meta: ObservationMeta,
  ): Promise<number> {
    try {
      const inputs = buildObservationInputs(candles, markers, meta);
      return await this.repo.saveMany(inputs);
    } catch (err) {
      this.logger.warn(`capture failed: ${err instanceof Error ? err.message : err}`);
      return 0;
    }
  }

  /**
   * For each PENDING observation, re-fetch recent candles for its
   * (token, exchange, timeframe), recompute the ATR-follow-through outcome from
   * the anchor bar, and finalize any that are now WIN/LOSS/TIMEOUT.
   */
  async resolvePending(limit = 200): Promise<number> {
    let resolved = 0;
    let pending: Awaited<ReturnType<PatternObservationRepository['findPending']>> = [];
    try {
      pending = await this.repo.findPending(limit);
    } catch (err) {
      this.logger.warn(`findPending failed: ${err instanceof Error ? err.message : err}`);
      return 0;
    }

    for (const row of pending) {
      try {
        const lookback = RESOLVE_LOOKBACK_DAYS[row.timeframe] ?? 10;
        const to = new Date();
        const from = new Date(row.barTime.getTime() - lookback * 24 * 60 * 60 * 1000);
        const raw = await this.adapter.getHistoricalData(
          row.token, row.exchange, row.timeframe, from, to, 'background',
        );
        const candles: OhlcvCandle[] = (raw ?? []).map((c: any) => ({
          time: c.timestamp.getTime(),
          open: c.open, high: c.high, low: c.low, close: c.close, volume: Number(c.volume ?? 0),
        }));

        const anchor = candles.findIndex((c) => c.time === row.barTime.getTime());
        if (anchor < 0) continue;

        const atr = computeAtrFromCandles(candles.slice(0, anchor + 1), 14);
        if (atr <= 0) continue;
        // Direction is implied by the stored bias; re-read it from the anchor bar's
        // pattern is unnecessary — we stored bias, but resolvePending only needs a
        // dir. We recompute both directions is wrong; instead we rely on the fact
        // that a PENDING row already committed a direction. Fetch it:
        // (bias not selected in findPending → resolve both is unsafe.) Use close move.
        // Simplter: recompute using the SAME sign we labeled with, carried on the row.
        // findPending must therefore include bias — added below.
        const dir: 1 | -1 = (row as any).bias === 'BEARISH' ? -1 : 1;
        const ft = resolveFollowThrough(candles, anchor, dir, atr, DEFAULT_FT_PARAMS);
        if (ft.outcome === 'PENDING') continue;
        await this.repo.updateOutcome(row.id, ft.outcome, ft.label);
        resolved++;
      } catch (err) {
        this.logger.warn(`resolve ${row.id} failed: ${err instanceof Error ? err.message : err}`);
      }
    }
    return resolved;
  }
}
```

- [ ] **Step 4: Add `bias` to `findPending` so resolvePending has the direction**

In `pattern-observation.repository.ts`, update `PendingObservation` and the `select`:

```typescript
export interface PendingObservation {
  id: string;
  token: string;
  exchange: string;
  timeframe: string;
  barTime: Date;
  bias: string;
}
```
and in `findPending`, add `bias: true` to the `select`. Then in `pattern-capture.service.ts` replace `(row as any).bias` with `row.bias` and delete the long explanatory comment block, leaving:

```typescript
        const dir: 1 | -1 = row.bias === 'BEARISH' ? -1 : 1;
```

- [ ] **Step 5: Register providers in the module**

In `apps/api/src/modules/signal-generator/signal-generator.module.ts`, import and add to the `providers` array:

```typescript
import { PatternObservationRepository } from './ml/pattern-observation.repository';
import { PatternBackfillService } from './ml/pattern-backfill.service';
import { PatternCaptureService } from './ml/pattern-capture.service';
// ...
  providers: [
    // ...existing providers...
    PatternObservationRepository,
    PatternBackfillService,
    PatternCaptureService,
  ],
```

- [ ] **Step 6: Run test to verify it passes**

Run: `cd apps/api && npx jest pattern-capture pattern-observation.repository -v`
Expected: PASS (all).

- [ ] **Step 7: Type-check the whole API compiles (no NEW errors at ml/ paths)**

Run: `cd apps/api && npx tsc -p tsconfig.json --noEmit 2>&1 | grep "signal-generator/ml" || echo "no ml errors"`
Expected: `no ml errors`.

- [ ] **Step 8: Commit**

```bash
git add apps/api/src/modules/signal-generator/ml/pattern-capture.service.ts apps/api/src/modules/signal-generator/ml/pattern-capture.service.spec.ts apps/api/src/modules/signal-generator/ml/pattern-observation.repository.ts apps/api/src/modules/signal-generator/signal-generator.module.ts
git commit -m "feat(ml): live pattern capture + pending resolver, wired into module"
```

---

## Task 7: ML Lessons 01 & 02

**Files:**
- Create: `docs/learning/ml/01-what-is-a-pattern-quality-scorer.md`
- Create: `docs/learning/ml/02-features-and-the-atr-follow-through-label.md`

- [ ] **Step 1: Write Lesson 01** — cover: why raw detectors are noisy; supervised learning framing (features → label → model → probability); what "pattern quality" means; how a probability threshold turns a noisy overlay into a filtered one; where this sits in the GrW pipeline (detectors in TS → observations → Python model). Tie each concept to a concrete file (`patterns/to-markers.ts`, `ml/pattern-observation.types.ts`). Keep the teaching voice of `docs/learning/pattern-detection/01-swing-points.md`.

- [ ] **Step 2: Write Lesson 02** — cover: features vs label; why we chose the ATR-follow-through label (path-aware, ATR-normalized, timeframe-relative); walk the WIN/LOSS/TIMEOUT/PENDING logic against a worked example; why NEUTRAL patterns are excluded; why `timeframe` is a feature (different patterns work on different timeframes). Reference `ml/follow-through.ts` and `ml/observation-assembler.ts` with real code excerpts.

- [ ] **Step 3: Commit**

```bash
git add docs/learning/ml/01-what-is-a-pattern-quality-scorer.md docs/learning/ml/02-features-and-the-atr-follow-through-label.md
git commit -m "docs(learning): ML lessons 01-02 (pattern-quality scorer, ATR label)"
```

---

## Self-Review Notes

- **Spec coverage:** `pattern_observations` table (Task 1) ✓; ATR-follow-through resolver (Task 2) ✓; timeframe-tagged observations + window + ATR (Task 3) ✓; repository (Task 4) ✓; backfill across ALL timeframes (Task 5, `BACKFILL_TIMEFRAMES`) ✓; live detection→observation writer + resolver (Task 6) ✓; lessons 01–02 (Task 7) ✓. Deferred to later phases (correctly out of Phase 1): Python features/training, `/score-patterns`, overlay filtering, heartbeat retrain.
- **NEUTRAL exclusion, PENDING vs TIMEOUT, same-bar tie → LOSS** are all pinned with tests.
- **Type consistency:** `OhlcvCandle`, `FollowThroughParams`, `PatternObservationInput`, `ObservationMeta` defined once (Task 2/3) and reused everywhere; `findPending` returns `bias` (Task 6 Step 4) which `resolvePending` consumes.
- **Follow-up (Phase 1 finish task, do last):** wire `PatternCaptureService.capture(...)` into the `/patterns` controller path (`detectPatterns`) so live detections are recorded, and add a `resolvePending` trigger endpoint for the external heartbeat. Left as a small integration step after the units land so the controller change is reviewed on its own.
