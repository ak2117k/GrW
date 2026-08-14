# Trade Sentinel — Stage 0 (Shadow Mode) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the Trade Sentinel observer so it runs live against real Angel One positions, records what it *would* have done, and places no orders.

**Architecture:** A new NestJS module `trade-sentinel`. Cheap pure-function tripwires ride the existing `trade-tracker` poller and detect *change*; when one fires (or a heartbeat is due) a context packet is assembled from existing services and handed to an LLM agent, which returns a schema-validated verdict. Verdict + packet are persisted. No executor, no veto window, no orders, no chart overlay — those are Stage 1+.

**Tech Stack:** NestJS 11, Prisma 6 (PostgreSQL), Jest, TypeScript, `@anthropic-ai/sdk` (new dependency), `@nestjs/schedule`.

**Spec:** `docs/superpowers/specs/2026-08-14-trade-sentinel-agent-design.md` — read it alongside this plan.

## Global Constraints

- All application code lives under `apps/api/src/modules/trade-sentinel/`. Shared types go in `packages/shared` only if consumed by the frontend (Stage 0: none are).
- **Stage 0 places no orders and calls no broker write API.** No import of `TradeExecutionService`, no `placeOrder`, no `squareOffAll`.
- Files: kebab-case. Classes: PascalCase. Functions: camelCase. Constants: SCREAMING_SNAKE. DB tables: snake_case via `@@map`.
- Prisma models live in `prisma/schema.prisma` (repo root). Migrations: `npm run db:migrate`.
- Tests: Jest, colocated as `*.spec.ts` next to the unit under test, or in a `__tests__/` subdirectory — both patterns exist in this repo; follow the neighbouring module.
- Run tests from the repo root with `npx jest --config apps/api/jest.config.js <path>` or `cd apps/api && npx jest <path>`.
- Model ID is exactly `claude-opus-5`. Do not append a date suffix.
- Missing inputs are represented as an explicit `{ available: false, reason: string }` — never a zero, never an omitted key (convention from commit `34e1268`).
- Max 5 watched positions (`SENTINEL_MAX_WATCHED = 5`). A 6th is recorded as `UNWATCHED`, never silently dropped.
- Every agent call and every commit must be attributable: verdicts store `promptVersion`.

---

## File Structure

| File | Responsibility |
|---|---|
| `prisma/schema.prisma` (modify) | `SentinelThesis`, `SentinelVerdict`, `OiWallSnapshot` models |
| `charges.ts` | Pure charge model + green-floor math |
| `tripwires/types.ts` | `TripwireInput`, `TripwireFire`, `Tripwire` interface |
| `tripwires/giveback-off-peak.tripwire.ts` | MFE-giveback sensor |
| `tripwires/level-break.tripwire.ts` | S/R break sensor |
| `tripwires/volume-anomaly.tripwire.ts` | Volume-vs-average sensor |
| `tripwires/oi-wall-shift.tripwire.ts` | OI wall movement sensor (uses new snapshots) |
| `tripwires/news-hit.tripwire.ts` | Recent-news sensor |
| `tripwires/context-factor-flip.tripwire.ts` | Real (non-stub) factor sign flip sensor |
| `services/tripwire.service.ts` | Runs all sensors, applies heartbeat |
| `services/roster.service.ts` | Selects ≤5 watched positions, resolves ownership |
| `services/oi-wall-snapshot.service.ts` | Persists successive OI wall snapshots |
| `services/context-packet.service.ts` | Assembles the evidence packet |
| `services/thesis.service.ts` | Infers / stores / corrects entry thesis |
| `services/sentinel-agent.service.ts` | Anthropic call + schema validation |
| `services/sentinel-cycle.service.ts` | Orchestrates roster → tripwire → packet → agent → record |
| `repositories/sentinel-verdict.repository.ts` | Verdict + packet persistence |
| `repositories/sentinel-thesis.repository.ts` | Thesis persistence |
| `controllers/sentinel.controller.ts` | `GET /` verdicts, `POST /thesis/:id` correction |
| `dto/sentinel.dto.ts` | Wire shapes |
| `trade-sentinel.module.ts` | Module wiring |

---

## Task 1: Prisma models and migration

**Files:**
- Modify: `prisma/schema.prisma`
- Create: `apps/api/src/modules/trade-sentinel/repositories/sentinel-verdict.repository.ts`
- Test: `apps/api/src/modules/trade-sentinel/repositories/sentinel-verdict.repository.spec.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: Prisma models `SentinelThesis`, `SentinelVerdict`, `OiWallSnapshot`; class `SentinelVerdictRepository` with `record(input: RecordVerdictInput): Promise<SentinelVerdict>`, `listForUser(userId: string, limit: number): Promise<SentinelVerdict[]>`, `recentForTracker(trackerId: string, limit: number): Promise<SentinelVerdict[]>`.

- [ ] **Step 1: Add the three models to the schema**

Append to `prisma/schema.prisma` (place near `TradeTracker`, around line 1583):

```prisma
model SentinelThesis {
  id            String   @id @default(cuid())
  userId        String
  trackerId     String   @unique
  direction     String   // 'LONG' | 'SHORT'
  reason        String
  levelPrice    Float?
  targetPrice   Float?
  invalidation  Float?
  source        String   @default("INFERRED") // 'INFERRED' | 'USER'
  createdAt     DateTime @default(now())
  updatedAt     DateTime @updatedAt

  @@index([userId])
  @@map("sentinel_theses")
}

model SentinelVerdict {
  id             String   @id @default(cuid())
  userId         String
  trackerId      String
  symbol         String
  verdict        String   // 'HOLD' | 'EXIT_ARMED' | 'EXIT_NOW' | 'ESCALATE'
  confidence     String   // 'low' | 'medium' | 'high'
  thesisStatus   String   // 'INTACT' | 'WEAKENING' | 'BROKEN'
  recoveryAvailable Boolean
  reason         String
  evidence       Json
  invalidationPoint String?
  reviewInSec    Int
  packet         Json     // the full context packet, verbatim
  promptVersion  String
  triggeredBy    Json     // tripwire names that fired, or ["heartbeat"]
  netPnl         Float
  greenFloor     Float?
  createdAt      DateTime @default(now())

  @@index([userId, createdAt])
  @@index([trackerId, createdAt])
  @@map("sentinel_verdicts")
}

model OiWallSnapshot {
  id           String   @id @default(cuid())
  symbol       String
  expiry       String
  callWall     Float?
  putWall      Float?
  // Deliberately unset in Stage 0: OiWallService returns LevelCandidate
  // {price, kind, score} and discards the raw OI, so nothing can fill these
  // honestly. Populate from OptionsChainService if ever needed — never from
  // `score`, which is a rank weight (30/20), not open interest.
  callWallOi   Float?
  putWallOi    Float?
  capturedAt   DateTime @default(now())

  @@index([symbol, capturedAt])
  @@map("oi_wall_snapshots")
}
```

- [ ] **Step 2: Generate the migration and the client**

Run: `npm run db:migrate -- --name trade_sentinel_stage0`
Then: `npm run db:generate`
Expected: migration created under `prisma/migrations/`, `@prisma/client` regenerated with the three new models.

- [ ] **Step 3: Write the failing repository test**

Create `apps/api/src/modules/trade-sentinel/repositories/sentinel-verdict.repository.spec.ts`:

```typescript
import { SentinelVerdictRepository } from './sentinel-verdict.repository';

describe('SentinelVerdictRepository', () => {
  const create = jest.fn();
  const findMany = jest.fn();
  const prisma = { sentinelVerdict: { create, findMany } } as any;
  const repo = new SentinelVerdictRepository(prisma);

  beforeEach(() => jest.clearAllMocks());

  it('stores the packet verbatim alongside the verdict', async () => {
    const packet = { position: { symbol: 'INFY' }, oi: { available: false, reason: 'no chain' } };
    create.mockResolvedValue({ id: 'v1' });

    await repo.record({
      userId: 'u1',
      trackerId: 't1',
      symbol: 'INFY',
      verdict: 'HOLD',
      confidence: 'high',
      thesisStatus: 'INTACT',
      recoveryAvailable: true,
      reason: 'structure holding',
      evidence: ['structure.nearestSupport'],
      invalidationPoint: 'close below 1450',
      reviewInSec: 300,
      packet,
      promptVersion: 'v1',
      triggeredBy: ['heartbeat'],
      netPnl: 1200,
      greenFloor: 1455,
    });

    expect(create).toHaveBeenCalledWith({ data: expect.objectContaining({ packet }) });
  });

  it('returns the most recent verdicts for one tracker, newest first', async () => {
    findMany.mockResolvedValue([]);
    await repo.recentForTracker('t1', 3);
    expect(findMany).toHaveBeenCalledWith({
      where: { trackerId: 't1' },
      orderBy: { createdAt: 'desc' },
      take: 3,
    });
  });
});
```

- [ ] **Step 4: Run it and watch it fail**

Run: `cd apps/api && npx jest src/modules/trade-sentinel/repositories/sentinel-verdict.repository.spec.ts`
Expected: FAIL — `Cannot find module './sentinel-verdict.repository'`.

- [ ] **Step 5: Implement the repository**

Create `apps/api/src/modules/trade-sentinel/repositories/sentinel-verdict.repository.ts`:

```typescript
import { Injectable } from '@nestjs/common';
import type { SentinelVerdict } from '@prisma/client';
import { PrismaService } from '../../../common/prisma/prisma.service';

/** Everything needed to persist one agent decision together with the evidence it saw. */
export interface RecordVerdictInput {
  userId: string;
  trackerId: string;
  symbol: string;
  verdict: 'HOLD' | 'EXIT_ARMED' | 'EXIT_NOW' | 'ESCALATE';
  confidence: 'low' | 'medium' | 'high';
  thesisStatus: 'INTACT' | 'WEAKENING' | 'BROKEN';
  recoveryAvailable: boolean;
  reason: string;
  evidence: string[];
  invalidationPoint: string | null;
  reviewInSec: number;
  packet: unknown;
  promptVersion: string;
  triggeredBy: string[];
  netPnl: number;
  greenFloor: number | null;
}

/**
 * Verdicts are stored WITH the packet that produced them. That pairing is what
 * makes the agent replayable: a later prompt change can be re-run against the
 * exact evidence and the verdicts diffed.
 */
@Injectable()
export class SentinelVerdictRepository {
  constructor(private readonly prisma: PrismaService) {}

  async record(input: RecordVerdictInput): Promise<SentinelVerdict> {
    return this.prisma.sentinelVerdict.create({
      data: {
        userId: input.userId,
        trackerId: input.trackerId,
        symbol: input.symbol,
        verdict: input.verdict,
        confidence: input.confidence,
        thesisStatus: input.thesisStatus,
        recoveryAvailable: input.recoveryAvailable,
        reason: input.reason,
        evidence: input.evidence as never,
        invalidationPoint: input.invalidationPoint,
        reviewInSec: input.reviewInSec,
        packet: input.packet as never,
        promptVersion: input.promptVersion,
        triggeredBy: input.triggeredBy as never,
        netPnl: input.netPnl,
        greenFloor: input.greenFloor,
      },
    });
  }

  async listForUser(userId: string, limit: number): Promise<SentinelVerdict[]> {
    return this.prisma.sentinelVerdict.findMany({
      where: { userId },
      orderBy: { createdAt: 'desc' },
      take: limit,
    });
  }

  async recentForTracker(trackerId: string, limit: number): Promise<SentinelVerdict[]> {
    return this.prisma.sentinelVerdict.findMany({
      where: { trackerId },
      orderBy: { createdAt: 'desc' },
      take: limit,
    });
  }
}
```

- [ ] **Step 6: Run the test and watch it pass**

Run: `cd apps/api && npx jest src/modules/trade-sentinel/repositories/sentinel-verdict.repository.spec.ts`
Expected: PASS, 2 tests.

- [ ] **Step 7: Commit**

```bash
git add prisma/schema.prisma prisma/migrations apps/api/src/modules/trade-sentinel/repositories
git commit -m "feat(sentinel): persist verdicts with the evidence that produced them"
```

---

## Task 2: Charge model and the green floor

**Files:**
- Create: `apps/api/src/modules/trade-sentinel/charges.ts`
- Test: `apps/api/src/modules/trade-sentinel/charges.spec.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `estimateCharges(input: ChargeInput): number`, `computeGreenFloor(input: GreenFloorInput): GreenFloor`, constant `GREEN_FLOOR_MARGIN_RUPEES`.

- [ ] **Step 1: Write the failing test**

Create `apps/api/src/modules/trade-sentinel/charges.spec.ts`:

```typescript
import { estimateCharges, computeGreenFloor, GREEN_FLOOR_MARGIN_RUPEES } from './charges';

describe('estimateCharges', () => {
  it('charges an equity delivery round trip on turnover, not on quantity alone', () => {
    const small = estimateCharges({ segment: 'EQ_DELIVERY', entryPrice: 100, exitPrice: 100, qty: 10 });
    const large = estimateCharges({ segment: 'EQ_DELIVERY', entryPrice: 100, exitPrice: 100, qty: 100 });
    expect(large).toBeGreaterThan(small);
  });

  it('never returns a negative charge for a losing trade', () => {
    expect(estimateCharges({ segment: 'EQ_INTRADAY', entryPrice: 100, exitPrice: 50, qty: 10 })).toBeGreaterThan(0);
  });

  it('applies the flat per-order brokerage cap for intraday', () => {
    const huge = estimateCharges({ segment: 'EQ_INTRADAY', entryPrice: 10000, exitPrice: 10000, qty: 1000 });
    // 2 orders x Rs 20 cap = Rs 40 brokerage; the rest is statutory, so the
    // total must exceed 40 but brokerage must not scale without bound.
    expect(huge).toBeGreaterThan(40);
  });
});

describe('computeGreenFloor', () => {
  it('is not armed until net P&L clears charges plus the margin', () => {
    const floor = computeGreenFloor({
      segment: 'EQ_INTRADAY', entryPrice: 100, ltp: 100.1, qty: 100, side: 'LONG',
    });
    expect(floor.armed).toBe(false);
  });

  it('arms once net P&L clears charges plus the margin, and reports the floor price', () => {
    const floor = computeGreenFloor({
      segment: 'EQ_INTRADAY', entryPrice: 100, ltp: 140, qty: 100, side: 'LONG',
    });
    expect(floor.armed).toBe(true);
    expect(floor.floorPrice).toBeGreaterThan(100);
    expect(floor.floorPrice).toBeLessThan(140);
  });

  it('puts a SHORT floor above the entry price', () => {
    const floor = computeGreenFloor({
      segment: 'EQ_INTRADAY', entryPrice: 100, ltp: 60, qty: 100, side: 'SHORT',
    });
    expect(floor.armed).toBe(true);
    expect(floor.floorPrice).toBeGreaterThan(60);
    expect(floor.floorPrice).toBeLessThan(100);
  });

  it('exposes the margin it used so the packet can state it', () => {
    const floor = computeGreenFloor({
      segment: 'EQ_INTRADAY', entryPrice: 100, ltp: 140, qty: 100, side: 'LONG',
    });
    expect(floor.marginRupees).toBe(GREEN_FLOOR_MARGIN_RUPEES);
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `cd apps/api && npx jest src/modules/trade-sentinel/charges.spec.ts`
Expected: FAIL — `Cannot find module './charges'`.

- [ ] **Step 3: Implement the charge model**

Create `apps/api/src/modules/trade-sentinel/charges.ts`:

```typescript
/**
 * Charge model for Indian equity/F&O round trips, and the "green floor" derived
 * from it.
 *
 * The floor is the price at which the trade's NET P&L (after every statutory and
 * broker charge) equals the charges plus a safety margin. Once unrealised net
 * P&L clears that bar the floor ARMS: from then on the trade must not be allowed
 * back into the red. This is deliberately arithmetic, not judgment — the agent
 * decides when to take MORE than the floor, never whether the floor applies.
 *
 * Rates are Angel One / exchange published values as of 2026-08. They are
 * approximations for decision-making, not a contract-note reconciliation.
 */

export type Segment = 'EQ_DELIVERY' | 'EQ_INTRADAY' | 'FUT' | 'OPT';
export type Side = 'LONG' | 'SHORT';

/** Cushion above breakeven before the floor arms, so noise can't un-arm it. */
export const GREEN_FLOOR_MARGIN_RUPEES = 150;

const BROKERAGE_FLAT = 20; // Rs per executed order, capped
const BROKERAGE_PCT = 0.0003; // 0.03% for intraday/futures, whichever is lower
const GST = 0.18;

interface Rates {
  /** Securities Transaction Tax, charged on the sell side only unless noted. */
  sttSell: number;
  sttBuy: number;
  exchangeTxn: number;
  stampBuy: number;
  brokerageFree: boolean;
}

const RATES: Record<Segment, Rates> = {
  EQ_DELIVERY: { sttSell: 0.001, sttBuy: 0.001, exchangeTxn: 0.0000297, stampBuy: 0.00015, brokerageFree: true },
  EQ_INTRADAY: { sttSell: 0.00025, sttBuy: 0, exchangeTxn: 0.0000297, stampBuy: 0.00003, brokerageFree: false },
  FUT: { sttSell: 0.0002, sttBuy: 0, exchangeTxn: 0.0000173, stampBuy: 0.00002, brokerageFree: false },
  OPT: { sttSell: 0.001, sttBuy: 0, exchangeTxn: 0.0003503, stampBuy: 0.00003, brokerageFree: false },
};

export interface ChargeInput {
  segment: Segment;
  entryPrice: number;
  exitPrice: number;
  qty: number;
}

/** Total round-trip charges in rupees. Always >= 0. */
export function estimateCharges({ segment, entryPrice, exitPrice, qty }: ChargeInput): number {
  const r = RATES[segment];
  const buyTurnover = Math.abs(entryPrice * qty);
  const sellTurnover = Math.abs(exitPrice * qty);
  const turnover = buyTurnover + sellTurnover;

  // Options brokerage is flat per order; everything else takes the lower of
  // flat-vs-percentage, which is how discount brokers actually bill.
  const perOrder = segment === 'OPT'
    ? BROKERAGE_FLAT
    : Math.min(BROKERAGE_FLAT, Math.max(buyTurnover, sellTurnover) * BROKERAGE_PCT);
  const brokerage = r.brokerageFree ? 0 : perOrder * 2;

  const stt = sellTurnover * r.sttSell + buyTurnover * r.sttBuy;
  const exchange = turnover * r.exchangeTxn;
  const stamp = buyTurnover * r.stampBuy;
  const sebi = turnover * 0.000001;
  const gst = (brokerage + exchange + sebi) * GST;

  return brokerage + stt + exchange + stamp + sebi + gst;
}

export interface GreenFloorInput {
  segment: Segment;
  entryPrice: number;
  ltp: number;
  qty: number;
  side: Side;
}

export interface GreenFloor {
  /** True once net P&L has cleared charges + margin at least once this evaluation. */
  armed: boolean;
  /** The price at which net P&L equals the margin. Null if qty is zero. */
  floorPrice: number | null;
  netPnl: number;
  charges: number;
  marginRupees: number;
}

/**
 * Net P&L and the price that locks it in. `armed` is computed from the CURRENT
 * ltp only; the caller is responsible for latching it (once armed, always armed
 * for that position) — the ratchet is state, and this function stays pure.
 */
export function computeGreenFloor({ segment, entryPrice, ltp, qty, side }: GreenFloorInput): GreenFloor {
  const dir = side === 'LONG' ? 1 : -1;
  const charges = estimateCharges({ segment, entryPrice, exitPrice: ltp, qty });
  const gross = (ltp - entryPrice) * qty * dir;
  const netPnl = gross - charges;

  if (qty === 0) {
    return { armed: false, floorPrice: null, netPnl, charges, marginRupees: GREEN_FLOOR_MARGIN_RUPEES };
  }

  // Price at which gross P&L covers charges + margin.
  const needed = charges + GREEN_FLOOR_MARGIN_RUPEES;
  const floorPrice = entryPrice + (needed / qty) * dir;

  return {
    armed: netPnl >= GREEN_FLOOR_MARGIN_RUPEES,
    floorPrice,
    netPnl,
    charges,
    marginRupees: GREEN_FLOOR_MARGIN_RUPEES,
  };
}
```

- [ ] **Step 4: Run the test and watch it pass**

Run: `cd apps/api && npx jest src/modules/trade-sentinel/charges.spec.ts`
Expected: PASS, 7 tests.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/modules/trade-sentinel/charges.ts apps/api/src/modules/trade-sentinel/charges.spec.ts
git commit -m "feat(sentinel): charge-aware green floor, the one number the agent cannot vote on"
```

---

## Task 3: Tripwire contract and the giveback sensor

**Files:**
- Create: `apps/api/src/modules/trade-sentinel/tripwires/types.ts`
- Create: `apps/api/src/modules/trade-sentinel/tripwires/giveback-off-peak.tripwire.ts`
- Test: `apps/api/src/modules/trade-sentinel/tripwires/giveback-off-peak.tripwire.spec.ts`

**Interfaces:**
- Consumes: `computeGreenFloor` from Task 2.
- Produces: `TripwireInput`, `TripwireFire`, `Tripwire` (all in `types.ts`); `givebackOffPeak: Tripwire`.

- [ ] **Step 1: Write the contract**

Create `apps/api/src/modules/trade-sentinel/tripwires/types.ts`:

```typescript
import type { Segment, Side } from '../charges';

/**
 * What every sensor sees. Deliberately narrow: a tripwire may only look at data
 * the poller already has, because tripwires run on EVERY tick for every watched
 * position and must stay free.
 */
export interface TripwireInput {
  trackerId: string;
  symbol: string;
  segment: Segment;
  side: Side;
  entryPrice: number;
  qty: number;
  ltp: number;
  holdingHigh: number | null;
  holdingLow: number | null;
  /** Nearest support/resistance from the level book, if the symbol has one. */
  nearestSupport: number | null;
  nearestResistance: number | null;
  /** Session volume vs the 20-day average, as a ratio. Null when unavailable. */
  volumeRatio: number | null;
  /** Current OI walls and the previous snapshot, for shift detection. */
  oiWallNow: { callWall: number | null; putWall: number | null } | null;
  oiWallPrev: { callWall: number | null; putWall: number | null } | null;
  /** Headline count for this symbol in the last 30 minutes. */
  freshNewsCount: number | null;
  /** Non-stub context factors, keyed by factor name, value in [-1, 1]. */
  factorValues: Record<string, number>;
  /** The same factors as of the previous evaluation, for flip detection. */
  prevFactorValues: Record<string, number>;
}

/** A sensor firing. It reports WHAT CHANGED — never what to do about it. */
export interface TripwireFire {
  name: string;
  detail: string;
}

export interface Tripwire {
  readonly name: string;
  /** Returns a fire, or null when nothing noteworthy changed. */
  check(input: TripwireInput): TripwireFire | null;
}
```

- [ ] **Step 2: Write the failing test**

Create `apps/api/src/modules/trade-sentinel/tripwires/giveback-off-peak.tripwire.spec.ts`:

```typescript
import { givebackOffPeak, GIVEBACK_FRACTION } from './giveback-off-peak.tripwire';
import type { TripwireInput } from './types';

const base: TripwireInput = {
  trackerId: 't1', symbol: 'INFY', segment: 'EQ_INTRADAY', side: 'LONG',
  entryPrice: 100, qty: 100, ltp: 100,
  holdingHigh: 100, holdingLow: 100,
  nearestSupport: null, nearestResistance: null,
  volumeRatio: null, oiWallNow: null, oiWallPrev: null,
  freshNewsCount: null, factorValues: {}, prevFactorValues: {},
};

describe('givebackOffPeak', () => {
  it('stays silent when the trade never went favourably', () => {
    expect(givebackOffPeak.check({ ...base, holdingHigh: 100, ltp: 95 })).toBeNull();
  });

  it('stays silent while the trade is still near its peak', () => {
    expect(givebackOffPeak.check({ ...base, holdingHigh: 120, ltp: 119 })).toBeNull();
  });

  it('fires when a long gives back more than the threshold fraction of its peak gain', () => {
    // Peak gain 20/share; giving back 60% leaves ltp at 108.
    const fire = givebackOffPeak.check({ ...base, holdingHigh: 120, ltp: 108 });
    expect(fire).not.toBeNull();
    expect(fire!.name).toBe('giveback-off-peak');
    expect(fire!.detail).toMatch(/gave back/i);
  });

  it('fires for a short measured off holdingLow', () => {
    const fire = givebackOffPeak.check({
      ...base, side: 'SHORT', holdingLow: 80, holdingHigh: 100, ltp: 92,
    });
    expect(fire).not.toBeNull();
  });

  it('uses a fraction strictly between 0 and 1', () => {
    expect(GIVEBACK_FRACTION).toBeGreaterThan(0);
    expect(GIVEBACK_FRACTION).toBeLessThan(1);
  });
});
```

- [ ] **Step 3: Run it and watch it fail**

Run: `cd apps/api && npx jest src/modules/trade-sentinel/tripwires/giveback-off-peak.tripwire.spec.ts`
Expected: FAIL — `Cannot find module './giveback-off-peak.tripwire'`.

- [ ] **Step 4: Implement the sensor**

Create `apps/api/src/modules/trade-sentinel/tripwires/giveback-off-peak.tripwire.ts`:

```typescript
import type { Tripwire, TripwireFire, TripwireInput } from './types';

/**
 * Fraction of peak favourable excursion that must be surrendered before this
 * sensor speaks. Deliberately loose: a sensor's job is "look at this", not
 * "sell this", so a false alarm costs one agent call, not a trade.
 */
export const GIVEBACK_FRACTION = 0.4;

/**
 * MFE giveback: the trade WAS up, and has since surrendered a meaningful share
 * of that gain. Measured off holdingHigh for longs and holdingLow for shorts —
 * the running extremes the trade-tracker already maintains per tick.
 */
export const givebackOffPeak: Tripwire = {
  name: 'giveback-off-peak',

  check(input: TripwireInput): TripwireFire | null {
    const { side, entryPrice, ltp, holdingHigh, holdingLow } = input;
    const peak = side === 'LONG' ? holdingHigh : holdingLow;
    if (peak === null) return null;

    const dir = side === 'LONG' ? 1 : -1;
    const peakGain = (peak - entryPrice) * dir;
    if (peakGain <= 0) return null; // never went right — a different sensor's problem

    const currentGain = (ltp - entryPrice) * dir;
    const givenBack = peakGain - currentGain;
    if (givenBack < peakGain * GIVEBACK_FRACTION) return null;

    const pct = Math.round((givenBack / peakGain) * 100);
    return {
      name: 'giveback-off-peak',
      detail: `gave back ${pct}% of peak excursion (peak ${peak}, now ${ltp}, entry ${entryPrice})`,
    };
  },
};
```

- [ ] **Step 5: Run the test and watch it pass**

Run: `cd apps/api && npx jest src/modules/trade-sentinel/tripwires/giveback-off-peak.tripwire.spec.ts`
Expected: PASS, 5 tests.

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/modules/trade-sentinel/tripwires
git commit -m "feat(sentinel): tripwire contract, and the giveback sensor that opens it"
```

---

## Task 4: Level-break and volume-anomaly sensors

**Files:**
- Create: `apps/api/src/modules/trade-sentinel/tripwires/level-break.tripwire.ts`
- Create: `apps/api/src/modules/trade-sentinel/tripwires/volume-anomaly.tripwire.ts`
- Test: `apps/api/src/modules/trade-sentinel/tripwires/level-break.tripwire.spec.ts`
- Test: `apps/api/src/modules/trade-sentinel/tripwires/volume-anomaly.tripwire.spec.ts`

**Interfaces:**
- Consumes: `Tripwire`, `TripwireInput`, `TripwireFire` from `./types`.
- Produces: `levelBreak: Tripwire`, `volumeAnomaly: Tripwire`, `VOLUME_SPIKE_RATIO`.

- [ ] **Step 1: Write both failing tests**

Create `apps/api/src/modules/trade-sentinel/tripwires/level-break.tripwire.spec.ts`:

```typescript
import { levelBreak } from './level-break.tripwire';
import type { TripwireInput } from './types';

const base: TripwireInput = {
  trackerId: 't1', symbol: 'INFY', segment: 'EQ_INTRADAY', side: 'LONG',
  entryPrice: 100, qty: 100, ltp: 100, underlyingLtp: 100,
  holdingHigh: null, holdingLow: null,
  nearestSupport: 95, nearestResistance: 110,
  volumeRatio: null, oiWallNow: null, oiWallPrev: null,
  freshNewsCount: null, factorValues: {}, prevFactorValues: {},
};

describe('levelBreak', () => {
  it('stays silent inside the range', () => {
    expect(levelBreak.check({ ...base, ltp: 102 })).toBeNull();
  });

  it('fires when a long loses its nearest support', () => {
    const fire = levelBreak.check({ ...base, ltp: 94 });
    expect(fire?.name).toBe('level-break');
    expect(fire?.detail).toMatch(/support/i);
  });

  it('fires when a short loses its nearest resistance', () => {
    const fire = levelBreak.check({ ...base, side: 'SHORT', ltp: 112 });
    expect(fire?.detail).toMatch(/resistance/i);
  });

  it('stays silent when the symbol has no level book', () => {
    expect(levelBreak.check({ ...base, nearestSupport: null, nearestResistance: null, ltp: 1 })).toBeNull();
  });

  // SCALE HAZARD regression. An option's `ltp` is the premium (~120) while its
  // levels are strikes (~24000). Comparing the premium against a strike breaches
  // permanently, so this sensor would fire on EVERY tick for the life of the
  // position. Both tests below fail if the implementation reads `ltp`.
  it('compares the underlying against the level, not the option premium', () => {
    const optionHoldingUp = {
      ...base,
      segment: 'OPT' as const,
      ltp: 120,              // premium — far below the strike, but irrelevant here
      underlyingLtp: 24500,  // underlying is comfortably above support
      nearestSupport: 24000,
      nearestResistance: 24800,
    };
    expect(levelBreak.check(optionHoldingUp)).toBeNull();
  });

  it('stays silent when the underlying price cannot be resolved', () => {
    expect(levelBreak.check({ ...base, underlyingLtp: null, nearestSupport: 95, ltp: 1 })).toBeNull();
  });
});
```

Create `apps/api/src/modules/trade-sentinel/tripwires/volume-anomaly.tripwire.spec.ts`:

```typescript
import { volumeAnomaly, VOLUME_SPIKE_RATIO } from './volume-anomaly.tripwire';
import type { TripwireInput } from './types';

const base: TripwireInput = {
  trackerId: 't1', symbol: 'INFY', segment: 'EQ_INTRADAY', side: 'LONG',
  entryPrice: 100, qty: 100, ltp: 100, underlyingLtp: 100,
  holdingHigh: null, holdingLow: null,
  nearestSupport: null, nearestResistance: null,
  volumeRatio: 1, oiWallNow: null, oiWallPrev: null,
  freshNewsCount: null, factorValues: {}, prevFactorValues: {},
};

describe('volumeAnomaly', () => {
  it('stays silent at normal volume', () => {
    expect(volumeAnomaly.check({ ...base, volumeRatio: 1.2 })).toBeNull();
  });

  it('fires on a volume spike', () => {
    const fire = volumeAnomaly.check({ ...base, volumeRatio: VOLUME_SPIKE_RATIO + 0.5 });
    expect(fire?.name).toBe('volume-anomaly');
  });

  it('stays silent — not fires — when volume data is unavailable', () => {
    expect(volumeAnomaly.check({ ...base, volumeRatio: null })).toBeNull();
  });
});
```

- [ ] **Step 2: Run both and watch them fail**

Run: `cd apps/api && npx jest src/modules/trade-sentinel/tripwires/level-break src/modules/trade-sentinel/tripwires/volume-anomaly`
Expected: FAIL — both modules not found.

- [ ] **Step 3: Implement level-break**

Create `apps/api/src/modules/trade-sentinel/tripwires/level-break.tripwire.ts`:

```typescript
import type { Tripwire, TripwireFire, TripwireInput } from './types';

/**
 * Price has crossed the level that was standing between the position and
 * trouble: nearest support for a long, nearest resistance for a short.
 *
 * A symbol with no level book (illiquid, or not covered by the level service)
 * yields null rather than firing — an absent level is not a broken level.
 */
export const levelBreak: Tripwire = {
  name: 'level-break',

  check({ side, underlyingLtp, nearestSupport, nearestResistance }: TripwireInput): TripwireFire | null {
    // SCALE HAZARD: levels live on the UNDERLYING's scale. For an option, `ltp`
    // is the premium (~120) while a level is a strike (~24000) — comparing them
    // breaches permanently and fires every tick. Compare against `underlyingLtp`,
    // and when it is null stay silent rather than falling back to `ltp`.
    if (underlyingLtp === null) return null;

    if (side === 'LONG') {
      if (nearestSupport === null) return null;
      if (underlyingLtp >= nearestSupport) return null;
      return { name: 'level-break', detail: `lost nearest support ${nearestSupport} (now ${underlyingLtp})` };
    }

    if (nearestResistance === null) return null;
    if (underlyingLtp <= nearestResistance) return null;
    return { name: 'level-break', detail: `lost nearest resistance ${nearestResistance} (now ${underlyingLtp})` };
  },
};
```

- [ ] **Step 4: Implement volume-anomaly**

Create `apps/api/src/modules/trade-sentinel/tripwires/volume-anomaly.tripwire.ts`:

```typescript
import type { Tripwire, TripwireFire, TripwireInput } from './types';

/** Session volume as a multiple of the 20-day average before this sensor speaks. */
export const VOLUME_SPIKE_RATIO = 2;

/**
 * Unusual participation. Volume alone says nothing about direction — that is
 * exactly why this is a sensor and not a rule: it tells the agent to look, and
 * the agent decides whether the surge is buyers or sellers.
 */
export const volumeAnomaly: Tripwire = {
  name: 'volume-anomaly',

  check({ volumeRatio }: TripwireInput): TripwireFire | null {
    if (volumeRatio === null) return null;
    if (volumeRatio < VOLUME_SPIKE_RATIO) return null;
    return {
      name: 'volume-anomaly',
      detail: `volume ${volumeRatio.toFixed(1)}x the 20-day average`,
    };
  },
};
```

- [ ] **Step 5: Run both tests and watch them pass**

Run: `cd apps/api && npx jest src/modules/trade-sentinel/tripwires/level-break src/modules/trade-sentinel/tripwires/volume-anomaly`
Expected: PASS, 7 tests total.

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/modules/trade-sentinel/tripwires
git commit -m "feat(sentinel): sensors for a broken level and unusual participation"
```

---

## Task 5: OI wall snapshots and the shift sensor

This is the one genuinely new data source in Stage 0. `oi-wall.service.ts` reports walls *now*; nothing yet stores them, so nothing can compute a *shift*.

**Files:**
- Create: `apps/api/src/modules/trade-sentinel/services/oi-wall-snapshot.service.ts`
- Create: `apps/api/src/modules/trade-sentinel/tripwires/oi-wall-shift.tripwire.ts`
- Test: `apps/api/src/modules/trade-sentinel/services/oi-wall-snapshot.service.spec.ts`
- Test: `apps/api/src/modules/trade-sentinel/tripwires/oi-wall-shift.tripwire.spec.ts`

**Interfaces:**
- Consumes: `OiWallService` from `../../signal-generator/services/oi-wall.service`; `PrismaService`; `Tripwire` types.
- Produces: `OiWallSnapshotService` with `captureAndCompare(symbol: string, expiry: string): Promise<{ now: WallPair | null; prev: WallPair | null }>`; `WallPair = { callWall: number | null; putWall: number | null }`; `oiWallShift: Tripwire`; `OI_WALL_SHIFT_PCT`.

- [ ] **Step 1: Write the failing snapshot-service test**

Create `apps/api/src/modules/trade-sentinel/services/oi-wall-snapshot.service.spec.ts`:

```typescript
import { OiWallSnapshotService } from './oi-wall-snapshot.service';

describe('OiWallSnapshotService', () => {
  const findFirst = jest.fn();
  const create = jest.fn();
  const prisma = { oiWallSnapshot: { findFirst, create } } as any;
  const oiWall = { walls: jest.fn() } as any;
  const svc = new OiWallSnapshotService(prisma, oiWall);

  beforeEach(() => jest.clearAllMocks());

  it('returns both nulls when the symbol has no chain, and stores nothing', async () => {
    oiWall.walls.mockResolvedValue([]);
    const result = await svc.captureAndCompare('INFY', '2026-08-28');
    expect(result).toEqual({ now: null, prev: null });
    expect(create).not.toHaveBeenCalled();
  });

  it('reads the previous snapshot BEFORE writing the new one', async () => {
    const order: string[] = [];
    oiWall.walls.mockResolvedValue([
      { kind: 'OI_CALL_WALL', price: 24200, oi: 900000 },
      { kind: 'OI_PUT_WALL', price: 24000, oi: 800000 },
    ]);
    findFirst.mockImplementation(async () => { order.push('read'); return { callWall: 24300, putWall: 23900 }; });
    create.mockImplementation(async () => { order.push('write'); return {}; });

    const result = await svc.captureAndCompare('NIFTY', '2026-08-28');

    expect(order).toEqual(['read', 'write']);
    expect(result.prev).toEqual({ callWall: 24300, putWall: 23900 });
    expect(result.now).toEqual({ callWall: 24200, putWall: 24000 });
  });

  it('reports prev as null on the first ever snapshot', async () => {
    oiWall.walls.mockResolvedValue([{ kind: 'OI_CALL_WALL', price: 100, oi: 5 }]);
    findFirst.mockResolvedValue(null);
    const result = await svc.captureAndCompare('NIFTY', '2026-08-28');
    expect(result.prev).toBeNull();
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `cd apps/api && npx jest src/modules/trade-sentinel/services/oi-wall-snapshot.service.spec.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the snapshot service**

Create `apps/api/src/modules/trade-sentinel/services/oi-wall-snapshot.service.ts`:

```typescript
import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../../common/prisma/prisma.service';
import { OiWallService } from '../../signal-generator/services/oi-wall.service';

export interface WallPair {
  callWall: number | null;
  putWall: number | null;
}

/**
 * `OiWallService` answers "where are the walls right now". Detecting a wall
 * SHIFT needs history, and nothing stored it — so this service captures each
 * reading and hands back the previous one alongside the new.
 *
 * Read-then-write ordering is load-bearing: writing first would make every
 * comparison compare a reading against itself.
 */
@Injectable()
export class OiWallSnapshotService {
  private readonly logger = new Logger(OiWallSnapshotService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly oiWall: OiWallService,
  ) {}

  async captureAndCompare(symbol: string, expiry: string): Promise<{ now: WallPair | null; prev: WallPair | null }> {
    const walls = await this.oiWall.walls(symbol);
    if (!walls || walls.length === 0) {
      // Cash stocks have no chain. Not an error — just nothing to compare.
      return { now: null, prev: null };
    }

    const call = walls.find((w: { kind: string }) => w.kind === 'OI_CALL_WALL');
    const put = walls.find((w: { kind: string }) => w.kind === 'OI_PUT_WALL');
    const now: WallPair = { callWall: call?.price ?? null, putWall: put?.price ?? null };

    const previous = await this.prisma.oiWallSnapshot.findFirst({
      where: { symbol, expiry },
      orderBy: { capturedAt: 'desc' },
    });

    await this.prisma.oiWallSnapshot.create({
      data: {
        symbol,
        expiry,
        callWall: now.callWall,
        putWall: now.putWall,
        callWallOi: call?.oi ?? null,
        putWallOi: put?.oi ?? null,
      },
    });

    return {
      now,
      prev: previous ? { callWall: previous.callWall, putWall: previous.putWall } : null,
    };
  }
}
```

- [ ] **Step 4: Write the failing shift-sensor test**

Create `apps/api/src/modules/trade-sentinel/tripwires/oi-wall-shift.tripwire.spec.ts`:

```typescript
import { oiWallShift, OI_WALL_SHIFT_PCT } from './oi-wall-shift.tripwire';
import type { TripwireInput } from './types';

const base: TripwireInput = {
  trackerId: 't1', symbol: 'NIFTY', segment: 'OPT', side: 'LONG',
  entryPrice: 100, qty: 50, ltp: 100, underlyingLtp: 24100,
  holdingHigh: null, holdingLow: null,
  nearestSupport: null, nearestResistance: null,
  volumeRatio: null,
  oiWallNow: { callWall: 24200, putWall: 24000 },
  oiWallPrev: { callWall: 24200, putWall: 24000 },
  freshNewsCount: null, factorValues: {}, prevFactorValues: {},
};

describe('oiWallShift', () => {
  it('stays silent when the walls have not moved', () => {
    expect(oiWallShift.check(base)).toBeNull();
  });

  it('stays silent when there is no previous snapshot to compare against', () => {
    expect(oiWallShift.check({ ...base, oiWallPrev: null })).toBeNull();
  });

  it('stays silent for a symbol with no chain at all', () => {
    expect(oiWallShift.check({ ...base, oiWallNow: null, oiWallPrev: null })).toBeNull();
  });

  it('fires when the call wall moves down against a long', () => {
    const moved = 24200 * (1 - OI_WALL_SHIFT_PCT * 2);
    const fire = oiWallShift.check({ ...base, oiWallNow: { callWall: moved, putWall: 24000 } });
    expect(fire?.name).toBe('oi-wall-shift');
    expect(fire?.detail).toMatch(/call wall/i);
  });

  it('fires when the put wall moves up against a short', () => {
    const moved = 24000 * (1 + OI_WALL_SHIFT_PCT * 2);
    const fire = oiWallShift.check({ ...base, side: 'SHORT', oiWallNow: { callWall: 24200, putWall: moved } });
    expect(fire?.detail).toMatch(/put wall/i);
  });
});
```

- [ ] **Step 5: Implement the shift sensor**

Create `apps/api/src/modules/trade-sentinel/tripwires/oi-wall-shift.tripwire.ts`:

```typescript
import type { Tripwire, TripwireFire, TripwireInput } from './types';

/** Fractional move in a wall strike before the shift counts as meaningful. */
export const OI_WALL_SHIFT_PCT = 0.002;

/**
 * The walls moved against the position. A call wall descending toward a long
 * means writers are capping the upside closer than they were; a put wall rising
 * toward a short means the same in reverse.
 *
 * Requires a previous snapshot (see OiWallSnapshotService). Without one — first
 * sighting, or a cash symbol with no chain — this stays silent rather than
 * inventing a comparison.
 */
export const oiWallShift: Tripwire = {
  name: 'oi-wall-shift',

  check({ side, oiWallNow, oiWallPrev }: TripwireInput): TripwireFire | null {
    if (!oiWallNow || !oiWallPrev) return null;

    if (side === 'LONG') {
      const { callWall } = oiWallNow;
      const prev = oiWallPrev.callWall;
      if (callWall === null || prev === null) return null;
      const moved = (prev - callWall) / prev;
      if (moved < OI_WALL_SHIFT_PCT) return null;
      return { name: 'oi-wall-shift', detail: `call wall fell ${prev} -> ${callWall}, capping upside closer` };
    }

    const { putWall } = oiWallNow;
    const prev = oiWallPrev.putWall;
    if (putWall === null || prev === null) return null;
    const moved = (putWall - prev) / prev;
    if (moved < OI_WALL_SHIFT_PCT) return null;
    return { name: 'oi-wall-shift', detail: `put wall rose ${prev} -> ${putWall}, floor rising against the short` };
  },
};
```

- [ ] **Step 6: Run both tests and watch them pass**

Run: `cd apps/api && npx jest src/modules/trade-sentinel/services/oi-wall-snapshot src/modules/trade-sentinel/tripwires/oi-wall-shift`
Expected: PASS, 8 tests total.

- [ ] **Step 7: Commit**

```bash
git add apps/api/src/modules/trade-sentinel
git commit -m "feat(sentinel): store OI walls over time so a shift becomes visible"
```

---

## Task 6: News and factor-flip sensors, and the tripwire runner

**Files:**
- Create: `apps/api/src/modules/trade-sentinel/tripwires/news-hit.tripwire.ts`
- Create: `apps/api/src/modules/trade-sentinel/tripwires/context-factor-flip.tripwire.ts`
- Create: `apps/api/src/modules/trade-sentinel/services/tripwire.service.ts`
- Test: `apps/api/src/modules/trade-sentinel/services/tripwire.service.spec.ts`

**Interfaces:**
- Consumes: all `Tripwire` implementations from Tasks 3–5.
- Produces: `newsHit: Tripwire`, `contextFactorFlip: Tripwire`, `REAL_FACTORS: string[]`; `TripwireService` with `evaluate(input: TripwireInput, lastVerdictAt: Date | null, now: Date): { fires: TripwireFire[]; heartbeat: boolean; shouldEvaluate: boolean }` and constant `HEARTBEAT_INTERVAL_MS`.

- [ ] **Step 1: Implement the two remaining sensors**

Create `apps/api/src/modules/trade-sentinel/tripwires/news-hit.tripwire.ts`:

```typescript
import type { Tripwire, TripwireFire, TripwireInput } from './types';

/**
 * Fresh headlines exist for this symbol. Sentiment is deliberately NOT judged
 * here — the aggregator's sentiment score is one more piece of evidence for the
 * agent, not a trigger condition.
 */
export const newsHit: Tripwire = {
  name: 'news-hit',

  check({ freshNewsCount }: TripwireInput): TripwireFire | null {
    if (freshNewsCount === null) return null;
    if (freshNewsCount < 1) return null;
    return { name: 'news-hit', detail: `${freshNewsCount} fresh headline(s) in the last 30 minutes` };
  },
};
```

Create `apps/api/src/modules/trade-sentinel/tripwires/context-factor-flip.tripwire.ts`:

```typescript
import type { Tripwire, TripwireFire, TripwireInput } from './types';

/**
 * The context-scoring factors that are actually implemented. The other six
 * (fii, sector, gold, crude-oil, nasdaq, oi-shift) return `isStub: true` and a
 * neutral zero — feeding those into a sign-flip check would manufacture signal
 * out of nothing, so they are excluded by name rather than by filtering at
 * runtime, which would silently start including them if a stub were filled in
 * without anyone revisiting this sensor.
 */
export const REAL_FACTORS = ['greeks', 'mtfTrend', 'volatility'];

/** A real factor changed sign since the last evaluation. */
export const contextFactorFlip: Tripwire = {
  name: 'context-factor-flip',

  check({ factorValues, prevFactorValues }: TripwireInput): TripwireFire | null {
    const flipped = REAL_FACTORS.filter((name) => {
      const now = factorValues[name];
      const prev = prevFactorValues[name];
      if (typeof now !== 'number' || typeof prev !== 'number') return false;
      return Math.sign(now) !== 0 && Math.sign(prev) !== 0 && Math.sign(now) !== Math.sign(prev);
    });

    if (flipped.length === 0) return null;
    return { name: 'context-factor-flip', detail: `factor(s) changed sign: ${flipped.join(', ')}` };
  },
};
```

- [ ] **Step 2: Write the failing runner test**

Create `apps/api/src/modules/trade-sentinel/services/tripwire.service.spec.ts`:

```typescript
import { TripwireService, HEARTBEAT_INTERVAL_MS } from './tripwire.service';
import type { TripwireInput } from '../tripwires/types';

const quiet: TripwireInput = {
  trackerId: 't1', symbol: 'INFY', segment: 'EQ_INTRADAY', side: 'LONG',
  entryPrice: 100, qty: 100, ltp: 100, underlyingLtp: 100,
  holdingHigh: 100, holdingLow: 100,
  nearestSupport: 90, nearestResistance: 110,
  volumeRatio: 1, oiWallNow: null, oiWallPrev: null,
  freshNewsCount: 0, factorValues: {}, prevFactorValues: {},
};

describe('TripwireService', () => {
  const svc = new TripwireService();
  const now = new Date('2026-08-14T10:00:00Z');

  it('does not evaluate when nothing fired and the heartbeat is not due', () => {
    const justNow = new Date(now.getTime() - 1000);
    const result = svc.evaluate(quiet, justNow, now);
    expect(result.fires).toEqual([]);
    expect(result.shouldEvaluate).toBe(false);
  });

  it('evaluates on the heartbeat even when every sensor is silent', () => {
    const stale = new Date(now.getTime() - HEARTBEAT_INTERVAL_MS - 1);
    const result = svc.evaluate(quiet, stale, now);
    expect(result.heartbeat).toBe(true);
    expect(result.shouldEvaluate).toBe(true);
  });

  it('always evaluates a position that has never been looked at', () => {
    expect(svc.evaluate(quiet, null, now).shouldEvaluate).toBe(true);
  });

  it('collects every sensor that fired, not just the first', () => {
    const noisy: TripwireInput = {
      ...quiet,
      holdingHigh: 130, ltp: 105,   // giveback
      nearestSupport: 110,          // level break
      volumeRatio: 5,               // volume spike
      freshNewsCount: 3,            // news
    };
    const result = svc.evaluate(noisy, new Date(now.getTime() - 1000), now);
    const names = result.fires.map((f) => f.name).sort();
    expect(names).toEqual(['giveback-off-peak', 'level-break', 'news-hit', 'volume-anomaly']);
    expect(result.shouldEvaluate).toBe(true);
  });

  it('never throws when a sensor sees only nulls', () => {
    const blank: TripwireInput = {
      ...quiet,
      holdingHigh: null, holdingLow: null,
      nearestSupport: null, nearestResistance: null,
      volumeRatio: null, freshNewsCount: null,
    };
    expect(() => svc.evaluate(blank, null, now)).not.toThrow();
  });
});
```

- [ ] **Step 3: Run it and watch it fail**

Run: `cd apps/api && npx jest src/modules/trade-sentinel/services/tripwire.service.spec.ts`
Expected: FAIL — module not found.

- [ ] **Step 4: Implement the runner**

Create `apps/api/src/modules/trade-sentinel/services/tripwire.service.ts`:

```typescript
import { Injectable } from '@nestjs/common';
import type { Tripwire, TripwireFire, TripwireInput } from '../tripwires/types';
import { givebackOffPeak } from '../tripwires/giveback-off-peak.tripwire';
import { levelBreak } from '../tripwires/level-break.tripwire';
import { volumeAnomaly } from '../tripwires/volume-anomaly.tripwire';
import { oiWallShift } from '../tripwires/oi-wall-shift.tripwire';
import { newsHit } from '../tripwires/news-hit.tripwire';
import { contextFactorFlip } from '../tripwires/context-factor-flip.tripwire';

/**
 * How long a watched position may go unexamined when every sensor is quiet.
 * The heartbeat exists so a slow grinding bleed — which by construction trips
 * nothing — cannot hide beneath the sensors' thresholds.
 */
export const HEARTBEAT_INTERVAL_MS = 15 * 60 * 1000;

const ALL_TRIPWIRES: Tripwire[] = [
  givebackOffPeak,
  levelBreak,
  volumeAnomaly,
  oiWallShift,
  newsHit,
  contextFactorFlip,
];

export interface TripwireResult {
  fires: TripwireFire[];
  heartbeat: boolean;
  /** True when the agent should be woken: something fired, or the heartbeat is due. */
  shouldEvaluate: boolean;
}

@Injectable()
export class TripwireService {
  evaluate(input: TripwireInput, lastVerdictAt: Date | null, now: Date): TripwireResult {
    const fires = ALL_TRIPWIRES
      .map((t) => t.check(input))
      .filter((f): f is TripwireFire => f !== null);

    const heartbeat =
      lastVerdictAt === null || now.getTime() - lastVerdictAt.getTime() >= HEARTBEAT_INTERVAL_MS;

    return { fires, heartbeat, shouldEvaluate: fires.length > 0 || heartbeat };
  }
}
```

- [ ] **Step 5: Run the test and watch it pass**

Run: `cd apps/api && npx jest src/modules/trade-sentinel/services/tripwire.service.spec.ts`
Expected: PASS, 5 tests.

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/modules/trade-sentinel
git commit -m "feat(sentinel): run every sensor, and wake on a heartbeat when none speak"
```

---

## Task 7: Roster — which five positions, and who owns them

**Files:**
- Create: `apps/api/src/modules/trade-sentinel/services/roster.service.ts`
- Test: `apps/api/src/modules/trade-sentinel/services/roster.service.spec.ts`

**Interfaces:**
- Consumes: `TradeTrackerService` (`apps/api/src/modules/trade-tracker/services/trade-tracker.service.ts`).
- Produces: `RosterService` with `build(userId: string): Promise<RosterEntry[]>`; `RosterEntry = { trackerId, symbol, kind, ownership, watched, reason }`; constants `SENTINEL_MAX_WATCHED`.

- [ ] **Step 1: Write the failing test**

Create `apps/api/src/modules/trade-sentinel/services/roster.service.spec.ts`:

```typescript
import { RosterService, SENTINEL_MAX_WATCHED } from './roster.service';

const tracker = (id: string, kind: 'POSITION' | 'HOLDING', symbol = id) => ({
  id, kind, symbol, exchange: 'NSE', token: '1', entryPrice: 100, qty: 10,
});

describe('RosterService', () => {
  const list = jest.fn();
  const trackerService = { listOpen: list } as any;
  const ownedElsewhere = jest.fn().mockResolvedValue(new Set<string>());
  const svc = new RosterService(trackerService, { symbolsOwnedByOtherEngines: ownedElsewhere } as any);

  beforeEach(() => jest.clearAllMocks());

  it('caps watched entries at the configured maximum', async () => {
    list.mockResolvedValue(Array.from({ length: 8 }, (_, i) => tracker(`t${i}`, 'POSITION')));
    const roster = await svc.build('u1');
    expect(roster.filter((r) => r.watched)).toHaveLength(SENTINEL_MAX_WATCHED);
  });

  it('lists the overflow explicitly rather than dropping it', async () => {
    list.mockResolvedValue(Array.from({ length: 8 }, (_, i) => tracker(`t${i}`, 'POSITION')));
    const roster = await svc.build('u1');
    expect(roster).toHaveLength(8);
    const unwatched = roster.filter((r) => !r.watched);
    expect(unwatched).toHaveLength(3);
    expect(unwatched[0].reason).toMatch(/over capacity/i);
  });

  it('gives holdings observe-only ownership and never close authority', async () => {
    list.mockResolvedValue([tracker('h1', 'HOLDING')]);
    const roster = await svc.build('u1');
    expect(roster[0].ownership).toBe('OBSERVE_ONLY');
  });

  it('marks a position already managed by another engine as observe-only', async () => {
    list.mockResolvedValue([tracker('t1', 'POSITION', 'NIFTY24800CE')]);
    ownedElsewhere.mockResolvedValue(new Set(['NIFTY24800CE']));
    const roster = await svc.build('u1');
    expect(roster[0].ownership).toBe('OBSERVE_ONLY');
    expect(roster[0].reason).toMatch(/another engine/i);
  });

  it('claims an unowned position as the sentinel’s own', async () => {
    list.mockResolvedValue([tracker('t1', 'POSITION')]);
    ownedElsewhere.mockResolvedValue(new Set());
    const roster = await svc.build('u1');
    expect(roster[0].ownership).toBe('SENTINEL');
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `cd apps/api && npx jest src/modules/trade-sentinel/services/roster.service.spec.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the roster**

Create `apps/api/src/modules/trade-sentinel/services/roster.service.ts`:

```typescript
import { Injectable, Logger } from '@nestjs/common';
import { TradeTrackerService } from '../../trade-tracker/services/trade-tracker.service';

/** Hard cap on concurrently watched positions (spec §2). */
export const SENTINEL_MAX_WATCHED = 5;

export type Ownership = 'SENTINEL' | 'OBSERVE_ONLY';

export interface RosterEntry {
  trackerId: string;
  symbol: string;
  kind: 'POSITION' | 'HOLDING';
  ownership: Ownership;
  watched: boolean;
  reason: string;
}

/**
 * Resolves the ownership question the spec's §11 raises: `watch-monitor` and the
 * `*-track` modules already close trades they own, so a position they manage is
 * observed but never claimed. One owner per trade.
 */
export interface EngineOwnershipProbe {
  symbolsOwnedByOtherEngines(userId: string): Promise<Set<string>>;
}

@Injectable()
export class RosterService {
  private readonly logger = new Logger(RosterService.name);

  constructor(
    private readonly trackers: TradeTrackerService,
    private readonly ownership: EngineOwnershipProbe,
  ) {}

  async build(userId: string): Promise<RosterEntry[]> {
    const open = await this.trackers.listOpen(userId);
    const ownedElsewhere = await this.ownership.symbolsOwnedByOtherEngines(userId);

    // Positions before holdings: only positions can ever gain close authority,
    // so they get first claim on the five watch slots.
    const ordered = [...open].sort((a, b) => (a.kind === b.kind ? 0 : a.kind === 'POSITION' ? -1 : 1));

    let watchedCount = 0;
    return ordered.map((t): RosterEntry => {
      const watched = watchedCount < SENTINEL_MAX_WATCHED;
      if (watched) watchedCount += 1;

      if (t.kind === 'HOLDING') {
        return {
          trackerId: t.id, symbol: t.symbol, kind: 'HOLDING', ownership: 'OBSERVE_ONLY',
          watched,
          reason: watched ? 'holding — observed, never closed' : 'over capacity: more than 5 open, not watched',
        };
      }

      if (ownedElsewhere.has(t.symbol)) {
        return {
          trackerId: t.id, symbol: t.symbol, kind: 'POSITION', ownership: 'OBSERVE_ONLY',
          watched,
          reason: watched
            ? 'managed by another engine — observed only'
            : 'over capacity: more than 5 open, not watched',
        };
      }

      return {
        trackerId: t.id, symbol: t.symbol, kind: 'POSITION', ownership: 'SENTINEL',
        watched,
        reason: watched ? 'unowned position — sentinel claims it' : 'over capacity: more than 5 open, not watched',
      };
    });
  }
}
```

- [ ] **Step 4: Add `listOpen` to TradeTrackerService if absent**

Check `apps/api/src/modules/trade-tracker/services/trade-tracker.service.ts` for a method returning OPEN trackers for a user. If none exists, add:

```typescript
  /** All OPEN trackers (positions and holdings) for one user. */
  async listOpen(userId: string) {
    return this.prisma.tradeTracker.findMany({
      where: { userId, status: 'OPEN' },
      orderBy: { entryTime: 'asc' },
    });
  }
```

- [ ] **Step 5: Run the test and watch it pass**

Run: `cd apps/api && npx jest src/modules/trade-sentinel/services/roster.service.spec.ts`
Expected: PASS, 5 tests.

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/modules/trade-sentinel apps/api/src/modules/trade-tracker
git commit -m "feat(sentinel): pick five positions, and say who owns each trade"
```

---

## Task 8: The context packet

**Files:**
- Create: `apps/api/src/modules/trade-sentinel/services/context-packet.service.ts`
- Test: `apps/api/src/modules/trade-sentinel/services/context-packet.service.spec.ts`

**Interfaces:**
- Consumes: `computeGreenFloor` (Task 2), `SentinelVerdictRepository.recentForTracker` (Task 1), `ThesisService` (Task 9 — inject as an interface so this task can land first), plus the existing `ChartContextService`, `NewsAggregatorService`, `OiWallService`.
- Produces: `ContextPacketService.build(entry, tick, thesis): Promise<ContextPacket>`; types `ContextPacket`, `Block<T> = { available: true; value: T; source: string; at: string } | { available: false; reason: string }`; helper `absent(reason: string)`, `present(value, source, at)`.

- [ ] **Step 1: Write the failing test**

Create `apps/api/src/modules/trade-sentinel/services/context-packet.service.spec.ts`:

```typescript
import { ContextPacketService, absent, present } from './context-packet.service';

describe('block helpers', () => {
  it('marks a missing block with a reason, never a zero', () => {
    const block = absent('fii factor is a stub');
    expect(block).toEqual({ available: false, reason: 'fii factor is a stub' });
    expect((block as any).value).toBeUndefined();
  });

  it('stamps a present block with its source and time', () => {
    const block = present(42, 'oi-wall.service', '2026-08-14T10:00:00.000Z');
    expect(block).toEqual({ available: true, value: 42, source: 'oi-wall.service', at: '2026-08-14T10:00:00.000Z' });
  });
});

describe('ContextPacketService', () => {
  const recentForTracker = jest.fn().mockResolvedValue([]);
  const svc = new ContextPacketService(
    { recentForTracker } as any,
    { levelsFor: jest.fn().mockResolvedValue(null) } as any,
    { recentFor: jest.fn().mockResolvedValue([]) } as any,
  );

  const entry = { trackerId: 't1', symbol: 'INFY', kind: 'POSITION' as const, ownership: 'SENTINEL' as const, watched: true, reason: '' };
  const tick = {
    segment: 'EQ_INTRADAY' as const, side: 'LONG' as const,
    entryPrice: 100, qty: 100, ltp: 120,
    holdingHigh: 125, holdingLow: 98,
    entryTime: new Date('2026-08-14T04:00:00Z'),
    expiry: null, volumeRatio: null, freshNewsCount: null,
    factorValues: {}, oiWallNow: null, oiWallPrev: null,
  };

  it('marks every stubbed macro factor unavailable with a stated reason', async () => {
    const packet = await svc.build(entry, tick, null);
    expect(packet.macro.fiiDii.available).toBe(false);
    if (!packet.macro.fiiDii.available) {
      expect(packet.macro.fiiDii.reason).toMatch(/stub/i);
    }
  });

  it('always includes the money block with net P&L and the green floor', async () => {
    const packet = await svc.build(entry, tick, null);
    expect(packet.money.netPnl).toBeLessThan((120 - 100) * 100); // charges subtracted
    expect(packet.money.greenFloorPrice).not.toBeNull();
  });

  it('states plainly when no thesis has been formed yet', async () => {
    const packet = await svc.build(entry, tick, null);
    expect(packet.thesis.available).toBe(false);
  });

  it('carries the trade’s own prior verdicts so the agent stays consistent', async () => {
    recentForTracker.mockResolvedValue([
      { verdict: 'HOLD', reason: 'structure intact', createdAt: new Date('2026-08-14T09:00:00Z') },
    ]);
    const packet = await svc.build(entry, tick, null);
    expect(packet.memory.available).toBe(true);
    if (packet.memory.available) expect(packet.memory.value).toHaveLength(1);
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `cd apps/api && npx jest src/modules/trade-sentinel/services/context-packet.service.spec.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the packet builder**

Create `apps/api/src/modules/trade-sentinel/services/context-packet.service.ts`:

```typescript
import { Injectable, Logger } from '@nestjs/common';
import { computeGreenFloor, type Segment, type Side } from '../charges';
import { SentinelVerdictRepository } from '../repositories/sentinel-verdict.repository';
import type { RosterEntry } from './roster.service';

/**
 * Every packet field is either present WITH provenance, or explicitly absent
 * WITH a reason. There is no third state and no silent zero.
 *
 * This matters more for an LLM than for a scoring function: handed a packet
 * where the OI block is quietly missing, the model will not say "I cannot see
 * OI" — it will reason fluently from the eight blocks it can see and sound
 * exactly as confident. Absent evidence must be present as an absence.
 * (Same lesson as commit 34e1268.)
 */
export type Block<T> =
  | { available: true; value: T; source: string; at: string }
  | { available: false; reason: string };

export function absent(reason: string): Block<never> {
  return { available: false, reason };
}

export function present<T>(value: T, source: string, at: string): Block<T> {
  return { available: true, value, source, at };
}

export interface TickSnapshot {
  segment: Segment;
  side: Side;
  entryPrice: number;
  qty: number;
  ltp: number;
  /**
   * Price of the UNDERLYING. Equal to `ltp` for cash segments; for OPT/FUT this
   * is the spot while `ltp` is the contract's own price. Null when unresolvable —
   * sensors that compare against levels or OI walls must then stay silent rather
   * than fall back to `ltp` (see the SCALE HAZARD note on TripwireInput).
   */
  underlyingLtp: number | null;
  /** Nearest level from the level book, on the UNDERLYING's scale. */
  nearestSupport: number | null;
  nearestResistance: number | null;
  holdingHigh: number | null;
  holdingLow: number | null;
  entryTime: Date;
  expiry: string | null;
  volumeRatio: number | null;
  freshNewsCount: number | null;
  factorValues: Record<string, number>;
  oiWallNow: { callWall: number | null; putWall: number | null } | null;
  oiWallPrev: { callWall: number | null; putWall: number | null } | null;
}

export interface StoredThesis {
  direction: string;
  reason: string;
  levelPrice: number | null;
  targetPrice: number | null;
  invalidation: number | null;
  source: string;
}

export interface ContextPacket {
  position: {
    symbol: string;
    kind: string;
    segment: Segment;
    side: Side;
    qty: number;
    entryPrice: number;
    entryTime: string;
    expiry: string | null;
  };
  money: {
    grossPnl: number;
    charges: number;
    netPnl: number;
    greenFloorPrice: number | null;
    greenFloorArmed: boolean;
    mfe: number | null;
    mae: number | null;
  };
  thesis: Block<StoredThesis>;
  structure: Block<unknown>;
  flow: {
    volumeRatio: Block<number>;
    oiWalls: Block<unknown>;
  };
  macro: {
    fiiDii: Block<never>;
    sector: Block<never>;
    globalCues: Block<never>;
    realFactors: Block<Record<string, number>>;
  };
  news: Block<unknown>;
  session: { nowIst: string; expiry: string | null };
  trigger: Block<unknown>;
  memory: Block<unknown>;
}

const STUB_REASON = 'context-scoring factor is a stub (returns isStub: true) — no real data behind it';

@Injectable()
export class ContextPacketService {
  private readonly logger = new Logger(ContextPacketService.name);

  constructor(
    private readonly verdicts: SentinelVerdictRepository,
    private readonly chartContext: { levelsFor(symbol: string): Promise<unknown> },
    private readonly news: { recentFor(symbol: string): Promise<unknown[]> },
  ) {}

  async build(
    entry: RosterEntry,
    tick: TickSnapshot,
    thesis: StoredThesis | null,
    fires: { name: string; detail: string }[] = [],
  ): Promise<ContextPacket> {
    const at = new Date().toISOString();

    const floor = computeGreenFloor({
      segment: tick.segment, entryPrice: tick.entryPrice, ltp: tick.ltp, qty: tick.qty, side: tick.side,
    });
    const dir = tick.side === 'LONG' ? 1 : -1;
    const grossPnl = (tick.ltp - tick.entryPrice) * tick.qty * dir;

    const structure = await this.safely(
      () => this.chartContext.levelsFor(entry.symbol),
      'chart-context.service',
      at,
      'level book unavailable for this symbol',
    );

    const newsBlock = await this.safely(
      () => this.news.recentFor(entry.symbol),
      'news-aggregator.service',
      at,
      'news aggregator returned nothing for this symbol',
    );

    const priorVerdicts = await this.verdicts.recentForTracker(entry.trackerId, 3);

    return {
      position: {
        symbol: entry.symbol,
        kind: entry.kind,
        segment: tick.segment,
        side: tick.side,
        qty: tick.qty,
        entryPrice: tick.entryPrice,
        entryTime: tick.entryTime.toISOString(),
        expiry: tick.expiry,
      },
      money: {
        grossPnl,
        charges: floor.charges,
        netPnl: floor.netPnl,
        greenFloorPrice: floor.floorPrice,
        greenFloorArmed: floor.armed,
        mfe: tick.side === 'LONG' ? tick.holdingHigh : tick.holdingLow,
        mae: tick.side === 'LONG' ? tick.holdingLow : tick.holdingHigh,
      },
      thesis: thesis
        ? present(thesis, thesis.source === 'USER' ? 'user correction' : 'agent inference', at)
        : absent('no thesis formed yet for this position'),
      structure,
      flow: {
        volumeRatio: tick.volumeRatio === null
          ? absent('session volume vs average not available for this symbol')
          : present(tick.volumeRatio, 'market-data', at),
        oiWalls: tick.oiWallNow === null
          ? absent('no options chain for this symbol, so no OI walls')
          : present({ now: tick.oiWallNow, previous: tick.oiWallPrev }, 'oi-wall.service', at),
      },
      macro: {
        fiiDii: absent(`${STUB_REASON}. Note FII/DII is published post-close and can never be an intraday trigger.`),
        sector: absent(STUB_REASON),
        globalCues: absent(`${STUB_REASON} (gold, crude-oil, nasdaq)`),
        realFactors: Object.keys(tick.factorValues).length > 0
          ? present(tick.factorValues, 'context-scoring (greeks, mtfTrend, volatility only)', at)
          : absent('no real context factors computed for this symbol'),
      },
      news: newsBlock,
      session: { nowIst: at, expiry: tick.expiry },
      trigger: fires.length > 0
        ? present(fires, 'tripwire.service', at)
        : present([{ name: 'heartbeat', detail: 'no sensor fired; scheduled review' }], 'tripwire.service', at),
      memory: priorVerdicts.length > 0
        ? present(
            priorVerdicts.map((v) => ({ verdict: v.verdict, reason: v.reason, at: v.createdAt.toISOString() })),
            'sentinel-verdict.repository',
            at,
          )
        : absent('no prior verdicts for this position — this is the first look'),
    };
  }

  /**
   * A source that throws must become a stated absence, never an exception that
   * kills the whole evaluation and never a silently empty block.
   */
  private async safely<T>(
    fn: () => Promise<T>,
    source: string,
    at: string,
    fallbackReason: string,
  ): Promise<Block<T>> {
    try {
      const value = await fn();
      if (value === null || value === undefined || (Array.isArray(value) && value.length === 0)) {
        return absent(fallbackReason);
      }
      return present(value, source, at);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.logger.warn(`${source} failed while building packet: ${message}`);
      return absent(`${source} failed: ${message}`);
    }
  }
}
```

- [ ] **Step 4: Run the test and watch it pass**

Run: `cd apps/api && npx jest src/modules/trade-sentinel/services/context-packet.service.spec.ts`
Expected: PASS, 6 tests.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/modules/trade-sentinel
git commit -m "feat(sentinel): assemble the evidence, and name every gap in it"
```

---

## Task 9: The agent — verdict schema, prompt, and the Anthropic call

**Files:**
- Modify: `apps/api/package.json` (add `@anthropic-ai/sdk`)
- Create: `apps/api/src/modules/trade-sentinel/services/sentinel-agent.service.ts`
- Create: `apps/api/src/modules/trade-sentinel/prompts/sentinel-system-prompt.ts`
- Test: `apps/api/src/modules/trade-sentinel/services/sentinel-agent.service.spec.ts`

**Interfaces:**
- Consumes: `ContextPacket` (Task 8).
- Produces: `SentinelAgentService.judge(packet: ContextPacket): Promise<Verdict>`; `Verdict` interface; `VERDICT_SCHEMA`; `SENTINEL_PROMPT_VERSION`, `SENTINEL_SYSTEM_PROMPT`, `SENTINEL_MODEL`.

- [ ] **Step 1: Add the SDK dependency**

Run: `cd apps/api && npm install @anthropic-ai/sdk`
Expected: `@anthropic-ai/sdk` appears in `apps/api/package.json` dependencies.

- [ ] **Step 2: Write the system prompt**

Create `apps/api/src/modules/trade-sentinel/prompts/sentinel-system-prompt.ts`:

```typescript
/**
 * Bump this whenever the prompt text or the schema changes. Every verdict stores
 * it, because the replay harness cannot attribute a behaviour change to a prompt
 * change without it.
 */
export const SENTINEL_PROMPT_VERSION = 'v1';

export const SENTINEL_MODEL = 'claude-opus-5';

export const SENTINEL_SYSTEM_PROMPT = `You are a trade sentinel watching a single open position in the Indian market.

You receive one JSON context packet describing the position, its money, the entry thesis, market structure, flow, news, and your own prior verdicts on this trade. You return one verdict object. You have no tools and take no actions; another system decides what to do with your verdict.

Your mandate:
- When the trade is in profit beyond charges, protect that profit. Say EXIT when the read has turned against it.
- When the trade is not in profit, keep working it. Only conclude recovery is unavailable when the thesis is genuinely broken.
- A hard max-loss limit and a charge-adjusted green floor are enforced elsewhere, mechanically. You do not vote on them.

How to read the packet:
- Every field is either {available: true, value, source, at} or {available: false, reason}. An unavailable field means you CANNOT SEE that information. Say so in your reasoning rather than inferring it. Never treat an absent field as neutral, zero, or benign.
- The "memory" block holds your own recent verdicts on this same trade. Stay consistent with them, or state explicitly what changed.
- The "trigger" block says what woke you. A trigger is a reason to look, not a reason to exit.

Rules for your answer:
- "evidence" must cite packet field paths you actually read, e.g. "money.netPnl", "flow.oiWalls". A verdict citing nothing is invalid.
- "invalidationPoint" must state what would prove this verdict wrong, in one concrete phrase.
- Use confidence "high" only when the evidence is unambiguous. EXIT_NOW requires high confidence; medium confidence means EXIT_ARMED.
- "recoveryAvailable" may be false only when thesisStatus is BROKEN and confidence is high.
- Keep "reason" to one sentence a trader would recognise.`;
```

- [ ] **Step 3: Write the failing agent test**

Create `apps/api/src/modules/trade-sentinel/services/sentinel-agent.service.spec.ts`:

```typescript
import { SentinelAgentService } from './sentinel-agent.service';

const validVerdict = {
  verdict: 'HOLD',
  confidence: 'high',
  thesisStatus: 'INTACT',
  recoveryAvailable: true,
  reason: 'structure holding above the demand zone',
  evidence: ['structure', 'money.netPnl'],
  invalidationPoint: 'close below 1450',
  reviewIn: 300,
};

const reply = (obj: unknown) => ({
  content: [{ type: 'text', text: JSON.stringify(obj) }],
});

describe('SentinelAgentService', () => {
  const create = jest.fn();
  const client = { messages: { create } } as any;
  const svc = new SentinelAgentService(client);
  const packet = { position: { symbol: 'INFY' } } as any;

  beforeEach(() => jest.clearAllMocks());

  it('returns the parsed verdict on a well-formed reply', async () => {
    create.mockResolvedValue(reply(validVerdict));
    await expect(svc.judge(packet)).resolves.toMatchObject({ verdict: 'HOLD', confidence: 'high' });
  });

  it('sends the packet as the user turn and caches the system prompt', async () => {
    create.mockResolvedValue(reply(validVerdict));
    await svc.judge(packet);
    const args = create.mock.calls[0][0];
    expect(args.model).toBe('claude-opus-5');
    expect(args.system[0].cache_control).toEqual({ type: 'ephemeral' });
    expect(args.messages[0].content).toContain('INFY');
  });

  it('rejects a verdict that cites no evidence', async () => {
    create.mockResolvedValue(reply({ ...validVerdict, evidence: [] }));
    await expect(svc.judge(packet)).rejects.toThrow(/evidence/i);
  });

  it('rejects EXIT_NOW at anything below high confidence', async () => {
    create.mockResolvedValue(reply({ ...validVerdict, verdict: 'EXIT_NOW', confidence: 'medium' }));
    await expect(svc.judge(packet)).rejects.toThrow(/confidence/i);
  });

  it('rejects recoveryAvailable=false unless the thesis is BROKEN at high confidence', async () => {
    create.mockResolvedValue(reply({ ...validVerdict, recoveryAvailable: false, thesisStatus: 'INTACT' }));
    await expect(svc.judge(packet)).rejects.toThrow(/recovery/i);
  });

  it('rejects a reply that is not JSON at all', async () => {
    create.mockResolvedValue({ content: [{ type: 'text', text: 'I think you should hold.' }] });
    await expect(svc.judge(packet)).rejects.toThrow(/parse/i);
  });
});
```

- [ ] **Step 4: Run it and watch it fail**

Run: `cd apps/api && npx jest src/modules/trade-sentinel/services/sentinel-agent.service.spec.ts`
Expected: FAIL — module not found.

- [ ] **Step 5: Implement the agent**

Create `apps/api/src/modules/trade-sentinel/services/sentinel-agent.service.ts`:

```typescript
import { Inject, Injectable, Logger } from '@nestjs/common';
import type Anthropic from '@anthropic-ai/sdk';
import type { ContextPacket } from './context-packet.service';
import {
  SENTINEL_MODEL,
  SENTINEL_PROMPT_VERSION,
  SENTINEL_SYSTEM_PROMPT,
} from '../prompts/sentinel-system-prompt';

export const ANTHROPIC_CLIENT = 'ANTHROPIC_CLIENT';

export interface Verdict {
  verdict: 'HOLD' | 'EXIT_ARMED' | 'EXIT_NOW' | 'ESCALATE';
  confidence: 'low' | 'medium' | 'high';
  thesisStatus: 'INTACT' | 'WEAKENING' | 'BROKEN';
  recoveryAvailable: boolean;
  reason: string;
  evidence: string[];
  invalidationPoint: string;
  reviewIn: number;
}

/** Structured-output schema. `additionalProperties: false` and full `required` are mandatory. */
export const VERDICT_SCHEMA = {
  type: 'object',
  properties: {
    verdict: { type: 'string', enum: ['HOLD', 'EXIT_ARMED', 'EXIT_NOW', 'ESCALATE'] },
    confidence: { type: 'string', enum: ['low', 'medium', 'high'] },
    thesisStatus: { type: 'string', enum: ['INTACT', 'WEAKENING', 'BROKEN'] },
    recoveryAvailable: { type: 'boolean' },
    reason: { type: 'string' },
    evidence: { type: 'array', items: { type: 'string' } },
    invalidationPoint: { type: 'string' },
    reviewIn: { type: 'integer' },
  },
  required: [
    'verdict', 'confidence', 'thesisStatus', 'recoveryAvailable',
    'reason', 'evidence', 'invalidationPoint', 'reviewIn',
  ],
  additionalProperties: false,
} as const;

/**
 * A pure function from evidence to verdict. It holds no broker access and takes
 * no action — which is what makes it replayable: capture a packet, re-run it,
 * and compare. An agent with side effects cannot be backtested, and this one
 * must be before it is ever allowed near real money.
 */
@Injectable()
export class SentinelAgentService {
  private readonly logger = new Logger(SentinelAgentService.name);

  constructor(@Inject(ANTHROPIC_CLIENT) private readonly client: Anthropic) {}

  get promptVersion(): string {
    return SENTINEL_PROMPT_VERSION;
  }

  async judge(packet: ContextPacket): Promise<Verdict> {
    const response = await this.client.messages.create({
      model: SENTINEL_MODEL,
      max_tokens: 16000,
      output_config: {
        effort: 'high',
        format: { type: 'json_schema', schema: VERDICT_SCHEMA },
      },
      system: [
        { type: 'text', text: SENTINEL_SYSTEM_PROMPT, cache_control: { type: 'ephemeral' } },
      ],
      messages: [{ role: 'user', content: JSON.stringify(packet) }],
    } as never);

    return this.validate(this.extractJson(response as never));
  }

  private extractJson(response: { content: { type: string; text?: string }[] }): unknown {
    const text = response.content.find((b) => b.type === 'text')?.text;
    if (!text) throw new Error('sentinel agent: could not parse reply — no text block returned');
    try {
      return JSON.parse(text);
    } catch {
      throw new Error(`sentinel agent: could not parse reply as JSON: ${text.slice(0, 200)}`);
    }
  }

  /**
   * Schema validation is the API's job; these are the SEMANTIC invariants the
   * schema cannot express. A verdict that cites nothing, or claims certainty it
   * has not earned, is rejected rather than recorded — a bad verdict in the
   * corpus poisons every future replay run.
   */
  private validate(raw: unknown): Verdict {
    const v = raw as Verdict;

    if (!Array.isArray(v.evidence) || v.evidence.length === 0) {
      throw new Error('sentinel agent: verdict cites no evidence — rejected');
    }
    if (v.verdict === 'EXIT_NOW' && v.confidence !== 'high') {
      throw new Error('sentinel agent: EXIT_NOW requires high confidence — rejected');
    }
    if (v.recoveryAvailable === false && !(v.thesisStatus === 'BROKEN' && v.confidence === 'high')) {
      throw new Error(
        'sentinel agent: recovery declared unavailable without a broken thesis at high confidence — rejected',
      );
    }
    if (typeof v.invalidationPoint !== 'string' || v.invalidationPoint.trim() === '') {
      throw new Error('sentinel agent: verdict states no invalidation point — rejected');
    }

    return v;
  }
}
```

- [ ] **Step 6: Run the test and watch it pass**

Run: `cd apps/api && npx jest src/modules/trade-sentinel/services/sentinel-agent.service.spec.ts`
Expected: PASS, 6 tests.

- [ ] **Step 7: Commit**

```bash
git add apps/api/package.json apps/api/package-lock.json apps/api/src/modules/trade-sentinel
git commit -m "feat(sentinel): the agent judges from evidence alone, and must cite it"
```

---

## Task 10: Thesis inference and correction

**Files:**
- Create: `apps/api/src/modules/trade-sentinel/services/thesis.service.ts`
- Create: `apps/api/src/modules/trade-sentinel/repositories/sentinel-thesis.repository.ts`
- Test: `apps/api/src/modules/trade-sentinel/services/thesis.service.spec.ts`

**Interfaces:**
- Consumes: `ANTHROPIC_CLIENT`, `StoredThesis` (Task 8), `PrismaService`.
- Produces: `SentinelThesisRepository` with `find(trackerId)`, `upsertInferred(...)`, `overrideByUser(...)`; `ThesisService.ensureFor(entry, tick): Promise<StoredThesis>` and `correct(trackerId, patch): Promise<StoredThesis>`.

- [ ] **Step 1: Write the failing test**

Create `apps/api/src/modules/trade-sentinel/services/thesis.service.spec.ts`:

```typescript
import { ThesisService } from './thesis.service';

const stored = {
  direction: 'LONG', reason: 'bought the demand zone', levelPrice: 1450,
  targetPrice: 1520, invalidation: 1440, source: 'INFERRED',
};

describe('ThesisService', () => {
  const find = jest.fn();
  const upsertInferred = jest.fn();
  const overrideByUser = jest.fn();
  const repo = { find, upsertInferred, overrideByUser } as any;
  const create = jest.fn();
  const client = { messages: { create } } as any;
  const svc = new ThesisService(repo, client, { levelsFor: jest.fn().mockResolvedValue(null) } as any);

  const entry = { trackerId: 't1', symbol: 'INFY' } as any;
  const tick = { side: 'LONG', entryPrice: 1455, entryTime: new Date(), qty: 10 } as any;

  beforeEach(() => jest.clearAllMocks());

  it('reuses a stored thesis instead of inferring again', async () => {
    find.mockResolvedValue(stored);
    const result = await svc.ensureFor(entry, tick);
    expect(result).toEqual(stored);
    expect(create).not.toHaveBeenCalled();
  });

  it('infers and stores a thesis the first time it sees a position', async () => {
    find.mockResolvedValue(null);
    create.mockResolvedValue({
      content: [{ type: 'text', text: JSON.stringify({
        direction: 'LONG', reason: 'bought the demand zone', levelPrice: 1450,
        targetPrice: 1520, invalidation: 1440,
      }) }],
    });
    upsertInferred.mockImplementation(async (_id: string, t: unknown) => ({ ...(t as object), source: 'INFERRED' }));

    const result = await svc.ensureFor(entry, tick);

    expect(create).toHaveBeenCalled();
    expect(upsertInferred).toHaveBeenCalledWith('t1', expect.objectContaining({ direction: 'LONG' }));
    expect(result.source).toBe('INFERRED');
  });

  it('falls back to a stated-unknown thesis rather than throwing when inference fails', async () => {
    find.mockResolvedValue(null);
    create.mockRejectedValue(new Error('api down'));
    upsertInferred.mockImplementation(async (_id: string, t: any) => ({ ...t, source: 'INFERRED' }));

    const result = await svc.ensureFor(entry, tick);

    expect(result.reason).toMatch(/could not be inferred/i);
    expect(result.levelPrice).toBeNull();
  });

  it('marks a user correction as USER so it outranks future inference', async () => {
    overrideByUser.mockResolvedValue({ ...stored, source: 'USER', reason: 'momentum breakout' });
    const result = await svc.correct('t1', { reason: 'momentum breakout' });
    expect(result.source).toBe('USER');
    expect(overrideByUser).toHaveBeenCalledWith('t1', { reason: 'momentum breakout' });
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `cd apps/api && npx jest src/modules/trade-sentinel/services/thesis.service.spec.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the repository**

Create `apps/api/src/modules/trade-sentinel/repositories/sentinel-thesis.repository.ts`:

```typescript
import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../../common/prisma/prisma.service';
import type { StoredThesis } from '../services/context-packet.service';

export interface ThesisDraft {
  userId: string;
  direction: string;
  reason: string;
  levelPrice: number | null;
  targetPrice: number | null;
  invalidation: number | null;
}

@Injectable()
export class SentinelThesisRepository {
  constructor(private readonly prisma: PrismaService) {}

  async find(trackerId: string): Promise<StoredThesis | null> {
    const row = await this.prisma.sentinelThesis.findUnique({ where: { trackerId } });
    if (!row) return null;
    return {
      direction: row.direction,
      reason: row.reason,
      levelPrice: row.levelPrice,
      targetPrice: row.targetPrice,
      invalidation: row.invalidation,
      source: row.source,
    };
  }

  /**
   * Inference never overwrites a user correction — `source: 'USER'` is final
   * until the user changes it again.
   */
  async upsertInferred(trackerId: string, draft: ThesisDraft): Promise<StoredThesis> {
    const existing = await this.prisma.sentinelThesis.findUnique({ where: { trackerId } });
    if (existing?.source === 'USER') {
      return this.find(trackerId) as Promise<StoredThesis>;
    }

    const row = await this.prisma.sentinelThesis.upsert({
      where: { trackerId },
      create: { trackerId, source: 'INFERRED', ...draft },
      update: { source: 'INFERRED', ...draft },
    });

    return {
      direction: row.direction, reason: row.reason, levelPrice: row.levelPrice,
      targetPrice: row.targetPrice, invalidation: row.invalidation, source: row.source,
    };
  }

  async overrideByUser(trackerId: string, patch: Partial<ThesisDraft>): Promise<StoredThesis> {
    const row = await this.prisma.sentinelThesis.update({
      where: { trackerId },
      data: { ...patch, source: 'USER' },
    });
    return {
      direction: row.direction, reason: row.reason, levelPrice: row.levelPrice,
      targetPrice: row.targetPrice, invalidation: row.invalidation, source: row.source,
    };
  }
}
```

- [ ] **Step 4: Implement the service**

Create `apps/api/src/modules/trade-sentinel/services/thesis.service.ts`:

```typescript
import { Inject, Injectable, Logger } from '@nestjs/common';
import type Anthropic from '@anthropic-ai/sdk';
import { SentinelThesisRepository, type ThesisDraft } from '../repositories/sentinel-thesis.repository';
import { ANTHROPIC_CLIENT } from './sentinel-agent.service';
import { SENTINEL_MODEL } from '../prompts/sentinel-system-prompt';
import type { StoredThesis, TickSnapshot } from './context-packet.service';
import type { RosterEntry } from './roster.service';

const THESIS_SCHEMA = {
  type: 'object',
  properties: {
    direction: { type: 'string', enum: ['LONG', 'SHORT'] },
    reason: { type: 'string' },
    levelPrice: { type: ['number', 'null'] },
    targetPrice: { type: ['number', 'null'] },
    invalidation: { type: ['number', 'null'] },
  },
  required: ['direction', 'reason', 'levelPrice', 'targetPrice', 'invalidation'],
  additionalProperties: false,
} as const;

const THESIS_PROMPT = `You are reading a trade someone already placed. From the entry price, entry time, side, and the market structure around that moment, state the thesis they most plausibly acted on.

Say what they appear to have been trading (a level reclaim, a breakout, a pullback buy, a mean reversion), which price level it hinges on, the target it implies, and the price that would prove it wrong. If the structure does not support a confident read, say so plainly in "reason" and return nulls for the prices rather than inventing them.`;

/**
 * "Reversed" only means something relative to an expectation. A manually placed
 * Angel One position arrives with no stated intent, so the agent forms one on
 * first sight and the user can correct it in one tap.
 *
 * Inference must never block watching: a failure here yields a thesis that
 * honestly says it is unknown, and the position stays watched.
 */
@Injectable()
export class ThesisService {
  private readonly logger = new Logger(ThesisService.name);

  constructor(
    private readonly repo: SentinelThesisRepository,
    @Inject(ANTHROPIC_CLIENT) private readonly client: Anthropic,
    private readonly chartContext: { levelsFor(symbol: string): Promise<unknown> },
  ) {}

  async ensureFor(entry: RosterEntry, tick: TickSnapshot, userId = ''): Promise<StoredThesis> {
    const existing = await this.repo.find(entry.trackerId);
    if (existing) return existing;

    const draft = await this.infer(entry, tick, userId);
    return this.repo.upsertInferred(entry.trackerId, draft);
  }

  async correct(trackerId: string, patch: Partial<ThesisDraft>): Promise<StoredThesis> {
    return this.repo.overrideByUser(trackerId, patch);
  }

  private async infer(entry: RosterEntry, tick: TickSnapshot, userId: string): Promise<ThesisDraft> {
    const unknown: ThesisDraft = {
      userId,
      direction: tick.side,
      reason: 'thesis could not be inferred — no confident read from the structure at entry',
      levelPrice: null,
      targetPrice: null,
      invalidation: null,
    };

    try {
      const structure = await this.chartContext.levelsFor(entry.symbol).catch(() => null);
      const response = (await this.client.messages.create({
        model: SENTINEL_MODEL,
        max_tokens: 8000,
        output_config: { effort: 'medium', format: { type: 'json_schema', schema: THESIS_SCHEMA } },
        system: [{ type: 'text', text: THESIS_PROMPT, cache_control: { type: 'ephemeral' } }],
        messages: [{
          role: 'user',
          content: JSON.stringify({
            symbol: entry.symbol,
            side: tick.side,
            entryPrice: tick.entryPrice,
            entryTime: tick.entryTime.toISOString(),
            qty: tick.qty,
            structure: structure ?? { available: false, reason: 'no level book for this symbol' },
          }),
        }],
      } as never)) as { content: { type: string; text?: string }[] };

      const text = response.content.find((b) => b.type === 'text')?.text;
      if (!text) return unknown;
      const parsed = JSON.parse(text) as Omit<ThesisDraft, 'userId'>;
      return { userId, ...parsed };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.logger.warn(`thesis inference failed for ${entry.symbol}: ${message}`);
      return unknown;
    }
  }
}
```

- [ ] **Step 5: Run the test and watch it pass**

Run: `cd apps/api && npx jest src/modules/trade-sentinel/services/thesis.service.spec.ts`
Expected: PASS, 4 tests.

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/modules/trade-sentinel
git commit -m "feat(sentinel): infer why a trade was taken, and let the user correct it"
```

---

## Task 11: The cycle — orchestration, shadow-only

**Files:**
- Create: `apps/api/src/modules/trade-sentinel/services/sentinel-cycle.service.ts`
- Test: `apps/api/src/modules/trade-sentinel/services/sentinel-cycle.service.spec.ts`

**Interfaces:**
- Consumes: `RosterService`, `TripwireService`, `ContextPacketService`, `ThesisService`, `SentinelAgentService`, `SentinelVerdictRepository`, `OiWallSnapshotService`.
- Produces: `SentinelCycleService.runForUser(userId: string, now?: Date): Promise<CycleReport>`; `CycleReport = { evaluated: number; skipped: number; failed: number; unwatched: number }`.

- [ ] **Step 1: Write the failing test**

Create `apps/api/src/modules/trade-sentinel/services/sentinel-cycle.service.spec.ts`:

```typescript
import { SentinelCycleService } from './sentinel-cycle.service';

const watched = (id: string) => ({
  trackerId: id, symbol: id, kind: 'POSITION' as const,
  ownership: 'SENTINEL' as const, watched: true, reason: '',
});

describe('SentinelCycleService', () => {
  const build = jest.fn();
  const evaluate = jest.fn();
  const buildPacket = jest.fn();
  const ensureFor = jest.fn();
  const judge = jest.fn();
  const record = jest.fn();
  const recentForTracker = jest.fn().mockResolvedValue([]);
  const captureAndCompare = jest.fn().mockResolvedValue({ now: null, prev: null });
  const tickFor = jest.fn();

  const svc = new SentinelCycleService(
    { build } as any,
    { evaluate } as any,
    { build: buildPacket } as any,
    { ensureFor } as any,
    { judge, promptVersion: 'v1' } as any,
    { record, recentForTracker } as any,
    { captureAndCompare } as any,
    { tickFor } as any,
  );

  beforeEach(() => {
    jest.clearAllMocks();
    recentForTracker.mockResolvedValue([]);
    captureAndCompare.mockResolvedValue({ now: null, prev: null });
    tickFor.mockResolvedValue({
      segment: 'EQ_INTRADAY', side: 'LONG', entryPrice: 100, qty: 10, ltp: 100,
      holdingHigh: null, holdingLow: null, entryTime: new Date(), expiry: null,
      volumeRatio: null, freshNewsCount: null, factorValues: {},
      oiWallNow: null, oiWallPrev: null,
    });
    ensureFor.mockResolvedValue(null);
    buildPacket.mockResolvedValue({ position: {}, money: { netPnl: 0, greenFloorPrice: null } });
    judge.mockResolvedValue({
      verdict: 'HOLD', confidence: 'high', thesisStatus: 'INTACT', recoveryAvailable: true,
      reason: 'ok', evidence: ['money.netPnl'], invalidationPoint: 'x', reviewIn: 300,
    });
  });

  it('never evaluates an unwatched entry', async () => {
    build.mockResolvedValue([{ ...watched('t1'), watched: false }]);
    const report = await svc.runForUser('u1');
    expect(judge).not.toHaveBeenCalled();
    expect(report.unwatched).toBe(1);
  });

  it('skips a watched entry when no sensor fired and no heartbeat is due', async () => {
    build.mockResolvedValue([watched('t1')]);
    evaluate.mockReturnValue({ fires: [], heartbeat: false, shouldEvaluate: false });
    const report = await svc.runForUser('u1');
    expect(judge).not.toHaveBeenCalled();
    expect(report.skipped).toBe(1);
  });

  it('records a verdict when a sensor fires', async () => {
    build.mockResolvedValue([watched('t1')]);
    evaluate.mockReturnValue({ fires: [{ name: 'level-break', detail: 'd' }], heartbeat: false, shouldEvaluate: true });
    const report = await svc.runForUser('u1');
    expect(record).toHaveBeenCalledWith(expect.objectContaining({
      trackerId: 't1', verdict: 'HOLD', promptVersion: 'v1', triggeredBy: ['level-break'],
    }));
    expect(report.evaluated).toBe(1);
  });

  it('does not let one failing position abort the rest of the cycle', async () => {
    build.mockResolvedValue([watched('t1'), watched('t2')]);
    evaluate.mockReturnValue({ fires: [], heartbeat: true, shouldEvaluate: true });
    judge.mockRejectedValueOnce(new Error('agent refused'));
    const report = await svc.runForUser('u1');
    expect(report.failed).toBe(1);
    expect(report.evaluated).toBe(1);
  });

  it('places no orders — the cycle exposes no execution path at all', () => {
    expect((svc as unknown as Record<string, unknown>).execute).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `cd apps/api && npx jest src/modules/trade-sentinel/services/sentinel-cycle.service.spec.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the cycle**

Create `apps/api/src/modules/trade-sentinel/services/sentinel-cycle.service.ts`:

```typescript
import { Injectable, Logger } from '@nestjs/common';
import { RosterService } from './roster.service';
import { TripwireService } from './tripwire.service';
import { ContextPacketService, type TickSnapshot } from './context-packet.service';
import { ThesisService } from './thesis.service';
import { SentinelAgentService } from './sentinel-agent.service';
import { SentinelVerdictRepository } from '../repositories/sentinel-verdict.repository';
import { OiWallSnapshotService } from './oi-wall-snapshot.service';

export interface CycleReport {
  evaluated: number;
  skipped: number;
  failed: number;
  unwatched: number;
}

/** Supplies the per-tick numbers a tripwire needs. Implemented over trade-tracker + market-data. */
export interface TickSource {
  tickFor(trackerId: string): Promise<TickSnapshot>;
}

/**
 * Stage 0 orchestration: roster -> tripwires -> packet -> agent -> record.
 *
 * There is deliberately no executor here and no import of TradeExecutionService.
 * Shadow mode is the full system with the last wire cut; the cut is structural,
 * not a flag someone can flip by accident.
 */
@Injectable()
export class SentinelCycleService {
  private readonly logger = new Logger(SentinelCycleService.name);

  constructor(
    private readonly roster: RosterService,
    private readonly tripwires: TripwireService,
    private readonly packets: ContextPacketService,
    private readonly thesis: ThesisService,
    private readonly agent: SentinelAgentService,
    private readonly verdicts: SentinelVerdictRepository,
    private readonly oiWalls: OiWallSnapshotService,
    private readonly ticks: TickSource,
  ) {}

  async runForUser(userId: string, now: Date = new Date()): Promise<CycleReport> {
    const entries = await this.roster.build(userId);
    const report: CycleReport = { evaluated: 0, skipped: 0, failed: 0, unwatched: 0 };

    for (const entry of entries) {
      if (!entry.watched) {
        report.unwatched += 1;
        this.logger.warn(`UNWATCHED: ${entry.symbol} (${entry.reason})`);
        continue;
      }

      try {
        const tick = await this.ticks.tickFor(entry.trackerId);

        const walls = tick.expiry
          ? await this.oiWalls.captureAndCompare(entry.symbol, tick.expiry, tick.underlyingLtp)
          : { now: null, prev: null };

        const [last] = await this.verdicts.recentForTracker(entry.trackerId, 1);
        const decision = this.tripwires.evaluate(
          {
            trackerId: entry.trackerId,
            symbol: entry.symbol,
            segment: tick.segment,
            side: tick.side,
            entryPrice: tick.entryPrice,
            qty: tick.qty,
            ltp: tick.ltp,
            underlyingLtp: tick.underlyingLtp,
            holdingHigh: tick.holdingHigh,
            holdingLow: tick.holdingLow,
            nearestSupport: tick.nearestSupport,
            nearestResistance: tick.nearestResistance,
            volumeRatio: tick.volumeRatio,
            oiWallNow: walls.now,
            oiWallPrev: walls.prev,
            freshNewsCount: tick.freshNewsCount,
            factorValues: tick.factorValues,
            prevFactorValues: {},
          },
          last ? last.createdAt : null,
          now,
        );

        if (!decision.shouldEvaluate) {
          report.skipped += 1;
          continue;
        }

        const thesis = await this.thesis.ensureFor(entry, tick, userId);
        const packet = await this.packets.build(
          entry,
          { ...tick, oiWallNow: walls.now, oiWallPrev: walls.prev },
          thesis,
          decision.fires,
        );

        const verdict = await this.agent.judge(packet);

        await this.verdicts.record({
          userId,
          trackerId: entry.trackerId,
          symbol: entry.symbol,
          verdict: verdict.verdict,
          confidence: verdict.confidence,
          thesisStatus: verdict.thesisStatus,
          recoveryAvailable: verdict.recoveryAvailable,
          reason: verdict.reason,
          evidence: verdict.evidence,
          invalidationPoint: verdict.invalidationPoint,
          reviewInSec: verdict.reviewIn,
          packet,
          promptVersion: this.agent.promptVersion,
          triggeredBy: decision.fires.length > 0 ? decision.fires.map((f) => f.name) : ['heartbeat'],
          netPnl: packet.money.netPnl,
          greenFloor: packet.money.greenFloorPrice,
        });

        report.evaluated += 1;
      } catch (err) {
        report.failed += 1;
        const message = err instanceof Error ? err.message : String(err);
        // One bad position must not blind the sentinel to the other four.
        this.logger.error(`sentinel cycle failed for ${entry.symbol}: ${message}`);
      }
    }

    return report;
  }
}
```

- [ ] **Step 4: Run the test and watch it pass**

Run: `cd apps/api && npx jest src/modules/trade-sentinel/services/sentinel-cycle.service.spec.ts`
Expected: PASS, 5 tests.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/modules/trade-sentinel
git commit -m "feat(sentinel): run the shadow cycle, with no wire to the broker at all"
```

---

## Task 12: Module wiring, controller, and the scheduled tick

**Files:**
> **Blocker discovered in Task 5 — fix this first.** `OiWallService` is listed under
> `providers` in `apps/api/src/modules/signal-generator/signal-generator.module.ts:137`
> but is **not in that module's `exports` array**. `TradeSentinelModule` imports
> `SignalGeneratorModule` and injects `OiWallService`, so Nest will fail at bootstrap
> with an unresolved-dependency error until `OiWallService` is added to `exports`.
> Add it there; do not work around it by re-providing the service locally, which would
> give the sentinel its own instance and defeat the `warned` de-duplication set.

- Create: `apps/api/src/modules/trade-sentinel/trade-sentinel.module.ts`
- Create: `apps/api/src/modules/trade-sentinel/controllers/sentinel.controller.ts`
- Create: `apps/api/src/modules/trade-sentinel/dto/sentinel.dto.ts`
- Modify: `apps/api/src/app.module.ts` (register `TradeSentinelModule`)
- Test: `apps/api/src/modules/trade-sentinel/controllers/sentinel.controller.spec.ts`

**Interfaces:**
- Consumes: everything from Tasks 1–11.
- Produces: `TradeSentinelModule`; `SentinelController` with `GET /api/trade-sentinel/verdicts` and `POST /api/trade-sentinel/thesis/:trackerId`.

- [ ] **Step 1: Write the DTOs**

Create `apps/api/src/modules/trade-sentinel/dto/sentinel.dto.ts`:

```typescript
import { IsIn, IsNumber, IsOptional, IsString } from 'class-validator';
import type { SentinelVerdict } from '@prisma/client';

/** Wire shape for a recorded verdict. Additive and optional on the frontend. */
export interface SentinelVerdictDto {
  id: string;
  trackerId: string;
  symbol: string;
  verdict: string;
  confidence: string;
  thesisStatus: string;
  recoveryAvailable: boolean;
  reason: string;
  evidence: string[];
  invalidationPoint: string | null;
  triggeredBy: string[];
  netPnl: number;
  greenFloor: number | null;
  createdAt: string; // ISO
}

export function toSentinelVerdictDto(v: SentinelVerdict): SentinelVerdictDto {
  return {
    id: v.id,
    trackerId: v.trackerId,
    symbol: v.symbol,
    verdict: v.verdict,
    confidence: v.confidence,
    thesisStatus: v.thesisStatus,
    recoveryAvailable: v.recoveryAvailable,
    reason: v.reason,
    evidence: (v.evidence as string[]) ?? [],
    invalidationPoint: v.invalidationPoint ?? null,
    triggeredBy: (v.triggeredBy as string[]) ?? [],
    netPnl: v.netPnl,
    greenFloor: v.greenFloor ?? null,
    createdAt: v.createdAt.toISOString(),
  };
}

export class CorrectThesisDto {
  @IsOptional() @IsIn(['LONG', 'SHORT']) direction?: string;
  @IsOptional() @IsString() reason?: string;
  @IsOptional() @IsNumber() levelPrice?: number;
  @IsOptional() @IsNumber() targetPrice?: number;
  @IsOptional() @IsNumber() invalidation?: number;
}
```

- [ ] **Step 2: Write the failing controller test**

Create `apps/api/src/modules/trade-sentinel/controllers/sentinel.controller.spec.ts`:

```typescript
import { SentinelController } from './sentinel.controller';

describe('SentinelController', () => {
  const listForUser = jest.fn();
  const correct = jest.fn();
  const ctrl = new SentinelController({ listForUser } as any, { correct } as any);

  beforeEach(() => jest.clearAllMocks());

  it('returns verdicts as ISO-dated DTOs for the calling user only', async () => {
    listForUser.mockResolvedValue([{
      id: 'v1', trackerId: 't1', symbol: 'INFY', verdict: 'HOLD', confidence: 'high',
      thesisStatus: 'INTACT', recoveryAvailable: true, reason: 'ok',
      evidence: ['money.netPnl'], invalidationPoint: null, triggeredBy: ['heartbeat'],
      netPnl: 10, greenFloor: null, createdAt: new Date('2026-08-14T10:00:00Z'),
    }]);

    const result = await ctrl.list('u1', undefined);

    expect(listForUser).toHaveBeenCalledWith('u1', 50);
    expect(result[0].createdAt).toBe('2026-08-14T10:00:00.000Z');
  });

  it('routes a thesis correction to the thesis service', async () => {
    correct.mockResolvedValue({ source: 'USER' });
    await ctrl.correctThesis('t1', { reason: 'momentum breakout' } as never);
    expect(correct).toHaveBeenCalledWith('t1', { reason: 'momentum breakout' });
  });

  it('exposes no route that could place an order', () => {
    const routes = Object.getOwnPropertyNames(SentinelController.prototype);
    expect(routes).not.toContain('exit');
    expect(routes).not.toContain('close');
  });
});
```

- [ ] **Step 3: Implement the controller**

Create `apps/api/src/modules/trade-sentinel/controllers/sentinel.controller.ts`:

```typescript
import { Body, Controller, Get, Param, Post, Query, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../../auth/guards/jwt-auth.guard';
import { CurrentUser } from '../../../common/decorators/current-user.decorator';
import { SentinelVerdictRepository } from '../repositories/sentinel-verdict.repository';
import { ThesisService } from '../services/thesis.service';
import { CorrectThesisDto, toSentinelVerdictDto, type SentinelVerdictDto } from '../dto/sentinel.dto';

/**
 * Stage 0 surface: read what the sentinel decided, and correct a thesis it read
 * wrong. There is no exit route here, by design.
 */
@Controller('trade-sentinel')
@UseGuards(JwtAuthGuard)
export class SentinelController {
  constructor(
    private readonly verdicts: SentinelVerdictRepository,
    private readonly thesis: ThesisService,
  ) {}

  @Get('verdicts')
  async list(
    @CurrentUser('userId') userId: string,
    @Query('limit') limit?: string,
  ): Promise<SentinelVerdictDto[]> {
    const take = Math.min(Number(limit) || 50, 200);
    const rows = await this.verdicts.listForUser(userId, take);
    return rows.map(toSentinelVerdictDto);
  }

  @Post('thesis/:trackerId')
  async correctThesis(@Param('trackerId') trackerId: string, @Body() body: CorrectThesisDto) {
    return this.thesis.correct(trackerId, body);
  }
}
```

> **Note for the implementer:** if the repo's other controllers apply the auth guard globally rather than per-controller, follow that convention instead and drop the `@UseGuards` line. Check `apps/api/src/modules/trade-tracker/controllers/trade-tracker.controller.ts` for the house style, including the exact import path of `CurrentUser`.

- [ ] **Step 4: Wire the module**

Create `apps/api/src/modules/trade-sentinel/trade-sentinel.module.ts`:

```typescript
import { Module } from '@nestjs/common';
import Anthropic from '@anthropic-ai/sdk';
import { PrismaModule } from '../../common/prisma/prisma.module';
import { TradeTrackerModule } from '../trade-tracker/trade-tracker.module';
import { SignalGeneratorModule } from '../signal-generator/signal-generator.module';
import { NewsModule } from '../news/news.module';
import { SentinelController } from './controllers/sentinel.controller';
import { SentinelVerdictRepository } from './repositories/sentinel-verdict.repository';
import { SentinelThesisRepository } from './repositories/sentinel-thesis.repository';
import { RosterService } from './services/roster.service';
import { TripwireService } from './services/tripwire.service';
import { ContextPacketService } from './services/context-packet.service';
import { ThesisService } from './services/thesis.service';
import { SentinelAgentService, ANTHROPIC_CLIENT } from './services/sentinel-agent.service';
import { SentinelCycleService } from './services/sentinel-cycle.service';
import { OiWallSnapshotService } from './services/oi-wall-snapshot.service';

/**
 * Trade Sentinel — Stage 0 (shadow). Observes open Angel One positions and
 * records the exits it would have taken. It imports no execution module, so it
 * structurally cannot place an order.
 */
@Module({
  imports: [PrismaModule, TradeTrackerModule, SignalGeneratorModule, NewsModule],
  controllers: [SentinelController],
  providers: [
    { provide: ANTHROPIC_CLIENT, useFactory: () => new Anthropic() },
    SentinelVerdictRepository,
    SentinelThesisRepository,
    RosterService,
    TripwireService,
    ContextPacketService,
    ThesisService,
    SentinelAgentService,
    SentinelCycleService,
    OiWallSnapshotService,
  ],
  exports: [SentinelCycleService],
})
export class TradeSentinelModule {}
```

> **Note for the implementer:** `RosterService`, `ContextPacketService`, and `ThesisService` take collaborator interfaces (`EngineOwnershipProbe`, the chart-context and news shims, `TickSource`). Provide each as an explicit Nest custom provider bound to the real service, following whatever token style the neighbouring modules use. If `SignalGeneratorModule` or `NewsModule` does not export the service you need, add the export there rather than reaching into internals.

- [ ] **Step 5: Register in the app module**

Modify `apps/api/src/app.module.ts`: import `TradeSentinelModule` and add it to the `imports` array alongside the other feature modules.

- [ ] **Step 6: Run the whole module's tests**

Run: `cd apps/api && npx jest src/modules/trade-sentinel`
Expected: PASS — every spec from Tasks 1–12.

- [ ] **Step 7: Build to prove the wiring compiles**

Run: `cd apps/api && npm run build`
Expected: build succeeds with no TypeScript errors.

- [ ] **Step 8: Commit**

```bash
git add apps/api/src/modules/trade-sentinel apps/api/src/app.module.ts
git commit -m "feat(sentinel): wire the shadow module, read-only by construction"
```

---

## Task 13: Replay harness

The corpus produced by shadow mode is only useful if a prompt change can be measured against it. This is the tool that measures.

**Files:**
- Create: `apps/api/src/modules/trade-sentinel/replay/replay-verdicts.ts`
- Test: `apps/api/src/modules/trade-sentinel/replay/replay-verdicts.spec.ts`

**Interfaces:**
- Consumes: `SentinelAgentService`, `SentinelVerdictRepository`.
- Produces: `replayVerdicts(rows, agent): Promise<ReplayReport>`; `ReplayReport = { total, agreed, changed, failed, diffs }`.

- [ ] **Step 1: Write the failing test**

Create `apps/api/src/modules/trade-sentinel/replay/replay-verdicts.spec.ts`:

```typescript
import { replayVerdicts } from './replay-verdicts';

const row = (id: string, verdict: string) => ({
  id, symbol: 'INFY', verdict, packet: { position: { symbol: 'INFY' } }, promptVersion: 'v1',
});

describe('replayVerdicts', () => {
  it('counts a verdict that did not change as agreement', async () => {
    const agent = { judge: jest.fn().mockResolvedValue({ verdict: 'HOLD' }), promptVersion: 'v2' } as any;
    const report = await replayVerdicts([row('a', 'HOLD')] as any, agent);
    expect(report.agreed).toBe(1);
    expect(report.changed).toBe(0);
  });

  it('records what changed, old and new, when a verdict flips', async () => {
    const agent = { judge: jest.fn().mockResolvedValue({ verdict: 'EXIT_NOW' }), promptVersion: 'v2' } as any;
    const report = await replayVerdicts([row('a', 'HOLD')] as any, agent);
    expect(report.changed).toBe(1);
    expect(report.diffs[0]).toMatchObject({ id: 'a', was: 'HOLD', now: 'EXIT_NOW' });
  });

  it('replays the stored packet verbatim, never a rebuilt one', async () => {
    const judge = jest.fn().mockResolvedValue({ verdict: 'HOLD' });
    const agent = { judge, promptVersion: 'v2' } as any;
    const r = row('a', 'HOLD');
    await replayVerdicts([r] as any, agent);
    expect(judge).toHaveBeenCalledWith(r.packet);
  });

  it('counts an agent rejection as a failure without aborting the run', async () => {
    const agent = {
      judge: jest.fn().mockRejectedValueOnce(new Error('cites no evidence')).mockResolvedValue({ verdict: 'HOLD' }),
      promptVersion: 'v2',
    } as any;
    const report = await replayVerdicts([row('a', 'HOLD'), row('b', 'HOLD')] as any, agent);
    expect(report.failed).toBe(1);
    expect(report.agreed).toBe(1);
    expect(report.total).toBe(2);
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `cd apps/api && npx jest src/modules/trade-sentinel/replay/replay-verdicts.spec.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the harness**

Create `apps/api/src/modules/trade-sentinel/replay/replay-verdicts.ts`:

```typescript
import type { SentinelVerdict } from '@prisma/client';
import type { ContextPacket } from '../services/context-packet.service';
import type { SentinelAgentService } from '../services/sentinel-agent.service';

export interface ReplayDiff {
  id: string;
  symbol: string;
  was: string;
  now: string;
}

export interface ReplayReport {
  total: number;
  agreed: number;
  changed: number;
  failed: number;
  promptVersion: string;
  diffs: ReplayDiff[];
}

/**
 * Re-run historical packets through the CURRENT prompt and diff the verdicts.
 *
 * The packet is replayed verbatim — never rebuilt from live services — because
 * rebuilding would change the evidence along with the prompt and make the diff
 * meaningless. Same idea as the S/R accuracy harness in commit 322a21f.
 */
export async function replayVerdicts(
  rows: Pick<SentinelVerdict, 'id' | 'symbol' | 'verdict' | 'packet'>[],
  agent: Pick<SentinelAgentService, 'judge' | 'promptVersion'>,
): Promise<ReplayReport> {
  const report: ReplayReport = {
    total: rows.length, agreed: 0, changed: 0, failed: 0,
    promptVersion: agent.promptVersion, diffs: [],
  };

  for (const row of rows) {
    try {
      const fresh = await agent.judge(row.packet as unknown as ContextPacket);
      if (fresh.verdict === row.verdict) {
        report.agreed += 1;
      } else {
        report.changed += 1;
        report.diffs.push({ id: row.id, symbol: row.symbol, was: row.verdict, now: fresh.verdict });
      }
    } catch {
      // A rejection is a data point about the new prompt, not a reason to stop.
      report.failed += 1;
    }
  }

  return report;
}
```

- [ ] **Step 4: Run the test and watch it pass**

Run: `cd apps/api && npx jest src/modules/trade-sentinel/replay/replay-verdicts.spec.ts`
Expected: PASS, 4 tests.

- [ ] **Step 5: Run the full module suite and build**

Run: `cd apps/api && npx jest src/modules/trade-sentinel && npm run build`
Expected: all specs pass, build clean.

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/modules/trade-sentinel/replay
git commit -m "feat(sentinel): replay stored packets so a prompt change can be measured"
```

---

## Deferred to Stage 1 (deliberately not in this plan)

- `ExitExecutorService`, the persisted exit state machine, pre-flight gates, re-validation, veto window, order placement, partial fills.
- The chart overlay and `sentinel.gateway`.
- Telegram delivery of verdicts.
- Golden-packet fixtures — they are built *from* Stage 0's recorded corpus, so they cannot be written before it exists.
- The **challenge call** (spec §6.4). In Stage 0 a `recoveryAvailable: false` verdict is recorded, not acted on, so the adversarial second opinion buys nothing yet — its whole purpose is to gate a permanent, irreversible exit. Task 9's semantic validation already refuses that verdict unless the thesis is BROKEN at high confidence, which is the Stage 0 guard. The challenge call lands with the executor.
- The `prevFactorValues` wiring for `context-factor-flip` (Task 11 passes `{}`, so the sensor is inert until Stage 1 stores the prior evaluation's factors). This is a known, stated gap, not an oversight.
