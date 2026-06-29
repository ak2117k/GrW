# Ungated Shadow-Track A/B Experiment Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a parallel paper-trading track that takes every scored Chartink alert (bypassing score / MTF / no-direction gates) using its own ₹80L pool, ₹2L per trade, 40-slot cap, separate DB tables. A daily comparison endpoint and UI strip make the A/B verdict visible on `/watch`. Spec: `docs/superpowers/specs/2026-05-20-ungated-shadow-track-design.md`.

**Architecture:** Full mirror (Approach A) per the spec — duplicate `WatchService`, `WatchRepository`, the relevant paper-side of `TradeExecutionService`. The two tracks share `ChartinkScoringService` output (one scoring call per alert) but fork at the admission decision in `ChartinkProcessService.processOne`. Each track has its own DB tables, own paper-account balance, own per-tick lifecycle.

**Tech Stack:** NestJS + Prisma + Jest (api), React + Vite + Vitest (web), PostgreSQL.

---

## File Structure

### Backend — new files (under `apps/api/src/modules/ungated-track/`)

```
ungated-track/
├── ungated-track.module.ts
├── controllers/
│   └── ungated-track.controller.ts          + .spec.ts
├── services/
│   ├── ungated-watch.service.ts             + .spec.ts        ← MIRROR of watch.service.ts
│   ├── ungated-paper-account.service.ts     + .spec.ts        ← NEW (ledger + invariants)
│   ├── ungated-trade-execution.service.ts   + .spec.ts        ← MIRROR (paper-only subset)
│   └── ungated-comparison.service.ts        + .spec.ts        ← NEW
└── repositories/
    ├── ungated-watch.repository.ts          + .spec.ts        ← MIRROR
    ├── ungated-trade.repository.ts          + .spec.ts        ← MIRROR (subset)
    └── ungated-rejection.repository.ts      + .spec.ts        ← NEW (small)
```

### Backend — modified files

- `prisma/schema.prisma` — add `UngatedWatchEntry`, `UngatedWatchEvent`, `UngatedTrade`, `UngatedPaperAccount`, `UngatedRejection` models
- `apps/api/src/modules/chartink/services/chartink-process.service.ts` — fork at line ~273
- `apps/api/src/modules/chartink/services/__tests__/chartink-process.service.spec.ts` — fork tests
- `apps/api/src/modules/chartink/chartink.module.ts` — import UngatedTrackModule
- `apps/api/src/app.module.ts` — register UngatedTrackModule

### Frontend — new files (under `apps/web/src/`)

```
services/
├── ungatedWatch.ts                                            ← API client
└── ungatedComparison.ts
hooks/
├── useUngatedWatchEntries.ts
├── useUngatedPaperAccount.ts
└── useDailyComparison.ts
pages/ungated-watch/
└── UngatedWatchPage.tsx                                       ← MIRROR of WatchPage.tsx
components/trading/
└── ComparisonStrip.tsx                       + .spec.ts        ← NEW
```

### Frontend — modified files

- `apps/web/src/types/watch.types.ts` — add `UngatedRejectionReason` union (small)
- `apps/web/src/pages/watch/WatchPage.tsx` — render `<ComparisonStrip />` above the P&L header
- `apps/web/src/App.tsx` (or wherever routes are declared) — register `/ungated-watch`
- `apps/web/src/components/layout/Sidebar.tsx` (or equivalent) — add nav link with `EXPERIMENT` badge

**Implementation order:** schema → repos (parallel) → ledger + trade-execution → watch service admission → watch service lifecycle → comparison service → controller → fork → frontend foundation → page → strip → final verification. The dependencies between tasks are explicit in each task header.

---

## Task 1: Prisma schema — five new models + `db push`

**Files:**
- Modify: `prisma/schema.prisma`

**Why this is first:** every other task imports `@prisma/client` types that don't exist yet. Run this once; the rest can fan out.

- [ ] **Step 1: Append five models + enum to the schema**

Append at the end of `prisma/schema.prisma`:

```prisma
// ============================================================================
// Ungated Shadow-Track A/B Experiment
// See docs/superpowers/specs/2026-05-20-ungated-shadow-track-design.md
// ============================================================================

model UngatedWatchEntry {
  id                    String   @id @default(cuid())
  alertId               String?
  setupId               String?
  symbol                String
  token                 String
  exchange              String
  side                  String
  initialPrice          Float
  initialScore          Int
  initialBreakdown      Json
  initialAt             DateTime @default(now())
  profitTarget          Float
  profitTargetSource    String
  stopLossScore         Int      @default(60)
  status                WatchStatus @default(WATCHING)
  currentPrice          Float?
  currentScore          Int?
  currentBreakdown      Json?
  maxFavorable          Float?
  maxAdverse            Float?
  lastTickAt            DateTime?
  lastRescoreAt         DateTime?
  lastEventPrice        Float?
  paperTradeId          String?
  executedAt            DateTime?
  executedPrice         Float?
  quantity              Int?
  closedAt              DateTime?
  closedReason          String?
  notes                 String?
  dismissedAt           DateTime?
  partialExitedAt       DateTime?
  partialExitPrice      Float?
  partialQty            Int?
  remainingQty          Int?
  trailingHighWater     Float?
  trailingStopPrice     Float?
  createdAt             DateTime @default(now())
  updatedAt             DateTime @updatedAt
  events                UngatedWatchEvent[]

  @@index([status])
  @@index([token])
  @@index([symbol])
  @@index([createdAt])
  @@map("ungated_watch_entries")
}

model UngatedWatchEvent {
  id            String         @id @default(cuid())
  watchEntryId  String
  watchEntry    UngatedWatchEntry @relation(fields: [watchEntryId], references: [id], onDelete: Cascade)
  eventType     WatchEventType
  price         Float?
  score         Int?
  breakdown     Json?
  priceDelta    Float?
  scoreDelta    Int?
  notes         String?
  createdAt     DateTime       @default(now())

  @@index([watchEntryId, createdAt])
  @@index([eventType])
  @@map("ungated_watch_events")
}

model UngatedTrade {
  id              String   @id @default(cuid())
  instrumentId    String
  signalId        String?
  orderId         String?
  side            String
  orderType       String
  positionType    String
  quantity        Int
  entryPrice      Float?
  exitPrice       Float?
  stoploss        Float?
  target          Float?
  pnl             Float?
  pnlPercent      Float?
  fees            Float    @default(0)
  status          String   @default("PENDING")
  strategy        String?
  isPaperTrade    Boolean  @default(true)
  entryTime       DateTime?
  exitTime        DateTime?
  notes           String?
  entryReason     String?
  exitReasonTag   String?
  exitNotes       String?
  createdAt       DateTime @default(now())
  updatedAt       DateTime @updatedAt

  @@index([status])
  @@index([createdAt])
  @@map("ungated_trades")
}

model UngatedPaperAccount {
  id               String   @id @default(cuid())
  startingBalance  Float
  cash             Float
  realizedPnl      Float    @default(0)
  fees             Float    @default(0)
  deployedCapital  Float    @default(0)
  killSwitchAt     DateTime?
  createdAt        DateTime @default(now())
  updatedAt        DateTime @updatedAt

  @@map("ungated_paper_account")
}

model UngatedRejection {
  id          String   @id @default(cuid())
  alertId     String?
  symbol      String
  reason      String
  score       Int?
  hitPrice    Float?
  createdAt   DateTime @default(now())

  @@index([createdAt])
  @@index([reason])
  @@map("ungated_rejections")
}
```

Note: this schema reuses the existing `WatchStatus` and `WatchEventType` enums — no new enum needed.

- [ ] **Step 2: Push the schema and regenerate the client**

Run:
```bash
cd /c/Users/AryanKumar/Desktop/TD_Automation && npx prisma db push --schema prisma/schema.prisma && npx prisma generate --schema prisma/schema.prisma
```

Expected: "Your database is now in sync with your Prisma schema." plus generated client.

**Do NOT run `migrate dev`** — the repo's memory says `db push` is the convention. `migrate dev` will offer to RESET (wipe) the DB.

- [ ] **Step 3: Sanity-check the new tables exist**

Run:
```bash
node -e "
const { PrismaClient } = require('@prisma/client');
const p = new PrismaClient();
(async () => {
  console.log('ungated_watch_entries:', await p.ungatedWatchEntry.count());
  console.log('ungated_trades       :', await p.ungatedTrade.count());
  console.log('ungated_paper_account:', await p.ungatedPaperAccount.count());
  console.log('ungated_rejections   :', await p.ungatedRejection.count());
  console.log('ungated_watch_events :', await p.ungatedWatchEvent.count());
  await p.\$disconnect();
})();
"
```

Expected: all five lines print `0` (tables exist, empty).

- [ ] **Step 4: Commit**

```bash
git add prisma/schema.prisma
git commit -m "feat(schema): ungated shadow-track tables (watch, trade, ledger, rejections)"
```

---

## Task 2: `UngatedWatchRepository` — mirror of `WatchRepository`

**Depends on:** Task 1

**Files:**
- Create: `apps/api/src/modules/ungated-track/repositories/ungated-watch.repository.ts`
- Test:   `apps/api/src/modules/ungated-track/repositories/ungated-watch.repository.spec.ts`

The source file `apps/api/src/modules/watch-monitor/repositories/watch.repository.ts` is the model. We mirror it with `prisma.watchEntry` → `prisma.ungatedWatchEntry` and remove the option-leg fields from `CreateEntryInput`.

- [ ] **Step 1: Write a failing test for the smallest surface (`createEntry` + `findActiveByToken`)**

Create `ungated-watch.repository.spec.ts`:

```typescript
import { Test } from '@nestjs/testing';
import { UngatedWatchRepository } from './ungated-watch.repository';
import { PrismaService } from '../../../common/prisma/prisma.service';

describe('UngatedWatchRepository', () => {
  let repo: UngatedWatchRepository;
  let prisma: any;

  beforeEach(async () => {
    prisma = {
      ungatedWatchEntry: {
        create:     jest.fn().mockResolvedValue({ id: 'uw1' }),
        findMany:   jest.fn().mockResolvedValue([]),
        findFirst:  jest.fn().mockResolvedValue(null),
        findUnique: jest.fn().mockResolvedValue(null),
        update:     jest.fn().mockResolvedValue({}),
        count:      jest.fn().mockResolvedValue(0),
      },
      ungatedWatchEvent: { create: jest.fn().mockResolvedValue({ id: 'ev1' }) },
    };
    const mod = await Test.createTestingModule({
      providers: [
        UngatedWatchRepository,
        { provide: PrismaService, useValue: prisma },
      ],
    }).compile();
    repo = mod.get(UngatedWatchRepository);
  });

  it('createEntry persists to ungated_watch_entries (not watch_entries)', async () => {
    await repo.createEntry({
      alertId: 'a1', setupId: null, symbol: 'TCS', token: '11536', exchange: 'NSE',
      side: 'BUY', initialPrice: 4000, initialScore: 42,
      initialBreakdown: { checks: [] }, profitTarget: 4080,
      profitTargetSource: 'fallback-2pct', stopLossScore: 50,
    });
    expect(prisma.ungatedWatchEntry.create).toHaveBeenCalledTimes(1);
    expect(prisma.watchEntry).toBeUndefined(); // proves we didn't touch the gated table
  });

  it('findActiveByToken filters out closed states (STOPPED/TARGET_HIT/EXITED/DISMISSED)', async () => {
    await repo.findActiveByToken('11536');
    const where = prisma.ungatedWatchEntry.findMany.mock.calls[0][0].where;
    expect(where.token).toBe('11536');
    expect(where.status.notIn).toEqual(
      expect.arrayContaining(['STOPPED', 'TARGET_HIT', 'EXITED', 'DISMISSED']),
    );
  });
});
```

- [ ] **Step 2: Verify the test fails**

Run: `cd apps/api && npx jest src/modules/ungated-track/repositories/ungated-watch.repository.spec.ts`
Expected: FAIL — `UngatedWatchRepository` does not exist yet.

- [ ] **Step 3: Implement the repository**

Create `ungated-watch.repository.ts`:

```typescript
import { Injectable } from '@nestjs/common';
import { Prisma, UngatedWatchEntry, WatchEventType, WatchStatus } from '@prisma/client';
import { PrismaService } from '../../../common/prisma/prisma.service';

export interface UngatedCreateEntryInput {
  alertId: string | null;
  setupId: string | null;
  symbol: string;
  token: string;
  exchange: string;
  side: 'BUY' | 'SELL';
  initialPrice: number;
  initialScore: number;
  initialBreakdown: Prisma.InputJsonValue;
  profitTarget: number;
  profitTargetSource: 'indicator-sr' | 'fallback-2pct';
  stopLossScore: number;
}

export interface UngatedCreateEventInput {
  watchEntryId: string;
  eventType: WatchEventType;
  price?: number | null;
  score?: number | null;
  breakdown?: Prisma.InputJsonValue | null;
  priceDelta?: number | null;
  scoreDelta?: number | null;
  notes?: string | null;
}

const CLOSED_STATES = [
  WatchStatus.STOPPED,
  WatchStatus.TARGET_HIT,
  WatchStatus.EXITED,
  WatchStatus.DISMISSED,
];

/**
 * MIRROR OF apps/api/src/modules/watch-monitor/repositories/watch.repository.ts
 * Keep correctness changes in sync. See specs/2026-05-20-ungated-shadow-track-design.md.
 *
 * Differences vs gated counterpart:
 *  - No options-leg columns (equity-only experiment)
 *  - No `findScannerNames` / `findTradeRealization` here — moved to ungated-trade.repository.ts
 *    + ungated-watch.service.ts joins, so this stays focused on the entry table.
 */
@Injectable()
export class UngatedWatchRepository {
  constructor(private readonly prisma: PrismaService) {}

  async createEntry(input: UngatedCreateEntryInput): Promise<UngatedWatchEntry> {
    return this.prisma.ungatedWatchEntry.create({
      data: {
        alertId: input.alertId,
        setupId: input.setupId,
        symbol: input.symbol,
        token: input.token,
        exchange: input.exchange,
        side: input.side,
        initialPrice: input.initialPrice,
        initialScore: input.initialScore,
        initialBreakdown: input.initialBreakdown,
        profitTarget: input.profitTarget,
        profitTargetSource: input.profitTargetSource,
        stopLossScore: input.stopLossScore,
      },
    });
  }

  async createEvent(input: UngatedCreateEventInput) {
    return this.prisma.ungatedWatchEvent.create({
      data: {
        watchEntryId: input.watchEntryId,
        eventType: input.eventType,
        price: input.price ?? null,
        score: input.score ?? null,
        breakdown: (input.breakdown ?? Prisma.JsonNull) as Prisma.InputJsonValue,
        priceDelta: input.priceDelta ?? null,
        scoreDelta: input.scoreDelta ?? null,
        notes: input.notes ?? null,
      },
    });
  }

  async findById(id: string): Promise<UngatedWatchEntry | null> {
    return this.prisma.ungatedWatchEntry.findUnique({ where: { id } });
  }

  async findActiveByToken(token: string): Promise<UngatedWatchEntry[]> {
    return this.prisma.ungatedWatchEntry.findMany({
      where: { token, status: { notIn: CLOSED_STATES } },
    });
  }

  async findAllActive(): Promise<UngatedWatchEntry[]> {
    return this.prisma.ungatedWatchEntry.findMany({
      where: { status: { notIn: CLOSED_STATES } },
    });
  }

  async countActive(): Promise<number> {
    return this.prisma.ungatedWatchEntry.count({
      where: { status: { notIn: CLOSED_STATES } },
    });
  }

  async countOpenTrades(): Promise<number> {
    // "Open" = TRADED (executed and not yet exited).
    return this.prisma.ungatedWatchEntry.count({
      where: { status: WatchStatus.TRADED },
    });
  }

  async wasTokenExecutedSince(token: string, since: Date): Promise<boolean> {
    const n = await this.prisma.ungatedWatchEntry.count({
      where: { token, executedAt: { gte: since } },
    });
    return n > 0;
  }

  async list(opts: { status?: WatchStatus; date?: string }) {
    const where: Prisma.UngatedWatchEntryWhereInput = {};
    if (opts.status) where.status = opts.status;
    if (opts.date) {
      const start = new Date(`${opts.date}T00:00:00.000+05:30`);
      const end = new Date(`${opts.date}T23:59:59.999+05:30`);
      where.createdAt = { gte: start, lte: end };
    }
    return this.prisma.ungatedWatchEntry.findMany({
      where,
      orderBy: { createdAt: 'desc' },
    });
  }

  async update(id: string, data: Prisma.UngatedWatchEntryUpdateInput) {
    return this.prisma.ungatedWatchEntry.update({ where: { id }, data });
  }
}
```

- [ ] **Step 4: Verify the test passes**

Run: `cd apps/api && npx jest src/modules/ungated-track/repositories/ungated-watch.repository.spec.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/modules/ungated-track/repositories/ungated-watch.repository.ts apps/api/src/modules/ungated-track/repositories/ungated-watch.repository.spec.ts
git commit -m "feat(ungated): UngatedWatchRepository (mirror, equity-only)"
```

---

## Task 3: `UngatedTradeRepository` — subset mirror of `TradeRepository`

**Depends on:** Task 1

**Files:**
- Create: `apps/api/src/modules/ungated-track/repositories/ungated-trade.repository.ts`
- Test:   `apps/api/src/modules/ungated-track/repositories/ungated-trade.repository.spec.ts`

- [ ] **Step 1: Write the failing test**

```typescript
import { Test } from '@nestjs/testing';
import { UngatedTradeRepository } from './ungated-trade.repository';
import { PrismaService } from '../../../common/prisma/prisma.service';

describe('UngatedTradeRepository', () => {
  let repo: UngatedTradeRepository;
  let prisma: any;

  beforeEach(async () => {
    prisma = {
      ungatedTrade: {
        create:     jest.fn().mockResolvedValue({ id: 'ut1' }),
        findUnique: jest.fn(),
        findMany:   jest.fn().mockResolvedValue([]),
        update:     jest.fn().mockResolvedValue({}),
        aggregate:  jest.fn(),
      },
    };
    const mod = await Test.createTestingModule({
      providers: [
        UngatedTradeRepository,
        { provide: PrismaService, useValue: prisma },
      ],
    }).compile();
    repo = mod.get(UngatedTradeRepository);
  });

  it('getOpenTrades returns OPEN + PARTIALLY_FILLED statuses', async () => {
    await repo.getOpenTrades();
    const where = prisma.ungatedTrade.findMany.mock.calls[0][0].where;
    expect(where.status.in).toEqual(expect.arrayContaining(['OPEN', 'PARTIALLY_FILLED']));
  });

  it('findRealization returns { pnl, fees } per closed trade id', async () => {
    prisma.ungatedTrade.findMany.mockResolvedValue([
      { id: 'a', pnl: 100, fees: 12 },
      { id: 'b', pnl: null, fees: 0 },     // skip null pnl
      { id: 'c', pnl: -50, fees: null },   // null fees coerces to 0
    ]);
    const map = await repo.findRealization(['a', 'b', 'c']);
    expect(map.get('a')).toEqual({ pnl: 100, fees: 12 });
    expect(map.has('b')).toBe(false);
    expect(map.get('c')).toEqual({ pnl: -50, fees: 0 });
  });
});
```

- [ ] **Step 2: Verify failing**

Run: `cd apps/api && npx jest src/modules/ungated-track/repositories/ungated-trade.repository.spec.ts`
Expected: FAIL.

- [ ] **Step 3: Implement**

```typescript
import { Injectable } from '@nestjs/common';
import { Prisma, UngatedTrade } from '@prisma/client';
import { PrismaService } from '../../../common/prisma/prisma.service';

@Injectable()
export class UngatedTradeRepository {
  constructor(private readonly prisma: PrismaService) {}

  async createTrade(data: Prisma.UngatedTradeUncheckedCreateInput): Promise<UngatedTrade> {
    return this.prisma.ungatedTrade.create({ data });
  }

  async getTradeById(id: string) {
    return this.prisma.ungatedTrade.findUnique({ where: { id } });
  }

  async getOpenTrades() {
    return this.prisma.ungatedTrade.findMany({
      where: { status: { in: ['OPEN', 'PARTIALLY_FILLED'] } },
    });
  }

  async update(id: string, data: Prisma.UngatedTradeUpdateInput) {
    return this.prisma.ungatedTrade.update({ where: { id }, data });
  }

  async findRealization(
    tradeIds: string[],
  ): Promise<Map<string, { pnl: number; fees: number }>> {
    const ids = [...new Set(tradeIds.filter((x): x is string => !!x))];
    if (ids.length === 0) return new Map();
    const trades = await this.prisma.ungatedTrade.findMany({
      where: { id: { in: ids } },
      select: { id: true, pnl: true, fees: true },
    });
    return new Map(
      trades
        .filter((t) => t.pnl != null)
        .map((t) => [t.id, { pnl: t.pnl as number, fees: t.fees ?? 0 }]),
    );
  }

  async sumRealized(): Promise<{ pnl: number; fees: number }> {
    const r = await this.prisma.ungatedTrade.aggregate({
      where: { status: 'CLOSED' },
      _sum: { pnl: true, fees: true },
    });
    return { pnl: r._sum.pnl ?? 0, fees: r._sum.fees ?? 0 };
  }

  async sumDeployedOpen(): Promise<number> {
    const open = await this.getOpenTrades();
    return open.reduce(
      (s, t) => s + (t.entryPrice ?? 0) * (t.quantity ?? 0),
      0,
    );
  }
}
```

- [ ] **Step 4: Verify passing**

Run: same command. Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/modules/ungated-track/repositories/ungated-trade.repository.ts apps/api/src/modules/ungated-track/repositories/ungated-trade.repository.spec.ts
git commit -m "feat(ungated): UngatedTradeRepository"
```

---

## Task 4: `UngatedRejectionRepository` — new, small

**Depends on:** Task 1

**Files:**
- Create: `apps/api/src/modules/ungated-track/repositories/ungated-rejection.repository.ts`
- Test:   `apps/api/src/modules/ungated-track/repositories/ungated-rejection.repository.spec.ts`

- [ ] **Step 1: Failing test**

```typescript
import { Test } from '@nestjs/testing';
import { UngatedRejectionRepository } from './ungated-rejection.repository';
import { PrismaService } from '../../../common/prisma/prisma.service';

describe('UngatedRejectionRepository', () => {
  let repo: UngatedRejectionRepository;
  let prisma: any;

  beforeEach(async () => {
    prisma = {
      ungatedRejection: {
        create: jest.fn().mockResolvedValue({ id: 'r1' }),
        groupBy: jest.fn().mockResolvedValue([
          { reason: 'capital-exhausted', _count: { _all: 3 } },
          { reason: 'symbol-dup', _count: { _all: 2 } },
        ]),
      },
    };
    const mod = await Test.createTestingModule({
      providers: [
        UngatedRejectionRepository,
        { provide: PrismaService, useValue: prisma },
      ],
    }).compile();
    repo = mod.get(UngatedRejectionRepository);
  });

  it('record writes one row with reason + score + alertId', async () => {
    await repo.record({
      alertId: 'a1', symbol: 'TCS', reason: 'capital-exhausted', score: 42, hitPrice: 100,
    });
    const data = prisma.ungatedRejection.create.mock.calls[0][0].data;
    expect(data).toMatchObject({
      alertId: 'a1', symbol: 'TCS', reason: 'capital-exhausted', score: 42, hitPrice: 100,
    });
  });

  it('countByDate returns a reason → count map for one IST day', async () => {
    const counts = await repo.countByDate('2026-05-20');
    expect(counts).toEqual({ 'capital-exhausted': 3, 'symbol-dup': 2 });
    const where = prisma.ungatedRejection.groupBy.mock.calls[0][0].where;
    expect(where.createdAt.gte).toBeInstanceOf(Date);
    expect(where.createdAt.lte).toBeInstanceOf(Date);
  });
});
```

- [ ] **Step 2: Verify failing**

Run: `cd apps/api && npx jest src/modules/ungated-track/repositories/ungated-rejection.repository.spec.ts`
Expected: FAIL.

- [ ] **Step 3: Implement**

```typescript
import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../../common/prisma/prisma.service';

export type UngatedRejectionReason =
  | 'capital-exhausted'
  | 'position-cap'
  | 'symbol-dup'
  | 'cooldown'
  | 'kill-switch';

export interface UngatedRecordRejectionInput {
  alertId: string | null;
  symbol: string;
  reason: UngatedRejectionReason;
  score?: number | null;
  hitPrice?: number | null;
}

@Injectable()
export class UngatedRejectionRepository {
  constructor(private readonly prisma: PrismaService) {}

  async record(input: UngatedRecordRejectionInput): Promise<void> {
    await this.prisma.ungatedRejection.create({
      data: {
        alertId: input.alertId,
        symbol: input.symbol,
        reason: input.reason,
        score: input.score ?? null,
        hitPrice: input.hitPrice ?? null,
      },
    });
  }

  async countByDate(date: string): Promise<Record<string, number>> {
    const start = new Date(`${date}T00:00:00.000+05:30`);
    const end = new Date(`${date}T23:59:59.999+05:30`);
    const grouped = await this.prisma.ungatedRejection.groupBy({
      by: ['reason'],
      where: { createdAt: { gte: start, lte: end } },
      _count: { _all: true },
    });
    const out: Record<string, number> = {};
    for (const g of grouped) out[g.reason] = g._count._all;
    return out;
  }
}
```

- [ ] **Step 4: Verify passing**

Run: same command. Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/modules/ungated-track/repositories/ungated-rejection.repository.ts apps/api/src/modules/ungated-track/repositories/ungated-rejection.repository.spec.ts
git commit -m "feat(ungated): UngatedRejectionRepository (audit log)"
```

---

## Task 5: `UngatedPaperAccountService` — the canary ledger

**Depends on:** Tasks 1, 3

**Files:**
- Create: `apps/api/src/modules/ungated-track/services/ungated-paper-account.service.ts`
- Test:   `apps/api/src/modules/ungated-track/services/ungated-paper-account.service.spec.ts`

This is the §6 invariant enforcer. The spec's canary test (entry → partial → final loss-cut, asserting all four ledger fields) is implemented here.

- [ ] **Step 1: Canary failing test (the spec §9.A test)**

```typescript
import { Test } from '@nestjs/testing';
import { UngatedPaperAccountService, STARTING_BALANCE, TRADE_CAPITAL } from './ungated-paper-account.service';
import { UngatedTradeRepository } from '../repositories/ungated-trade.repository';
import { PrismaService } from '../../../common/prisma/prisma.service';

describe('UngatedPaperAccountService', () => {
  let svc: UngatedPaperAccountService;
  let prisma: any;
  let trades: any;

  beforeEach(async () => {
    let row = { id: 'a1', startingBalance: STARTING_BALANCE, cash: STARTING_BALANCE,
      realizedPnl: 0, fees: 0, deployedCapital: 0, killSwitchAt: null };
    prisma = {
      ungatedPaperAccount: {
        findFirst: jest.fn(async () => row),
        create:    jest.fn(async ({ data }) => { row = { ...row, ...data, id: 'a1' }; return row; }),
        update:    jest.fn(async ({ data }) => { row = { ...row, ...data }; return row; }),
      },
    };
    trades = { sumRealized: jest.fn(async () => ({ pnl: 0, fees: 0 })), sumDeployedOpen: jest.fn(async () => 0) };
    const mod = await Test.createTestingModule({
      providers: [
        UngatedPaperAccountService,
        { provide: PrismaService, useValue: prisma },
        { provide: UngatedTradeRepository, useValue: trades },
      ],
    }).compile();
    svc = mod.get(UngatedPaperAccountService);
    await svc.onModuleInit(); // seeds the row
  });

  it('canary: BUY 100 @ 2000 → partial 50 @ 2200 → final 50 @ 1990 leaves invariants intact', async () => {
    await svc.applyEntry({ entryPrice: 2000, quantity: 100, entryFees: 40 });
    let a = await svc.snapshot();
    expect(a.cash).toBe(STARTING_BALANCE - 200000);
    expect(a.deployedCapital).toBe(200000);
    expect(a.realizedPnl).toBe(0);
    expect(a.fees).toBe(40);

    // Partial: 50 shares closed at 2200. slicePnl = (2200-2000)*50 = 10000.
    // cash delta = +2200*50 = +110000  (NOT entryPrice * 50 — that's the bug class)
    // deployed delta = -2000*50 = -100000  (frozen at entry price)
    await svc.applyExit({
      entryPrice: 2000, exitPrice: 2200, quantity: 50, sideMul: 1, exitFees: 30,
    });
    a = await svc.snapshot();
    expect(a.cash).toBe(STARTING_BALANCE - 200000 + 110000);
    expect(a.deployedCapital).toBe(100000);
    expect(a.realizedPnl).toBe(10000);
    expect(a.fees).toBe(70);

    // Final loss-cut: 50 @ 1990. slicePnl = (1990-2000)*50 = -500.
    // cash delta = +1990*50 = +99500. deployed delta = -2000*50 = -100000.
    await svc.applyExit({
      entryPrice: 2000, exitPrice: 1990, quantity: 50, sideMul: 1, exitFees: 25,
    });
    a = await svc.snapshot();
    expect(a.cash).toBe(STARTING_BALANCE - 200000 + 110000 + 99500);
    expect(a.deployedCapital).toBe(0);
    expect(a.realizedPnl).toBe(9500);
    expect(a.fees).toBe(95);

    // Final invariants (no open positions):
    expect(a.cash).toBe(a.startingBalance + a.realizedPnl - a.fees);
  });

  it('admit() throws UngatedCapitalExhaustedError when cash < TRADE_CAPITAL', async () => {
    prisma.ungatedPaperAccount.findFirst.mockResolvedValue({
      id: 'a1', startingBalance: STARTING_BALANCE, cash: 50000, realizedPnl: 0,
      fees: 0, deployedCapital: 0, killSwitchAt: null,
    });
    await expect(svc.admit({ openTrades: 0 })).rejects.toThrow(/capital-exhausted|capital_exhausted/i);
  });

  it('admit() throws UngatedPositionCapError when openTrades >= 40', async () => {
    await expect(svc.admit({ openTrades: 40 })).rejects.toThrow(/position-cap|position_cap/i);
  });

  it('admit() throws UngatedKillSwitchError when killSwitchAt is set', async () => {
    prisma.ungatedPaperAccount.findFirst.mockResolvedValue({
      id: 'a1', startingBalance: STARTING_BALANCE, cash: STARTING_BALANCE, realizedPnl: 0,
      fees: 0, deployedCapital: 0, killSwitchAt: new Date(),
    });
    await expect(svc.admit({ openTrades: 0 })).rejects.toThrow(/kill-switch|kill_switch/i);
  });
});
```

- [ ] **Step 2: Verify failing**

Run: `cd apps/api && npx jest src/modules/ungated-track/services/ungated-paper-account.service.spec.ts`
Expected: FAIL — service doesn't exist.

- [ ] **Step 3: Implement**

```typescript
import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { PrismaService } from '../../../common/prisma/prisma.service';
import { UngatedTradeRepository } from '../repositories/ungated-trade.repository';

export const STARTING_BALANCE = 80_00_000;
export const TRADE_CAPITAL = 2_00_000;
export const MAX_CONCURRENT = 40;

export class UngatedCapitalExhaustedError extends Error {
  constructor(public readonly cash: number) {
    super(`ungated capital-exhausted (cash=${cash})`);
    this.name = 'UngatedCapitalExhaustedError';
  }
}
export class UngatedPositionCapError extends Error {
  constructor(public readonly openTrades: number) {
    super(`ungated position-cap reached (${openTrades}/${MAX_CONCURRENT})`);
    this.name = 'UngatedPositionCapError';
  }
}
export class UngatedKillSwitchError extends Error {
  constructor() {
    super('ungated kill-switch is active');
    this.name = 'UngatedKillSwitchError';
  }
}

export interface UngatedAccountSnapshot {
  id: string;
  startingBalance: number;
  cash: number;
  realizedPnl: number;
  fees: number;
  deployedCapital: number;
  killSwitchAt: Date | null;
  /** Derived live: equity = cash + deployedCapital + unrealizedPnl (caller adds unrealized). */
}

@Injectable()
export class UngatedPaperAccountService implements OnModuleInit {
  private readonly logger = new Logger(UngatedPaperAccountService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly trades: UngatedTradeRepository,
  ) {}

  async onModuleInit(): Promise<void> {
    const existing = await this.prisma.ungatedPaperAccount.findFirst();
    if (!existing) {
      await this.prisma.ungatedPaperAccount.create({
        data: { startingBalance: STARTING_BALANCE, cash: STARTING_BALANCE },
      });
      this.logger.log(`Seeded ungated_paper_account with ₹${STARTING_BALANCE}`);
      return;
    }
    // Reconcile from ungated_trades. Spec §5.4.
    const realized = await this.trades.sumRealized();
    const deployed = await this.trades.sumDeployedOpen();
    const recomputedCash =
      existing.startingBalance + realized.pnl - realized.fees - deployed;
    if (Math.abs(recomputedCash - existing.cash) > 1) {
      this.logger.warn(
        `ungated_paper_account.cash drift: stored=${existing.cash} recomputed=${recomputedCash} — overwriting`,
      );
      await this.prisma.ungatedPaperAccount.update({
        where: { id: existing.id },
        data: {
          cash: recomputedCash,
          realizedPnl: realized.pnl,
          fees: realized.fees,
          deployedCapital: deployed,
        },
      });
    }
  }

  async snapshot(): Promise<UngatedAccountSnapshot> {
    const row = await this.prisma.ungatedPaperAccount.findFirst();
    if (!row) throw new Error('ungated_paper_account row missing — call onModuleInit first');
    return row;
  }

  /** Pre-entry gate. Throws on capital / position-cap / kill-switch. */
  async admit(opts: { openTrades: number }): Promise<void> {
    const a = await this.snapshot();
    if (a.killSwitchAt) throw new UngatedKillSwitchError();
    if (a.cash < TRADE_CAPITAL) throw new UngatedCapitalExhaustedError(a.cash);
    if (opts.openTrades >= MAX_CONCURRENT) throw new UngatedPositionCapError(opts.openTrades);
  }

  /** Entry fill: cash -= notional, deployed += notional, fees += entryFees. */
  async applyEntry(args: {
    entryPrice: number; quantity: number; entryFees: number;
  }): Promise<void> {
    const notional = args.entryPrice * args.quantity;
    const a = await this.snapshot();
    await this.prisma.ungatedPaperAccount.update({
      where: { id: a.id },
      data: {
        cash: a.cash - notional,
        deployedCapital: a.deployedCapital + notional,
        fees: a.fees + args.entryFees,
      },
    });
  }

  /**
   * Exit fill (partial OR final). The asymmetry is critical:
   *   cash    += exitPrice * quantity   (real money received)
   *   deployed -= entryPrice * quantity  (capital frozen at entry, released at entry)
   *   realized += (exitPrice - entryPrice) * sideMul * quantity
   *   fees    += exitFees
   */
  async applyExit(args: {
    entryPrice: number; exitPrice: number; quantity: number;
    sideMul: 1 | -1; exitFees: number;
  }): Promise<void> {
    const a = await this.snapshot();
    const cashIn = args.exitPrice * args.quantity;
    const deployedOut = args.entryPrice * args.quantity;
    const slicePnl =
      args.sideMul * (args.exitPrice - args.entryPrice) * args.quantity;
    await this.prisma.ungatedPaperAccount.update({
      where: { id: a.id },
      data: {
        cash: a.cash + cashIn,
        deployedCapital: a.deployedCapital - deployedOut,
        realizedPnl: a.realizedPnl + slicePnl,
        fees: a.fees + args.exitFees,
      },
    });
  }
}
```

- [ ] **Step 4: Verify passing**

Run: same command. Expected: 4 tests PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/modules/ungated-track/services/ungated-paper-account.service.ts apps/api/src/modules/ungated-track/services/ungated-paper-account.service.spec.ts
git commit -m "feat(ungated): UngatedPaperAccountService ledger + canary invariants"
```

---

## Task 6: `UngatedTradeExecutionService` — paper-only mirror of `TradeExecutionService`

**Depends on:** Tasks 1, 3, 5

**Files:**
- Create: `apps/api/src/modules/ungated-track/services/ungated-trade-execution.service.ts`
- Test:   `apps/api/src/modules/ungated-track/services/ungated-trade-execution.service.spec.ts`

Mirror of `apps/api/src/modules/trade-engine/services/trade-execution.service.ts` for the paper-only path. Drop live-broker branches entirely (no `BROKER_ADAPTER_TOKEN`). Reuse `computeOrderCharges` from `@td/shared` (the existing fees model).

- [ ] **Step 1: Failing test — open + close-with-explicit-exit-price**

```typescript
import { Test } from '@nestjs/testing';
import { UngatedTradeExecutionService } from './ungated-trade-execution.service';
import { UngatedTradeRepository } from '../repositories/ungated-trade.repository';
import { UngatedPaperAccountService } from './ungated-paper-account.service';

describe('UngatedTradeExecutionService', () => {
  let svc: UngatedTradeExecutionService;
  let trades: any;
  let account: any;

  beforeEach(async () => {
    trades = {
      createTrade: jest.fn(async (d) => ({ id: 'ut1', ...d, status: 'OPEN' })),
      getTradeById: jest.fn(async () => ({
        id: 'ut1', side: 'BUY', quantity: 100, entryPrice: 2000,
        status: 'OPEN', isPaperTrade: true,
      })),
      update: jest.fn(async (id, data) => ({ id, ...data })),
    };
    account = {
      applyEntry: jest.fn(), applyExit: jest.fn(),
    };
    const mod = await Test.createTestingModule({
      providers: [
        UngatedTradeExecutionService,
        { provide: UngatedTradeRepository, useValue: trades },
        { provide: UngatedPaperAccountService, useValue: account },
      ],
    }).compile();
    svc = mod.get(UngatedTradeExecutionService);
  });

  it('openTrade creates row + applies entry to the ledger', async () => {
    await svc.openTrade({
      instrumentId: 'i1', side: 'BUY', quantity: 100, entryPrice: 2000,
      exchange: 'NSE', target: 2040,
    });
    expect(trades.createTrade).toHaveBeenCalledTimes(1);
    expect(account.applyEntry).toHaveBeenCalledWith(expect.objectContaining({
      entryPrice: 2000, quantity: 100,
    }));
  });

  it('closeTrade with opts.exitPrice uses that price (not entry/last fallback)', async () => {
    const out = await svc.closeTrade('ut1', { reason: 'sl-loss-cut', exitPrice: 1990 });
    expect(out.exitPrice).toBe(1990);
    // P&L = (1990-2000) * 100 = -1000
    expect(out.pnl).toBeCloseTo(-1000, 2);
    expect(account.applyExit).toHaveBeenCalledWith(expect.objectContaining({
      entryPrice: 2000, exitPrice: 1990, quantity: 100, sideMul: 1,
    }));
  });

  it('closeTrade with quantity option closes a partial slice', async () => {
    const out = await svc.closeTrade('ut1', {
      reason: 'partial-exit', quantity: 50, exitPrice: 2050,
    });
    expect(out.status).toBe('PARTIALLY_FILLED');
    expect(account.applyExit).toHaveBeenCalledWith(expect.objectContaining({ quantity: 50 }));
  });
});
```

- [ ] **Step 2: Verify failing**

Run: `cd apps/api && npx jest src/modules/ungated-track/services/ungated-trade-execution.service.spec.ts`
Expected: FAIL.

- [ ] **Step 3: Implement**

```typescript
import { Injectable, Logger } from '@nestjs/common';
import { computeOrderCharges } from '@td/shared';
import { UngatedTradeRepository } from '../repositories/ungated-trade.repository';
import { UngatedPaperAccountService } from './ungated-paper-account.service';

export interface UngatedOpenTradeInput {
  instrumentId: string;
  side: 'BUY' | 'SELL';
  quantity: number;
  entryPrice: number;
  exchange: string;
  target?: number | null;
  stoploss?: number | null;
}

export interface UngatedCloseTradeOpts {
  reason: string;
  exitPrice: number;   // REQUIRED on ungated track — every caller knows the trigger price
  quantity?: number;   // omit to close all; partial otherwise
}

/**
 * MIRROR (paper-only subset) of trade-execution.service.ts.
 * No live broker — every trade is paper. opts.exitPrice is REQUIRED, not optional
 * (we control every call site, so the bug class from commits 9fb5bcd / 75a8559 is
 * impossible by construction here).
 */
@Injectable()
export class UngatedTradeExecutionService {
  private readonly logger = new Logger(UngatedTradeExecutionService.name);

  constructor(
    private readonly trades: UngatedTradeRepository,
    private readonly account: UngatedPaperAccountService,
  ) {}

  async openTrade(input: UngatedOpenTradeInput) {
    const charges = computeOrderCharges({
      side: input.side,
      price: input.entryPrice,
      quantity: input.quantity,
      exchange: input.exchange,
    });
    const trade = await this.trades.createTrade({
      instrumentId: input.instrumentId,
      side: input.side,
      orderType: 'MARKET',
      positionType: 'INTRADAY',
      quantity: input.quantity,
      entryPrice: input.entryPrice,
      target: input.target ?? null,
      stoploss: input.stoploss ?? null,
      fees: charges.total,
      status: 'OPEN',
      isPaperTrade: true,
      entryTime: new Date(),
    });
    await this.account.applyEntry({
      entryPrice: input.entryPrice,
      quantity: input.quantity,
      entryFees: charges.total,
    });
    return trade;
  }

  async closeTrade(tradeId: string, opts: UngatedCloseTradeOpts) {
    const trade = await this.trades.getTradeById(tradeId);
    if (!trade) throw new Error(`UngatedTrade ${tradeId} not found`);
    if (trade.status !== 'OPEN' && trade.status !== 'PARTIALLY_FILLED') {
      throw new Error(`Cannot close trade with status ${trade.status}`);
    }
    const closeQty = Math.min(
      Math.max(1, Math.floor(opts.quantity ?? trade.quantity)),
      trade.quantity,
    );
    const isFullClose = closeQty >= trade.quantity;
    const sideMul: 1 | -1 = trade.side === 'BUY' ? 1 : -1;
    const exitSide = trade.side === 'BUY' ? 'SELL' : 'BUY';

    const exitCharges = computeOrderCharges({
      side: exitSide as 'BUY' | 'SELL',
      price: opts.exitPrice,
      quantity: closeQty,
      exchange: 'NSE', // ungated track is equity-only NSE
    });

    const slicePnl =
      sideMul * (opts.exitPrice - (trade.entryPrice ?? 0)) * closeQty;
    const pnlPercent =
      (trade.entryPrice ?? 0) > 0
        ? (sideMul * (opts.exitPrice - (trade.entryPrice ?? 0))) /
            (trade.entryPrice ?? 1) *
            100
        : 0;

    const updateData: any = {
      pnl: (trade.pnl ?? 0) + slicePnl,
      pnlPercent,
      fees: (trade.fees ?? 0) + exitCharges.total,
      exitReasonTag: opts.reason,
      exitNotes: opts.reason,
    };
    if (isFullClose) {
      updateData.exitPrice = opts.exitPrice;
      updateData.exitTime = new Date();
      updateData.status = 'CLOSED';
      updateData.quantity = trade.quantity; // unchanged on full close
    } else {
      updateData.quantity = trade.quantity - closeQty;
      updateData.status = 'PARTIALLY_FILLED';
    }

    const updated = await this.trades.update(tradeId, updateData);

    await this.account.applyExit({
      entryPrice: trade.entryPrice ?? 0,
      exitPrice: opts.exitPrice,
      quantity: closeQty,
      sideMul,
      exitFees: exitCharges.total,
    });

    return updated;
  }
}
```

- [ ] **Step 4: Verify passing**

Run: same command. Expected: 3 tests PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/modules/ungated-track/services/ungated-trade-execution.service.ts apps/api/src/modules/ungated-track/services/ungated-trade-execution.service.spec.ts
git commit -m "feat(ungated): UngatedTradeExecutionService (paper-only, exitPrice required)"
```

---

## Task 7: `UngatedWatchService.createFromAlert` — admission + auto-execute

**Depends on:** Tasks 1, 2, 5, 6

**Files:**
- Create: `apps/api/src/modules/ungated-track/services/ungated-watch.service.ts`
- Test:   `apps/api/src/modules/ungated-track/services/ungated-watch.service.spec.ts`

This task builds ONLY the admission + executeEntry flow. Tick/lifecycle goes in Task 8.

- [ ] **Step 1: Failing tests for admission rules + symbol dedup + auto-execute**

```typescript
import { Test } from '@nestjs/testing';
import { UngatedWatchService, UngatedSymbolDupError } from './ungated-watch.service';
import { UngatedWatchRepository } from '../repositories/ungated-watch.repository';
import { UngatedTradeRepository } from '../repositories/ungated-trade.repository';
import {
  UngatedPaperAccountService, TRADE_CAPITAL, MAX_CONCURRENT,
  UngatedCapitalExhaustedError, UngatedPositionCapError,
} from './ungated-paper-account.service';
import { UngatedTradeExecutionService } from './ungated-trade-execution.service';

describe('UngatedWatchService.createFromAlert', () => {
  let svc: UngatedWatchService;
  let repo: any, trades: any, account: any, exec: any;

  const baseInput = {
    alertId: 'a1', setupId: null, symbol: 'TCS', token: '11536', exchange: 'NSE',
    side: 'BUY' as const, initialPrice: 2000, initialScore: 42,
    initialBreakdown: { checks: [] },
  };

  beforeEach(async () => {
    repo = {
      findActiveByToken: jest.fn().mockResolvedValue([]),
      countOpenTrades:   jest.fn().mockResolvedValue(0),
      createEntry:       jest.fn().mockResolvedValue({ id: 'uw1', token: '11536' }),
      createEvent:       jest.fn(),
      update:            jest.fn().mockResolvedValue({}),
      findById:          jest.fn().mockResolvedValue({
        id: 'uw1', token: '11536', side: 'BUY', initialPrice: 2000,
        status: 'WATCHING', exchange: 'NSE',
      }),
    };
    trades = {};
    account = {
      admit: jest.fn().mockResolvedValue(undefined),
      applyEntry: jest.fn(),
    };
    exec = {
      openTrade: jest.fn().mockResolvedValue({ id: 'ut1', entryPrice: 2000 }),
    };
    const mod = await Test.createTestingModule({
      providers: [
        UngatedWatchService,
        { provide: UngatedWatchRepository, useValue: repo },
        { provide: UngatedTradeRepository, useValue: trades },
        { provide: UngatedPaperAccountService, useValue: account },
        { provide: UngatedTradeExecutionService, useValue: exec },
      ],
    }).compile();
    svc = mod.get(UngatedWatchService);
  });

  it('rejects when the same token already has a non-terminal entry (symbol-dup)', async () => {
    repo.findActiveByToken.mockResolvedValue([{ id: 'prev', token: '11536' }]);
    await expect(svc.createFromAlert(baseInput)).rejects.toBeInstanceOf(UngatedSymbolDupError);
  });

  it('forwards account.admit failures (capital / cap / kill-switch)', async () => {
    account.admit.mockRejectedValue(new UngatedCapitalExhaustedError(50_000));
    await expect(svc.createFromAlert(baseInput)).rejects.toBeInstanceOf(UngatedCapitalExhaustedError);
  });

  it('on admission, sizes qty = floor(2L / initialPrice) and opens the trade', async () => {
    await svc.createFromAlert(baseInput);
    expect(exec.openTrade).toHaveBeenCalledWith(expect.objectContaining({
      quantity: Math.floor(TRADE_CAPITAL / 2000), // 100
      entryPrice: 2000,
      side: 'BUY',
    }));
  });

  it('always sizes at least 1 share even when price exceeds TRADE_CAPITAL', async () => {
    await svc.createFromAlert({ ...baseInput, initialPrice: 250_000 });
    expect(exec.openTrade).toHaveBeenCalledWith(expect.objectContaining({ quantity: 1 }));
  });

  it('sets the entry to TRADED and persists paperTradeId after openTrade', async () => {
    await svc.createFromAlert(baseInput);
    expect(repo.update).toHaveBeenCalledWith('uw1', expect.objectContaining({
      status: 'TRADED', paperTradeId: 'ut1', executedPrice: 2000,
    }));
  });
});
```

- [ ] **Step 2: Verify failing**

Run: `cd apps/api && npx jest src/modules/ungated-track/services/ungated-watch.service.spec.ts`
Expected: FAIL.

- [ ] **Step 3: Implement (admission + executeEntry only)**

```typescript
import { Injectable, Logger } from '@nestjs/common';
import { Prisma, WatchEventType, WatchStatus } from '@prisma/client';
import {
  UngatedWatchRepository, UngatedCreateEntryInput,
} from '../repositories/ungated-watch.repository';
import { UngatedTradeRepository } from '../repositories/ungated-trade.repository';
import { UngatedPaperAccountService, TRADE_CAPITAL } from './ungated-paper-account.service';
import { UngatedTradeExecutionService } from './ungated-trade-execution.service';

export class UngatedSymbolDupError extends Error {
  constructor(public readonly symbol: string) {
    super(`ungated: symbol ${symbol} already has an active entry`);
    this.name = 'UngatedSymbolDupError';
  }
}
export class UngatedCooldownError extends Error {
  constructor(public readonly symbol: string) {
    super(`ungated: symbol ${symbol} in cooldown`);
    this.name = 'UngatedCooldownError';
  }
}

export interface UngatedCreateFromAlertInput {
  alertId: string | null;
  setupId: string | null;
  symbol: string;
  token: string;
  exchange: string;
  side: 'BUY' | 'SELL';
  initialPrice: number;
  initialScore: number;
  initialBreakdown: Prisma.InputJsonValue;
}

const PROFIT_TARGET_PCT = 0.02; // 2% fallback — no indicator-sr on ungated (YAGNI)
export const TRADE_COOLDOWN_MS = 30 * 60_000; // 30 min after exit

@Injectable()
export class UngatedWatchService {
  private readonly logger = new Logger(UngatedWatchService.name);

  constructor(
    private readonly repo: UngatedWatchRepository,
    private readonly trades: UngatedTradeRepository,
    private readonly account: UngatedPaperAccountService,
    private readonly exec: UngatedTradeExecutionService,
  ) {}

  async createFromAlert(input: UngatedCreateFromAlertInput) {
    // 1. Symbol dedup — token-based, mirrors gated rule.
    const active = await this.repo.findActiveByToken(input.token);
    if (active.length > 0) throw new UngatedSymbolDupError(input.symbol);

    // 2. Admission (capital + position cap + kill switch).
    const openTrades = await this.repo.countOpenTrades();
    await this.account.admit({ openTrades });

    // 3. Compute the 2% fallback profit target.
    const sideMul = input.side === 'BUY' ? 1 : -1;
    const profitTarget =
      input.initialPrice * (1 + sideMul * PROFIT_TARGET_PCT);

    // 4. Create the WATCHING entry row.
    const createInput: UngatedCreateEntryInput = {
      alertId: input.alertId,
      setupId: input.setupId,
      symbol: input.symbol,
      token: input.token,
      exchange: input.exchange,
      side: input.side,
      initialPrice: input.initialPrice,
      initialScore: input.initialScore,
      initialBreakdown: input.initialBreakdown,
      profitTarget,
      profitTargetSource: 'fallback-2pct',
      stopLossScore: 50,
    };
    const entry = await this.repo.createEntry(createInput);
    await this.repo.createEvent({
      watchEntryId: entry.id,
      eventType: WatchEventType.INITIAL,
      price: input.initialPrice,
      score: input.initialScore,
      breakdown: input.initialBreakdown,
    });

    // 5. Auto-execute — every admitted ungated alert opens its trade immediately.
    const qty = Math.max(1, Math.floor(TRADE_CAPITAL / Math.max(input.initialPrice, 1)));
    const trade = await this.exec.openTrade({
      instrumentId: entry.id, // placeholder — controller can rewire to a real instrument row if needed
      side: input.side,
      quantity: qty,
      entryPrice: input.initialPrice,
      exchange: input.exchange,
      target: profitTarget,
    });
    await this.repo.update(entry.id, {
      status: WatchStatus.TRADED,
      paperTradeId: trade.id,
      executedAt: new Date(),
      executedPrice: input.initialPrice,
      quantity: qty,
    });

    return entry;
  }
}
```

- [ ] **Step 4: Verify passing**

Run: same command. Expected: 5 tests PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/modules/ungated-track/services/ungated-watch.service.ts apps/api/src/modules/ungated-track/services/ungated-watch.service.spec.ts
git commit -m "feat(ungated): UngatedWatchService admission + auto-execute"
```

---

## Task 8: `UngatedWatchService` — lifecycle (tick handler + transitions)

**Depends on:** Task 7

**Files:**
- Modify: `apps/api/src/modules/ungated-track/services/ungated-watch.service.ts`
- Modify: `apps/api/src/modules/ungated-track/services/ungated-watch.service.spec.ts`

Implements `onTick(token, ltp, ts)` which runs target-hit → hard-loss-cut → partial-exit → trailing-stop in that order. Mirrors `watch.service.ts:applyTick` faithfully — including the fix from commits `9fb5bcd` + `75a8559` (forwarding `opts.exitPrice` on every close).

- [ ] **Step 1: Failing tests for each transition**

Append to the spec from Task 7:

```typescript
describe('UngatedWatchService.onTick — transitions', () => {
  let svc: UngatedWatchService;
  let repo: any, account: any, exec: any;

  function tradedEntry(overrides: Record<string, any> = {}) {
    return {
      id: 'uw1', token: '11536', symbol: 'TCS', side: 'BUY', status: 'TRADED',
      initialPrice: 2000, executedPrice: 2000, profitTarget: 2040,
      paperTradeId: 'ut1', quantity: 100, remainingQty: 100,
      partialExitedAt: null, trailingHighWater: null, trailingStopPrice: null,
      ...overrides,
    };
  }

  beforeEach(async () => {
    repo = {
      findActiveByToken: jest.fn(),
      findById:          jest.fn(),
      createEvent:       jest.fn(),
      update:            jest.fn().mockResolvedValue({}),
    };
    account = {};
    exec = { closeTrade: jest.fn().mockResolvedValue({}) };
    const mod = await Test.createTestingModule({
      providers: [
        UngatedWatchService,
        { provide: UngatedWatchRepository, useValue: repo },
        { provide: UngatedTradeRepository, useValue: { } },
        { provide: UngatedPaperAccountService, useValue: account },
        { provide: UngatedTradeExecutionService, useValue: exec },
      ],
    }).compile();
    svc = mod.get(UngatedWatchService);
  });

  it('BUY: ltp >= profitTarget → target-hit, forwards exitPrice', async () => {
    repo.findActiveByToken.mockResolvedValue([tradedEntry()]);
    await svc.onTick('11536', 2045, new Date());
    expect(exec.closeTrade).toHaveBeenCalledWith('ut1', expect.objectContaining({
      reason: 'target-hit', exitPrice: 2045,
    }));
    expect(repo.update).toHaveBeenCalledWith('uw1', expect.objectContaining({
      status: 'TARGET_HIT',
    }));
  });

  it('hard loss-cut at -0.4% of deployed → forwards exitPrice', async () => {
    // deployed = 2000*100 = 200000. 0.4% = 800. So ltp where loss = 800: 2000 - 8 = 1992.
    repo.findActiveByToken.mockResolvedValue([tradedEntry()]);
    await svc.onTick('11536', 1992, new Date());
    expect(exec.closeTrade).toHaveBeenCalledWith('ut1', expect.objectContaining({
      reason: 'sl-loss-cut', exitPrice: 1992,
    }));
    expect(repo.update).toHaveBeenCalledWith('uw1', expect.objectContaining({
      status: 'STOPPED', closedReason: 'loss-cut',
    }));
  });

  it('+1% favorable triggers partial exit, forwards exitPrice + sets trailing fields', async () => {
    repo.findActiveByToken.mockResolvedValue([tradedEntry({ profitTarget: 9999 })]);
    await svc.onTick('11536', 2020, new Date()); // +1.00%
    expect(exec.closeTrade).toHaveBeenCalledWith('ut1', expect.objectContaining({
      reason: 'partial-exit', quantity: 50, exitPrice: 2020,
    }));
    expect(repo.update).toHaveBeenCalledWith('uw1', expect.objectContaining({
      partialExitedAt: expect.any(Date),
      partialExitPrice: 2020,
      partialQty: 50,
      remainingQty: 50,
      trailingHighWater: 2020,
      trailingStopPrice: 2020 * 0.995, // BUY trail = ltp * (1 - 0.005)
    }));
  });

  it('post-partial: price drops below trail → trailing-stop fires, exitPrice forwarded', async () => {
    repo.findActiveByToken.mockResolvedValue([
      tradedEntry({
        profitTarget: 9999, partialExitedAt: new Date(),
        partialExitPrice: 2020, partialQty: 50, remainingQty: 50,
        trailingHighWater: 2025, trailingStopPrice: 2025 * 0.995,
      }),
    ]);
    const trailStop = 2025 * 0.995;
    await svc.onTick('11536', trailStop - 1, new Date());
    expect(exec.closeTrade).toHaveBeenCalledWith('ut1', expect.objectContaining({
      reason: 'trailing-stop', exitPrice: trailStop - 1,
    }));
    expect(repo.update).toHaveBeenCalledWith('uw1', expect.objectContaining({
      status: 'EXITED', closedReason: 'trailing-stop',
    }));
  });
});
```

- [ ] **Step 2: Verify failing**

Run: `cd apps/api && npx jest src/modules/ungated-track/services/ungated-watch.service.spec.ts`
Expected: FAIL — `onTick` doesn't exist yet.

- [ ] **Step 3: Implement onTick + transitions**

Add the following methods to the `UngatedWatchService` class created in Task 7 (do not duplicate the class declaration, just append the methods inside the existing class body):

```typescript
  // --- Constants (paste near class top, after constructor) ----------------
  private readonly HARD_STOP_PCT = 0.004;            // R5: 0.4% of deployed
  private readonly PARTIAL_EXIT_THRESHOLD_PCT = 0.01; // +1% favorable
  private readonly PARTIAL_EXIT_FRACTION = 0.5;       // sell half
  private readonly TRAILING_STOP_PCT = 0.005;         // 0.5% from high-water

  // --- Public tick entrypoint ---------------------------------------------
  async onTick(token: string, ltp: number, _ts: Date): Promise<void> {
    const entries = await this.repo.findActiveByToken(token);
    for (const entry of entries) {
      if (entry.status !== 'TRADED') continue;
      try {
        await this.applyTick(entry, ltp);
      } catch (err) {
        this.logger.warn(
          `[ungated] applyTick ${entry.symbol} threw: ${err instanceof Error ? err.message : err}`,
        );
      }
    }
  }

  private async applyTick(entry: any, ltp: number): Promise<void> {
    // 1. Target-hit (first — a profit exit wins over loss/partial).
    const sideMul: 1 | -1 = entry.side === 'BUY' ? 1 : -1;
    const isTargetHit =
      entry.profitTarget != null &&
      (sideMul === 1 ? ltp >= entry.profitTarget : ltp <= entry.profitTarget);
    if (isTargetHit) return this.transitionTargetHit(entry, ltp);

    // 2. Hard loss-cut (R5).
    const openLoss = this.computeOpenPnl(entry, ltp);
    const threshold = -this.HARD_STOP_PCT *
      (entry.executedPrice ?? entry.initialPrice) *
      (entry.remainingQty ?? entry.quantity ?? 0);
    if (openLoss <= threshold) return this.transitionLossCut(entry, ltp, openLoss);

    // 3. Partial-exit + trailing-stop (only after we've cleared loss-cut).
    if (!entry.partialExitedAt) {
      await this.checkPartialExitTrigger(entry, ltp);
    } else {
      await this.updateTrailingStop(entry, ltp);
    }
  }

  private computeOpenPnl(entry: any, ltp: number): number {
    const ref = entry.executedPrice ?? entry.initialPrice;
    const sideMul: 1 | -1 = entry.side === 'BUY' ? 1 : -1;
    const qty = entry.remainingQty ?? entry.quantity ?? 0;
    return (ltp - ref) * sideMul * qty;
  }

  private async transitionTargetHit(entry: any, price: number): Promise<void> {
    await this.repo.createEvent({
      watchEntryId: entry.id, eventType: WatchEventType.TARGET_HIT, price,
    });
    await this.exec.closeTrade(entry.paperTradeId, {
      reason: 'target-hit', exitPrice: price,
    });
    await this.repo.update(entry.id, {
      status: WatchStatus.TARGET_HIT, closedAt: new Date(), closedReason: 'target-hit',
    });
  }

  private async transitionLossCut(entry: any, exitPrice: number, openLoss: number): Promise<void> {
    await this.repo.createEvent({
      watchEntryId: entry.id, eventType: WatchEventType.SL_HIT_PRICE, price: exitPrice,
      notes: `cause:loss-cut loss:${Math.abs(openLoss).toFixed(0)}`,
    });
    await this.exec.closeTrade(entry.paperTradeId, {
      reason: 'sl-loss-cut', exitPrice,
    });
    await this.repo.update(entry.id, {
      status: WatchStatus.STOPPED, closedAt: new Date(), closedReason: 'loss-cut',
    });
  }

  private async checkPartialExitTrigger(entry: any, ltp: number): Promise<void> {
    const ref = entry.executedPrice ?? entry.initialPrice;
    if (ref <= 0) return;
    const sideMul: 1 | -1 = entry.side === 'BUY' ? 1 : -1;
    const moveFavor = ((ltp - ref) / ref) * sideMul;
    if (moveFavor < this.PARTIAL_EXIT_THRESHOLD_PCT) return;

    const initialQty = entry.quantity ??
      Math.max(1, Math.floor(2_00_000 / Math.max(ref, 1)));
    const partialQty = Math.floor(initialQty * this.PARTIAL_EXIT_FRACTION);
    const remainingQty = initialQty - partialQty;
    const trailingStopPrice = sideMul === 1
      ? ltp * (1 - this.TRAILING_STOP_PCT)
      : ltp * (1 + this.TRAILING_STOP_PCT);

    await this.exec.closeTrade(entry.paperTradeId, {
      reason: 'partial-exit', quantity: partialQty, exitPrice: ltp,
    });
    await this.repo.createEvent({
      watchEntryId: entry.id, eventType: WatchEventType.PARTIAL_EXIT, price: ltp,
      notes: `partial 50% sold at +${(moveFavor * 100).toFixed(2)}%, trail @ ${trailingStopPrice.toFixed(2)}`,
    });
    await this.repo.update(entry.id, {
      partialExitedAt: new Date(),
      partialExitPrice: ltp,
      partialQty,
      remainingQty,
      trailingHighWater: ltp,
      trailingStopPrice,
    });
  }

  private async updateTrailingStop(entry: any, ltp: number): Promise<void> {
    const sideMul: 1 | -1 = entry.side === 'BUY' ? 1 : -1;
    let highWater = entry.trailingHighWater;
    let newStop = entry.trailingStopPrice;
    const moves = sideMul === 1 ? ltp > highWater : ltp < highWater;
    if (moves) {
      highWater = ltp;
      newStop = sideMul === 1 ? ltp * (1 - this.TRAILING_STOP_PCT) : ltp * (1 + this.TRAILING_STOP_PCT);
      await this.repo.update(entry.id, {
        trailingHighWater: highWater,
        trailingStopPrice: newStop,
      });
    }
    const hit = sideMul === 1 ? ltp <= newStop : ltp >= newStop;
    if (hit) {
      await this.exec.closeTrade(entry.paperTradeId, {
        reason: 'trailing-stop', exitPrice: ltp,
      });
      await this.repo.createEvent({
        watchEntryId: entry.id, eventType: WatchEventType.TRAILING_STOP_HIT, price: ltp,
        notes: `trail stop fired (high-water ${highWater}, stop ${newStop.toFixed(2)})`,
      });
      await this.repo.update(entry.id, {
        status: WatchStatus.EXITED, closedAt: new Date(), closedReason: 'trailing-stop',
      });
    }
  }
```

- [ ] **Step 4: Verify passing**

Run: same command. Expected: all tests PASS (Task 7's 5 + Task 8's 4 = 9).

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/modules/ungated-track/services/ungated-watch.service.ts apps/api/src/modules/ungated-track/services/ungated-watch.service.spec.ts
git commit -m "feat(ungated): UngatedWatchService lifecycle (target/loss-cut/partial/trail, exitPrice plumbed)"
```

---

## Task 9: `UngatedComparisonService` — daily verdict

**Depends on:** Tasks 3, 4

**Files:**
- Create: `apps/api/src/modules/ungated-track/services/ungated-comparison.service.ts`
- Test:   `apps/api/src/modules/ungated-track/services/ungated-comparison.service.spec.ts`

- [ ] **Step 1: Failing test**

```typescript
import { Test } from '@nestjs/testing';
import { UngatedComparisonService } from './ungated-comparison.service';
import { UngatedTradeRepository } from '../repositories/ungated-trade.repository';
import { UngatedRejectionRepository } from '../repositories/ungated-rejection.repository';
import { PrismaService } from '../../../common/prisma/prisma.service';

describe('UngatedComparisonService', () => {
  let svc: UngatedComparisonService;
  let prisma: any, trades: any, rejections: any;

  beforeEach(async () => {
    prisma = {
      trade: { findMany: jest.fn().mockResolvedValue([
        { pnl: 100, fees: 10 }, { pnl: -300, fees: 12 },
      ]) },
    };
    trades = {};
    rejections = {
      countByDate: jest.fn().mockResolvedValue({ 'capital-exhausted': 3 }),
    };
    // Stub the ungated-side via prisma.ungatedTrade.findMany (the service queries the model directly).
    prisma.ungatedTrade = { findMany: jest.fn().mockResolvedValue([
      { pnl: 1000, fees: 50 }, { pnl: 800, fees: 40 }, { pnl: -200, fees: 30 },
    ]) };

    const mod = await Test.createTestingModule({
      providers: [
        UngatedComparisonService,
        { provide: PrismaService, useValue: prisma },
        { provide: UngatedTradeRepository, useValue: trades },
        { provide: UngatedRejectionRepository, useValue: rejections },
      ],
    }).compile();
    svc = mod.get(UngatedComparisonService);
  });

  it('computes gated + ungated + edge for one IST day', async () => {
    const r = await svc.daily('2026-05-20');
    expect(r.gated).toEqual({
      tradeCount: 2, gross: -200, charges: 22, net: -222,
    });
    expect(r.ungated).toMatchObject({
      tradeCount: 3, gross: 1600, charges: 120, net: 1480,
      rejected: { 'capital-exhausted': 3 },
    });
    expect(r.edge.netDiff).toBe(-222 - 1480); // gated - ungated
    expect(r.edge.verdict).toMatch(/ungated outperformed/i);
  });

  it('verdict says "gate added value" when gated.net > ungated.net by ≥ ₹100', async () => {
    prisma.trade.findMany.mockResolvedValue([{ pnl: 5000, fees: 50 }]);
    prisma.ungatedTrade.findMany.mockResolvedValue([{ pnl: 100, fees: 20 }]);
    const r = await svc.daily('2026-05-20');
    expect(r.edge.verdict).toMatch(/gate added value/i);
  });

  it('verdict is neutral when |netDiff| < ₹100', async () => {
    prisma.trade.findMany.mockResolvedValue([{ pnl: 100, fees: 5 }]);
    prisma.ungatedTrade.findMany.mockResolvedValue([{ pnl: 130, fees: 10 }]);
    const r = await svc.daily('2026-05-20');
    expect(r.edge.verdict).toMatch(/no meaningful edge/i);
  });
});
```

- [ ] **Step 2: Verify failing**

Run: `cd apps/api && npx jest src/modules/ungated-track/services/ungated-comparison.service.spec.ts`
Expected: FAIL.

- [ ] **Step 3: Implement**

```typescript
import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../../common/prisma/prisma.service';
import { UngatedTradeRepository } from '../repositories/ungated-trade.repository';
import { UngatedRejectionRepository } from '../repositories/ungated-rejection.repository';

export interface DailyComparison {
  date: string;
  gated:   { tradeCount: number; gross: number; charges: number; net: number };
  ungated: {
    tradeCount: number; gross: number; charges: number; net: number;
    rejected: Record<string, number>;
  };
  edge: {
    netDiff: number; // gated.net - ungated.net
    verdict: string;
  };
}

const NEUTRAL_BAND = 100; // ₹

@Injectable()
export class UngatedComparisonService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly _trades: UngatedTradeRepository, // reserved; future hook for streaming totals
    private readonly rejections: UngatedRejectionRepository,
  ) {}

  async daily(date: string): Promise<DailyComparison> {
    const start = new Date(`${date}T00:00:00.000+05:30`);
    const end = new Date(`${date}T23:59:59.999+05:30`);

    const [gatedRows, ungatedRows, rejected] = await Promise.all([
      this.prisma.trade.findMany({
        where: { isPaperTrade: true, status: 'CLOSED', exitTime: { gte: start, lte: end } },
        select: { pnl: true, fees: true },
      }),
      this.prisma.ungatedTrade.findMany({
        where: { isPaperTrade: true, status: 'CLOSED', exitTime: { gte: start, lte: end } },
        select: { pnl: true, fees: true },
      }),
      this.rejections.countByDate(date),
    ]);

    const sum = (rows: { pnl: number | null; fees: number | null }[]) => {
      let gross = 0, charges = 0;
      for (const r of rows) { gross += r.pnl ?? 0; charges += r.fees ?? 0; }
      return { tradeCount: rows.length, gross, charges, net: gross - charges };
    };

    const gated = sum(gatedRows);
    const ungated = { ...sum(ungatedRows), rejected };
    const netDiff = gated.net - ungated.net;
    return { date, gated, ungated, edge: { netDiff, verdict: this.verdict(netDiff) } };
  }

  private verdict(netDiff: number): string {
    if (Math.abs(netDiff) < NEUTRAL_BAND) return 'no meaningful edge today';
    return netDiff > 0
      ? `gate added value: +₹${netDiff.toFixed(0)} vs ungated`
      : `ungated outperformed by ₹${Math.abs(netDiff).toFixed(0)}`;
  }
}
```

- [ ] **Step 4: Verify passing**

Run: same command. Expected: 3 tests PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/modules/ungated-track/services/ungated-comparison.service.ts apps/api/src/modules/ungated-track/services/ungated-comparison.service.spec.ts
git commit -m "feat(ungated): UngatedComparisonService daily verdict"
```

---

## Task 10: `UngatedTrackController` — three GET endpoints

**Depends on:** Tasks 2, 3, 5, 9

**Files:**
- Create: `apps/api/src/modules/ungated-track/controllers/ungated-track.controller.ts`
- Test:   `apps/api/src/modules/ungated-track/controllers/ungated-track.controller.spec.ts`

- [ ] **Step 1: Failing test**

```typescript
import { Test } from '@nestjs/testing';
import { UngatedTrackController } from './ungated-track.controller';
import { UngatedWatchRepository } from '../repositories/ungated-watch.repository';
import { UngatedTradeRepository } from '../repositories/ungated-trade.repository';
import { UngatedPaperAccountService, STARTING_BALANCE } from '../services/ungated-paper-account.service';
import { UngatedComparisonService } from '../services/ungated-comparison.service';

describe('UngatedTrackController', () => {
  let ctrl: UngatedTrackController;
  let watchRepo: any, tradeRepo: any, account: any, comparison: any;

  beforeEach(async () => {
    watchRepo = { list: jest.fn().mockResolvedValue([
      { id: 'uw1', alertId: 'a1', paperTradeId: 'ut1', status: 'TARGET_HIT' },
    ]) };
    tradeRepo = { findRealization: jest.fn().mockResolvedValue(
      new Map([['ut1', { pnl: 200, fees: 30 }]])
    ) };
    account = {
      snapshot: jest.fn().mockResolvedValue({
        startingBalance: STARTING_BALANCE, cash: STARTING_BALANCE - 100000,
        realizedPnl: 200, fees: 30, deployedCapital: 100000, killSwitchAt: null,
      }),
    };
    comparison = { daily: jest.fn().mockResolvedValue({ date: '2026-05-20' }) };

    const mod = await Test.createTestingModule({
      controllers: [UngatedTrackController],
      providers: [
        { provide: UngatedWatchRepository, useValue: watchRepo },
        { provide: UngatedTradeRepository, useValue: tradeRepo },
        { provide: UngatedPaperAccountService, useValue: account },
        { provide: UngatedComparisonService, useValue: comparison },
      ],
    }).compile();
    ctrl = mod.get(UngatedTrackController);
  });

  it('GET /api/ungated/watch attaches realizedPnl + realizedFees per closed entry', async () => {
    const out = await ctrl.list(undefined, '2026-05-20');
    expect(out[0]).toMatchObject({ id: 'uw1', realizedPnl: 200, realizedFees: 30 });
  });

  it('GET /api/ungated/paper-account returns the live snapshot with equity = cash + deployed', async () => {
    const out = await ctrl.account();
    expect(out.equity).toBe(STARTING_BALANCE - 100000 + 100000);
    expect(out.cash).toBe(STARTING_BALANCE - 100000);
  });

  it('GET /api/ungated/comparison delegates to the service', async () => {
    const out = await ctrl.comparison('2026-05-20');
    expect(comparison.daily).toHaveBeenCalledWith('2026-05-20');
    expect(out.date).toBe('2026-05-20');
  });
});
```

- [ ] **Step 2: Verify failing**

Run: `cd apps/api && npx jest src/modules/ungated-track/controllers/ungated-track.controller.spec.ts`
Expected: FAIL.

- [ ] **Step 3: Implement**

```typescript
import { Controller, Get, Query } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { WatchStatus } from '@prisma/client';
import { UngatedWatchRepository } from '../repositories/ungated-watch.repository';
import { UngatedTradeRepository } from '../repositories/ungated-trade.repository';
import { UngatedPaperAccountService } from '../services/ungated-paper-account.service';
import { UngatedComparisonService } from '../services/ungated-comparison.service';

@ApiTags('Ungated Track (A/B experiment)')
@Controller('api/ungated')
export class UngatedTrackController {
  constructor(
    private readonly watchRepo: UngatedWatchRepository,
    private readonly tradeRepo: UngatedTradeRepository,
    private readonly account: UngatedPaperAccountService,
    private readonly comparison: UngatedComparisonService,
  ) {}

  @Get('watch')
  async list(
    @Query('status') status?: WatchStatus,
    @Query('date') date?: string,
  ) {
    const entries = await this.watchRepo.list({ status, date });
    const tradeIds = entries
      .map((e) => e.paperTradeId)
      .filter((x): x is string => !!x);
    const realization = await this.tradeRepo.findRealization(tradeIds);
    return entries.map((e) => {
      const r = e.paperTradeId ? realization.get(e.paperTradeId) : undefined;
      return { ...e, realizedPnl: r?.pnl ?? null, realizedFees: r?.fees ?? null };
    });
  }

  @Get('paper-account')
  async account() {
    const snap = await this.account.snapshot();
    // unrealized would require live prices on open trades; for MVP we return 0
    // (the controller is called from a settled-down view; open positions snapshot
    // can be added later if needed).
    const unrealized = 0;
    return {
      ...snap,
      unrealizedPnl: unrealized,
      equity: snap.cash + snap.deployedCapital + unrealized,
    };
  }

  @Get('comparison')
  async comparison(@Query('date') date: string) {
    return this.comparison.daily(date);
  }
}
```

- [ ] **Step 4: Verify passing**

Run: same command. Expected: 3 tests PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/modules/ungated-track/controllers/ungated-track.controller.ts apps/api/src/modules/ungated-track/controllers/ungated-track.controller.spec.ts
git commit -m "feat(ungated): UngatedTrackController endpoints"
```

---

## Task 11: Wire `UngatedTrackModule` into the app

**Depends on:** Tasks 2, 3, 4, 5, 6, 7, 8, 9, 10

**Files:**
- Create: `apps/api/src/modules/ungated-track/ungated-track.module.ts`
- Modify: `apps/api/src/app.module.ts` — register the module
- Modify: `apps/api/src/modules/chartink/chartink.module.ts` — import UngatedTrackModule so the fork (Task 12) can inject `UngatedWatchService` and `UngatedRejectionRepository`

- [ ] **Step 1: Create the module file**

```typescript
// apps/api/src/modules/ungated-track/ungated-track.module.ts
import { Module } from '@nestjs/common';
import { UngatedWatchRepository } from './repositories/ungated-watch.repository';
import { UngatedTradeRepository } from './repositories/ungated-trade.repository';
import { UngatedRejectionRepository } from './repositories/ungated-rejection.repository';
import { UngatedPaperAccountService } from './services/ungated-paper-account.service';
import { UngatedTradeExecutionService } from './services/ungated-trade-execution.service';
import { UngatedWatchService } from './services/ungated-watch.service';
import { UngatedComparisonService } from './services/ungated-comparison.service';
import { UngatedTrackController } from './controllers/ungated-track.controller';
import { PrismaModule } from '../../common/prisma/prisma.module';

@Module({
  imports: [PrismaModule],
  controllers: [UngatedTrackController],
  providers: [
    UngatedWatchRepository,
    UngatedTradeRepository,
    UngatedRejectionRepository,
    UngatedPaperAccountService,
    UngatedTradeExecutionService,
    UngatedWatchService,
    UngatedComparisonService,
  ],
  exports: [UngatedWatchService, UngatedRejectionRepository],
})
export class UngatedTrackModule {}
```

- [ ] **Step 2: Add `UngatedTrackModule` to `app.module.ts`**

Open `apps/api/src/app.module.ts` and add to the `imports` array (alphabetically near other module imports):

```typescript
import { UngatedTrackModule } from './modules/ungated-track/ungated-track.module';
// ...
@Module({
  imports: [
    // ... existing modules
    UngatedTrackModule,
  ],
  // ...
})
```

- [ ] **Step 3: Import `UngatedTrackModule` from `chartink.module.ts`**

Open `apps/api/src/modules/chartink/chartink.module.ts` and add to its `imports` array:

```typescript
import { UngatedTrackModule } from '../ungated-track/ungated-track.module';
// ...
@Module({
  imports: [
    // ... existing
    UngatedTrackModule,
  ],
  // ...
})
```

- [ ] **Step 4: Smoke-test the module wiring**

Run: `cd apps/api && npm run build`
Expected: `Successfully compiled: NNN files with swc` — no DI errors.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/modules/ungated-track/ungated-track.module.ts apps/api/src/app.module.ts apps/api/src/modules/chartink/chartink.module.ts
git commit -m "feat(ungated): wire UngatedTrackModule into AppModule + chartink"
```

---

## Task 12: Fork in `ChartinkProcessService.processOne` + rejection persistence

**Depends on:** Tasks 4, 7, 11

**Files:**
- Modify: `apps/api/src/modules/chartink/services/chartink-process.service.ts`
- Modify: `apps/api/src/modules/chartink/services/__tests__/chartink-process.service.spec.ts`

- [ ] **Step 1: Failing tests for fork isolation (spec §9.B)**

Append to the existing process spec:

```typescript
describe('ChartinkProcessService — ungated fork', () => {
  let svc: ChartinkProcessService;
  let ungatedWatch: any, ungatedRejections: any, /* …existing mocks… */;

  beforeEach(async () => {
    ungatedWatch = { createFromAlert: jest.fn().mockResolvedValue({ id: 'uw1' }) };
    ungatedRejections = { record: jest.fn().mockResolvedValue(undefined) };
    // ... rest of existing setup ... also inject UngatedWatchService + UngatedRejectionRepository
  });

  it('scored-low alert: gated rejects, ungated still calls createFromAlert', async () => {
    // ... arrange a score=42 alert ...
    await svc.processOne('a1', { symbol: 'TCS', token: '11536', hitPrice: 100 });
    expect(ungatedWatch.createFromAlert).toHaveBeenCalledWith(
      expect.objectContaining({ initialScore: 42 }),
    );
  });

  it('ungated createFromAlert failure does NOT affect the gated path', async () => {
    ungatedWatch.createFromAlert.mockRejectedValue(new Error('ungated db down'));
    await expect(
      svc.processOne('a1', { symbol: 'TCS', token: '11536', hitPrice: 100 }),
    ).resolves.not.toThrow();
  });

  it('UngatedCapitalExhaustedError persists a rejection row', async () => {
    const { UngatedCapitalExhaustedError } = await import(
      '../../ungated-track/services/ungated-paper-account.service'
    );
    ungatedWatch.createFromAlert.mockRejectedValue(new UngatedCapitalExhaustedError(50_000));
    await svc.processOne('a1', { symbol: 'TCS', token: '11536', hitPrice: 100 });
    expect(ungatedRejections.record).toHaveBeenCalledWith(
      expect.objectContaining({ reason: 'capital-exhausted' }),
    );
  });
});
```

- [ ] **Step 2: Verify failing**

Run: `cd apps/api && npx jest src/modules/chartink/services/__tests__/chartink-process.service.spec.ts`
Expected: FAIL — fork doesn't exist.

- [ ] **Step 3: Inject the two new deps and append the fork**

Edit `apps/api/src/modules/chartink/services/chartink-process.service.ts`:

a) Add imports at the top of the file:

```typescript
import { UngatedWatchService } from '../../ungated-track/services/ungated-watch.service';
import { UngatedRejectionRepository, UngatedRejectionReason } from '../../ungated-track/repositories/ungated-rejection.repository';
import {
  UngatedCapitalExhaustedError, UngatedPositionCapError, UngatedKillSwitchError,
} from '../../ungated-track/services/ungated-paper-account.service';
import { UngatedSymbolDupError, UngatedCooldownError } from '../../ungated-track/services/ungated-watch.service';
```

b) Add the two deps to the constructor:

```typescript
constructor(
  // ... existing
  private readonly ungatedWatch: UngatedWatchService,
  private readonly ungatedRejections: UngatedRejectionRepository,
) {}
```

c) Append the fork branch immediately after the existing gated `if (policy.admitted) { … } else { … }` block (just before the end of `processOne`):

```typescript
    // === 5. UNGATED shadow track — runs unconditionally for every scored alert.
    // Independent try/catch: failures here MUST NOT affect the gated path.
    // See specs/2026-05-20-ungated-shadow-track-design.md §5.1.
    try {
      await this.ungatedWatch.createFromAlert({
        alertId,
        setupId: null,
        symbol: hit.symbol,
        token: instrument.token,
        exchange: 'NSE',
        side,
        initialPrice: hit.hitPrice,
        initialScore: scoringResult.score,
        initialBreakdown: { checks: scoringResult.checks, lotCount: scoringResult.lotCount } as any,
      });
    } catch (err) {
      const reason: UngatedRejectionReason | null = this.mapUngatedError(err);
      if (reason) {
        await this.ungatedRejections.record({
          alertId, symbol: hit.symbol, reason,
          score: scoringResult.score, hitPrice: hit.hitPrice,
        });
      } else {
        this.logger.warn(`[ungated] ${hit.symbol}: ${err instanceof Error ? err.message : err}`);
      }
    }
  }

  private mapUngatedError(err: unknown): UngatedRejectionReason | null {
    if (err instanceof UngatedCapitalExhaustedError) return 'capital-exhausted';
    if (err instanceof UngatedPositionCapError) return 'position-cap';
    if (err instanceof UngatedSymbolDupError) return 'symbol-dup';
    if (err instanceof UngatedCooldownError) return 'cooldown';
    if (err instanceof UngatedKillSwitchError) return 'kill-switch';
    return null;
  }
```

- [ ] **Step 4: Verify passing**

Run: `cd apps/api && npx jest src/modules/chartink`
Expected: existing tests + 3 new fork tests all PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/modules/chartink/services/chartink-process.service.ts apps/api/src/modules/chartink/services/__tests__/chartink-process.service.spec.ts
git commit -m "feat(chartink): fork to UngatedWatchService + persist ungated rejections"
```

---

## Task 13: Frontend types, API client, hooks

**Depends on:** Tasks 10 (API surface)

**Files:**
- Create: `apps/web/src/types/ungatedWatch.types.ts`
- Create: `apps/web/src/services/ungatedWatch.ts`
- Create: `apps/web/src/services/ungatedComparison.ts`
- Create: `apps/web/src/hooks/useUngatedWatchEntries.ts`
- Create: `apps/web/src/hooks/useUngatedPaperAccount.ts`
- Create: `apps/web/src/hooks/useDailyComparison.ts`

- [ ] **Step 1: Type stubs**

```typescript
// apps/web/src/types/ungatedWatch.types.ts
import type { WatchEntry } from './watch.types';
export type UngatedWatchEntry = WatchEntry; // shape parity guaranteed by spec §4

export interface UngatedPaperAccount {
  id: string;
  startingBalance: number;
  cash: number;
  realizedPnl: number;
  unrealizedPnl: number;
  fees: number;
  deployedCapital: number;
  equity: number;
  killSwitchAt: string | null;
}

export interface DailyComparison {
  date: string;
  gated:   { tradeCount: number; gross: number; charges: number; net: number };
  ungated: {
    tradeCount: number; gross: number; charges: number; net: number;
    rejected: Record<string, number>;
  };
  edge: { netDiff: number; verdict: string };
}
```

- [ ] **Step 2: API client wrappers**

```typescript
// apps/web/src/services/ungatedWatch.ts
import api from './api';
import type { UngatedWatchEntry, UngatedPaperAccount } from '../types/ungatedWatch.types';
import type { WatchStatus } from '../types/watch.types';

export async function listUngatedEntries(opts: { status?: WatchStatus; date?: string } = {}) {
  const r = await api.get<UngatedWatchEntry[]>('/ungated/watch', { params: opts });
  return r.data;
}

export async function getUngatedAccount() {
  const r = await api.get<UngatedPaperAccount>('/ungated/paper-account');
  return r.data;
}
```

```typescript
// apps/web/src/services/ungatedComparison.ts
import api from './api';
import type { DailyComparison } from '../types/ungatedWatch.types';

export async function getDailyComparison(date: string) {
  const r = await api.get<DailyComparison>('/ungated/comparison', { params: { date } });
  return r.data;
}
```

- [ ] **Step 3: React hooks**

```typescript
// apps/web/src/hooks/useUngatedWatchEntries.ts
import { useEffect, useState } from 'react';
import { listUngatedEntries } from '../services/ungatedWatch';
import type { UngatedWatchEntry } from '../types/ungatedWatch.types';
import type { WatchStatus } from '../types/watch.types';

export function useUngatedWatchEntries(filter?: WatchStatus, date?: string) {
  const [entries, setEntries] = useState<UngatedWatchEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    setLoading(true);
    listUngatedEntries({ status: filter, date })
      .then((data) => { setEntries(data); setError(null); })
      .catch((e) => setError(e instanceof Error ? e.message : String(e)))
      .finally(() => setLoading(false));
  }, [filter, date]);
  return { entries, loading, error };
}
```

```typescript
// apps/web/src/hooks/useUngatedPaperAccount.ts
import { useEffect, useState } from 'react';
import { getUngatedAccount } from '../services/ungatedWatch';
import type { UngatedPaperAccount } from '../types/ungatedWatch.types';

export function useUngatedPaperAccount() {
  const [account, setAccount] = useState<UngatedPaperAccount | null>(null);
  useEffect(() => {
    getUngatedAccount().then(setAccount).catch(() => setAccount(null));
  }, []);
  return { account };
}
```

```typescript
// apps/web/src/hooks/useDailyComparison.ts
import { useEffect, useState } from 'react';
import { getDailyComparison } from '../services/ungatedComparison';
import type { DailyComparison } from '../types/ungatedWatch.types';

export function useDailyComparison(date: string) {
  const [data, setData] = useState<DailyComparison | null>(null);
  useEffect(() => {
    let cancelled = false;
    getDailyComparison(date).then((r) => { if (!cancelled) setData(r); });
    return () => { cancelled = true; };
  }, [date]);
  return { data };
}
```

- [ ] **Step 4: Type-check + smoke run**

Run: `cd apps/web && npx tsc -b 2>&1 | grep -v "isActive\\|loadOlder\\|isLoadingMore\\|onReachStart\\|getDefaultVisibleBars"`
Expected: no NEW errors (pre-existing errors in unrelated files are filtered out by the grep).

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/types/ungatedWatch.types.ts apps/web/src/services/ungatedWatch.ts apps/web/src/services/ungatedComparison.ts apps/web/src/hooks/useUngatedWatchEntries.ts apps/web/src/hooks/useUngatedPaperAccount.ts apps/web/src/hooks/useDailyComparison.ts
git commit -m "feat(web): ungated track API client + hooks"
```

---

## Task 14: `UngatedWatchPage` — mirror of `WatchPage`

**Depends on:** Task 13

**Files:**
- Create: `apps/web/src/pages/ungated-watch/UngatedWatchPage.tsx`

- [ ] **Step 1: Implement (no spec — pure presentational reuse)**

```typescript
import { useState } from 'react';
import { useUngatedWatchEntries } from '../../hooks/useUngatedWatchEntries';
import { WatchTable } from '../watch/WatchTable';
import { dayRealizedSummary } from '../../utils/watchPnl';
import { useUngatedPaperAccount } from '../../hooks/useUngatedPaperAccount';
import type { WatchStatus } from '../../types/watch.types';

const FILTERS: Array<{ label: string; value: WatchStatus | undefined }> = [
  { label: 'All', value: undefined },
  { label: 'Watching', value: 'WATCHING' },
  { label: 'Traded', value: 'TRADED' },
  { label: 'Stopped', value: 'STOPPED' },
  { label: 'Target Hit', value: 'TARGET_HIT' },
];

function todayIST(): string {
  return new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
}

export function UngatedWatchPage() {
  const [filter, setFilter] = useState<WatchStatus | undefined>(undefined);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [date, setDate] = useState<string>(todayIST());
  const { entries, loading, error } = useUngatedWatchEntries(filter, date);
  const { account } = useUngatedPaperAccount();
  const activeCount = entries.filter((e) => e.status === 'WATCHING' || e.status === 'TRADED').length;

  return (
    <div className="p-6 text-[var(--color-text-primary)]">
      <div className="flex items-center justify-between mb-4 gap-4">
        <h1 className="text-2xl font-semibold">
          Ungated (Shadow Track){' '}
          <span className="text-[10px] px-1.5 py-0.5 rounded bg-amber-500/20 text-amber-300 align-middle ml-2">EXPERIMENT</span>
        </h1>
        <div className="flex items-center gap-4 text-sm text-[var(--color-text-muted)]">
          {account && <span>Equity ₹{Math.round(account.equity).toLocaleString('en-IN')}</span>}
          <span>{activeCount} / 40 active</span>
        </div>
      </div>

      <div className="flex gap-2 mb-4">
        {FILTERS.map((f) => (
          <button
            key={f.label}
            onClick={() => setFilter(f.value)}
            className={`px-3 py-1 text-sm rounded transition-colors ${
              filter === f.value
                ? 'bg-blue-600 text-white'
                : 'bg-[var(--color-bg-tertiary)] text-[var(--color-text-secondary)] hover:text-[var(--color-text-primary)]'
            }`}
          >
            {f.label}
          </button>
        ))}
        <input
          type="date"
          value={date}
          onChange={(e) => setDate(e.target.value)}
          className="ml-auto px-2 py-1 text-sm rounded bg-[var(--color-bg-tertiary)]"
        />
      </div>

      {loading && <div className="text-[var(--color-text-muted)]">Loading…</div>}
      {error && <div className="text-red-400">Error: {error}</div>}
      {!loading && !error && (
        <>
          <WatchTable entries={entries} onSelect={setSelectedId} selectedId={selectedId} />
          {(() => {
            const s = dayRealizedSummary(entries);
            if (s.count === 0) return null;
            const fmt = (n: number) => `${n >= 0 ? '+' : '−'}₹${Math.abs(n).toFixed(2)}`;
            const color = (n: number) => (n > 0 ? 'text-emerald-400' : n < 0 ? 'text-red-400' : 'text-[var(--color-text-secondary)]');
            return (
              <div className="mt-4 rounded-lg border border-[var(--color-border-subtle)] bg-[var(--color-bg-tertiary)]/40 px-4 py-3">
                <div className="flex flex-wrap items-baseline justify-between gap-x-6 gap-y-1 text-sm">
                  <div className="text-[11px] uppercase tracking-wider text-[var(--color-text-muted)]">
                    Day realised — {s.count} closed trade{s.count === 1 ? '' : 's'}
                  </div>
                  <div className="flex flex-wrap items-baseline gap-x-6 gap-y-1 tabular-nums">
                    <div><span className="text-[var(--color-text-muted)]">Gross </span><span className={`font-semibold ${color(s.gross)}`}>{fmt(s.gross)}</span></div>
                    <div><span className="text-[var(--color-text-muted)]">Charges </span><span className="font-semibold text-amber-400">−₹{s.charges.toFixed(2)}</span></div>
                    <div><span className="text-[var(--color-text-muted)]">Net </span><span className={`font-semibold ${color(s.net)}`}>{fmt(s.net)}</span></div>
                  </div>
                </div>
              </div>
            );
          })()}
        </>
      )}
    </div>
  );
}
```

- [ ] **Step 2: Verify it builds (no type errors)**

Run: `cd apps/web && npx tsc -b 2>&1 | grep "UngatedWatchPage"`
Expected: no output (= no errors specific to the new file).

- [ ] **Step 3: Commit**

```bash
git add apps/web/src/pages/ungated-watch/UngatedWatchPage.tsx
git commit -m "feat(web): UngatedWatchPage mirror with day-realised footer"
```

---

## Task 15: `ComparisonStrip` + integrate on `/watch` + route + nav

**Depends on:** Tasks 13, 14

**Files:**
- Create: `apps/web/src/components/trading/ComparisonStrip.tsx`
- Create: `apps/web/src/components/trading/ComparisonStrip.spec.ts`
- Modify: `apps/web/src/pages/watch/WatchPage.tsx`
- Modify: app's route file (probably `apps/web/src/App.tsx` or `apps/web/src/router.tsx`)
- Modify: sidebar/nav component (look for it under `apps/web/src/components/layout/`)

- [ ] **Step 1: Failing test for the strip's render rules**

```typescript
// apps/web/src/components/trading/ComparisonStrip.spec.ts
import { describe, it, expect } from 'vitest';
import { computeStripState } from './ComparisonStrip';

describe('computeStripState', () => {
  const base = {
    date: 'd', gated: { tradeCount: 16, gross: 0, charges: 0, net: 1234 },
    ungated: { tradeCount: 42, gross: 0, charges: 0, net: -5678, rejected: {} },
    edge: { netDiff: 1234 - -5678, verdict: 'gate added value: +₹6912 vs ungated' },
  };

  it('returns "hidden" when ungated.tradeCount = 0', () => {
    const s = computeStripState({ ...base, ungated: { ...base.ungated, tradeCount: 0 } });
    expect(s.hidden).toBe(true);
  });

  it('emerald tone when gated.net > ungated.net by >= ₹100', () => {
    expect(computeStripState(base).tone).toBe('emerald');
  });

  it('red tone when ungated.net > gated.net by >= ₹100', () => {
    const flipped = { ...base, gated: { ...base.gated, net: -5678 }, ungated: { ...base.ungated, net: 1234 } };
    expect(computeStripState(flipped).tone).toBe('red');
  });

  it('grey tone when within ±₹100', () => {
    const tight = { ...base, gated: { ...base.gated, net: 100 }, ungated: { ...base.ungated, net: 50 } };
    expect(computeStripState(tight).tone).toBe('grey');
  });
});
```

- [ ] **Step 2: Verify failing**

Run: `cd apps/web && npx vitest run src/components/trading/ComparisonStrip.spec.ts`
Expected: FAIL.

- [ ] **Step 3: Implement the component + pure helper**

```typescript
// apps/web/src/components/trading/ComparisonStrip.tsx
import { Link } from 'react-router-dom';
import type { DailyComparison } from '../../types/ungatedWatch.types';

export type StripTone = 'emerald' | 'red' | 'grey';

export interface StripState {
  hidden: boolean;
  tone: StripTone;
  edgeText: string;
}

export function computeStripState(c: DailyComparison): StripState {
  if (c.ungated.tradeCount === 0) return { hidden: true, tone: 'grey', edgeText: '' };
  const diff = c.edge.netDiff;
  const tone: StripTone =
    Math.abs(diff) < 100 ? 'grey' : diff > 0 ? 'emerald' : 'red';
  const sign = diff >= 0 ? '+' : '−';
  return { hidden: false, tone, edgeText: `EDGE ${sign}₹${Math.abs(diff).toFixed(0)}` };
}

const TONE_CLASS: Record<StripTone, string> = {
  emerald: 'text-emerald-400',
  red: 'text-red-400',
  grey: 'text-[var(--color-text-secondary)]',
};

export function ComparisonStrip({ data, date }: { data: DailyComparison; date: string }) {
  const s = computeStripState(data);
  if (s.hidden) return null;
  return (
    <Link
      to={`/ungated-watch?date=${date}`}
      className="mb-3 flex flex-wrap items-baseline gap-x-6 gap-y-1 rounded-lg border border-[var(--color-border-subtle)] bg-[var(--color-bg-tertiary)]/40 px-3 py-2 text-sm hover:bg-[var(--color-bg-tertiary)]/60 transition-colors"
      title={data.edge.verdict}
    >
      <span className="text-[10px] uppercase tracking-wider text-amber-300">A/B</span>
      <span><span className="text-[var(--color-text-muted)]">Gated </span>{data.gated.net >= 0 ? '+' : '−'}₹{Math.abs(data.gated.net).toFixed(0)} · {data.gated.tradeCount}t</span>
      <span><span className="text-[var(--color-text-muted)]">Ungated </span>{data.ungated.net >= 0 ? '+' : '−'}₹{Math.abs(data.ungated.net).toFixed(0)} · {data.ungated.tradeCount}t</span>
      <span className={`font-semibold ${TONE_CLASS[s.tone]}`}>{s.edgeText}</span>
    </Link>
  );
}
```

- [ ] **Step 4: Verify the test passes**

Run: same vitest command.
Expected: 4 tests PASS.

- [ ] **Step 5: Integrate on `/watch`**

Edit `apps/web/src/pages/watch/WatchPage.tsx`:

a) Add imports near the top:

```typescript
import { ComparisonStrip } from '../../components/trading/ComparisonStrip';
import { useDailyComparison } from '../../hooks/useDailyComparison';
```

b) Inside the component, after `useWatchEntries` / `usePaperAccount`, fetch the comparison:

```typescript
  const { data: comparison } = useDailyComparison(date);
```

c) Render the strip just before the existing P&L summary IIFE (search for `{/* Real P/L summary */}` or the "Real P/L: " block — insert directly above):

```tsx
{comparison && <ComparisonStrip data={comparison} date={date} />}
```

- [ ] **Step 6: Add the `/ungated-watch` route**

Open the app's router file (search the repo: `grep -rn "WatchPage" apps/web/src --include='*.tsx' | grep -v WatchPage.tsx`) and add a route for `UngatedWatchPage`. The exact change depends on the router style (react-router-dom v6 typical):

```tsx
import { UngatedWatchPage } from './pages/ungated-watch/UngatedWatchPage';
// inside <Routes>:
<Route path="/ungated-watch" element={<UngatedWatchPage />} />
```

- [ ] **Step 7: Add the sidebar nav link**

Search for the current `/watch` link in the layout component (`grep -rn '"/watch"' apps/web/src`). Add a parallel entry below it:

```tsx
<NavLink to="/ungated-watch">
  Ungated{' '}
  <span className="text-[9px] px-1 py-0.5 rounded bg-amber-500/20 text-amber-300 ml-1">EXP</span>
</NavLink>
```

(The exact JSX depends on the existing nav style — match it.)

- [ ] **Step 8: Commit**

```bash
git add apps/web/src/components/trading/ComparisonStrip.tsx apps/web/src/components/trading/ComparisonStrip.spec.ts apps/web/src/pages/watch/WatchPage.tsx apps/web/src/App.tsx apps/web/src/components/layout/Sidebar.tsx
git commit -m "feat(web): ComparisonStrip on /watch + /ungated-watch route + nav link"
```

(Adjust the staged paths to match the actual router + nav files found in steps 6–7.)

---

## Task 16: End-to-end verification — rebuild, restart, smoke-test

**Depends on:** Everything above.

- [ ] **Step 1: Run the full backend test suite**

Run: `cd apps/api && npx jest 2>&1 | tail -8`
Expected: all suites pass — should be the previous count + new ungated tests (≈ +25 tests).

- [ ] **Step 2: Run the full frontend test suite**

Run: `cd apps/web && npx vitest run 2>&1 | tail -8`
Expected: all pass — should be the previous count + 4 new `ComparisonStrip` tests.

- [ ] **Step 3: Rebuild the API**

Run: `cd apps/api && npm run build`
Expected: `Successfully compiled: NNN files with swc`.

- [ ] **Step 4: Restart the API**

PowerShell:
```powershell
$c = Get-NetTCPConnection -LocalPort 4001 -State Listen -ErrorAction SilentlyContinue
if ($c) { foreach ($x in $c) { try { Stop-Process -Id $x.OwningProcess -Force } catch {} } }
```

Then:
```bash
cd apps/api && npm run start &
```

Poll for readiness:
```bash
i=0; until curl -s -m 2 -o /dev/null -w "" http://127.0.0.1:4001/api/trades/paper-account; do i=$((i+1)); [ $i -gt 60 ] && exit 1; sleep 2; done; echo "API ready"
```

- [ ] **Step 5: Smoke-test the new endpoints**

```bash
curl -s http://127.0.0.1:4001/api/ungated/paper-account
# Expect: { "startingBalance": 8000000, "cash": 8000000, "deployedCapital": 0, "equity": 8000000, ... }

curl -s "http://127.0.0.1:4001/api/ungated/watch?date=2026-05-20" | head -c 200
# Expect: [] (empty array — no ungated alerts have been processed yet)

curl -s "http://127.0.0.1:4001/api/ungated/comparison?date=2026-05-20"
# Expect: { date, gated: {tradeCount, gross, charges, net}, ungated: {...0...}, edge: {netDiff, verdict} }
```

- [ ] **Step 6: Visual smoke check**

Open `http://localhost:4000`:
- `/watch` — the ComparisonStrip renders nothing (ungated tradeCount = 0 on day one).
- Navigate to `/ungated-watch` — empty table, "0 / 40 active" badge, ₹80,00,000 equity.

- [ ] **Step 7: Wait for one real Chartink alert and inspect both tracks**

After the next live alert lands (or fire a synthetic one via the curl pattern from earlier in the session):
1. The alert appears on `/watch` as either accepted (`scored-low` rejection or admitted setup) — *gated* behaviour unchanged.
2. The same alert appears on `/ungated-watch` as a new ungated entry (regardless of score).
3. Refresh `/api/ungated/paper-account` — cash should have decremented by `qty × initialPrice`, deployed should match.
4. `/api/ungated/comparison?date=today` should now show `ungated.tradeCount: 1`.

If all four observations hold, the feature is live.

- [ ] **Step 8: Commit any final tweaks + push**

```bash
git status   # should be clean unless step 7 surfaced a fix
git push
```

---

## Notes for the implementer

- The repo uses `prisma db push`, not `migrate dev`. Memory note: `migrate dev` will offer to RESET the DB — never run it here.
- Web dev server is IPv6-loopback only — health-check via `http://localhost:4000`, not `127.0.0.1:4000`.
- The trigger-price fix from commits `9fb5bcd` and `75a8559` is baked into Task 6/7/8 by requiring `opts.exitPrice` non-optionally. The ungated track therefore cannot regress that bug class.
- All `MIRROR OF …` comment headers should be left in place — they're the breadcrumb for future maintainers (or for an eventual Approach B refactor).
- The ungated track has no live-broker code path. Every trade is paper. Don't add a live branch without re-reading the spec § 5.3.
