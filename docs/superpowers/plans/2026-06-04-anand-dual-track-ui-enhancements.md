# Anand Dual-Track UI Enhancements Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Enrich the Intraday and Swing pages with richer table columns, ₹2L-notional P&L cards, scanner name, swing date/duration columns, a duplicate-symbol guard, and a TRADED default status.

**Architecture:** Backend-first (schema → repo → service → controller), then frontend types, then UI. Each task is independently testable. No changes to gated/ungated watch modules.

**Tech Stack:** NestJS + Prisma (backend), React + Tailwind + clsx (frontend), Jest (tests)

---

## File Map

| File | What changes |
|------|-------------|
| `prisma/schema.prisma` | Default status TRADED on IntradayEntry + SwingEntry |
| `apps/api/src/modules/anand-dual-track/repositories/anand-dual-track.repository.ts` | `listWatchingIntraday/Swing` → query TRADED; `expireAllWatchingIntraday` → expire TRADED; add `findActiveTradedBySymbol`; add `findScannerNamesByAlertIds`; add `totalPnlRs` to `PnlSummaryPeriod` + `compute()` |
| `apps/api/src/modules/anand-dual-track/repositories/__tests__/anand-dual-track.repository.spec.ts` | New tests for the 3 new methods; update mock to include `findFirst` + `chartinkAlert` |
| `apps/api/src/modules/anand-dual-track/services/anand-dual-track.service.ts` | Add duplicate-symbol guard in `createEntries()` |
| `apps/api/src/modules/anand-dual-track/services/__tests__/anand-dual-track.service.spec.ts` | Add `findActiveTradedBySymbol` mock; add 2 guard tests |
| `apps/api/src/modules/anand-dual-track/controllers/anand-dual-track.controller.ts` | Add `enrichWithScannerName()` private method; chain after `enrichWithLivePrice()` |
| `apps/web/src/services/anand.ts` | Add `scannerName: string \| null` to `AnandEntry`; add `totalPnlRs: number` to `PnlPeriod` |
| `apps/web/src/pages/intraday/IntradayPage.tsx` | New `PnlBar` (4 cards), new `EntryRow` (9 cols), active count → TRADED |
| `apps/web/src/pages/swing/SwingPage.tsx` | Same `PnlBar`, new `EntryRow` (12 cols + date/days), TRADED badge, active count |

---

## Task 1: Schema — default status TRADED

**Files:**
- Modify: `prisma/schema.prisma`

- [ ] **Step 1: Edit schema**

In `prisma/schema.prisma`, find the `IntradayEntry` model (around line 774) and change:
```prisma
status         String   @default("WATCHED")
```
to:
```prisma
status         String   @default("TRADED")
```

Find the `SwingEntry` model (around line 793) and apply the same change:
```prisma
status         String   @default("TRADED")
```

- [ ] **Step 2: Push schema**

```bash
npx prisma db push
```

Expected output: `Your database is now in sync with your Prisma schema.`

- [ ] **Step 3: Commit**

```bash
git add prisma/schema.prisma
git commit -m "fix(schema): default IntradayEntry + SwingEntry status to TRADED"
```

---

## Task 2: Repository — active queries, new lookup methods, totalPnlRs

**Files:**
- Modify: `apps/api/src/modules/anand-dual-track/repositories/anand-dual-track.repository.ts`
- Modify: `apps/api/src/modules/anand-dual-track/repositories/__tests__/anand-dual-track.repository.spec.ts`

- [ ] **Step 1: Write failing tests**

Open `apps/api/src/modules/anand-dual-track/repositories/__tests__/anand-dual-track.repository.spec.ts`.

**a) Expand the prisma mock** — add `findFirst` on both entry models and a `chartinkAlert` mock:

```ts
prisma = {
  intradayEntry: {
    create: jest.fn(),
    findMany: jest.fn().mockResolvedValue([]),
    findFirst: jest.fn().mockResolvedValue(null),
    update: jest.fn(),
    updateMany: jest.fn(),
  },
  swingEntry: {
    create: jest.fn(),
    findMany: jest.fn().mockResolvedValue([]),
    findFirst: jest.fn().mockResolvedValue(null),
    update: jest.fn(),
  },
  chartinkAlert: {
    findMany: jest.fn().mockResolvedValue([]),
  },
};
```

**b) Add new tests at the bottom of the describe block:**

```ts
describe('findActiveTradedBySymbol', () => {
  it('returns null when no TRADED entry exists for symbol', async () => {
    prisma.intradayEntry.findFirst.mockResolvedValue(null);
    const result = await repo.findActiveTradedBySymbol('intraday', 'RELIANCE');
    expect(result).toBeNull();
    expect(prisma.intradayEntry.findFirst).toHaveBeenCalledWith({
      where: { symbol: 'RELIANCE', status: 'TRADED' },
      select: { id: true },
    });
  });

  it('returns the entry when a TRADED entry exists for symbol (intraday)', async () => {
    prisma.intradayEntry.findFirst.mockResolvedValue({ id: 'i1' });
    const result = await repo.findActiveTradedBySymbol('intraday', 'TCS');
    expect(result).toEqual({ id: 'i1' });
  });

  it('queries swingEntry when track is swing', async () => {
    prisma.swingEntry.findFirst.mockResolvedValue({ id: 's1' });
    const result = await repo.findActiveTradedBySymbol('swing', 'INFY');
    expect(result).toEqual({ id: 's1' });
    expect(prisma.swingEntry.findFirst).toHaveBeenCalledWith({
      where: { symbol: 'INFY', status: 'TRADED' },
      select: { id: true },
    });
  });
});

describe('findScannerNamesByAlertIds', () => {
  it('returns empty map for empty input', async () => {
    const result = await repo.findScannerNamesByAlertIds([]);
    expect(result.size).toBe(0);
    expect(prisma.chartinkAlert.findMany).not.toHaveBeenCalled();
  });

  it('returns map of alertId → scanName', async () => {
    prisma.chartinkAlert.findMany.mockResolvedValue([
      { id: 'a1', scanner: { scanName: 'ANAND SWING' } },
      { id: 'a2', scanner: { scanName: 'BREAKOUT 5MIN' } },
    ]);
    const result = await repo.findScannerNamesByAlertIds(['a1', 'a2']);
    expect(result.get('a1')).toBe('ANAND SWING');
    expect(result.get('a2')).toBe('BREAKOUT 5MIN');
    expect(prisma.chartinkAlert.findMany).toHaveBeenCalledWith({
      where: { id: { in: ['a1', 'a2'] } },
      select: { id: true, scanner: { select: { scanName: true } } },
    });
  });
});

describe('getPnlSummary — totalPnlRs', () => {
  it('includes totalPnlRs = 0 when no exits', async () => {
    prisma.intradayEntry.findMany.mockResolvedValue([]);
    const summary = await repo.getPnlSummary('intraday');
    expect(summary.daily.totalPnlRs).toBe(0);
    expect(summary.yearly.totalPnlRs).toBe(0);
  });

  it('computes totalPnlRs as sum of (exitPct/100)*200000 across exits', async () => {
    // +5% trade and -5% trade in the daily window
    const now = new Date();
    prisma.intradayEntry.findMany.mockResolvedValue([
      { exitedAt: now, entryPrice: 100, exitPrice: 105 }, // +5%
      { exitedAt: now, entryPrice: 100, exitPrice: 95 },  // -5%
    ]);
    const summary = await repo.getPnlSummary('intraday');
    // +5% → +₹10000, -5% → -₹10000, net = 0
    expect(summary.daily.totalPnlRs).toBeCloseTo(0, 2);
    expect(summary.daily.count).toBe(2);
  });

  it('totalPnlRs is positive when all exits are profitable', async () => {
    const now = new Date();
    prisma.intradayEntry.findMany.mockResolvedValue([
      { exitedAt: now, entryPrice: 1000, exitPrice: 1050 }, // +5% → +₹10000
      { exitedAt: now, entryPrice: 2000, exitPrice: 2100 }, // +5% → +₹10000
    ]);
    const summary = await repo.getPnlSummary('intraday');
    expect(summary.daily.totalPnlRs).toBeCloseTo(20000, 0);
  });
});
```

- [ ] **Step 2: Run tests to confirm they fail**

```bash
cd apps/api && npx jest anand-dual-track.repository.spec --no-coverage
```

Expected: FAIL — `findActiveTradedBySymbol is not a function`, `findScannerNamesByAlertIds is not a function`, `totalPnlRs` undefined.

- [ ] **Step 3: Implement in repository**

Replace the full content of `apps/api/src/modules/anand-dual-track/repositories/anand-dual-track.repository.ts` with:

```ts
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
  totalPnlRs: number;
}

export interface PnlSummary {
  daily: PnlSummaryPeriod;
  weekly: PnlSummaryPeriod;
  monthly: PnlSummaryPeriod;
  yearly: PnlSummaryPeriod;
}

const NOTIONAL = 200_000; // ₹2L per trade

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

  /** Returns the first TRADED entry for this symbol on the given track, or null. */
  async findActiveTradedBySymbol(
    track: 'intraday' | 'swing',
    symbol: string,
  ): Promise<{ id: string } | null> {
    const model = track === 'intraday' ? this.prisma.intradayEntry : this.prisma.swingEntry;
    return (model as any).findFirst({
      where: { symbol, status: 'TRADED' },
      select: { id: true },
    });
  }

  /** Batch-resolves alertId → scanner scanName via ChartinkAlert → ChartinkScanner join. */
  async findScannerNamesByAlertIds(alertIds: string[]): Promise<Map<string, string>> {
    if (alertIds.length === 0) return new Map();
    const rows = await this.prisma.chartinkAlert.findMany({
      where: { id: { in: alertIds } },
      select: { id: true, scanner: { select: { scanName: true } } },
    });
    const map = new Map<string, string>();
    for (const row of rows) {
      map.set(row.id, row.scanner.scanName);
    }
    return map;
  }

  /** Fetches active entries for price-monitor polling (TRADED status = active position). */
  async listWatchingIntraday() {
    return this.prisma.intradayEntry.findMany({
      where: { status: 'TRADED' },
      orderBy: { enteredAt: 'desc' },
    });
  }

  async listWatchingSwing() {
    return this.prisma.swingEntry.findMany({
      where: { status: 'TRADED' },
      orderBy: { enteredAt: 'desc' },
    });
  }

  async listIntradayEntries(filter: ListEntriesFilter = {}) {
    return this.prisma.intradayEntry.findMany({
      where: {
        ...(filter.status ? { status: filter.status } : {}),
        ...(filter.from || filter.to
          ? {
              enteredAt: {
                ...(filter.from ? { gte: filter.from } : {}),
                ...(filter.to ? { lte: filter.to } : {}),
              },
            }
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
          ? {
              enteredAt: {
                ...(filter.from ? { gte: filter.from } : {}),
                ...(filter.to ? { lte: filter.to } : {}),
              },
            }
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
      where: { status: 'TRADED' },
      data: { status: 'EXPIRED', exitedAt: new Date() },
    });
    return result.count;
  }

  async getPnlSummary(track: 'intraday' | 'swing'): Promise<PnlSummary> {
    const istMidnightDaysAgo = (days: number): Date => {
      const now = new Date();
      const istNow = new Date(now.getTime() + 5.5 * 60 * 60 * 1000);
      istNow.setUTCHours(0, 0, 0, 0);
      istNow.setUTCDate(istNow.getUTCDate() - days);
      return new Date(istNow.getTime() - 5.5 * 60 * 60 * 1000);
    };

    const yearStart = istMidnightDaysAgo(365);
    const exitStatuses =
      track === 'intraday'
        ? ['TARGET_HIT', 'STOPPED', 'EXPIRED']
        : ['TARGET_HIT', 'STOPPED'];

    const exits = await (track === 'intraday'
      ? this.prisma.intradayEntry.findMany({
          where: { status: { in: exitStatuses }, exitedAt: { gte: yearStart }, exitPrice: { not: null } },
          select: { exitedAt: true, entryPrice: true, exitPrice: true },
        })
      : this.prisma.swingEntry.findMany({
          where: { status: { in: exitStatuses }, exitedAt: { gte: yearStart }, exitPrice: { not: null } },
          select: { exitedAt: true, entryPrice: true, exitPrice: true },
        }));

    const compute = (rows: typeof exits): PnlSummaryPeriod => {
      if (rows.length === 0) return { avgExitPct: 0, count: 0, winCount: 0, totalPnlRs: 0 };
      let sum = 0;
      let wins = 0;
      let totalPnlRs = 0;
      for (const r of rows) {
        const pct = ((r.exitPrice! - r.entryPrice) / r.entryPrice) * 100;
        sum += pct;
        if (pct > 0) wins++;
        totalPnlRs += (pct / 100) * NOTIONAL;
      }
      return { avgExitPct: sum / rows.length, count: rows.length, winCount: wins, totalPnlRs };
    };

    return {
      daily: compute(exits.filter(r => r.exitedAt! >= istMidnightDaysAgo(1))),
      weekly: compute(exits.filter(r => r.exitedAt! >= istMidnightDaysAgo(7))),
      monthly: compute(exits.filter(r => r.exitedAt! >= istMidnightDaysAgo(30))),
      yearly: compute(exits),
    };
  }
}
```

- [ ] **Step 4: Run tests to confirm they pass**

```bash
cd apps/api && npx jest anand-dual-track.repository.spec --no-coverage
```

Expected: All tests pass.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/modules/anand-dual-track/repositories/
git commit -m "feat(anand): repo — findActiveTradedBySymbol, findScannerNamesByAlertIds, totalPnlRs, TRADED active queries"
```

---

## Task 3: Service — duplicate symbol guard

**Files:**
- Modify: `apps/api/src/modules/anand-dual-track/services/anand-dual-track.service.ts`
- Modify: `apps/api/src/modules/anand-dual-track/services/__tests__/anand-dual-track.service.spec.ts`

- [ ] **Step 1: Write failing tests**

Open `apps/api/src/modules/anand-dual-track/services/__tests__/anand-dual-track.service.spec.ts`.

Add `findActiveTradedBySymbol` to the repo mock and add 3 new tests:

```ts
// In beforeEach, update the repo mock:
repo = {
  createIntradayEntry: jest.fn().mockResolvedValue({ id: 'i1' }),
  createSwingEntry: jest.fn().mockResolvedValue({ id: 's1' }),
  findActiveTradedBySymbol: jest.fn().mockResolvedValue(null), // default: no active trade
};

// New tests:
it('skips intraday insert when TRADED intraday entry already exists', async () => {
  repo.findActiveTradedBySymbol.mockImplementation(
    (track: string) => track === 'intraday' ? Promise.resolve({ id: 'existing' }) : Promise.resolve(null),
  );
  await service.createEntries({
    alertId: 'a1', symbol: 'RELIANCE', token: '2885', hitPrice: 2500, scoreBreakdown: null,
  });
  expect(repo.createIntradayEntry).not.toHaveBeenCalled();
  expect(repo.createSwingEntry).toHaveBeenCalledTimes(1); // swing not blocked
});

it('skips swing insert when TRADED swing entry already exists', async () => {
  repo.findActiveTradedBySymbol.mockImplementation(
    (track: string) => track === 'swing' ? Promise.resolve({ id: 'existing' }) : Promise.resolve(null),
  );
  await service.createEntries({
    alertId: 'a1', symbol: 'TCS', token: '11536', hitPrice: 3500, scoreBreakdown: null,
  });
  expect(repo.createIntradayEntry).toHaveBeenCalledTimes(1); // intraday not blocked
  expect(repo.createSwingEntry).not.toHaveBeenCalled();
});

it('skips both when both tracks have TRADED entries', async () => {
  repo.findActiveTradedBySymbol.mockResolvedValue({ id: 'existing' });
  await service.createEntries({
    alertId: 'a1', symbol: 'INFY', token: '1594', hitPrice: 1800, scoreBreakdown: null,
  });
  expect(repo.createIntradayEntry).not.toHaveBeenCalled();
  expect(repo.createSwingEntry).not.toHaveBeenCalled();
});
```

- [ ] **Step 2: Run tests to confirm they fail**

```bash
cd apps/api && npx jest anand-dual-track.service.spec --no-coverage
```

Expected: 3 new tests FAIL (`createIntradayEntry` called when it should not be).

- [ ] **Step 3: Implement the guard**

Replace `apps/api/src/modules/anand-dual-track/services/anand-dual-track.service.ts` with:

```ts
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

    // Check both tracks independently so an intraday block never prevents a swing entry.
    const [activeIntraday, activeSwing] = await Promise.all([
      this.repo.findActiveTradedBySymbol('intraday', input.symbol),
      this.repo.findActiveTradedBySymbol('swing', input.symbol),
    ]);

    const tasks: Promise<unknown>[] = [];

    if (activeIntraday) {
      this.logger.log(
        `[anand] intraday: ${input.symbol} already has active TRADED entry (${activeIntraday.id}) — skipping`,
      );
    } else {
      tasks.push(
        this.repo.createIntradayEntry(shared).catch((err: unknown) => {
          this.logger.warn(
            `[anand-dual-track] intraday insert failed for ${input.symbol}: ${err instanceof Error ? err.message : err}`,
          );
        }),
      );
    }

    if (activeSwing) {
      this.logger.log(
        `[anand] swing: ${input.symbol} already has active TRADED entry (${activeSwing.id}) — skipping`,
      );
    } else {
      tasks.push(
        this.repo.createSwingEntry(shared).catch((err: unknown) => {
          this.logger.warn(
            `[anand-dual-track] swing insert failed for ${input.symbol}: ${err instanceof Error ? err.message : err}`,
          );
        }),
      );
    }

    await Promise.all(tasks);
  }
}
```

- [ ] **Step 4: Run all service tests**

```bash
cd apps/api && npx jest anand-dual-track.service.spec --no-coverage
```

Expected: All 5 tests pass (2 original + 3 new).

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/modules/anand-dual-track/services/
git commit -m "feat(anand): duplicate symbol guard — skip intraday/swing insert if TRADED entry already exists"
```

---

## Task 4: Controller — scanner name enrichment

**Files:**
- Modify: `apps/api/src/modules/anand-dual-track/controllers/anand-dual-track.controller.ts`

*(No controller spec exists — enrichment is covered by the repo tests above.)*

- [ ] **Step 1: Update the controller**

Replace `apps/api/src/modules/anand-dual-track/controllers/anand-dual-track.controller.ts` with:

```ts
import { Body, Controller, Get, NotFoundException, Param, Patch, Query } from '@nestjs/common';
import { IsNotEmpty, IsString } from 'class-validator';
import { AnandDualTrackRepository } from '../repositories/anand-dual-track.repository';
import { ChartinkRepository } from '../../chartink/repositories/chartink.repository';
import { AngelOneAdapterService } from '../../market-data/services/angel-one-adapter.service';

class UpdateCategoryDto {
  @IsString() @IsNotEmpty() category!: string;
}

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
    const enriched = await this.enrichWithLivePrice(entries);
    return this.enrichWithScannerName(enriched);
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
    const enriched = await this.enrichWithLivePrice(entries);
    return this.enrichWithScannerName(enriched);
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
    @Body() body: UpdateCategoryDto,
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

  private async enrichWithScannerName(
    entries: Array<{ alertId?: string | null; [key: string]: unknown }>,
  ) {
    const alertIds = [
      ...new Set(entries.map((e) => e.alertId).filter((id): id is string => !!id)),
    ];
    const nameMap = alertIds.length
      ? await this.repo.findScannerNamesByAlertIds(alertIds)
      : new Map<string, string>();

    return entries.map((e) => ({
      ...e,
      scannerName: (e.alertId ? nameMap.get(e.alertId as string) : undefined) ?? null,
    }));
  }
}
```

- [ ] **Step 2: Verify TypeScript compiles**

```bash
cd apps/api && npx tsc --noEmit 2>&1 | grep -v "@td/shared"
```

Expected: No errors (beyond known @td/shared alias noise).

- [ ] **Step 3: Commit**

```bash
git add apps/api/src/modules/anand-dual-track/controllers/anand-dual-track.controller.ts
git commit -m "feat(anand): enrich list endpoints with scannerName from ChartinkAlert join"
```

---

## Task 5: Frontend types

**Files:**
- Modify: `apps/web/src/services/anand.ts`

- [ ] **Step 1: Update types**

Replace the contents of `apps/web/src/services/anand.ts` with:

```ts
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
  scannerName: string | null;
  scoreBreakdown: Array<{ name: string; points: number; pointsPossible: number; passed: boolean }> | null;
}

export interface PnlPeriod {
  avgExitPct: number;
  count: number;
  winCount: number;
  totalPnlRs: number;
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

- [ ] **Step 2: Commit**

```bash
git add apps/web/src/services/anand.ts
git commit -m "feat(web): add scannerName + totalPnlRs to AnandEntry and PnlPeriod types"
```

---

## Task 6: IntradayPage — richer table + P&L cards

**Files:**
- Modify: `apps/web/src/pages/intraday/IntradayPage.tsx`

- [ ] **Step 1: Replace IntradayPage.tsx**

Replace the full contents of `apps/web/src/pages/intraday/IntradayPage.tsx`:

```tsx
import React, { useState } from 'react';
import clsx from 'clsx';
import { useIntradayEntries } from '../../hooks/useIntradayEntries';
import ChartinkScoreTable from '../../components/chartink/ChartinkScoreTable';
import type { AnandEntry, PnlSummary } from '../../services/anand';

const FILTERS = [
  { label: 'All', value: undefined },
  { label: 'Traded', value: 'TRADED' },
  { label: 'Target Hit', value: 'TARGET_HIT' },
  { label: 'Stopped', value: 'STOPPED' },
  { label: 'Expired', value: 'EXPIRED' },
] as const;

const NOTIONAL = 200_000;

function todayIST(): string {
  return new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
}

function fmtPct(n: number): string {
  return `${n >= 0 ? '+' : ''}${n.toFixed(2)}%`;
}

function fmtRs(n: number): string {
  const abs = Math.abs(n);
  const formatted = new Intl.NumberFormat('en-IN', { maximumFractionDigits: 0 }).format(abs);
  return `${n >= 0 ? '+' : '−'}₹${formatted}`;
}

function PnlBar({ pnl }: { pnl: PnlSummary }) {
  const periods = [
    { label: 'Daily', data: pnl.daily },
    { label: 'Weekly', data: pnl.weekly },
    { label: 'Monthly', data: pnl.monthly },
    { label: 'Yearly', data: pnl.yearly },
  ] as const;

  return (
    <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
      {periods.map(({ label, data }) => (
        <div
          key={label}
          className="rounded-lg border border-[var(--color-border-subtle)] bg-[var(--color-bg-secondary)] px-4 py-3"
        >
          <div className="mb-1 text-xs uppercase tracking-wider text-[var(--color-text-muted)]">
            {label} P&L
          </div>
          <div
            className={clsx(
              'text-lg font-semibold tabular-nums',
              data.totalPnlRs > 0
                ? 'text-emerald-400'
                : data.totalPnlRs < 0
                  ? 'text-red-400'
                  : 'text-[var(--color-text-muted)]',
            )}
          >
            {data.count ? fmtRs(data.totalPnlRs) : '—'}
          </div>
          <div className="mt-1 text-xs text-[var(--color-text-muted)]">
            {data.count ? `${data.count}t · ${data.winCount}W` : 'No trades'}
          </div>
        </div>
      ))}
    </div>
  );
}

function EntryRow({ entry }: { entry: AnandEntry }) {
  const [expanded, setExpanded] = useState(false);
  const pnlColor = entry.pnlPct >= 0 ? 'text-emerald-400' : 'text-red-400';
  const displayPrice =
    entry.status === 'TRADED' ? entry.currentPrice : (entry.exitPrice ?? entry.currentPrice);
  const pnlRs = (entry.pnlPct / 100) * NOTIONAL;

  const statusColor: Record<string, string> = {
    TRADED: 'text-blue-400',
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
        <td className="max-w-[160px] truncate px-3 py-2 text-xs text-[var(--color-text-muted)]">
          {entry.scannerName ?? '—'}
        </td>
        <td className="px-3 py-2 tabular-nums">₹{entry.entryPrice.toFixed(2)}</td>
        <td className="px-3 py-2 tabular-nums">
          <span>₹{displayPrice.toFixed(2)}</span>
          <span className={clsx('ml-1 text-xs', pnlColor)}>{fmtPct(entry.pnlPct)}</span>
        </td>
        <td className={clsx('px-3 py-2 font-semibold tabular-nums', pnlColor)}>
          {fmtRs(pnlRs)}
        </td>
        <td className={clsx('px-3 py-2 tabular-nums', pnlColor)}>{fmtPct(entry.pnlPct)}</td>
        <td className="px-3 py-2 tabular-nums text-[var(--color-text-muted)]">
          {entry.targetPct}%
        </td>
        <td
          className={clsx(
            'px-3 py-2 text-xs font-semibold uppercase tracking-wider',
            statusColor[entry.status] ?? 'text-gray-400',
          )}
        >
          {entry.status.replace('_', ' ')}
        </td>
        <td className="px-3 py-2 text-xs tabular-nums text-[var(--color-text-muted)]">
          {new Date(entry.enteredAt).toLocaleTimeString('en-IN', {
            timeZone: 'Asia/Kolkata',
            hour: '2-digit',
            minute: '2-digit',
          })}
        </td>
      </tr>
      {expanded && entry.scoreBreakdown && (
        <tr className="border-t border-[var(--color-border-subtle)] bg-[var(--color-bg-secondary)]/40">
          <td colSpan={9} className="px-3 py-2">
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
  const activeCount = entries.filter((e) => e.status === 'TRADED').length;

  return (
    <div className="flex flex-col gap-4 p-6 text-[var(--color-text-primary)]">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold">Intraday Track</h1>
          <p className="text-sm text-[var(--color-text-muted)]">5% target · 5% stop · expires at 15:15</p>
        </div>
        <div className="text-sm text-[var(--color-text-muted)]">{activeCount} active</div>
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
                <th className="px-3 py-2">Scanner</th>
                <th className="px-3 py-2">Entry ₹</th>
                <th className="px-3 py-2">Price / Δ%</th>
                <th className="px-3 py-2">P&L ₹</th>
                <th className="px-3 py-2">P&L %</th>
                <th className="px-3 py-2">Target</th>
                <th className="px-3 py-2">Status</th>
                <th className="px-3 py-2">Entry Time</th>
              </tr>
            </thead>
            <tbody>
              {entries.length === 0 && (
                <tr>
                  <td colSpan={9} className="px-3 py-8 text-center text-[var(--color-text-muted)]">
                    No entries yet. Tag an Anand Swing scanner as ANAND_SWING to start auto-logging.
                  </td>
                </tr>
              )}
              {entries.map((e) => (
                <EntryRow key={e.id} entry={e} />
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
```

- [ ] **Step 2: Commit**

```bash
git add apps/web/src/pages/intraday/IntradayPage.tsx
git commit -m "feat(web): IntradayPage — 9-col table, scanner col, P&L ₹2L cards, TRADED status"
```

---

## Task 7: SwingPage — richer table + P&L cards + date/days columns

**Files:**
- Modify: `apps/web/src/pages/swing/SwingPage.tsx`

- [ ] **Step 1: Replace SwingPage.tsx**

Replace the full contents of `apps/web/src/pages/swing/SwingPage.tsx`:

```tsx
import React, { useState } from 'react';
import clsx from 'clsx';
import { useSwingEntries } from '../../hooks/useSwingEntries';
import ChartinkScoreTable from '../../components/chartink/ChartinkScoreTable';
import type { AnandEntry, PnlSummary } from '../../services/anand';

const FILTERS = [
  { label: 'All', value: undefined },
  { label: 'Traded', value: 'TRADED' },
  { label: 'Target Hit', value: 'TARGET_HIT' },
  { label: 'Stopped', value: 'STOPPED' },
] as const;

const NOTIONAL = 200_000;

function todayIST(): string {
  return new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
}

function fmtPct(n: number): string {
  return `${n >= 0 ? '+' : ''}${n.toFixed(2)}%`;
}

function fmtRs(n: number): string {
  const abs = Math.abs(n);
  const formatted = new Intl.NumberFormat('en-IN', { maximumFractionDigits: 0 }).format(abs);
  return `${n >= 0 ? '+' : '−'}₹${formatted}`;
}

function fmtDate(iso: string): string {
  return new Date(iso).toLocaleDateString('en-IN', {
    timeZone: 'Asia/Kolkata',
    day: '2-digit',
    month: 'short',
  });
}

function calcDays(enteredAt: string, exitedAt: string | null): number {
  const start = new Date(enteredAt).getTime();
  const end = exitedAt ? new Date(exitedAt).getTime() : Date.now();
  return Math.max(1, Math.ceil((end - start) / (1000 * 60 * 60 * 24)));
}

function PnlBar({ pnl }: { pnl: PnlSummary }) {
  const periods = [
    { label: 'Daily', data: pnl.daily },
    { label: 'Weekly', data: pnl.weekly },
    { label: 'Monthly', data: pnl.monthly },
    { label: 'Yearly', data: pnl.yearly },
  ] as const;

  return (
    <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
      {periods.map(({ label, data }) => (
        <div
          key={label}
          className="rounded-lg border border-[var(--color-border-subtle)] bg-[var(--color-bg-secondary)] px-4 py-3"
        >
          <div className="mb-1 text-xs uppercase tracking-wider text-[var(--color-text-muted)]">
            {label} P&L
          </div>
          <div
            className={clsx(
              'text-lg font-semibold tabular-nums',
              data.totalPnlRs > 0
                ? 'text-emerald-400'
                : data.totalPnlRs < 0
                  ? 'text-red-400'
                  : 'text-[var(--color-text-muted)]',
            )}
          >
            {data.count ? fmtRs(data.totalPnlRs) : '—'}
          </div>
          <div className="mt-1 text-xs text-[var(--color-text-muted)]">
            {data.count ? `${data.count}t · ${data.winCount}W` : 'No trades'}
          </div>
        </div>
      ))}
    </div>
  );
}

function EntryRow({ entry }: { entry: AnandEntry }) {
  const [expanded, setExpanded] = useState(false);
  const pnlColor = entry.pnlPct >= 0 ? 'text-emerald-400' : 'text-red-400';
  const displayPrice =
    entry.status === 'TRADED' ? entry.currentPrice : (entry.exitPrice ?? entry.currentPrice);
  const pnlRs = (entry.pnlPct / 100) * NOTIONAL;
  const days = calcDays(entry.enteredAt, entry.exitedAt);

  const statusColor: Record<string, string> = {
    TRADED: 'text-blue-400',
    TARGET_HIT: 'text-emerald-400',
    STOPPED: 'text-red-400',
  };

  return (
    <React.Fragment>
      <tr
        onClick={() => setExpanded((v) => !v)}
        className="cursor-pointer border-t border-[var(--color-border-subtle)] hover:bg-[var(--color-bg-tertiary)]"
      >
        <td className="px-3 py-2 font-mono font-medium">
          {entry.symbol}
          {entry.status === 'TRADED' && (
            <span className="ml-2 rounded bg-amber-500/20 px-1 py-0.5 text-[9px] font-semibold uppercase text-amber-300">
              Overnight
            </span>
          )}
        </td>
        <td className="max-w-[160px] truncate px-3 py-2 text-xs text-[var(--color-text-muted)]">
          {entry.scannerName ?? '—'}
        </td>
        <td className="px-3 py-2 tabular-nums">₹{entry.entryPrice.toFixed(2)}</td>
        <td className="px-3 py-2 tabular-nums">
          <span>₹{displayPrice.toFixed(2)}</span>
          <span className={clsx('ml-1 text-xs', pnlColor)}>{fmtPct(entry.pnlPct)}</span>
        </td>
        <td className={clsx('px-3 py-2 font-semibold tabular-nums', pnlColor)}>
          {fmtRs(pnlRs)}
        </td>
        <td className={clsx('px-3 py-2 tabular-nums', pnlColor)}>{fmtPct(entry.pnlPct)}</td>
        <td className="px-3 py-2 tabular-nums text-[var(--color-text-muted)]">
          {entry.targetPct}%
        </td>
        <td
          className={clsx(
            'px-3 py-2 text-xs font-semibold uppercase tracking-wider',
            statusColor[entry.status] ?? 'text-gray-400',
          )}
        >
          {entry.status.replace('_', ' ')}
        </td>
        <td className="px-3 py-2 text-xs tabular-nums text-[var(--color-text-muted)]">
          {fmtDate(entry.enteredAt)}
        </td>
        <td className="px-3 py-2 text-xs tabular-nums text-[var(--color-text-muted)]">
          {entry.exitedAt ? (
            fmtDate(entry.exitedAt)
          ) : (
            <span className="italic text-[var(--color-text-muted)]">Ongoing</span>
          )}
        </td>
        <td className="px-3 py-2 text-xs tabular-nums text-[var(--color-text-muted)]">
          {days}d
        </td>
      </tr>
      {expanded && entry.scoreBreakdown && (
        <tr className="border-t border-[var(--color-border-subtle)] bg-[var(--color-bg-secondary)]/40">
          <td colSpan={11} className="px-3 py-2">
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
  const activeCount = entries.filter((e) => e.status === 'TRADED').length;

  return (
    <div className="flex flex-col gap-4 p-6 text-[var(--color-text-primary)]">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold">Swing Track</h1>
          <p className="text-sm text-[var(--color-text-muted)]">10% target · 10% stop · holds overnight</p>
        </div>
        <div className="text-sm text-[var(--color-text-muted)]">{activeCount} active</div>
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
                <th className="px-3 py-2">Scanner</th>
                <th className="px-3 py-2">Entry ₹</th>
                <th className="px-3 py-2">Price / Δ%</th>
                <th className="px-3 py-2">P&L ₹</th>
                <th className="px-3 py-2">P&L %</th>
                <th className="px-3 py-2">Target</th>
                <th className="px-3 py-2">Status</th>
                <th className="px-3 py-2">Start</th>
                <th className="px-3 py-2">End</th>
                <th className="px-3 py-2">Days</th>
              </tr>
            </thead>
            <tbody>
              {entries.length === 0 && (
                <tr>
                  <td colSpan={11} className="px-3 py-8 text-center text-[var(--color-text-muted)]">
                    No swing entries yet. Waiting for Anand Swing scanner alerts.
                  </td>
                </tr>
              )}
              {entries.map((e) => (
                <EntryRow key={e.id} entry={e} />
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
```

- [ ] **Step 2: Commit**

```bash
git add apps/web/src/pages/swing/SwingPage.tsx
git commit -m "feat(web): SwingPage — 11-col table, scanner col, P&L ₹2L cards, start/end/days, TRADED status"
```

---

## Final Verification

- [ ] **Run all anand-dual-track tests**

```bash
cd apps/api && npx jest anand-dual-track --no-coverage
```

Expected: All tests pass (no failures).

- [ ] **Check TypeScript**

```bash
cd apps/api && npx tsc --noEmit 2>&1 | grep -v "@td/shared"
```

Expected: No errors.

- [ ] **Smoke-test the UI**

Start the dev server if not running:
```bash
npm run dev:api   # port 4001
npm run dev:web   # port 4000
```

Navigate to `http://localhost:4000/intraday` and `http://localhost:4000/swing`.

Verify:
1. Four P&L cards visible at top (Daily / Weekly / Monthly / Yearly)
2. Table has Scanner column showing scanner name or "—"
3. Table has P&L ₹ column
4. Swing page has Start / End / Days columns
5. No "Watching" filter button — replaced by "Traded"
6. Active count in header shows "N active" (not "N watching")
