# Anand Dual-Track Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Auto-create Intraday (5% P/L) and Swing (10% P/L, overnight) analysis log entries for every Anand Swing Chartink alert, exposed on two dedicated pages.

**Architecture:** A new `anand-dual-track` NestJS module holds a repository, entry-creation service, price-monitor poller (Cron-based, same pattern as `UngatedTickPoller`), and controller. `ChartinkProcessService` calls the service after scoring when the scanner's `category === 'ANAND_SWING'`. Two React pages (`/intraday`, `/swing`) poll the API and update P/L live via the existing `wsService`.

**Tech Stack:** NestJS, Prisma, `@nestjs/schedule` Cron, `AngelOneAdapterService.getLtpsBatch`, React + TypeScript, Tailwind CSS, `wsService` (existing WebSocket).

---

## File Map

**Create (backend):**
- `apps/api/src/modules/anand-dual-track/repositories/anand-dual-track.repository.ts`
- `apps/api/src/modules/anand-dual-track/repositories/__tests__/anand-dual-track.repository.spec.ts`
- `apps/api/src/modules/anand-dual-track/services/anand-dual-track.service.ts`
- `apps/api/src/modules/anand-dual-track/services/__tests__/anand-dual-track.service.spec.ts`
- `apps/api/src/modules/anand-dual-track/services/anand-price-monitor.service.ts`
- `apps/api/src/modules/anand-dual-track/services/__tests__/anand-price-monitor.service.spec.ts`
- `apps/api/src/modules/anand-dual-track/controllers/anand-dual-track.controller.ts`
- `apps/api/src/modules/anand-dual-track/anand-dual-track.module.ts`

**Modify (backend):**
- `prisma/schema.prisma` — add `category` field + two new models
- `apps/api/src/modules/chartink/repositories/chartink.repository.ts` — add `updateScannerCategory` + `getScannerById`
- `apps/api/src/modules/chartink/services/chartink-process.service.ts` — add step 6 dual-track call
- `apps/api/src/modules/chartink/chartink.module.ts` — import `AnandDualTrackModule`
- `apps/api/src/app.module.ts` — register `AnandDualTrackModule`

**Create (frontend):**
- `apps/web/src/services/anand.ts`
- `apps/web/src/hooks/useIntradayEntries.ts`
- `apps/web/src/hooks/useSwingEntries.ts`
- `apps/web/src/pages/intraday/IntradayPage.tsx`
- `apps/web/src/pages/swing/SwingPage.tsx`

**Modify (frontend):**
- `apps/web/src/components/layout/Sidebar.tsx`
- `apps/web/src/App.tsx`

---

## Task 1: Prisma Schema — Add Category Field + New Models

**Files:**
- Modify: `prisma/schema.prisma`

- [ ] **Step 1: Add `category` to `ChartinkScanner`**

In `prisma/schema.prisma`, find the `ChartinkScanner` model and add the field after `fireCount`:

```prisma
model ChartinkScanner {
  id           String           @id @default(cuid())
  scanUrl      String           @unique
  scanName     String
  alertName    String?
  firstSeenAt  DateTime         @default(now())
  lastFiredAt  DateTime?
  fireCount    Int              @default(0)
  category     String           @default("OTHER")
  alerts       ChartinkAlert[]

  @@map("chartink_scanners")
}
```

- [ ] **Step 2: Add `IntradayEntry` and `SwingEntry` models**

Append to end of `prisma/schema.prisma`:

```prisma
// ============================================
// Anand Dual-Track Analysis Logs
// ============================================

model IntradayEntry {
  id             String    @id @default(cuid())
  symbol         String
  token          String?
  entryPrice     Float
  enteredAt      DateTime  @default(now())
  targetPct      Float     @default(5.0)
  stopPct        Float     @default(5.0)
  status         String    @default("WATCHING")
  exitPrice      Float?
  exitedAt       DateTime?
  alertId        String
  scoreBreakdown Json?

  @@index([status, enteredAt])
  @@map("intraday_entries")
}

model SwingEntry {
  id             String    @id @default(cuid())
  symbol         String
  token          String?
  entryPrice     Float
  enteredAt      DateTime  @default(now())
  targetPct      Float     @default(10.0)
  stopPct        Float     @default(10.0)
  status         String    @default("WATCHING")
  exitPrice      Float?
  exitedAt       DateTime?
  alertId        String
  scoreBreakdown Json?

  @@index([status, enteredAt])
  @@map("swing_entries")
}
```

- [ ] **Step 3: Run `prisma db push`**

```bash
cd apps/api && npx prisma db push
```

Expected: `Your database is now in sync with your Prisma schema.`

- [ ] **Step 4: Regenerate Prisma client**

```bash
cd apps/api && npx prisma generate
```

- [ ] **Step 5: Commit**

```bash
git add prisma/schema.prisma
git commit -m "feat(schema): add ChartinkScanner.category + IntradayEntry + SwingEntry models"
```

---

## Task 2: Repository

**Files:**
- Create: `apps/api/src/modules/anand-dual-track/repositories/anand-dual-track.repository.ts`
- Create: `apps/api/src/modules/anand-dual-track/repositories/__tests__/anand-dual-track.repository.spec.ts`

- [ ] **Step 1: Write the failing tests**

Create `apps/api/src/modules/anand-dual-track/repositories/__tests__/anand-dual-track.repository.spec.ts`:

```typescript
import { Test } from '@nestjs/testing';
import { AnandDualTrackRepository } from '../anand-dual-track.repository';
import { PrismaService } from '../../../../common/prisma/prisma.service';

describe('AnandDualTrackRepository', () => {
  let repo: AnandDualTrackRepository;
  let prisma: {
    intradayEntry: {
      create: jest.Mock;
      findMany: jest.Mock;
      update: jest.Mock;
      updateMany: jest.Mock;
    };
    swingEntry: {
      create: jest.Mock;
      findMany: jest.Mock;
      update: jest.Mock;
    };
  };

  beforeEach(async () => {
    prisma = {
      intradayEntry: {
        create: jest.fn(),
        findMany: jest.fn().mockResolvedValue([]),
        update: jest.fn(),
        updateMany: jest.fn(),
      },
      swingEntry: {
        create: jest.fn(),
        findMany: jest.fn().mockResolvedValue([]),
        update: jest.fn(),
      },
    };

    const mod = await Test.createTestingModule({
      providers: [
        AnandDualTrackRepository,
        { provide: PrismaService, useValue: prisma },
      ],
    }).compile();

    repo = mod.get(AnandDualTrackRepository);
  });

  it('createIntradayEntry inserts with targetPct=5', async () => {
    prisma.intradayEntry.create.mockResolvedValue({ id: 'i1' });
    const result = await repo.createIntradayEntry({
      symbol: 'RELIANCE', token: '123', entryPrice: 2500, alertId: 'a1', scoreBreakdown: null,
    });
    expect(result.id).toBe('i1');
    expect(prisma.intradayEntry.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ targetPct: 5, stopPct: 5 }) }),
    );
  });

  it('createSwingEntry inserts with targetPct=10', async () => {
    prisma.swingEntry.create.mockResolvedValue({ id: 's1' });
    const result = await repo.createSwingEntry({
      symbol: 'RELIANCE', token: '123', entryPrice: 2500, alertId: 'a1', scoreBreakdown: null,
    });
    expect(result.id).toBe('s1');
    expect(prisma.swingEntry.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ targetPct: 10, stopPct: 10 }) }),
    );
  });

  it('listWatchingIntraday returns only WATCHING rows', async () => {
    const row = { id: 'i1', symbol: 'RELIANCE', token: '123', entryPrice: 2500, status: 'WATCHING', targetPct: 5, stopPct: 5 };
    prisma.intradayEntry.findMany.mockResolvedValue([row]);
    const result = await repo.listWatchingIntraday();
    expect(prisma.intradayEntry.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ status: 'WATCHING' }) }),
    );
    expect(result).toHaveLength(1);
  });

  it('listWatchingSwing returns only WATCHING rows', async () => {
    const row = { id: 's1', symbol: 'TCS', token: '456', entryPrice: 3500, status: 'WATCHING', targetPct: 10, stopPct: 10 };
    prisma.swingEntry.findMany.mockResolvedValue([row]);
    const result = await repo.listWatchingSwing();
    expect(result).toHaveLength(1);
  });

  it('updateIntradayStatus sets status, exitPrice, exitedAt', async () => {
    prisma.intradayEntry.update.mockResolvedValue({});
    const now = new Date('2026-06-03T05:00:00Z');
    await repo.updateIntradayStatus('i1', { status: 'TARGET_HIT', exitPrice: 2625, exitedAt: now });
    expect(prisma.intradayEntry.update).toHaveBeenCalledWith({
      where: { id: 'i1' },
      data: { status: 'TARGET_HIT', exitPrice: 2625, exitedAt: now },
    });
  });

  it('expireAllWatchingIntraday updates all WATCHING rows to EXPIRED', async () => {
    prisma.intradayEntry.updateMany.mockResolvedValue({ count: 3 });
    const count = await repo.expireAllWatchingIntraday();
    expect(count).toBe(3);
    expect(prisma.intradayEntry.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { status: 'WATCHING' }, data: expect.objectContaining({ status: 'EXPIRED' }) }),
    );
  });

  it('getPnlSummary returns daily/weekly/monthly/yearly stats', async () => {
    const exits = [
      { exitedAt: new Date(), entryPrice: 100, exitPrice: 105 },
      { exitedAt: new Date(), entryPrice: 100, exitPrice: 95 },
    ];
    prisma.intradayEntry.findMany.mockResolvedValue(exits);
    const result = await repo.getPnlSummary('intraday');
    expect(result.daily.count).toBe(2);
    expect(result.daily.winCount).toBe(1);
    expect(result.daily.avgExitPct).toBeCloseTo(0); // (+5 + -5) / 2
  });
});
```

- [ ] **Step 2: Run tests to confirm they fail**

```bash
cd apps/api && npx jest anand-dual-track.repository --no-coverage 2>&1 | tail -5
```

Expected: `FAIL` — `Cannot find module '../anand-dual-track.repository'`

- [ ] **Step 3: Implement the repository**

Create `apps/api/src/modules/anand-dual-track/repositories/anand-dual-track.repository.ts`:

```typescript
import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../../common/prisma/prisma.service';

export interface CreateEntryInput {
  symbol: string;
  token: string | null;
  entryPrice: number;
  alertId: string;
  scoreBreakdown: unknown;
}

export interface UpdateStatusInput {
  status: string;
  exitPrice?: number;
  exitedAt?: Date;
}

export interface ListEntriesFilter {
  status?: string;
  from?: Date;
  to?: Date;
}

export interface PnlSummaryPeriod {
  avgExitPct: number;
  count: number;
  winCount: number;
}

export interface PnlSummary {
  daily: PnlSummaryPeriod;
  weekly: PnlSummaryPeriod;
  monthly: PnlSummaryPeriod;
  yearly: PnlSummaryPeriod;
}

@Injectable()
export class AnandDualTrackRepository {
  constructor(private readonly prisma: PrismaService) {}

  async createIntradayEntry(input: CreateEntryInput): Promise<{ id: string }> {
    return this.prisma.intradayEntry.create({
      data: {
        symbol: input.symbol,
        token: input.token,
        entryPrice: input.entryPrice,
        alertId: input.alertId,
        targetPct: 5,
        stopPct: 5,
        scoreBreakdown:
          input.scoreBreakdown == null
            ? Prisma.JsonNull
            : (input.scoreBreakdown as Prisma.InputJsonValue),
      },
      select: { id: true },
    });
  }

  async createSwingEntry(input: CreateEntryInput): Promise<{ id: string }> {
    return this.prisma.swingEntry.create({
      data: {
        symbol: input.symbol,
        token: input.token,
        entryPrice: input.entryPrice,
        alertId: input.alertId,
        targetPct: 10,
        stopPct: 10,
        scoreBreakdown:
          input.scoreBreakdown == null
            ? Prisma.JsonNull
            : (input.scoreBreakdown as Prisma.InputJsonValue),
      },
      select: { id: true },
    });
  }

  async listWatchingIntraday() {
    return this.prisma.intradayEntry.findMany({
      where: { status: 'WATCHING' },
      orderBy: { enteredAt: 'desc' },
    });
  }

  async listWatchingSwing() {
    return this.prisma.swingEntry.findMany({
      where: { status: 'WATCHING' },
      orderBy: { enteredAt: 'desc' },
    });
  }

  async listIntradayEntries(filter: ListEntriesFilter = {}) {
    return this.prisma.intradayEntry.findMany({
      where: {
        ...(filter.status ? { status: filter.status } : {}),
        ...(filter.from || filter.to
          ? { enteredAt: { ...(filter.from ? { gte: filter.from } : {}), ...(filter.to ? { lte: filter.to } : {}) } }
          : {}),
      },
      orderBy: { enteredAt: 'desc' },
      take: 200,
    });
  }

  async listSwingEntries(filter: ListEntriesFilter = {}) {
    return this.prisma.swingEntry.findMany({
      where: {
        ...(filter.status ? { status: filter.status } : {}),
        ...(filter.from || filter.to
          ? { enteredAt: { ...(filter.from ? { gte: filter.from } : {}), ...(filter.to ? { lte: filter.to } : {}) } }
          : {}),
      },
      orderBy: { enteredAt: 'desc' },
      take: 200,
    });
  }

  async updateIntradayStatus(id: string, data: UpdateStatusInput): Promise<void> {
    await this.prisma.intradayEntry.update({ where: { id }, data });
  }

  async updateSwingStatus(id: string, data: UpdateStatusInput): Promise<void> {
    await this.prisma.swingEntry.update({ where: { id }, data });
  }

  async expireAllWatchingIntraday(): Promise<number> {
    const result = await this.prisma.intradayEntry.updateMany({
      where: { status: 'WATCHING' },
      data: { status: 'EXPIRED', exitedAt: new Date() },
    });
    return result.count;
  }

  async getPnlSummary(track: 'intraday' | 'swing'): Promise<PnlSummary> {
    const now = new Date();
    const startOf = (offsetDays: number) => {
      const d = new Date(now);
      d.setDate(d.getDate() - offsetDays);
      d.setHours(0, 0, 0, 0);
      return d;
    };

    const exits = await (track === 'intraday'
      ? this.prisma.intradayEntry.findMany({
          where: { status: { in: ['TARGET_HIT', 'STOPPED', 'EXPIRED'] }, exitedAt: { not: null }, exitPrice: { not: null } },
          select: { exitedAt: true, entryPrice: true, exitPrice: true },
        })
      : this.prisma.swingEntry.findMany({
          where: { status: { in: ['TARGET_HIT', 'STOPPED'] }, exitedAt: { not: null }, exitPrice: { not: null } },
          select: { exitedAt: true, entryPrice: true, exitPrice: true },
        }));

    const compute = (rows: typeof exits): PnlSummaryPeriod => {
      if (rows.length === 0) return { avgExitPct: 0, count: 0, winCount: 0 };
      let sum = 0;
      let wins = 0;
      for (const r of rows) {
        const pct = ((r.exitPrice! - r.entryPrice) / r.entryPrice) * 100;
        sum += pct;
        if (pct > 0) wins++;
      }
      return { avgExitPct: sum / rows.length, count: rows.length, winCount: wins };
    };

    const daily = exits.filter(r => r.exitedAt! >= startOf(1));
    const weekly = exits.filter(r => r.exitedAt! >= startOf(7));
    const monthly = exits.filter(r => r.exitedAt! >= startOf(30));
    const yearly = exits.filter(r => r.exitedAt! >= startOf(365));

    return {
      daily: compute(daily),
      weekly: compute(weekly),
      monthly: compute(monthly),
      yearly: compute(yearly),
    };
  }
}
```

- [ ] **Step 4: Run tests to confirm they pass**

```bash
cd apps/api && npx jest anand-dual-track.repository --no-coverage 2>&1 | tail -5
```

Expected: `PASS`

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/modules/anand-dual-track/
git commit -m "feat(anand-dual-track): repository — CRUD for intraday/swing entries + P/L summary"
```

---

## Task 3: AnandDualTrackService

**Files:**
- Create: `apps/api/src/modules/anand-dual-track/services/anand-dual-track.service.ts`
- Create: `apps/api/src/modules/anand-dual-track/services/__tests__/anand-dual-track.service.spec.ts`

- [ ] **Step 1: Write the failing tests**

Create `apps/api/src/modules/anand-dual-track/services/__tests__/anand-dual-track.service.spec.ts`:

```typescript
import { Test } from '@nestjs/testing';
import { AnandDualTrackService } from '../anand-dual-track.service';
import { AnandDualTrackRepository } from '../../repositories/anand-dual-track.repository';

describe('AnandDualTrackService', () => {
  let service: AnandDualTrackService;
  let repo: { createIntradayEntry: jest.Mock; createSwingEntry: jest.Mock };

  beforeEach(async () => {
    repo = {
      createIntradayEntry: jest.fn().mockResolvedValue({ id: 'i1' }),
      createSwingEntry: jest.fn().mockResolvedValue({ id: 's1' }),
    };

    const mod = await Test.createTestingModule({
      providers: [
        AnandDualTrackService,
        { provide: AnandDualTrackRepository, useValue: repo },
      ],
    }).compile();

    service = mod.get(AnandDualTrackService);
  });

  it('createEntries calls both repo methods with same input', async () => {
    const input = {
      alertId: 'a1', symbol: 'RELIANCE', token: '2885', hitPrice: 2500, scoreBreakdown: [{ name: 'RSI', passed: true }],
    };
    await service.createEntries(input);
    expect(repo.createIntradayEntry).toHaveBeenCalledWith({
      symbol: 'RELIANCE', token: '2885', entryPrice: 2500, alertId: 'a1', scoreBreakdown: [{ name: 'RSI', passed: true }],
    });
    expect(repo.createSwingEntry).toHaveBeenCalledWith({
      symbol: 'RELIANCE', token: '2885', entryPrice: 2500, alertId: 'a1', scoreBreakdown: [{ name: 'RSI', passed: true }],
    });
  });

  it('createEntries does not throw if one insert fails', async () => {
    repo.createSwingEntry.mockRejectedValue(new Error('DB error'));
    await expect(service.createEntries({
      alertId: 'a1', symbol: 'TCS', token: '11536', hitPrice: 3500, scoreBreakdown: null,
    })).resolves.not.toThrow();
    expect(repo.createIntradayEntry).toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run tests to confirm they fail**

```bash
cd apps/api && npx jest anand-dual-track.service --no-coverage 2>&1 | tail -5
```

Expected: `FAIL` — `Cannot find module '../anand-dual-track.service'`

- [ ] **Step 3: Implement the service**

Create `apps/api/src/modules/anand-dual-track/services/anand-dual-track.service.ts`:

```typescript
import { Injectable, Logger } from '@nestjs/common';
import { AnandDualTrackRepository } from '../repositories/anand-dual-track.repository';

export interface CreateEntriesInput {
  alertId: string;
  symbol: string;
  token: string | null;
  hitPrice: number;
  scoreBreakdown: unknown;
}

@Injectable()
export class AnandDualTrackService {
  private readonly logger = new Logger(AnandDualTrackService.name);

  constructor(private readonly repo: AnandDualTrackRepository) {}

  async createEntries(input: CreateEntriesInput): Promise<void> {
    const shared = {
      symbol: input.symbol,
      token: input.token,
      entryPrice: input.hitPrice,
      alertId: input.alertId,
      scoreBreakdown: input.scoreBreakdown,
    };

    const results = await Promise.allSettled([
      this.repo.createIntradayEntry(shared),
      this.repo.createSwingEntry(shared),
    ]);

    for (const [i, result] of results.entries()) {
      if (result.status === 'rejected') {
        this.logger.warn(
          `[anand-dual-track] ${i === 0 ? 'intraday' : 'swing'} insert failed for ${input.symbol}: ${result.reason instanceof Error ? result.reason.message : result.reason}`,
        );
      }
    }
  }
}
```

- [ ] **Step 4: Run tests to confirm they pass**

```bash
cd apps/api && npx jest anand-dual-track.service --no-coverage 2>&1 | tail -5
```

Expected: `PASS`

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/modules/anand-dual-track/services/anand-dual-track.service.ts \
        apps/api/src/modules/anand-dual-track/services/__tests__/anand-dual-track.service.spec.ts
git commit -m "feat(anand-dual-track): entry creation service — parallel intraday + swing inserts"
```

---

## Task 4: AnandPriceMonitorService

**Files:**
- Create: `apps/api/src/modules/anand-dual-track/services/anand-price-monitor.service.ts`
- Create: `apps/api/src/modules/anand-dual-track/services/__tests__/anand-price-monitor.service.spec.ts`

- [ ] **Step 1: Write the failing tests**

Create `apps/api/src/modules/anand-dual-track/services/__tests__/anand-price-monitor.service.spec.ts`:

```typescript
import { Test } from '@nestjs/testing';
import { AnandPriceMonitorService } from '../anand-price-monitor.service';
import { AnandDualTrackRepository } from '../../repositories/anand-dual-track.repository';
import { AngelOneAdapterService } from '../../../../market-data/services/angel-one-adapter.service';

const makeEntry = (overrides: Partial<{
  id: string; symbol: string; token: string; entryPrice: number;
  targetPct: number; stopPct: number; status: string;
}> = {}) => ({
  id: 'i1', symbol: 'RELIANCE', token: '2885', entryPrice: 2500,
  targetPct: 5, stopPct: 5, status: 'WATCHING', exitPrice: null, exitedAt: null,
  ...overrides,
});

describe('AnandPriceMonitorService', () => {
  let service: AnandPriceMonitorService;
  let repo: {
    listWatchingIntraday: jest.Mock;
    listWatchingSwing: jest.Mock;
    updateIntradayStatus: jest.Mock;
    updateSwingStatus: jest.Mock;
    expireAllWatchingIntraday: jest.Mock;
  };
  let adapter: { getLtpsBatch: jest.Mock };

  beforeEach(async () => {
    repo = {
      listWatchingIntraday: jest.fn().mockResolvedValue([]),
      listWatchingSwing: jest.fn().mockResolvedValue([]),
      updateIntradayStatus: jest.fn().mockResolvedValue(undefined),
      updateSwingStatus: jest.fn().mockResolvedValue(undefined),
      expireAllWatchingIntraday: jest.fn().mockResolvedValue(0),
    };
    adapter = { getLtpsBatch: jest.fn().mockResolvedValue(new Map()) };

    const mod = await Test.createTestingModule({
      providers: [
        AnandPriceMonitorService,
        { provide: AnandDualTrackRepository, useValue: repo },
        { provide: AngelOneAdapterService, useValue: adapter },
      ],
    }).compile();

    service = mod.get(AnandPriceMonitorService);
  });

  it('marks intraday entry TARGET_HIT when ltp >= entryPrice * 1.05', async () => {
    repo.listWatchingIntraday.mockResolvedValue([makeEntry({ entryPrice: 2500, targetPct: 5 })]);
    adapter.getLtpsBatch.mockResolvedValue(new Map([['2885', 2625]])); // +5%
    await service.pollMarketHours();
    expect(repo.updateIntradayStatus).toHaveBeenCalledWith('i1', expect.objectContaining({ status: 'TARGET_HIT', exitPrice: 2625 }));
  });

  it('marks intraday entry STOPPED when ltp <= entryPrice * 0.95', async () => {
    repo.listWatchingIntraday.mockResolvedValue([makeEntry({ entryPrice: 2500, stopPct: 5 })]);
    adapter.getLtpsBatch.mockResolvedValue(new Map([['2885', 2374]])); // -5.04%
    await service.pollMarketHours();
    expect(repo.updateIntradayStatus).toHaveBeenCalledWith('i1', expect.objectContaining({ status: 'STOPPED' }));
  });

  it('does not update status when price is within range', async () => {
    repo.listWatchingIntraday.mockResolvedValue([makeEntry({ entryPrice: 2500 })]);
    adapter.getLtpsBatch.mockResolvedValue(new Map([['2885', 2530]])); // +1.2%
    await service.pollMarketHours();
    expect(repo.updateIntradayStatus).not.toHaveBeenCalled();
  });

  it('marks swing entry TARGET_HIT when ltp >= entryPrice * 1.10', async () => {
    repo.listWatchingSwing.mockResolvedValue([makeEntry({ id: 's1', token: '2885', entryPrice: 3000, targetPct: 10, stopPct: 10 })]);
    adapter.getLtpsBatch.mockResolvedValue(new Map([['2885', 3300]])); // +10%
    await service.pollMarketHours();
    expect(repo.updateSwingStatus).toHaveBeenCalledWith('s1', expect.objectContaining({ status: 'TARGET_HIT', exitPrice: 3300 }));
  });

  it('expireIntradayAtClose calls expireAllWatchingIntraday', async () => {
    repo.expireAllWatchingIntraday.mockResolvedValue(4);
    await service.expireIntradayAtClose();
    expect(repo.expireAllWatchingIntraday).toHaveBeenCalled();
  });

  it('pollOvernight only processes swing entries', async () => {
    repo.listWatchingSwing.mockResolvedValue([makeEntry({ id: 's1', token: '2885', entryPrice: 3000, targetPct: 10, stopPct: 10 })]);
    adapter.getLtpsBatch.mockResolvedValue(new Map([['2885', 3300]]));
    await service.pollOvernight();
    expect(repo.listWatchingIntraday).not.toHaveBeenCalled();
    expect(repo.updateSwingStatus).toHaveBeenCalledWith('s1', expect.objectContaining({ status: 'TARGET_HIT' }));
  });

  it('skips token not found in ltp map', async () => {
    repo.listWatchingIntraday.mockResolvedValue([makeEntry({ token: 'unknown' })]);
    adapter.getLtpsBatch.mockResolvedValue(new Map()); // empty
    await service.pollMarketHours();
    expect(repo.updateIntradayStatus).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run tests to confirm they fail**

```bash
cd apps/api && npx jest anand-price-monitor --no-coverage 2>&1 | tail -5
```

Expected: `FAIL` — `Cannot find module '../anand-price-monitor.service'`

- [ ] **Step 3: Implement the price monitor**

Create `apps/api/src/modules/anand-dual-track/services/anand-price-monitor.service.ts`:

```typescript
import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { AnandDualTrackRepository } from '../repositories/anand-dual-track.repository';
import { AngelOneAdapterService } from '../../market-data/services/angel-one-adapter.service';

@Injectable()
export class AnandPriceMonitorService {
  private readonly logger = new Logger(AnandPriceMonitorService.name);

  constructor(
    private readonly repo: AnandDualTrackRepository,
    private readonly adapter: AngelOneAdapterService,
  ) {}

  // Poll both tracks every 30s during market hours Mon–Fri 09:15–15:15 IST.
  @Cron('*/30 9-15 * * 1-5', { timeZone: 'Asia/Kolkata' })
  async pollMarketHours(): Promise<void> {
    const [intraday, swing] = await Promise.all([
      this.repo.listWatchingIntraday(),
      this.repo.listWatchingSwing(),
    ]);

    await this.checkEntries(intraday, 'intraday');
    await this.checkEntries(swing, 'swing');
  }

  // Expire all WATCHING intraday entries at 15:15 IST (market close).
  @Cron('15 15 15 * * 1-5', { timeZone: 'Asia/Kolkata' })
  async expireIntradayAtClose(): Promise<void> {
    const count = await this.repo.expireAllWatchingIntraday();
    this.logger.log(`[anand-intraday] expired ${count} WATCHING entries at market close`);
  }

  // Poll swing entries every 10 min outside market hours (overnight, weekends).
  @Cron('0 */10 0-8 * * 1-5', { timeZone: 'Asia/Kolkata' })
  @Cron('0 */10 16-23 * * 1-5', { timeZone: 'Asia/Kolkata' })
  @Cron('0 */10 * * * 0,6', { timeZone: 'Asia/Kolkata' })
  async pollOvernight(): Promise<void> {
    const swing = await this.repo.listWatchingSwing();
    await this.checkEntries(swing, 'swing');
  }

  private async checkEntries(
    entries: Array<{ id: string; token: string | null; entryPrice: number; targetPct: number; stopPct: number }>,
    track: 'intraday' | 'swing',
  ): Promise<void> {
    const withToken = entries.filter((e) => e.token);
    if (withToken.length === 0) return;

    const tokens = [...new Set(withToken.map((e) => e.token as string))];
    const ltpMap = await this.adapter.getLtpsBatch('NSE', tokens).catch(() => new Map<string, number>());

    const now = new Date();
    for (const entry of withToken) {
      const ltp = ltpMap.get(entry.token as string);
      if (ltp === undefined) continue;

      const pnlPct = ((ltp - entry.entryPrice) / entry.entryPrice) * 100;

      if (pnlPct >= entry.targetPct) {
        this.logger.log(`[anand-${track}] ${entry.id} TARGET_HIT at ${ltp} (+${pnlPct.toFixed(2)}%)`);
        await (track === 'intraday'
          ? this.repo.updateIntradayStatus(entry.id, { status: 'TARGET_HIT', exitPrice: ltp, exitedAt: now })
          : this.repo.updateSwingStatus(entry.id, { status: 'TARGET_HIT', exitPrice: ltp, exitedAt: now }));
      } else if (pnlPct <= -entry.stopPct) {
        this.logger.log(`[anand-${track}] ${entry.id} STOPPED at ${ltp} (${pnlPct.toFixed(2)}%)`);
        await (track === 'intraday'
          ? this.repo.updateIntradayStatus(entry.id, { status: 'STOPPED', exitPrice: ltp, exitedAt: now })
          : this.repo.updateSwingStatus(entry.id, { status: 'STOPPED', exitPrice: ltp, exitedAt: now }));
      }
    }
  }
}
```

- [ ] **Step 4: Run tests to confirm they pass**

```bash
cd apps/api && npx jest anand-price-monitor --no-coverage 2>&1 | tail -5
```

Expected: `PASS`

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/modules/anand-dual-track/services/anand-price-monitor.service.ts \
        apps/api/src/modules/anand-dual-track/services/__tests__/anand-price-monitor.service.spec.ts
git commit -m "feat(anand-dual-track): price monitor — Cron poll for target/stop hit + intraday expiry"
```

---

## Task 5: Controller + Module + AppModule + ChartinkRepository patch

**Files:**
- Create: `apps/api/src/modules/anand-dual-track/controllers/anand-dual-track.controller.ts`
- Create: `apps/api/src/modules/anand-dual-track/anand-dual-track.module.ts`
- Modify: `apps/api/src/app.module.ts`
- Modify: `apps/api/src/modules/chartink/repositories/chartink.repository.ts`

- [ ] **Step 1: Create the controller**

Create `apps/api/src/modules/anand-dual-track/controllers/anand-dual-track.controller.ts`:

```typescript
import { Body, Controller, Get, NotFoundException, Param, Patch, Query } from '@nestjs/common';
import { AnandDualTrackRepository } from '../repositories/anand-dual-track.repository';
import { ChartinkRepository } from '../../chartink/repositories/chartink.repository';
import { AngelOneAdapterService } from '../../market-data/services/angel-one-adapter.service';

@Controller('api/anand')
export class AnandDualTrackController {
  constructor(
    private readonly repo: AnandDualTrackRepository,
    private readonly chartinkRepo: ChartinkRepository,
    private readonly adapter: AngelOneAdapterService,
  ) {}

  @Get('intraday/entries')
  async listIntraday(
    @Query('status') status?: string,
    @Query('from') from?: string,
    @Query('to') to?: string,
  ) {
    const entries = await this.repo.listIntradayEntries({
      status: status || undefined,
      from: from ? new Date(from) : undefined,
      to: to ? new Date(to) : undefined,
    });
    return this.enrichWithLivePrice(entries);
  }

  @Get('swing/entries')
  async listSwing(
    @Query('status') status?: string,
    @Query('from') from?: string,
    @Query('to') to?: string,
  ) {
    const entries = await this.repo.listSwingEntries({
      status: status || undefined,
      from: from ? new Date(from) : undefined,
      to: to ? new Date(to) : undefined,
    });
    return this.enrichWithLivePrice(entries);
  }

  @Get('intraday/pnl-summary')
  async intradayPnl() {
    return this.repo.getPnlSummary('intraday');
  }

  @Get('swing/pnl-summary')
  async swingPnl() {
    return this.repo.getPnlSummary('swing');
  }

  @Patch('scanners/:id/category')
  async tagScanner(
    @Param('id') id: string,
    @Body() body: { category: string },
  ) {
    const updated = await this.chartinkRepo.updateScannerCategory(id, body.category);
    if (!updated) throw new NotFoundException(`Scanner ${id} not found`);
    return updated;
  }

  private async enrichWithLivePrice(
    entries: Array<{ id: string; token: string | null; entryPrice: number; targetPct: number; stopPct: number; status: string; [key: string]: unknown }>,
  ) {
    const tokens = [...new Set(entries.map((e) => e.token).filter(Boolean) as string[])];
    const ltpMap = tokens.length
      ? await this.adapter.getLtpsBatch('NSE', tokens).catch(() => new Map<string, number>())
      : new Map<string, number>();

    return entries.map((e) => {
      const currentPrice = (e.token ? ltpMap.get(e.token) : undefined) ?? e.entryPrice;
      const pnlPct = ((currentPrice - e.entryPrice) / e.entryPrice) * 100;
      const targetLeftPct = e.targetPct - pnlPct;
      return { ...e, currentPrice, pnlPct, targetLeftPct };
    });
  }
}
```

- [ ] **Step 2: Add `updateScannerCategory` and `getScannerById` to `ChartinkRepository`**

In `apps/api/src/modules/chartink/repositories/chartink.repository.ts`, add after `listRecentAlerts`:

```typescript
  async updateScannerCategory(
    id: string,
    category: string,
  ): Promise<{ id: string; category: string } | null> {
    try {
      return await this.prisma.chartinkScanner.update({
        where: { id },
        data: { category },
        select: { id: true, category: true },
      });
    } catch {
      return null;
    }
  }

  async getScannerById(id: string) {
    return this.prisma.chartinkScanner.findUnique({ where: { id } });
  }
```

- [ ] **Step 3: Create the module**

Create `apps/api/src/modules/anand-dual-track/anand-dual-track.module.ts`:

```typescript
import { Module } from '@nestjs/common';
import { ScheduleModule } from '@nestjs/schedule';
import { PrismaModule } from '../../common/prisma/prisma.module';
import { MarketDataModule } from '../market-data/market-data.module';
import { ChartinkModule } from '../chartink/chartink.module';
import { AnandDualTrackRepository } from './repositories/anand-dual-track.repository';
import { AnandDualTrackService } from './services/anand-dual-track.service';
import { AnandPriceMonitorService } from './services/anand-price-monitor.service';
import { AnandDualTrackController } from './controllers/anand-dual-track.controller';

@Module({
  imports: [PrismaModule, MarketDataModule, ChartinkModule],
  controllers: [AnandDualTrackController],
  providers: [AnandDualTrackRepository, AnandDualTrackService, AnandPriceMonitorService],
  exports: [AnandDualTrackService],
})
export class AnandDualTrackModule {}
```

- [ ] **Step 4: Register in `AppModule`**

In `apps/api/src/app.module.ts`, add the import after `UngatedTrackModule`:

```typescript
import { AnandDualTrackModule } from './modules/anand-dual-track/anand-dual-track.module';
```

And in the `imports` array after `UngatedTrackModule,`:

```typescript
    // Anand Dual-Track — intraday (5%) and swing (10%) analysis logs
    AnandDualTrackModule,
```

- [ ] **Step 5: Smoke-test the API compiles**

```bash
cd apps/api && npx nest build 2>&1 | tail -10
```

Expected: no TypeScript errors.

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/modules/anand-dual-track/ \
        apps/api/src/modules/chartink/repositories/chartink.repository.ts \
        apps/api/src/app.module.ts
git commit -m "feat(anand-dual-track): controller, module, AppModule wiring + scanner category endpoint"
```

---

## Task 6: Wire `ChartinkProcessService`

**Files:**
- Modify: `apps/api/src/modules/chartink/services/chartink-process.service.ts`
- Modify: `apps/api/src/modules/chartink/chartink.module.ts`

- [ ] **Step 1: Pass scanner category through the call chain**

In `apps/api/src/modules/chartink/services/chartink-process.service.ts`:

1. Update the `processAlert` method to extract `scannerCategory`:

```typescript
  async processAlert(alertId: string, hits: Hit[]): Promise<void> {
    this.logger.log(`Processing Chartink alert ${alertId} — ${hits.length} hits`);
    let scanName: string | undefined;
    let scannerCategory: string | undefined;
    try {
      const alert = await this.repo.getAlertWithSetups(alertId);
      scanName = alert?.scanner?.scanName ?? undefined;
      scannerCategory = (alert?.scanner as any)?.category ?? undefined;
    } catch (err) {
      this.logger.warn(
        `could not resolve scanner name for alert ${alertId}: ${err instanceof Error ? err.message : err}`,
      );
    }
    for (let i = 0; i < hits.length; i++) {
      try {
        await this.processOne(alertId, hits[i], scanName, scannerCategory);
      } catch (err) {
        this.logger.warn(
          `processOne unexpected throw for ${hits[i].symbol}: ${err instanceof Error ? err.message : err}`,
        );
      }
      if (i < hits.length - 1) await this.sleep(RATE_LIMIT_MS);
    }
  }
```

2. Update the `processOne` signature and inject `AnandDualTrackService`:

At the top of the file add the import:
```typescript
import { AnandDualTrackService } from '../../anand-dual-track/services/anand-dual-track.service';
```

In the constructor, add:
```typescript
    private readonly anandDualTrack: AnandDualTrackService,
```

Update `processOne` signature:
```typescript
  async processOne(alertId: string, hit: Hit, scanName?: string, scannerCategory?: string): Promise<void> {
```

3. After the existing step 5 (ungated track), add step 6 at the end of `processOne`:

```typescript
    // === 6. ANAND DUAL TRACK — runs for ANAND_SWING scanners after scoring.
    // Independent try/catch: failures here MUST NOT affect gated or ungated paths.
    if (scannerCategory === 'ANAND_SWING') {
      try {
        await this.anandDualTrack.createEntries({
          alertId,
          symbol: hit.symbol,
          token: instrument.token,
          hitPrice: hit.hitPrice,
          scoreBreakdown: scoringResult.checks,
        });
      } catch (err) {
        this.logger.warn(`[anand-dual-track] createEntries failed for ${hit.symbol}: ${err instanceof Error ? err.message : err}`);
      }
    }
```

- [ ] **Step 2: Import `AnandDualTrackModule` in `ChartinkModule`**

In `apps/api/src/modules/chartink/chartink.module.ts`:

Add import at top:
```typescript
import { AnandDualTrackModule } from '../anand-dual-track/anand-dual-track.module';
```

Add to `imports` array in the module decorator:
```typescript
    AnandDualTrackModule,
```

- [ ] **Step 3: Verify the existing process service tests still pass**

```bash
cd apps/api && npx jest chartink-process --no-coverage 2>&1 | tail -10
```

Expected: `PASS` — the new `anandDualTrack` parameter gets mocked as `{ createEntries: jest.fn() }`. If tests fail due to missing mock, add to the test's `beforeEach`:

```typescript
    let anandDualTrack: { createEntries: jest.Mock };
    // inside beforeEach:
    anandDualTrack = { createEntries: jest.fn().mockResolvedValue(undefined) };
    // in the providers list:
    { provide: AnandDualTrackService, useValue: anandDualTrack },
```

And add to the `Test.createTestingModule` providers in `chartink-process.service.spec.ts`.

- [ ] **Step 4: Smoke-test API starts cleanly**

Restart the dev server and check for errors:

```bash
cd apps/api && npx nest start --watch 2>&1 | head -20
```

Expected: `TD Automation API running on http://localhost:4001`

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/modules/chartink/services/chartink-process.service.ts \
        apps/api/src/modules/chartink/chartink.module.ts \
        apps/api/src/modules/chartink/services/__tests__/chartink-process.service.spec.ts
git commit -m "feat(chartink): wire AnandDualTrackService into processOne — step 6 for ANAND_SWING scanners"
```

---

## Task 7: Tag the Anand Swing Scanner

- [ ] **Step 1: Find the scanner ID**

```bash
curl -s http://127.0.0.1:4001/api/chartink/scanners | npx -y json-pretty-print 2>/dev/null || \
curl -s http://127.0.0.1:4001/api/chartink/scanners
```

Find the scanner with `scanName` containing "Anand" and note its `id`.

- [ ] **Step 2: Tag it as ANAND_SWING**

Replace `<SCANNER_ID>` with the actual ID:

```bash
curl -s -X PATCH http://127.0.0.1:4001/api/anand/scanners/<SCANNER_ID>/category \
  -H "Content-Type: application/json" \
  -d '{"category":"ANAND_SWING"}'
```

Expected: `{"id":"<SCANNER_ID>","category":"ANAND_SWING"}`

- [ ] **Step 3: Verify with scanner list**

```bash
curl -s http://127.0.0.1:4001/api/chartink/scanners | grep -A2 "Anand"
```

Expected: `"category": "ANAND_SWING"` visible in the response.

---

## Task 8: Frontend Service + Hooks

**Files:**
- Create: `apps/web/src/services/anand.ts`
- Create: `apps/web/src/hooks/useIntradayEntries.ts`
- Create: `apps/web/src/hooks/useSwingEntries.ts`

- [ ] **Step 1: Create the API service**

Create `apps/web/src/services/anand.ts`:

```typescript
import api from './api';

export interface AnandEntry {
  id: string;
  symbol: string;
  token: string | null;
  entryPrice: number;
  enteredAt: string;
  targetPct: number;
  stopPct: number;
  status: string;
  exitPrice: number | null;
  exitedAt: string | null;
  currentPrice: number;
  pnlPct: number;
  targetLeftPct: number;
  scoreBreakdown: Array<{ name: string; points: number; pointsPossible: number; passed: boolean }> | null;
}

export interface PnlPeriod {
  avgExitPct: number;
  count: number;
  winCount: number;
}

export interface PnlSummary {
  daily: PnlPeriod;
  weekly: PnlPeriod;
  monthly: PnlPeriod;
  yearly: PnlPeriod;
}

export async function listIntradayEntries(params: {
  status?: string; from?: string; to?: string;
} = {}): Promise<AnandEntry[]> {
  const r = await api.get<AnandEntry[]>('/anand/intraday/entries', { params });
  return r.data;
}

export async function listSwingEntries(params: {
  status?: string; from?: string; to?: string;
} = {}): Promise<AnandEntry[]> {
  const r = await api.get<AnandEntry[]>('/anand/swing/entries', { params });
  return r.data;
}

export async function getIntradayPnl(): Promise<PnlSummary> {
  const r = await api.get<PnlSummary>('/anand/intraday/pnl-summary');
  return r.data;
}

export async function getSwingPnl(): Promise<PnlSummary> {
  const r = await api.get<PnlSummary>('/anand/swing/pnl-summary');
  return r.data;
}
```

- [ ] **Step 2: Create `useIntradayEntries` hook**

Create `apps/web/src/hooks/useIntradayEntries.ts`:

```typescript
import { useCallback, useEffect, useState } from 'react';
import { listIntradayEntries, getIntradayPnl, type AnandEntry, type PnlSummary } from '../services/anand';

const REFRESH_MS = 30_000;

export function useIntradayEntries(status?: string, date?: string) {
  const [entries, setEntries] = useState<AnandEntry[]>([]);
  const [pnl, setPnl] = useState<PnlSummary | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const [rows, summary] = await Promise.all([
        listIntradayEntries({
          status: status || undefined,
          from: date ? `${date}T00:00:00.000Z` : undefined,
          to: date ? `${date}T23:59:59.999Z` : undefined,
        }),
        getIntradayPnl(),
      ]);
      setEntries(rows);
      setPnl(summary);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'fetch failed');
    } finally {
      setLoading(false);
    }
  }, [status, date]);

  useEffect(() => {
    refresh();
    const t = window.setInterval(refresh, REFRESH_MS);
    return () => window.clearInterval(t);
  }, [refresh]);

  return { entries, pnl, loading, error, refresh };
}
```

- [ ] **Step 3: Create `useSwingEntries` hook**

Create `apps/web/src/hooks/useSwingEntries.ts`:

```typescript
import { useCallback, useEffect, useState } from 'react';
import { listSwingEntries, getSwingPnl, type AnandEntry, type PnlSummary } from '../services/anand';

const REFRESH_MS = 30_000;

export function useSwingEntries(status?: string, from?: string) {
  const [entries, setEntries] = useState<AnandEntry[]>([]);
  const [pnl, setPnl] = useState<PnlSummary | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const [rows, summary] = await Promise.all([
        listSwingEntries({
          status: status || undefined,
          from: from ? `${from}T00:00:00.000Z` : undefined,
        }),
        getSwingPnl(),
      ]);
      setEntries(rows);
      setPnl(summary);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'fetch failed');
    } finally {
      setLoading(false);
    }
  }, [status, from]);

  useEffect(() => {
    refresh();
    const t = window.setInterval(refresh, REFRESH_MS);
    return () => window.clearInterval(t);
  }, [refresh]);

  return { entries, pnl, loading, error, refresh };
}
```

- [ ] **Step 4: Commit**

```bash
git add apps/web/src/services/anand.ts \
        apps/web/src/hooks/useIntradayEntries.ts \
        apps/web/src/hooks/useSwingEntries.ts
git commit -m "feat(web): anand service + useIntradayEntries + useSwingEntries hooks"
```

---

## Task 9: IntradayPage

**Files:**
- Create: `apps/web/src/pages/intraday/IntradayPage.tsx`
- Modify: `apps/web/src/App.tsx`
- Modify: `apps/web/src/components/layout/Sidebar.tsx`

- [ ] **Step 1: Create `IntradayPage`**

Create `apps/web/src/pages/intraday/IntradayPage.tsx`:

```typescript
import React, { useState } from 'react';
import clsx from 'clsx';
import { useIntradayEntries } from '../../hooks/useIntradayEntries';
import ChartinkScoreTable from '../../components/chartink/ChartinkScoreTable';
import type { AnandEntry, PnlSummary } from '../../services/anand';

const FILTERS = [
  { label: 'All', value: undefined },
  { label: 'Watching', value: 'WATCHING' },
  { label: 'Target Hit', value: 'TARGET_HIT' },
  { label: 'Stopped', value: 'STOPPED' },
  { label: 'Expired', value: 'EXPIRED' },
] as const;

function todayIST(): string {
  return new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
}

function fmtPct(n: number): string {
  return `${n >= 0 ? '+' : ''}${n.toFixed(2)}%`;
}

function PnlBar({ pnl }: { pnl: PnlSummary }) {
  const fmt = (p: { avgExitPct: number; count: number; winCount: number }) =>
    p.count ? `${fmtPct(p.avgExitPct)} (${p.winCount}W/${p.count})` : '—';
  return (
    <div className="flex flex-wrap gap-6 rounded-lg border border-[var(--color-border-subtle)] bg-[var(--color-bg-secondary)] px-4 py-3 text-sm">
      {(['daily', 'weekly', 'monthly', 'yearly'] as const).map((k) => (
        <div key={k}>
          <span className="text-[var(--color-text-muted)] capitalize">{k}: </span>
          <span className={clsx('font-semibold tabular-nums', pnl[k].avgExitPct >= 0 ? 'text-emerald-400' : 'text-red-400')}>
            {fmt(pnl[k])}
          </span>
        </div>
      ))}
    </div>
  );
}

function EntryRow({ entry }: { entry: AnandEntry }) {
  const [expanded, setExpanded] = useState(false);
  const pnlColor = entry.pnlPct >= 0 ? 'text-emerald-400' : 'text-red-400';
  const statusColor: Record<string, string> = {
    WATCHING: 'text-blue-400',
    TARGET_HIT: 'text-emerald-400',
    STOPPED: 'text-red-400',
    EXPIRED: 'text-gray-400',
  };

  return (
    <React.Fragment>
      <tr
        onClick={() => setExpanded((v) => !v)}
        className="cursor-pointer border-t border-[var(--color-border-subtle)] hover:bg-[var(--color-bg-tertiary)]"
      >
        <td className="px-3 py-2 font-mono font-medium">{entry.symbol}</td>
        <td className="px-3 py-2 tabular-nums">₹{entry.entryPrice.toFixed(2)}</td>
        <td className="px-3 py-2 text-[var(--color-text-muted)] tabular-nums">
          {new Date(entry.enteredAt).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' })}
        </td>
        <td className={clsx('px-3 py-2 font-semibold tabular-nums', pnlColor)}>
          {fmtPct(entry.pnlPct)}
        </td>
        <td className="px-3 py-2 tabular-nums text-[var(--color-text-muted)]">
          {entry.status === 'WATCHING' ? fmtPct(entry.targetLeftPct) : '—'}
        </td>
        <td className={clsx('px-3 py-2 text-xs font-semibold uppercase tracking-wider', statusColor[entry.status] ?? 'text-gray-400')}>
          {entry.status}
        </td>
      </tr>
      {expanded && entry.scoreBreakdown && (
        <tr className="border-t border-[var(--color-border-subtle)] bg-[var(--color-bg-secondary)]/40">
          <td colSpan={6} className="px-3 py-2">
            <ChartinkScoreTable
              score={entry.scoreBreakdown.filter((c) => c.passed).reduce((s, c) => s + c.points, 0)}
              lotCount={0}
              checks={entry.scoreBreakdown}
            />
          </td>
        </tr>
      )}
    </React.Fragment>
  );
}

export default function IntradayPage() {
  const [filter, setFilter] = useState<string | undefined>(undefined);
  const [date, setDate] = useState(todayIST());
  const { entries, pnl, loading, error } = useIntradayEntries(filter, date);
  const activeCount = entries.filter((e) => e.status === 'WATCHING').length;

  return (
    <div className="flex flex-col gap-4 p-6 text-[var(--color-text-primary)]">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold">Intraday Track</h1>
          <p className="text-sm text-[var(--color-text-muted)]">5% target · 5% stop · expires at 15:15</p>
        </div>
        <div className="text-sm text-[var(--color-text-muted)]">{activeCount} watching</div>
      </div>

      {pnl && <PnlBar pnl={pnl} />}

      <div className="flex flex-wrap gap-2">
        {FILTERS.map((f) => (
          <button
            key={f.label}
            onClick={() => setFilter(f.value)}
            className={clsx(
              'rounded px-3 py-1 text-sm transition-colors',
              filter === f.value
                ? 'bg-blue-600 text-white'
                : 'bg-[var(--color-bg-tertiary)] text-[var(--color-text-secondary)] hover:text-[var(--color-text-primary)]',
            )}
          >
            {f.label}
          </button>
        ))}
        <input
          type="date"
          value={date}
          onChange={(e) => setDate(e.target.value)}
          className="ml-auto rounded bg-[var(--color-bg-tertiary)] px-2 py-1 text-sm text-[var(--color-text-secondary)]"
        />
      </div>

      {loading && <div className="text-[var(--color-text-muted)]">Loading…</div>}
      {error && <div className="text-red-400">Error: {error}</div>}
      {!loading && !error && (
        <div className="overflow-hidden rounded-lg border border-[var(--color-border-subtle)]">
          <table className="w-full text-sm">
            <thead className="bg-[var(--color-bg-secondary)] text-left text-xs uppercase tracking-wider text-[var(--color-text-muted)]">
              <tr>
                <th className="px-3 py-2">Symbol</th>
                <th className="px-3 py-2">Entry ₹</th>
                <th className="px-3 py-2">Date & Time</th>
                <th className="px-3 py-2">P/L %</th>
                <th className="px-3 py-2">Target Left</th>
                <th className="px-3 py-2">Status</th>
              </tr>
            </thead>
            <tbody>
              {entries.length === 0 && (
                <tr>
                  <td colSpan={6} className="px-3 py-8 text-center text-[var(--color-text-muted)]">
                    No entries yet. Tag an Anand Swing scanner as ANAND_SWING to start auto-logging.
                  </td>
                </tr>
              )}
              {entries.map((e) => <EntryRow key={e.id} entry={e} />)}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
```

- [ ] **Step 2: Add sidebar entry and route for Intraday**

In `apps/web/src/components/layout/Sidebar.tsx`, add `Timer` to the lucide import:
```typescript
import {
  // ... existing imports ...
  Timer,
  TrendingUp,
} from 'lucide-react';
```

Add to `navItems` array after the `UngatedWatch` entry:
```typescript
  { path: '/intraday', label: 'Intraday', icon: Timer },
  { path: '/swing',    label: 'Swing',    icon: TrendingUp },
```

In `apps/web/src/App.tsx`, add the import:
```typescript
import IntradayPage from '@/pages/intraday/IntradayPage';
```

Add the route after `ungated-watch`:
```typescript
        <Route path="intraday" element={<IntradayPage />} />
```

- [ ] **Step 3: Commit**

```bash
git add apps/web/src/pages/intraday/ \
        apps/web/src/components/layout/Sidebar.tsx \
        apps/web/src/App.tsx
git commit -m "feat(web): IntradayPage — 5% target/stop analysis log with score factor expansion"
```

---

## Task 10: SwingPage

**Files:**
- Create: `apps/web/src/pages/swing/SwingPage.tsx`
- Modify: `apps/web/src/App.tsx`

- [ ] **Step 1: Create `SwingPage`**

Create `apps/web/src/pages/swing/SwingPage.tsx`:

```typescript
import React, { useState } from 'react';
import clsx from 'clsx';
import { useSwingEntries } from '../../hooks/useSwingEntries';
import ChartinkScoreTable from '../../components/chartink/ChartinkScoreTable';
import type { AnandEntry, PnlSummary } from '../../services/anand';

const FILTERS = [
  { label: 'All', value: undefined },
  { label: 'Watching', value: 'WATCHING' },
  { label: 'Target Hit', value: 'TARGET_HIT' },
  { label: 'Stopped', value: 'STOPPED' },
] as const;

function todayIST(): string {
  return new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
}

function fmtPct(n: number): string {
  return `${n >= 0 ? '+' : ''}${n.toFixed(2)}%`;
}

function PnlBar({ pnl }: { pnl: PnlSummary }) {
  const fmt = (p: { avgExitPct: number; count: number; winCount: number }) =>
    p.count ? `${fmtPct(p.avgExitPct)} (${p.winCount}W/${p.count})` : '—';
  return (
    <div className="flex flex-wrap gap-6 rounded-lg border border-[var(--color-border-subtle)] bg-[var(--color-bg-secondary)] px-4 py-3 text-sm">
      {(['daily', 'weekly', 'monthly', 'yearly'] as const).map((k) => (
        <div key={k}>
          <span className="text-[var(--color-text-muted)] capitalize">{k}: </span>
          <span className={clsx('font-semibold tabular-nums', pnl[k].avgExitPct >= 0 ? 'text-emerald-400' : 'text-red-400')}>
            {fmt(pnl[k])}
          </span>
        </div>
      ))}
    </div>
  );
}

function EntryRow({ entry }: { entry: AnandEntry }) {
  const [expanded, setExpanded] = useState(false);
  const pnlColor = entry.pnlPct >= 0 ? 'text-emerald-400' : 'text-red-400';
  const statusColor: Record<string, string> = {
    WATCHING: 'text-blue-400',
    TARGET_HIT: 'text-emerald-400',
    STOPPED: 'text-red-400',
  };
  const isOvernight = entry.status === 'WATCHING';

  return (
    <React.Fragment>
      <tr
        onClick={() => setExpanded((v) => !v)}
        className="cursor-pointer border-t border-[var(--color-border-subtle)] hover:bg-[var(--color-bg-tertiary)]"
      >
        <td className="px-3 py-2 font-mono font-medium">
          {entry.symbol}
          {isOvernight && (
            <span className="ml-2 rounded bg-amber-500/20 px-1 py-0.5 text-[9px] font-semibold uppercase text-amber-300">
              Overnight
            </span>
          )}
        </td>
        <td className="px-3 py-2 tabular-nums">₹{entry.entryPrice.toFixed(2)}</td>
        <td className="px-3 py-2 text-[var(--color-text-muted)] tabular-nums">
          {new Date(entry.enteredAt).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' })}
        </td>
        <td className={clsx('px-3 py-2 font-semibold tabular-nums', pnlColor)}>
          {fmtPct(entry.pnlPct)}
        </td>
        <td className="px-3 py-2 tabular-nums text-[var(--color-text-muted)]">
          {entry.status === 'WATCHING' ? fmtPct(entry.targetLeftPct) : '—'}
        </td>
        <td className={clsx('px-3 py-2 text-xs font-semibold uppercase tracking-wider', statusColor[entry.status] ?? 'text-gray-400')}>
          {entry.status}
        </td>
      </tr>
      {expanded && entry.scoreBreakdown && (
        <tr className="border-t border-[var(--color-border-subtle)] bg-[var(--color-bg-secondary)]/40">
          <td colSpan={6} className="px-3 py-2">
            <ChartinkScoreTable
              score={entry.scoreBreakdown.filter((c) => c.passed).reduce((s, c) => s + c.points, 0)}
              lotCount={0}
              checks={entry.scoreBreakdown}
            />
          </td>
        </tr>
      )}
    </React.Fragment>
  );
}

export default function SwingPage() {
  const [filter, setFilter] = useState<string | undefined>(undefined);
  const [from, setFrom] = useState(todayIST());
  const { entries, pnl, loading, error } = useSwingEntries(filter, from);
  const activeCount = entries.filter((e) => e.status === 'WATCHING').length;

  return (
    <div className="flex flex-col gap-4 p-6 text-[var(--color-text-primary)]">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold">Swing Track</h1>
          <p className="text-sm text-[var(--color-text-muted)]">10% target · 10% stop · holds overnight</p>
        </div>
        <div className="text-sm text-[var(--color-text-muted)]">{activeCount} watching</div>
      </div>

      {pnl && <PnlBar pnl={pnl} />}

      <div className="flex flex-wrap gap-2">
        {FILTERS.map((f) => (
          <button
            key={f.label}
            onClick={() => setFilter(f.value)}
            className={clsx(
              'rounded px-3 py-1 text-sm transition-colors',
              filter === f.value
                ? 'bg-blue-600 text-white'
                : 'bg-[var(--color-bg-tertiary)] text-[var(--color-text-secondary)] hover:text-[var(--color-text-primary)]',
            )}
          >
            {f.label}
          </button>
        ))}
        <div className="ml-auto flex items-center gap-2 text-sm text-[var(--color-text-muted)]">
          <label>From:</label>
          <input
            type="date"
            value={from}
            onChange={(e) => setFrom(e.target.value)}
            className="rounded bg-[var(--color-bg-tertiary)] px-2 py-1 text-[var(--color-text-secondary)]"
          />
        </div>
      </div>

      {loading && <div className="text-[var(--color-text-muted)]">Loading…</div>}
      {error && <div className="text-red-400">Error: {error}</div>}
      {!loading && !error && (
        <div className="overflow-hidden rounded-lg border border-[var(--color-border-subtle)]">
          <table className="w-full text-sm">
            <thead className="bg-[var(--color-bg-secondary)] text-left text-xs uppercase tracking-wider text-[var(--color-text-muted)]">
              <tr>
                <th className="px-3 py-2">Symbol</th>
                <th className="px-3 py-2">Entry ₹</th>
                <th className="px-3 py-2">Date & Time</th>
                <th className="px-3 py-2">P/L %</th>
                <th className="px-3 py-2">Target Left</th>
                <th className="px-3 py-2">Status</th>
              </tr>
            </thead>
            <tbody>
              {entries.length === 0 && (
                <tr>
                  <td colSpan={6} className="px-3 py-8 text-center text-[var(--color-text-muted)]">
                    No swing entries yet. Waiting for Anand Swing scanner alerts.
                  </td>
                </tr>
              )}
              {entries.map((e) => <EntryRow key={e.id} entry={e} />)}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
```

- [ ] **Step 2: Add route in `App.tsx`**

In `apps/web/src/App.tsx`, add the import:
```typescript
import SwingPage from '@/pages/swing/SwingPage';
```

Add the route after the intraday route:
```typescript
        <Route path="swing" element={<SwingPage />} />
```

- [ ] **Step 3: Run the full test suite**

```bash
cd apps/api && npx jest --no-coverage 2>&1 | tail -15
```

Expected: all tests pass (no regressions).

- [ ] **Step 4: Commit**

```bash
git add apps/web/src/pages/swing/ apps/web/src/App.tsx
git commit -m "feat(web): SwingPage — 10% target/stop with overnight badge + score factor expansion"
```

---

## Self-Review Checklist

**Spec coverage:**
- ✅ `category` field on `ChartinkScanner` — Task 1
- ✅ `IntradayEntry` + `SwingEntry` DB models — Task 1
- ✅ Auto-create both entries from webhook — Tasks 3, 6
- ✅ 5%/10% targets stored in DB — Task 2 (defaulted in `createIntradayEntry`/`createSwingEntry`)
- ✅ Price monitor: market hours poll + intraday expiry at 15:15 — Task 4
- ✅ Overnight swing poll — Task 4 (`pollOvernight`)
- ✅ Angel One session recovery — handled by `getLtpsBatch` which catches errors and returns empty map; monitor continues silently
- ✅ REST endpoints for both tracks + P/L summary — Task 5
- ✅ PATCH to tag scanner — Task 5, executed Task 7
- ✅ Frontend pages at `/intraday` + `/swing` — Tasks 9, 10
- ✅ P/L bar: daily/weekly/monthly/yearly — Tasks 9, 10
- ✅ Status filters — Tasks 9, 10
- ✅ Score factor expansion row — Tasks 9, 10
- ✅ Overnight badge on swing WATCHING rows — Task 10
- ✅ Sidebar + route wiring — Tasks 9, 10
- ✅ P/L as % not ₹ — `avgExitPct` throughout

**Placeholders:** None.

**Type consistency:** `AnandEntry` (frontend) matches controller response shape. `CreateEntryInput` defined in repository and re-used in service. `UpdateStatusInput` used consistently in repository and price monitor.
