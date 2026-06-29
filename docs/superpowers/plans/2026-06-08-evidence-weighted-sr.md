# Evidence-Weighted Support/Resistance Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add volume-profile nodes, adaptive round numbers, and OI walls as *scored* S/R candidates so a level is only marked support/resistance when corroborated by evidence — fixing the blue-sky breakout case (CUPID shows `R 145` instead of `R —`) and surfacing OI walls on index charts.

**Architecture:** A backend `SrEvidenceService` (with pure sub-units `computeVolumeNodes`, `adaptiveRoundNumbers`, `scoreAndCluster`, and an injected `OiWallService`) computes scored `EvidenceLevel[]` per token, exposed at `GET /api/signals/sr-evidence`. The frontend polls it via `useSrEvidence`, folds it into the existing `buildSRView`, and draws the levels via a new overlay.

**Tech Stack:** NestJS + TypeScript (apps/api, jest), React + TypeScript (apps/web, vitest), lightweight-charts.

**Spec:** `docs/superpowers/specs/2026-06-08-evidence-weighted-sr-design.md`

---

## Shared type (used across tasks)

`EvidenceLevel` is defined in Task 3 (API) and mirrored in Task 6 (web):
```ts
type EvidenceKind = 'VOLUME' | 'HISTORY' | 'OI_CALL' | 'OI_PUT' | 'ROUND';
interface EvidenceLevel {
  price: number;
  side: 'resistance' | 'support';
  score: number;          // 0–100
  kinds: EvidenceKind[];
  soft: boolean;          // surfaced fallback (below floor) when a side is otherwise empty
  distancePct: number;    // signed % from ltp
}
```
Internal scorer input:
```ts
interface LevelCandidate { price: number; kind: EvidenceKind; score: number; }
```

Scoring constants (Task 3): `FLOOR = 35`. Cluster tolerance `tol = max(0.3 * atr14, 0.003 * ltp)`.

---

## Task 1: `adaptiveRoundNumbers` helper (pure, TDD)

**Files:**
- Create: `apps/api/src/modules/signal-generator/services/adaptive-round-numbers.ts`
- Test: `apps/api/src/modules/signal-generator/services/adaptive-round-numbers.spec.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { adaptiveRoundStep, adaptiveRoundNumbers, roundScore } from './adaptive-round-numbers';

describe('adaptiveRoundNumbers', () => {
  it('picks a price-tiered step', () => {
    expect(adaptiveRoundStep(30)).toBe(1);
    expect(adaptiveRoundStep(140)).toBe(5);
    expect(adaptiveRoundStep(380)).toBe(10);
    expect(adaptiveRoundStep(1500)).toBe(25);
    expect(adaptiveRoundStep(3000)).toBe(50);
    expect(adaptiveRoundStep(9000)).toBe(100);
  });

  it('generates ±3 steps around spot on the grid', () => {
    // CUPID ~140 → step 5 → 130,135,140,145,150 (center 140)
    expect(adaptiveRoundNumbers(140)).toEqual([125, 130, 135, 140, 145, 150, 155]);
  });

  it('roundScore: 12 for grid membership, 15 for a major round (multiple of 5*step)', () => {
    // step 5 → major rounds are multiples of 25
    expect(roundScore(140, 5)).toBe(12);
    expect(roundScore(150, 5)).toBe(15); // 150 = 30*5, and 150 % 25 === 0 → major
    expect(roundScore(141, 5)).toBe(0);  // not on grid
  });

  it('returns [] for non-positive ltp', () => {
    expect(adaptiveRoundNumbers(0)).toEqual([]);
    expect(adaptiveRoundNumbers(-5)).toEqual([]);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd apps/api && npx jest adaptive-round-numbers --silent=false 2>&1 | tail -15`
Expected: cannot find module './adaptive-round-numbers'.

- [ ] **Step 3: Implement**

Create `apps/api/src/modules/signal-generator/services/adaptive-round-numbers.ts`:
```ts
/**
 * Price-adaptive round-number grid. The old flat step of 50 is meaningless for
 * a ₹140 stock; real round numbers scale with price.
 */
export function adaptiveRoundStep(ltp: number): number {
  if (ltp < 50) return 1;
  if (ltp < 200) return 5;
  if (ltp < 500) return 10;
  if (ltp < 2000) return 25;
  if (ltp < 5000) return 50;
  return 100;
}

/** ±3 steps around spot, snapped to the grid. [] when ltp <= 0. */
export function adaptiveRoundNumbers(ltp: number): number[] {
  if (!(ltp > 0)) return [];
  const step = adaptiveRoundStep(ltp);
  const center = Math.round(ltp / step) * step;
  const out: number[] = [];
  for (let k = -3; k <= 3; k++) out.push(center + k * step);
  return out;
}

/**
 * Score a price's round-number significance:
 *  - 0  if not on the grid
 *  - 15 if it is a "major" round (a multiple of 5*step — e.g. a century/half-century)
 *  - 12 otherwise (ordinary grid level)
 */
export function roundScore(price: number, step: number): number {
  if (step <= 0) return 0;
  const onGrid = Math.abs(price / step - Math.round(price / step)) < 1e-9;
  if (!onGrid) return 0;
  const major = Math.abs(price / (5 * step) - Math.round(price / (5 * step))) < 1e-9;
  return major ? 15 : 12;
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `cd apps/api && npx jest adaptive-round-numbers 2>&1 | tail -8`
Expected: 4 tests pass.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/modules/signal-generator/services/adaptive-round-numbers.ts apps/api/src/modules/signal-generator/services/adaptive-round-numbers.spec.ts
git commit -m "feat(sr): adaptive round-number grid + scoring helper"
```

---

## Task 2: `computeVolumeNodes` (pure, TDD)

**Files:**
- Create: `apps/api/src/modules/signal-generator/services/volume-profile.ts`
- Test: `apps/api/src/modules/signal-generator/services/volume-profile.spec.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { computeVolumeNodes, type ProfileCandle } from './volume-profile';

function c(close: number, volume: number): ProfileCandle {
  return { high: close, low: close, close, volume };
}

describe('computeVolumeNodes', () => {
  it('returns [] for fewer than 10 candles', () => {
    expect(computeVolumeNodes([c(100, 5)], 2, 100)).toEqual([]);
  });

  it('surfaces the highest-volume price bucket as a node with score', () => {
    // 20 candles; a heavy cluster at ~150, light elsewhere. atr 2 → bucket 0.5 (0.25% of 150=0.375 → max=0.5)
    const candles: ProfileCandle[] = [];
    for (let i = 0; i < 16; i++) candles.push(c(120 + (i % 3), 10));
    for (let i = 0; i < 8; i++) candles.push(c(150, 300));
    const nodes = computeVolumeNodes(candles, 2, 145);
    expect(nodes.length).toBeGreaterThan(0);
    // top node is the 150 shelf
    expect(Math.round(nodes[0].price)).toBe(150);
    expect(nodes[0].score).toBeGreaterThanOrEqual(35); // >=3x avg → full 40-ish
  });

  it('caps at 5 nodes', () => {
    const candles: ProfileCandle[] = [];
    for (let i = 0; i < 40; i++) candles.push(c(100 + i, 10 + i)); // many distinct buckets
    const nodes = computeVolumeNodes(candles, 1, 120);
    expect(nodes.length).toBeLessThanOrEqual(5);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd apps/api && npx jest volume-profile --silent=false 2>&1 | tail -15`
Expected: cannot find module './volume-profile'.

- [ ] **Step 3: Implement**

Create `apps/api/src/modules/signal-generator/services/volume-profile.ts`:
```ts
export interface ProfileCandle {
  high: number;
  low: number;
  close: number;
  volume: number;
}

export interface VolumeNode {
  price: number;  // bucket center
  volume: number; // total volume in the bucket
  score: number;  // 0–40 volume evidence score
}

/**
 * Volume-by-price profile. Buckets candles by their typical price (v1
 * simplification — assign full bar volume to one bucket, not spread across
 * high–low), returns the top 5 high-volume nodes scored 0–40 by how far each
 * exceeds the average bucket volume (>=3x → ~40).
 *
 * Returns [] for < 10 candles (insufficient profile).
 */
export function computeVolumeNodes(
  candles: ProfileCandle[],
  atr14: number,
  ltp: number,
): VolumeNode[] {
  if (candles.length < 10 || !(ltp > 0)) return [];
  const bucket = Math.max(0.1 * atr14, 0.0025 * ltp) || 0.0025 * ltp;
  if (!(bucket > 0)) return [];

  const byBucket = new Map<number, number>(); // bucketIndex → volume
  for (const k of candles) {
    const typical = (k.high + k.low + k.close) / 3;
    const idx = Math.round(typical / bucket);
    const vol = Number(k.volume) || 0;
    byBucket.set(idx, (byBucket.get(idx) ?? 0) + vol);
  }
  if (byBucket.size === 0) return [];

  const totalVol = [...byBucket.values()].reduce((a, b) => a + b, 0);
  const avgVol = totalVol / byBucket.size;

  const nodes: VolumeNode[] = [...byBucket.entries()].map(([idx, volume]) => ({
    price: idx * bucket,
    volume,
    score: avgVol > 0 ? 40 * Math.min(volume / avgVol / 3, 1) : 0,
  }));

  nodes.sort((a, b) => b.volume - a.volume);
  return nodes.slice(0, 5);
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `cd apps/api && npx jest volume-profile 2>&1 | tail -8`
Expected: 3 tests pass.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/modules/signal-generator/services/volume-profile.ts apps/api/src/modules/signal-generator/services/volume-profile.spec.ts
git commit -m "feat(sr): volume-by-price profile (top-5 high-volume nodes, scored)"
```

---

## Task 3: `EvidenceLevel` types + `scoreAndCluster` (pure, TDD)

**Files:**
- Create: `apps/api/src/modules/signal-generator/types/evidence-level.types.ts`
- Create: `apps/api/src/modules/signal-generator/services/sr-evidence-scoring.ts`
- Test: `apps/api/src/modules/signal-generator/services/sr-evidence-scoring.spec.ts`

- [ ] **Step 1: Write the types**

Create `apps/api/src/modules/signal-generator/types/evidence-level.types.ts`:
```ts
export type EvidenceKind = 'VOLUME' | 'HISTORY' | 'OI_CALL' | 'OI_PUT' | 'ROUND';

export interface EvidenceLevel {
  price: number;
  side: 'resistance' | 'support';
  score: number;          // 0–100
  kinds: EvidenceKind[];
  soft: boolean;
  distancePct: number;
}

export interface LevelCandidate {
  price: number;
  kind: EvidenceKind;
  score: number;
}
```

- [ ] **Step 2: Write the failing test**

Create `apps/api/src/modules/signal-generator/services/sr-evidence-scoring.spec.ts`:
```ts
import { scoreAndCluster } from './sr-evidence-scoring';
import type { LevelCandidate } from '../types/evidence-level.types';

const ATR = 2;     // tol = max(0.6, 0.3% of ltp)
const LTP = 100;

describe('scoreAndCluster', () => {
  it('keeps a candidate at/above the floor (35) and sides it correctly', () => {
    const cands: LevelCandidate[] = [{ price: 105, kind: 'VOLUME', score: 38 }];
    const out = scoreAndCluster(cands, LTP, ATR, { softRoundGrid: [] });
    expect(out).toHaveLength(1);
    expect(out[0].side).toBe('resistance');
    expect(out[0].score).toBe(38);
    expect(out[0].kinds).toEqual(['VOLUME']);
    expect(out[0].soft).toBe(false);
    expect(out[0].distancePct).toBeCloseTo(5, 5);
  });

  it('drops a candidate below the floor (a naked round number)', () => {
    const cands: LevelCandidate[] = [{ price: 105, kind: 'ROUND', score: 12 }];
    const out = scoreAndCluster(cands, LTP, ATR, { softRoundGrid: [] });
    expect(out.filter((l) => !l.soft)).toHaveLength(0);
  });

  it('clusters confluence: round + volume at the same price sum above floor', () => {
    const cands: LevelCandidate[] = [
      { price: 105, kind: 'ROUND', score: 12 },
      { price: 105.1, kind: 'VOLUME', score: 30 },
    ];
    const out = scoreAndCluster(cands, LTP, ATR, { softRoundGrid: [] });
    const kept = out.filter((l) => !l.soft);
    expect(kept).toHaveLength(1);
    expect(kept[0].score).toBe(42);
    expect(kept[0].kinds.sort()).toEqual(['ROUND', 'VOLUME']);
  });

  it('caps cluster score at 100', () => {
    const cands: LevelCandidate[] = [
      { price: 105, kind: 'VOLUME', score: 40 },
      { price: 105, kind: 'HISTORY', score: 25 },
      { price: 105, kind: 'OI_CALL', score: 30 },
      { price: 105, kind: 'ROUND', score: 15 },
    ];
    const out = scoreAndCluster(cands, LTP, ATR, { softRoundGrid: [] });
    expect(out[0].score).toBe(100);
  });

  it('adds a soft round number on a side that has no kept level', () => {
    // only a support is kept; resistance side empty → soft nearest round above
    const cands: LevelCandidate[] = [{ price: 95, kind: 'VOLUME', score: 38 }];
    const out = scoreAndCluster(cands, LTP, ATR, { softRoundGrid: [90, 100, 110, 120] });
    const res = out.find((l) => l.side === 'resistance')!;
    expect(res.soft).toBe(true);
    expect(res.price).toBe(110); // nearest grid value above ltp 100 (100 excluded == ltp)
    expect(res.kinds).toEqual(['ROUND']);
  });

  it('does not add a soft level when the side already has a kept level', () => {
    const cands: LevelCandidate[] = [{ price: 105, kind: 'VOLUME', score: 38 }];
    const out = scoreAndCluster(cands, LTP, ATR, { softRoundGrid: [110, 120] });
    expect(out.filter((l) => l.side === 'resistance' && l.soft)).toHaveLength(0);
  });
});
```

- [ ] **Step 3: Run to verify it fails**

Run: `cd apps/api && npx jest sr-evidence-scoring --silent=false 2>&1 | tail -15`
Expected: cannot find module './sr-evidence-scoring'.

- [ ] **Step 4: Implement**

Create `apps/api/src/modules/signal-generator/services/sr-evidence-scoring.ts`:
```ts
import type { EvidenceKind, EvidenceLevel, LevelCandidate } from '../types/evidence-level.types';

const FLOOR = 35;

interface ScoreOpts {
  /** Adaptive round-number grid for the soft fallback when a side is empty. */
  softRoundGrid: number[];
  floor?: number;
}

interface Cluster {
  price: number;       // strongest contributor's price
  topScore: number;    // for representative price selection
  score: number;       // summed, capped at 100
  kinds: Set<EvidenceKind>;
}

/**
 * Cluster confluent candidates, sum their evidence into a 0–100 score, side
 * them vs the live price, drop everything below the floor, and — when a side
 * has no kept level — surface the nearest adaptive round number on that side as
 * a `soft` fallback (so a blue-sky breakout still shows a "how far" reference).
 */
export function scoreAndCluster(
  candidates: LevelCandidate[],
  ltp: number,
  atr14: number,
  opts: ScoreOpts,
): EvidenceLevel[] {
  if (!(ltp > 0)) return [];
  const floor = opts.floor ?? FLOOR;
  const tol = Math.max(0.3 * atr14, 0.003 * ltp);

  // Cluster by proximity (greedy, nearest-first by price).
  const sorted = [...candidates]
    .filter((c) => Number.isFinite(c.price) && c.price > 0 && c.price !== ltp)
    .sort((a, b) => a.price - b.price);

  const clusters: Cluster[] = [];
  for (const c of sorted) {
    const last = clusters[clusters.length - 1];
    if (last && Math.abs(c.price - last.price) <= tol) {
      last.score = Math.min(100, last.score + c.score);
      last.kinds.add(c.kind);
      if (c.score > last.topScore) {
        last.topScore = c.score;
        last.price = c.price; // representative = strongest contributor
      }
    } else {
      clusters.push({ price: c.price, topScore: c.score, score: Math.min(100, c.score), kinds: new Set([c.kind]) });
    }
  }

  const kept: EvidenceLevel[] = clusters
    .filter((cl) => cl.score >= floor)
    .map((cl) => ({
      price: cl.price,
      side: cl.price > ltp ? 'resistance' : 'support',
      score: cl.score,
      kinds: [...cl.kinds],
      soft: false,
      distancePct: ((cl.price - ltp) / ltp) * 100,
    }));

  // Soft fallback per empty side.
  const hasRes = kept.some((l) => l.side === 'resistance');
  const hasSup = kept.some((l) => l.side === 'support');
  const grid = opts.softRoundGrid.filter((p) => p > 0 && p !== ltp);

  const addSoft = (side: 'resistance' | 'support') => {
    const pool = side === 'resistance' ? grid.filter((p) => p > ltp) : grid.filter((p) => p < ltp);
    if (pool.length === 0) return;
    const price = pool.reduce((best, p) => (Math.abs(p - ltp) < Math.abs(best - ltp) ? p : best));
    kept.push({
      price,
      side,
      score: 0,
      kinds: ['ROUND'],
      soft: true,
      distancePct: ((price - ltp) / ltp) * 100,
    });
  };
  if (!hasRes) addSoft('resistance');
  if (!hasSup) addSoft('support');

  return kept.sort((a, b) => Math.abs(a.distancePct) - Math.abs(b.distancePct));
}
```

- [ ] **Step 5: Run to verify it passes**

Run: `cd apps/api && npx jest sr-evidence-scoring 2>&1 | tail -8`
Expected: 6 tests pass.

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/modules/signal-generator/types/evidence-level.types.ts apps/api/src/modules/signal-generator/services/sr-evidence-scoring.ts apps/api/src/modules/signal-generator/services/sr-evidence-scoring.spec.ts
git commit -m "feat(sr): evidence scorer — cluster confluence, floor gate, soft fallback"
```

---

## Task 4: `OiWallService` (TDD with mocked options chain)

**Files:**
- Create: `apps/api/src/modules/signal-generator/services/oi-wall.service.ts`
- Test: `apps/api/src/modules/signal-generator/services/oi-wall.service.spec.ts`

`OiWallService` injects `OptionsChainService` (`getExpiries(symbol): Promise<string[]>`, `getOptionsChain(symbol, expiry): Promise<OptionsChainEntry[]>`). A chain entry is `{ strikePrice, ceData: { oi, ... } | null, peData: { oi, ... } | null }`.

- [ ] **Step 1: Write the failing test**

```ts
import { OiWallService } from './oi-wall.service';

describe('OiWallService', () => {
  const chain = [
    { strikePrice: 100, ceData: { oi: 10 }, peData: { oi: 90 } },
    { strikePrice: 110, ceData: { oi: 80 }, peData: { oi: 20 } },
    { strikePrice: 120, ceData: { oi: 50 }, peData: { oi: 5 } },
    { strikePrice: 90,  ceData: { oi: 5 },  peData: { oi: 70 } },
  ];

  function svc(getExpiries: jest.Mock, getOptionsChain: jest.Mock) {
    return new OiWallService({ getExpiries, getOptionsChain } as never);
  }

  it('returns [] for a non-F&O symbol (no expiries)', async () => {
    const s = svc(jest.fn().mockResolvedValue([]), jest.fn());
    expect(await s.walls('CUPID')).toEqual([]);
  });

  it('returns top-2 call strikes as resistance (score 30/20) and top-2 put strikes as support', async () => {
    const s = svc(
      jest.fn().mockResolvedValue(['2026-06-25']),
      jest.fn().mockResolvedValue(chain),
    );
    const walls = await s.walls('NIFTY');
    const res = walls.filter((w) => w.kind === 'OI_CALL').sort((a, b) => b.score - a.score);
    const sup = walls.filter((w) => w.kind === 'OI_PUT').sort((a, b) => b.score - a.score);
    expect(res[0]).toMatchObject({ price: 110, score: 30 }); // highest call OI
    expect(res[1]).toMatchObject({ price: 120, score: 20 });
    expect(sup[0]).toMatchObject({ price: 100, score: 30 }); // highest put OI
    expect(sup[1]).toMatchObject({ price: 90, score: 20 });
  });

  it('returns [] and does not throw when the chain fetch fails', async () => {
    const s = svc(
      jest.fn().mockResolvedValue(['2026-06-25']),
      jest.fn().mockRejectedValue(new Error('boom')),
    );
    expect(await s.walls('NIFTY')).toEqual([]);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd apps/api && npx jest oi-wall.service --silent=false 2>&1 | tail -15`
Expected: cannot find module './oi-wall.service'.

- [ ] **Step 3: Implement**

Create `apps/api/src/modules/signal-generator/services/oi-wall.service.ts`:
```ts
import { Injectable, Logger, Optional } from '@nestjs/common';
import { OptionsChainService } from '../../options-chain/services/options-chain.service';
import type { LevelCandidate } from '../types/evidence-level.types';

/**
 * OI walls: the strikes with the most open interest act as magnets/walls.
 * Top call-OI strike = resistance, top put-OI strike = support. F&O underlyings
 * only — a cash stock has no chain, so `walls()` returns []. Never throws.
 */
@Injectable()
export class OiWallService {
  private readonly logger = new Logger(OiWallService.name);

  constructor(@Optional() private readonly optionsChain?: OptionsChainService) {}

  async walls(symbol: string): Promise<LevelCandidate[]> {
    if (!this.optionsChain || !symbol) return [];
    try {
      const expiries = await this.optionsChain.getExpiries(symbol);
      if (!expiries || expiries.length === 0) return []; // cash stock — no OI
      const chain = await this.optionsChain.getOptionsChain(symbol, expiries[0]);
      if (!Array.isArray(chain) || chain.length === 0) return [];

      const calls = chain
        .map((e: any) => ({ price: e.strikePrice, oi: e.ceData?.oi ?? 0 }))
        .filter((x) => x.oi > 0)
        .sort((a, b) => b.oi - a.oi);
      const puts = chain
        .map((e: any) => ({ price: e.strikePrice, oi: e.peData?.oi ?? 0 }))
        .filter((x) => x.oi > 0)
        .sort((a, b) => b.oi - a.oi);

      const out: LevelCandidate[] = [];
      const ranks = [30, 20];
      calls.slice(0, 2).forEach((c, i) => out.push({ price: c.price, kind: 'OI_CALL', score: ranks[i] }));
      puts.slice(0, 2).forEach((p, i) => out.push({ price: p.price, kind: 'OI_PUT', score: ranks[i] }));
      return out;
    } catch (err) {
      this.logger.debug(`OI walls failed for ${symbol}: ${err instanceof Error ? err.message : err}`);
      return [];
    }
  }
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `cd apps/api && npx jest oi-wall.service 2>&1 | tail -8`
Expected: 3 tests pass.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/modules/signal-generator/services/oi-wall.service.ts apps/api/src/modules/signal-generator/services/oi-wall.service.spec.ts
git commit -m "feat(sr): OiWallService — max call/put OI strikes (F&O only)"
```

---

## Task 5: `SrEvidenceService` orchestration + endpoint + module wiring

**Files:**
- Create: `apps/api/src/modules/signal-generator/services/sr-evidence.service.ts`
- Test: `apps/api/src/modules/signal-generator/services/sr-evidence.service.spec.ts`
- Modify: `apps/api/src/modules/signal-generator/controllers/signal-generator.controller.ts`
- Modify: `apps/api/src/modules/signal-generator/signal-generator.module.ts`

- [ ] **Step 1: Write the failing test** (orchestration with all deps mocked)

Create `apps/api/src/modules/signal-generator/services/sr-evidence.service.spec.ts`:
```ts
import { SrEvidenceService } from './sr-evidence.service';

describe('SrEvidenceService', () => {
  const book = { spot: 140, atr14: 4, pdh: 138, pdl: 130 };
  const candles = Array.from({ length: 20 }, (_, i) => ({
    high: 150, low: 150, close: 150, volume: i < 10 ? 500 : 50,
  }));

  function build(overrides: Partial<any> = {}) {
    const deps = {
      levelBookService: { lazyLoad: jest.fn().mockResolvedValue(book) },
      angelOneAdapter: { getHistoricalData: jest.fn().mockResolvedValue(candles) },
      marketDataRepository: {
        getInstrumentByToken: jest.fn().mockResolvedValue({ id: 'i1', symbol: 'CUPID', exchange: 'NSE' }),
        getCandles: jest.fn().mockResolvedValue([]),
      },
      zoneRepository: { findActiveByToken: jest.fn().mockResolvedValue([]) },
      oiWallService: { walls: jest.fn().mockResolvedValue([]) },
      ...overrides,
    };
    return new SrEvidenceService(
      deps.levelBookService as never,
      deps.angelOneAdapter as never,
      deps.marketDataRepository as never,
      deps.zoneRepository as never,
      deps.oiWallService as never,
    );
  }

  it('returns [] when no level book (insufficient data)', async () => {
    const s = build({ levelBookService: { lazyLoad: jest.fn().mockResolvedValue(null) } });
    expect(await s.levelsFor('18520', 'NSE', 'CUPID')).toEqual([]);
  });

  it('produces a scored resistance from a volume node above spot', async () => {
    const s = build();
    const levels = await s.levelsFor('18520', 'NSE', 'CUPID');
    // 150 shelf is above spot 140 → resistance candidate; with soft fallback support exists too
    const res = levels.find((l) => l.side === 'resistance' && !l.soft);
    expect(res).toBeTruthy();
    expect(res!.kinds).toContain('VOLUME');
  });

  it('includes OI walls when the symbol is F&O', async () => {
    const s = build({
      oiWallService: { walls: jest.fn().mockResolvedValue([{ price: 145, kind: 'OI_CALL', score: 30 }]) },
    });
    const levels = await s.levelsFor('99926000', 'NSE', 'NIFTY');
    expect(levels.some((l) => l.kinds.includes('OI_CALL'))).toBe(true);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd apps/api && npx jest sr-evidence.service --silent=false 2>&1 | tail -15`
Expected: cannot find module './sr-evidence.service'.

- [ ] **Step 3: Implement the service**

Create `apps/api/src/modules/signal-generator/services/sr-evidence.service.ts`:
```ts
import { Injectable, Logger, Optional } from '@nestjs/common';
import { LevelBookService } from './level-book.service';
import { AngelOneAdapterService } from '../../market-data/services/angel-one-adapter.service';
import { MarketDataRepository } from '../../market-data/repositories/market-data.repository';
import { ZoneRepository } from '../repositories/zone.repository';
import { OiWallService } from './oi-wall.service';
import { computeVolumeNodes, type ProfileCandle } from './volume-profile';
import { adaptiveRoundNumbers, adaptiveRoundStep, roundScore } from './adaptive-round-numbers';
import { scoreAndCluster } from './sr-evidence-scoring';
import type { EvidenceLevel, LevelCandidate } from '../types/evidence-level.types';

interface CacheEntry { at: number; levels: EvidenceLevel[]; }
const CACHE_TTL_MS = 15 * 60 * 1000;

/**
 * Orchestrates evidence-weighted S/R: volume nodes + adaptive round numbers +
 * OI walls + pivot history → scored, sided EvidenceLevel[]. Cached 15 min.
 * All deps optional so test/unwired containers construct cleanly; returns []
 * rather than throwing on any failure.
 */
@Injectable()
export class SrEvidenceService {
  private readonly logger = new Logger(SrEvidenceService.name);
  private readonly cache = new Map<string, CacheEntry>();

  constructor(
    @Optional() private readonly levelBookService?: LevelBookService,
    @Optional() private readonly angelOneAdapter?: AngelOneAdapterService,
    @Optional() private readonly marketDataRepository?: MarketDataRepository,
    @Optional() private readonly zoneRepository?: ZoneRepository,
    @Optional() private readonly oiWallService?: OiWallService,
  ) {}

  async levelsFor(token: string, exchange: string, symbol: string): Promise<EvidenceLevel[]> {
    if (!token || !this.levelBookService) return [];
    const cacheKey = `${token}:${exchange}`;
    const cached = this.cache.get(cacheKey);
    if (cached && Date.now() - cached.at < CACHE_TTL_MS) return cached.levels;

    try {
      const book = await this.levelBookService.lazyLoad(token, exchange, symbol);
      if (!book) return [];
      const ltp = book.spot;
      const atr14 = book.atr14;
      if (!(ltp > 0)) return [];

      const candles5m = await this.fetch5mCandles(token, exchange);
      const volNodes = computeVolumeNodes(candles5m, atr14, ltp);
      const step = adaptiveRoundStep(ltp);
      const roundGrid = adaptiveRoundNumbers(ltp);
      const oiWalls = this.oiWallService ? await this.oiWallService.walls(symbol) : [];
      const pivots = this.zoneRepository ? await this.zoneRepository.findActiveByToken(token) : [];

      const candidates: LevelCandidate[] = [];
      for (const n of volNodes) candidates.push({ price: n.price, kind: 'VOLUME', score: n.score });
      for (const r of roundGrid) {
        const rs = roundScore(r, step);
        if (rs > 0) candidates.push({ price: r, kind: 'ROUND', score: rs });
      }
      for (const w of oiWalls) candidates.push(w);
      for (const p of pivots as any[]) {
        const edge = p.type === 'resistance' ? p.lower : p.upper;
        candidates.push({ price: edge, kind: 'HISTORY', score: 25 * ((p.strength ?? 0) / 100) });
      }

      const levels = scoreAndCluster(candidates, ltp, atr14, { softRoundGrid: roundGrid });
      this.cache.set(cacheKey, { at: Date.now(), levels });
      return levels;
    } catch (err) {
      this.logger.warn(`SrEvidence levelsFor failed for ${token}: ${err instanceof Error ? err.message : err}`);
      return [];
    }
  }

  /** Live 5m candles (last 10 days) via the adapter; DB fallback. */
  private async fetch5mCandles(token: string, exchange: string): Promise<ProfileCandle[]> {
    const now = new Date();
    const from = new Date(now.getTime() - 10 * 24 * 60 * 60 * 1000);
    if (this.angelOneAdapter) {
      try {
        const live = await this.angelOneAdapter.getHistoricalData(token, exchange, '5m', from, now);
        if (Array.isArray(live) && live.length >= 10) {
          return live.map((c: any) => ({ high: c.high, low: c.low, close: c.close, volume: Number(c.volume) }));
        }
      } catch (err) {
        this.logger.debug(`SrEvidence live 5m fetch failed for ${token}: ${err instanceof Error ? err.message : err}`);
      }
    }
    if (this.marketDataRepository) {
      const inst = await this.marketDataRepository.getInstrumentByToken(token);
      if (inst) {
        const rows = await this.marketDataRepository.getCandles(inst.id, '5m', from, now, 800);
        return rows.map((r: any) => ({ high: r.high, low: r.low, close: r.close, volume: Number(r.volume) }));
      }
    }
    return [];
  }
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `cd apps/api && npx jest sr-evidence.service 2>&1 | tail -8`
Expected: 3 tests pass.

- [ ] **Step 5: Register in the module**

In `apps/api/src/modules/signal-generator/signal-generator.module.ts`:
- Add imports near the other service imports:
```ts
import { SrEvidenceService } from './services/sr-evidence.service';
import { OiWallService } from './services/oi-wall.service';
```
- Add to the `providers:` array (after the existing zone/level providers): `OiWallService,` and `SrEvidenceService,`.
- Add `SrEvidenceService,` to the `exports:` array.

- [ ] **Step 6: Add the endpoint**

In `apps/api/src/modules/signal-generator/controllers/signal-generator.controller.ts`:
- Import: `import { SrEvidenceService } from '../services/sr-evidence.service';`
- Add to the constructor as the last optional dep:
```ts
    @Optional() private readonly srEvidenceService?: SrEvidenceService,
```
- Add the endpoint method right after `getZones`:
```ts
  /**
   * GET /api/signals/sr-evidence — evidence-weighted S/R levels (volume nodes,
   * adaptive round numbers, OI walls, pivot history) scored + sided vs spot.
   * Returns [] (not 404) when unavailable so the overlay stays mounted.
   */
  @Get('sr-evidence')
  async getSrEvidence(
    @Query('token') token: string,
    @Query('exchange') exchange?: string,
    @Query('symbol') symbol?: string,
  ) {
    if (!token) throw new BadRequestException('token is required');
    if (!this.srEvidenceService) return [];
    let resolvedSymbol = symbol;
    let resolvedExchange = exchange ?? 'NSE';
    if (!resolvedSymbol && this.marketDataRepository) {
      try {
        const inst = await this.marketDataRepository.getInstrumentByToken(token);
        resolvedSymbol = inst?.symbol;
        resolvedExchange = inst?.exchange ?? resolvedExchange;
      } catch {
        /* fall through — service handles missing symbol */
      }
    }
    return this.srEvidenceService.levelsFor(token, resolvedExchange, resolvedSymbol ?? '');
  }
```

- [ ] **Step 7: Type-check + commit**

Run: `cd apps/api && npx tsc --noEmit -p tsconfig.json 2>&1 | grep -E "sr-evidence|oi-wall|signal-generator.controller|signal-generator.module" | head`
Expected: no errors in the new/modified files (known pre-existing `@td/shared` standalone-tsc noise is unrelated — ignore).

```bash
git add apps/api/src/modules/signal-generator/services/sr-evidence.service.ts apps/api/src/modules/signal-generator/services/sr-evidence.service.spec.ts apps/api/src/modules/signal-generator/controllers/signal-generator.controller.ts apps/api/src/modules/signal-generator/signal-generator.module.ts
git commit -m "feat(sr): SrEvidenceService orchestration + /signals/sr-evidence endpoint"
```

---

## Task 6: Frontend `EvidenceLevel` type + `useSrEvidence` hook

**Files:**
- Modify: `apps/web/src/types/index.ts`
- Create: `apps/web/src/hooks/useSrEvidence.ts`

- [ ] **Step 1: Add the mirror type**

Append to `apps/web/src/types/index.ts`:
```ts
// Evidence-weighted S/R (mirrors apps/api .../types/evidence-level.types.ts).
export type EvidenceKind = 'VOLUME' | 'HISTORY' | 'OI_CALL' | 'OI_PUT' | 'ROUND';
export interface EvidenceLevel {
  price: number;
  side: 'resistance' | 'support';
  score: number;
  kinds: EvidenceKind[];
  soft: boolean;
  distancePct: number;
}
```

- [ ] **Step 2: Create the hook** (mirror `useZones.ts`)

Create `apps/web/src/hooks/useSrEvidence.ts`:
```ts
import { useState, useEffect, useCallback, useRef } from 'react';
import api from '@/services/api';
import type { EvidenceLevel } from '@/types';

interface UseSrEvidenceReturn {
  evidence: EvidenceLevel[];
  isLoading: boolean;
  error: Error | null;
  refetch: () => void;
}

const POLL_INTERVAL_MS = 60_000;

/** Polls /api/signals/sr-evidence every 60s. Mirrors useZones — empty array on
 * error, AbortController to drop stale in-flight responses on symbol switch. */
export function useSrEvidence(
  token: string | null,
  exchange: string | null,
): UseSrEvidenceReturn {
  const [evidence, setEvidence] = useState<EvidenceLevel[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<Error | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  const fetchEvidence = useCallback(async () => {
    if (!token || !exchange) {
      setEvidence([]); setIsLoading(false); setError(null);
      return;
    }
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    setIsLoading(true);
    try {
      const response = await api.get('/signals/sr-evidence', {
        params: { token, exchange },
        signal: controller.signal,
      });
      const payload = response.data;
      const candidate =
        (payload?.evidence as EvidenceLevel[] | undefined) ??
        (payload?.data as EvidenceLevel[] | undefined) ??
        payload;
      setEvidence(Array.isArray(candidate) ? candidate : []);
      setError(null);
    } catch (err) {
      const name = (err as { name?: string })?.name;
      const code = (err as { code?: string })?.code;
      if (name === 'CanceledError' || name === 'AbortError' || code === 'ERR_CANCELED') return;
      setError(err instanceof Error ? err : new Error('Failed to fetch sr-evidence'));
      setEvidence([]);
    } finally {
      if (abortRef.current === controller) setIsLoading(false);
    }
  }, [token, exchange]);

  useEffect(() => {
    if (!token || !exchange) {
      setEvidence([]); setError(null); setIsLoading(false);
      return;
    }
    fetchEvidence();
    const id = window.setInterval(fetchEvidence, POLL_INTERVAL_MS);
    return () => {
      window.clearInterval(id);
      abortRef.current?.abort();
      abortRef.current = null;
    };
  }, [fetchEvidence, token, exchange]);

  return { evidence, isLoading, error, refetch: fetchEvidence };
}
```

- [ ] **Step 3: Type-check + commit**

Run: `cd apps/web && npx tsc --noEmit -p tsconfig.json 2>&1 | grep -iE "useSrEvidence|types/index" | head`
Expected: no errors in the new files.

```bash
git add apps/web/src/types/index.ts apps/web/src/hooks/useSrEvidence.ts
git commit -m "feat(web): EvidenceLevel type + useSrEvidence hook"
```

---

## Task 7: Fold evidence into `buildSRView` (TDD)

**Files:**
- Modify: `apps/web/src/components/charts/buildSRView.ts`
- Modify: `apps/web/src/components/charts/buildSRView.test.ts`

Evidence levels arrive pre-scored and pre-sided. They join the candidate pool: a high-score evidence level (≥60) is `major`, the nearest each side is `immediate`, `soft` levels get a dedicated `soft` flag, the rest `context`.

- [ ] **Step 1: Add failing tests**

Add to `apps/web/src/components/charts/buildSRView.test.ts` (inside the describe, before the final `});`):
```ts
  it('folds an evidence resistance in when anchored/pivots are all below price', () => {
    const book: LevelBookLite = { ...emptyBook, pdh: 95, pdl: 90 };
    const evidence = [
      { price: 105, side: 'resistance' as const, score: 55, kinds: ['VOLUME' as const], soft: false, distancePct: 5 },
    ];
    const v = buildSRView(book, [], evidence, 100);
    expect(v.immediateResistance?.price).toBe(105);
    expect(v.immediateResistance?.source).toBe('EVIDENCE');
  });

  it('marks a soft evidence level with the soft tier', () => {
    const evidence = [
      { price: 110, side: 'resistance' as const, score: 0, kinds: ['ROUND' as const], soft: true, distancePct: 10 },
    ];
    const v = buildSRView(emptyBook, [], evidence, 100);
    const lvl = v.levels.find((l) => l.source === 'EVIDENCE')!;
    expect(lvl.tier).toBe('soft');
    expect(v.immediateResistance?.price).toBe(110);
  });

  it('a high-score (>=60) non-nearest evidence level is major', () => {
    const evidence = [
      { price: 101, side: 'resistance' as const, score: 40, kinds: ['VOLUME' as const], soft: false, distancePct: 1 },
      { price: 120, side: 'resistance' as const, score: 80, kinds: ['OI_CALL' as const], soft: false, distancePct: 20 },
    ];
    const v = buildSRView(emptyBook, [], evidence, 100);
    expect(v.immediateResistance?.price).toBe(101);
    expect(v.levels.find((l) => l.price === 120)!.tier).toBe('major');
  });
```
Also update the THREE existing call sites in this file that call `buildSRView(book, zones, ltp)` to `buildSRView(book, zones, [], ltp)` (insert the empty evidence arg). Search the test for `buildSRView(` and add `[]` before the ltp arg in each existing call.

- [ ] **Step 2: Run to verify the new tests fail**

Run: `cd apps/web && npx vitest run src/components/charts/buildSRView.test.ts`
Expected: the 3 new tests fail (signature mismatch / EVIDENCE source missing); existing pass after the `[]` arg edits.

- [ ] **Step 3: Extend `buildSRView.ts`**

In `apps/web/src/components/charts/buildSRView.ts`:
- Add `'EVIDENCE'` to `SRSource` and `'soft'` to `SRTier`:
```ts
export type SRSource = 'PDH' | 'PDL' | 'ORH' | 'ORL' | 'VWAP' | 'PIVOT' | 'EVIDENCE';
export type SRTier = 'immediate' | 'major' | 'context' | 'soft';
```
- Import the evidence type at the top:
```ts
import type { EvidenceLevel } from '@/types';
```
- Change the signature and add evidence to the candidate pool. Replace the function declaration line:
```ts
export function buildSRView(
  book: LevelBookLite | null,
  zones: StrongZone[],
  ltp: number,
): SRView {
```
with:
```ts
export function buildSRView(
  book: LevelBookLite | null,
  zones: StrongZone[],
  evidence: EvidenceLevel[],
  ltp: number,
): SRView {
```
- The internal `Candidate` interface gains optional carry-through fields. Find the `interface Candidate {` block and add:
```ts
  isSoft?: boolean;
  evScore?: number;
```
- After the pivot-collection loop (the `for (const z of zones)` block), add evidence candidates:
```ts
  // Evidence-weighted levels (volume nodes, OI walls, round confluence, soft
  // fallbacks) arrive pre-scored and pre-sided from the backend.
  for (const e of evidence) {
    candidates.push({
      price: e.price,
      source: 'EVIDENCE',
      label: e.soft ? 'ROUND' : e.kinds[0] ?? 'EVIDENCE',
      isStructural: !e.soft && e.score >= 60,
      isSoft: e.soft,
      evScore: e.score,
    });
  }
```
- In `toLevel`, make `soft` and high-score evidence tier correctly. Replace the `tier` computation line:
```ts
    const tier: SRTier = isImmediate ? 'immediate' : c.isStructural ? 'major' : 'context';
```
with:
```ts
    const tier: SRTier = c.isSoft
      ? 'soft'
      : isImmediate
        ? 'immediate'
        : c.isStructural
          ? 'major'
          : 'context';
```
(Note: a `soft` candidate keeps the `soft` tier even when it is the nearest — it is a low-confidence fallback, surfaced but not promoted to a confident `immediate`. `immediateResistance`/`immediateSupport` still point at it so the chip shows it.)

- [ ] **Step 4: Run to verify all pass**

Run: `cd apps/web && npx vitest run src/components/charts/buildSRView.test.ts`
Expected: all green (existing + 3 new).

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/components/charts/buildSRView.ts apps/web/src/components/charts/buildSRView.test.ts
git commit -m "feat(web): buildSRView folds evidence levels (volume/OI/round) + soft tier"
```

---

## Task 8: Wire the hook + draw evidence levels

**Files:**
- Create: `apps/web/src/components/charts/EvidenceLevelOverlay.tsx`
- Modify: `apps/web/src/pages/charts/ChartsPage.tsx`

- [ ] **Step 1: Create the overlay**

Create `apps/web/src/components/charts/EvidenceLevelOverlay.tsx`:
```tsx
import { useEffect, useMemo, useRef } from 'react';
import type { IPriceLine, ISeriesApi } from 'lightweight-charts';
import type { EvidenceLevel } from '@/types';

interface Props {
  candleSeries: ISeriesApi<'Candlestick'> | null;
  evidence: EvidenceLevel[];
}

/** Colour by the dominant evidence kind; soft levels are faint dotted. */
function styleFor(e: EvidenceLevel): { color: string; lineWidth: 1 | 2; lineStyle: 0 | 1 | 2 } {
  if (e.soft) return { color: '#94a3b8', lineWidth: 1, lineStyle: 1 }; // gray dotted (projected)
  const k = e.kinds[0];
  if (k === 'OI_CALL' || k === 'OI_PUT') return { color: '#d946ef', lineWidth: 2, lineStyle: 0 }; // magenta OI wall
  if (k === 'VOLUME') return { color: '#14b8a6', lineWidth: e.score >= 60 ? 2 : 1, lineStyle: 0 }; // teal volume shelf
  return { color: '#a3a3a3', lineWidth: 1, lineStyle: 2 }; // round/other dashed
}

function title(e: EvidenceLevel): string {
  const role = e.side === 'resistance' ? 'R' : 'S';
  const tag = e.soft ? 'PROJ' : e.kinds.includes('OI_CALL') || e.kinds.includes('OI_PUT') ? 'OI' : e.kinds[0];
  const price = e.price.toLocaleString('en-IN', { maximumFractionDigits: 2 });
  const sign = e.distancePct >= 0 ? '+' : '';
  return `${tag} ${role} ${price} (${sign}${e.distancePct.toFixed(1)}%)`;
}

function safeCreate(series: ISeriesApi<'Candlestick'>, opts: Parameters<ISeriesApi<'Candlestick'>['createPriceLine']>[0]): IPriceLine | null {
  try { return series.createPriceLine(opts); } catch { return null; }
}
function safeRemove(series: ISeriesApi<'Candlestick'>, line: IPriceLine): void {
  try { series.removePriceLine(line); } catch { /* disposed */ }
}

export default function EvidenceLevelOverlay({ candleSeries, evidence }: Props) {
  const linesRef = useRef<IPriceLine[]>([]);
  const drawKey = useMemo(
    () => evidence.map((e) => `${e.price}:${e.side}:${e.score}:${e.soft}:${e.distancePct.toFixed(1)}`).join('|'),
    [evidence],
  );

  useEffect(() => {
    if (!candleSeries) return;
    const series = candleSeries;
    for (const l of linesRef.current) safeRemove(series, l);
    linesRef.current = [];
    for (const e of evidence) {
      const s = styleFor(e);
      const line = safeCreate(series, {
        price: e.price, color: s.color, lineWidth: s.lineWidth, lineStyle: s.lineStyle,
        axisLabelVisible: true, title: title(e),
      });
      if (line) linesRef.current.push(line);
    }
    return () => {
      for (const l of linesRef.current) safeRemove(series, l);
      linesRef.current = [];
    };
    // evidence is captured via drawKey (stable across no-op re-renders).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [candleSeries, drawKey]);

  return null;
}
```

- [ ] **Step 2: Wire into ChartsPage**

In `apps/web/src/pages/charts/ChartsPage.tsx`:
- Imports (after the buildSRView import):
```tsx
import EvidenceLevelOverlay from '@/components/charts/EvidenceLevelOverlay';
import { useSrEvidence } from '@/hooks/useSrEvidence';
```
- After the `const { zones } = useZones(...)` call add:
```tsx
  const { evidence } = useSrEvidence(selectedSymbol.token, selectedSymbol.exchange);
```
- Update the `srView` memo to pass evidence (it currently calls `buildSRView(analysis?.levels ?? null, zones, ltp)`):
```tsx
  const srView = useMemo(
    () => buildSRView(analysis?.levels ?? null, zones, evidence, ltp),
    [analysis?.levels, zones, evidence, ltp],
  );
```
- Mount the overlay right after the existing `ChartZoneOverlay` mount block:
```tsx
          {timeframe === '15m' && ltp > 0 && (
            <EvidenceLevelOverlay
              candleSeries={chartRef.current?.candleSeries ?? null}
              evidence={evidence}
            />
          )}
```

- [ ] **Step 3: Type-check + commit**

Run: `cd apps/web && npx tsc --noEmit -p tsconfig.json 2>&1 | grep -iE "EvidenceLevelOverlay|ChartsPage" | head`
Expected: no errors in the modified files.

```bash
git add apps/web/src/components/charts/EvidenceLevelOverlay.tsx apps/web/src/pages/charts/ChartsPage.tsx
git commit -m "feat(web): draw evidence levels + feed them into the S/R chip"
```

---

## Task 9: End-to-end verification

**Files:** none.

- [ ] **Step 1: All new tests green**

Run: `cd apps/api && npx jest adaptive-round-numbers volume-profile sr-evidence-scoring oi-wall.service sr-evidence.service 2>&1 | grep -E "Tests:"`
Run: `cd apps/web && npx vitest run src/components/charts/buildSRView.test.ts 2>&1 | grep -E "Tests"`
Expected: all green.

- [ ] **Step 2: Restart API (load new endpoint)**

The API runs under `nest start --watch`; touch a source file to force a rebuild:
Run: `cd "C:/Users/AryanKumar/Desktop/TD_Automation" && touch apps/api/src/main.ts`
Then poll until the endpoint responds:
Run: `curl -s "http://127.0.0.1:4001/api/signals/sr-evidence?token=18520&exchange=NSE&symbol=CUPID-EQ"` (retry for ~40s while it rebuilds)

- [ ] **Step 3: CUPID — the target case**

`curl -s "http://127.0.0.1:4001/api/signals/sr-evidence?token=18520&exchange=NSE&symbol=CUPID-EQ"` →
Expect a JSON array; confirm there is at least one `side:"resistance"` level (a volume node above, or a `soft:true` round number) — i.e. CUPID is no longer resistance-less. Note any naked round number is NOT present unless corroborated.

- [ ] **Step 4: NIFTY — OI walls**

`curl -s "http://127.0.0.1:4001/api/signals/sr-evidence?token=99926000&exchange=NSE&symbol=NIFTY"` →
Expect levels including `kinds` containing `OI_CALL` (resistance) and `OI_PUT` (support) IF an option-chain snapshot exists. If the chain snapshot is stale/empty, note it (OI tracker captures during market hours).

- [ ] **Step 5: Visual (user)**

Open `http://localhost:4000/charts?symbol=CUPID&token=18520&exchange=NSE&tf=15m`. Confirm: the chip shows `R …· S …` (with a PROJ/soft resistance if blue-sky); teal volume-shelf lines; on NIFTY, magenta OI-wall lines. No naked round-number clutter.

- [ ] **Step 6: Confirm no backend regression to existing zones/analyze**

`curl -s "http://127.0.0.1:4001/api/signals/zones?token=2885&exchange=NSE&symbol=RELIANCE-EQ"` still returns zones (the new service is additive).

---

## Self-Review (completed during planning)
- **Spec coverage:** volume profile → Task 2; adaptive round numbers → Task 1; OI walls → Task 4; scoring/clustering/floor/soft-fallback → Task 3; orchestration + endpoint → Task 5; frontend hook/type → Task 6; buildSRView fold-in + soft tier → Task 7; overlay + chip wiring → Task 8; CUPID + NIFTY verification → Task 9. All spec sections mapped.
- **Placeholder scan:** none — every step has complete code/commands.
- **Type consistency:** `EvidenceLevel` (price/side/score/kinds/soft/distancePct) defined in Task 3, mirrored in Task 6, consumed in Tasks 7–8. `LevelCandidate` (price/kind/score) defined Task 3, produced by Tasks 2/4 and the orchestrator (Task 5), consumed by `scoreAndCluster`. `ProfileCandle` (high/low/close/volume) defined Task 2, produced by Task 5's `fetch5mCandles`. `scoreAndCluster(candidates, ltp, atr14, { softRoundGrid })` signature consistent between Task 3 def and Task 5 call. `buildSRView(book, zones, evidence, ltp)` new 4-arg signature defined Task 7, called in Task 8 — and Task 7 Step 1 updates the existing test call sites to match.
- **Note:** Task 7 changes `buildSRView`'s arity — the only other caller is `ChartsPage` (updated in Task 8). No other consumers exist.
