# Anand Dual-Track Enhancements — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add four enhancements to the Anand dual-track feature — a swing lead counter, a same-day no-re-entry-after-target guard, an intraday Supertrend trailing stop after +5%, and a swing-profit reinvestment system with its own page.

**Architecture:** Backend changes concentrate in the existing `anand-dual-track` module (repository, service, price-monitor, controller) plus new Prisma models. The intraday trail reuses `getHistoricalData` + `supertrend` from existing modules. Feature 4 adds `ReinvestmentLot`/`ReinvestmentPool` models, a reinvestment service, monitor polling, controller routes, and a new `/reinvest` React page. Frontend reuses the existing page/table/card idioms.

**Tech Stack:** NestJS + Prisma (PostgreSQL, evolved via `prisma db push`), React + Vite + TypeScript, Tailwind CSS vars, Jest.

**Spec:** `docs/superpowers/specs/2026-06-04-anand-dualtrack-enhancements-design.md`

**Key constants:** `NOTIONAL = ₹200,000`; swing profit per +10% = `₹20,000`. IST = UTC+5:30.

---

## File Structure

**Backend (modify):**
- `prisma/schema.prisma` — add fields to `IntradayEntry`; add `SymbolLeadStat`, `ReinvestmentLot`, `ReinvestmentPool`.
- `apps/api/src/modules/anand-dual-track/repositories/anand-dual-track.repository.ts` — lead-stat methods, same-day-target query, intraday trailing update, reinvestment CRUD + pool.
- `apps/api/src/modules/anand-dual-track/services/anand-dual-track.service.ts` — bump lead stat + same-day guard in `createEntries`.
- `apps/api/src/modules/anand-dual-track/services/anand-price-monitor.service.ts` — intraday trailing, reinvestment-lot polling, swing-target → create reinvestment lot.
- `apps/api/src/modules/anand-dual-track/controllers/anand-dual-track.controller.ts` — enrich swing entries with lead data; reinvestment routes.
- `apps/api/src/modules/anand-dual-track/anand-dual-track.module.ts` — register new providers.

**Backend (create):**
- `apps/api/src/modules/anand-dual-track/services/reinvestment.service.ts` — reinvestment lifecycle + pool math.

**Frontend (modify):**
- `apps/web/src/services/anand.ts` — extend `AnandEntry`, add reinvest client.
- `apps/web/src/pages/swing/SwingPage.tsx` — Leads column.
- `apps/web/src/pages/intraday/IntradayPage.tsx` — trailing chip / exit-reason.
- `apps/web/src/App.tsx` — `/reinvest` route.
- `apps/web/src/components/layout/Sidebar.tsx` — Reinvestment nav item.

**Frontend (create):**
- `apps/web/src/hooks/useReinvestLots.ts`
- `apps/web/src/pages/reinvest/ReinvestPage.tsx`

---

## Task 1: Schema — add fields & new models

**Files:**
- Modify: `prisma/schema.prisma` (`IntradayEntry` ~786-803; append new models after `SwingEntry` ~822)

- [ ] **Step 1: Add trailing fields to `IntradayEntry`**

In `model IntradayEntry`, after the `scoreBreakdown Json?` line (before the `@@index` lines), add:

```prisma
  trailing       Boolean   @default(false)
  peakPrice      Float?
  exitReason     String?
```

- [ ] **Step 2: Append the three new models after `model SwingEntry { ... }`**

```prisma
model SymbolLeadStat {
  id        String   @id @default(cuid())
  symbol    String
  track     String   @default("swing")
  count     Int      @default(0)
  dates     Json     @default("[]")
  lastLedAt DateTime @default(now())

  @@unique([symbol, track])
  @@map("symbol_lead_stats")
}

model ReinvestmentLot {
  id                 String    @id @default(cuid())
  symbol             String
  sourceSwingEntryId String    @unique
  capital            Float
  entryPrice         Float
  enteredAt          DateTime  @default(now())
  targetPct          Float     @default(10.0)
  stopPct            Float     @default(10.0)
  status             String    @default("OPEN")
  exitPrice          Float?
  exitedAt           DateTime?
  exitReason         String?

  @@index([status, enteredAt])
  @@index([symbol])
  @@map("reinvestment_lots")
}

model ReinvestmentPool {
  id             String @id @default("singleton")
  harvestedTotal Float  @default(0)
  deployedActive Float  @default(0)
  idleBalance    Float  @default(0)
  realizedPnl    Float  @default(0)

  @@map("reinvestment_pool")
}
```

- [ ] **Step 3: Push schema and regenerate client**

Run: `cd C:/Users/AryanKumar/Desktop/TD_Automation && npx prisma db push && npx prisma generate`
Expected: "Your database is now in sync with your Prisma schema." and "Generated Prisma Client". **Do NOT run `prisma migrate dev`** (it resets the DB).

- [ ] **Step 4: Commit**

```bash
git add prisma/schema.prisma
git commit -m "feat(anand): schema for lead counter, intraday trailing, reinvestment"
```

---

## Task 2: Feature 1 — lead-stat repository methods

**Files:**
- Modify: `apps/api/src/modules/anand-dual-track/repositories/anand-dual-track.repository.ts`
- Test: `apps/api/src/modules/anand-dual-track/repositories/__tests__/lead-stat.repository.spec.ts`

- [ ] **Step 1: Write the failing test**

Create the test file:

```typescript
import { AnandDualTrackRepository } from '../anand-dual-track.repository';

function makePrismaMock() {
  const store = new Map<string, { count: number; dates: string[]; lastLedAt: Date }>();
  return {
    store,
    symbolLeadStat: {
      upsert: jest.fn(async ({ where, create, update }: any) => {
        const key = `${where.symbol_track.symbol}:${where.symbol_track.track}`;
        const existing = store.get(key);
        if (!existing) {
          store.set(key, { count: create.count, dates: create.dates, lastLedAt: create.lastLedAt });
        } else {
          existing.count = update.count.increment ? existing.count + update.count.increment : update.count;
          existing.dates = update.dates;
          existing.lastLedAt = update.lastLedAt;
        }
        return store.get(key);
      }),
      findFirst: jest.fn(async ({ where }: any) => {
        const key = `${where.symbol}:${where.track}`;
        return store.get(key) ?? null;
      }),
      findMany: jest.fn(async ({ where }: any) => {
        const out: any[] = [];
        for (const [key, v] of store) {
          const [symbol, track] = key.split(':');
          if (track === where.track && where.symbol.in.includes(symbol)) out.push({ symbol, ...v });
        }
        return out;
      }),
    },
  };
}

describe('AnandDualTrackRepository lead stats', () => {
  it('bumpLeadStat creates then increments count and appends a date', async () => {
    const prisma = makePrismaMock();
    const repo = new AnandDualTrackRepository(prisma as any);

    await repo.bumpLeadStat('swing', 'TCS');
    await repo.bumpLeadStat('swing', 'TCS');

    const stat = prisma.store.get('TCS:swing')!;
    expect(stat.count).toBe(2);
    expect(stat.dates).toHaveLength(2);
  });

  it('getLeadStats returns a symbol→{count,dates} map', async () => {
    const prisma = makePrismaMock();
    const repo = new AnandDualTrackRepository(prisma as any);
    await repo.bumpLeadStat('swing', 'TCS');

    const map = await repo.getLeadStats('swing', ['TCS', 'INFY']);
    expect(map.get('TCS')?.count).toBe(1);
    expect(map.get('INFY')).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/api && npx jest lead-stat.repository.spec -i`
Expected: FAIL — `repo.bumpLeadStat is not a function`.

- [ ] **Step 3: Add the methods to the repository**

Add these methods inside `AnandDualTrackRepository` (after `findActiveTradedBySymbol`):

```typescript
  /**
   * Record one "lead" occurrence for a symbol+track. Increments count and
   * appends the current ISO timestamp to the lossless `dates` log. Called on
   * EVERY scanner fire — even when no new entry is created — so the count is
   * true lead frequency.
   */
  async bumpLeadStat(track: 'swing' | 'intraday', symbol: string): Promise<void> {
    const nowIso = new Date().toISOString();
    const existing = await this.prisma.symbolLeadStat.findFirst({
      where: { symbol, track },
      select: { dates: true },
    });
    const dates = Array.isArray(existing?.dates) ? (existing!.dates as string[]) : [];
    await this.prisma.symbolLeadStat.upsert({
      where: { symbol_track: { symbol, track } },
      create: { symbol, track, count: 1, dates: [nowIso], lastLedAt: new Date() },
      update: { count: { increment: 1 }, dates: [...dates, nowIso], lastLedAt: new Date() },
    });
  }

  /** Map symbol → { count, dates } for the given symbols on a track. */
  async getLeadStats(
    track: 'swing' | 'intraday',
    symbols: string[],
  ): Promise<Map<string, { count: number; dates: string[] }>> {
    const out = new Map<string, { count: number; dates: string[] }>();
    if (symbols.length === 0) return out;
    const rows = await this.prisma.symbolLeadStat.findMany({
      where: { track, symbol: { in: [...new Set(symbols)] } },
      select: { symbol: true, count: true, dates: true },
    });
    for (const r of rows) {
      out.set(r.symbol, { count: r.count, dates: Array.isArray(r.dates) ? (r.dates as string[]) : [] });
    }
    return out;
  }
```

> Note: the test's `upsert` mock reads `update.dates` as the final array (we pass the concatenated array, not a Prisma op), matching the implementation.

- [ ] **Step 4: Run test to verify it passes**

Run: `cd apps/api && npx jest lead-stat.repository.spec -i`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/modules/anand-dual-track/repositories/anand-dual-track.repository.ts apps/api/src/modules/anand-dual-track/repositories/__tests__/lead-stat.repository.spec.ts
git commit -m "feat(anand): lead-stat repository methods (Feature 1)"
```

---

## Task 3: Feature 2 — same-day target-hit guard (repository)

**Files:**
- Modify: `apps/api/src/modules/anand-dual-track/repositories/anand-dual-track.repository.ts`
- Test: `apps/api/src/modules/anand-dual-track/repositories/__tests__/same-day-guard.repository.spec.ts`

- [ ] **Step 1: Write the failing test**

```typescript
import { AnandDualTrackRepository } from '../anand-dual-track.repository';

describe('hasTargetHitTodayBySymbol', () => {
  function repoWith(rows: any[]) {
    const prisma = {
      swingEntry: { findFirst: jest.fn(async ({ where }: any) => {
        return rows.find(
          (r) =>
            r.symbol === where.symbol &&
            r.status === where.status &&
            r.exitedAt >= where.exitedAt.gte,
        ) ?? null;
      }) },
      intradayEntry: { findFirst: jest.fn(async () => null) },
    };
    return { repo: new AnandDualTrackRepository(prisma as any), prisma };
  }

  it('true when a TARGET_HIT exists for the symbol today (IST)', async () => {
    const { repo } = repoWith([{ symbol: 'TCS', status: 'TARGET_HIT', exitedAt: new Date() }]);
    expect(await repo.hasTargetHitTodayBySymbol('swing', 'TCS')).toBe(true);
  });

  it('false when no target-hit today', async () => {
    const { repo } = repoWith([]);
    expect(await repo.hasTargetHitTodayBySymbol('swing', 'TCS')).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/api && npx jest same-day-guard.repository.spec -i`
Expected: FAIL — `repo.hasTargetHitTodayBySymbol is not a function`.

- [ ] **Step 3: Add the method (and a shared IST-midnight helper)**

Add a private helper and the method inside `AnandDualTrackRepository`:

```typescript
  /** IST midnight of the current day, returned as a UTC Date. */
  private istMidnightTodayUtc(): Date {
    const now = new Date();
    const istNow = new Date(now.getTime() + 5.5 * 60 * 60 * 1000);
    istNow.setUTCHours(0, 0, 0, 0);
    return new Date(istNow.getTime() - 5.5 * 60 * 60 * 1000);
  }

  /** True if the symbol already hit its target today (IST) on the given track. */
  async hasTargetHitTodayBySymbol(
    track: 'intraday' | 'swing',
    symbol: string,
  ): Promise<boolean> {
    const model = track === 'intraday' ? this.prisma.intradayEntry : this.prisma.swingEntry;
    const hit = await (model as any).findFirst({
      where: { symbol, status: 'TARGET_HIT', exitedAt: { gte: this.istMidnightTodayUtc() } },
      select: { id: true },
    });
    return hit != null;
  }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd apps/api && npx jest same-day-guard.repository.spec -i`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/modules/anand-dual-track/repositories/anand-dual-track.repository.ts apps/api/src/modules/anand-dual-track/repositories/__tests__/same-day-guard.repository.spec.ts
git commit -m "feat(anand): hasTargetHitTodayBySymbol guard (Feature 2)"
```

---

## Task 4: Features 1+2 — wire `createEntries`

**Files:**
- Modify: `apps/api/src/modules/anand-dual-track/services/anand-dual-track.service.ts`
- Test: `apps/api/src/modules/anand-dual-track/services/__tests__/anand-dual-track.service.spec.ts`

- [ ] **Step 1: Write the failing test**

```typescript
import { AnandDualTrackService } from '../anand-dual-track.service';

function makeRepo(overrides: Partial<any> = {}) {
  return {
    bumpLeadStat: jest.fn(async () => {}),
    findActiveTradedBySymbol: jest.fn(async () => null),
    hasTargetHitTodayBySymbol: jest.fn(async () => false),
    createIntradayEntry: jest.fn(async () => ({ id: 'i1' })),
    createSwingEntry: jest.fn(async () => ({ id: 's1' })),
    ...overrides,
  };
}

const input = { alertId: 'a1', symbol: 'TCS', token: 't1', hitPrice: 100, scoreBreakdown: null };

describe('AnandDualTrackService.createEntries', () => {
  it('bumps the swing lead stat on every fire', async () => {
    const repo = makeRepo();
    await new AnandDualTrackService(repo as any).createEntries(input);
    expect(repo.bumpLeadStat).toHaveBeenCalledWith('swing', 'TCS');
  });

  it('skips both tracks when that track hit target today', async () => {
    const repo = makeRepo({ hasTargetHitTodayBySymbol: jest.fn(async () => true) });
    await new AnandDualTrackService(repo as any).createEntries(input);
    expect(repo.createIntradayEntry).not.toHaveBeenCalled();
    expect(repo.createSwingEntry).not.toHaveBeenCalled();
    // lead stat still bumped
    expect(repo.bumpLeadStat).toHaveBeenCalledWith('swing', 'TCS');
  });

  it('still creates entries on a normal fire', async () => {
    const repo = makeRepo();
    await new AnandDualTrackService(repo as any).createEntries(input);
    expect(repo.createIntradayEntry).toHaveBeenCalled();
    expect(repo.createSwingEntry).toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/api && npx jest anand-dual-track.service.spec -i`
Expected: FAIL — `repo.bumpLeadStat is not a function` / assertions fail.

- [ ] **Step 3: Update `createEntries`**

Replace the body of `createEntries` with:

```typescript
  async createEntries(input: CreateEntriesInput): Promise<void> {
    const shared = {
      symbol: input.symbol,
      token: input.token,
      entryPrice: input.hitPrice,
      alertId: input.alertId,
      scoreBreakdown: input.scoreBreakdown,
    };

    // Feature 1: record the lead on EVERY swing fire, before any guard.
    await this.repo.bumpLeadStat('swing', input.symbol).catch((err) =>
      this.logger.warn(`[anand] bumpLeadStat failed for ${input.symbol}: ${err instanceof Error ? err.message : err}`),
    );

    // Per-track guards: skip if an active TRADED entry exists OR (Feature 2)
    // the symbol already hit its target today on that track.
    const [activeIntraday, activeSwing, intradayHitToday, swingHitToday] = await Promise.all([
      this.repo.findActiveTradedBySymbol('intraday', input.symbol),
      this.repo.findActiveTradedBySymbol('swing', input.symbol),
      this.repo.hasTargetHitTodayBySymbol('intraday', input.symbol),
      this.repo.hasTargetHitTodayBySymbol('swing', input.symbol),
    ]);

    if (activeIntraday) {
      this.logger.log(`[anand] intraday: ${input.symbol} already has active TRADED entry — skipping`);
    } else if (intradayHitToday) {
      this.logger.log(`[anand] intraday: ${input.symbol} already hit target today — SKIP_TARGET_HIT_TODAY`);
    } else {
      try {
        await this.repo.createIntradayEntry(shared);
      } catch (err) {
        this.logger.warn(`[anand-dual-track] intraday insert failed for ${input.symbol}: ${err instanceof Error ? err.message : err}`);
      }
    }

    if (activeSwing) {
      this.logger.log(`[anand] swing: ${input.symbol} already has active TRADED entry — skipping`);
    } else if (swingHitToday) {
      this.logger.log(`[anand] swing: ${input.symbol} already hit target today — SKIP_TARGET_HIT_TODAY`);
    } else {
      try {
        await this.repo.createSwingEntry(shared);
      } catch (err) {
        this.logger.warn(`[anand-dual-track] swing insert failed for ${input.symbol}: ${err instanceof Error ? err.message : err}`);
      }
    }
  }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd apps/api && npx jest anand-dual-track.service.spec -i`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/modules/anand-dual-track/services/anand-dual-track.service.ts apps/api/src/modules/anand-dual-track/services/__tests__/anand-dual-track.service.spec.ts
git commit -m "feat(anand): wire lead counter + same-day guard into createEntries (Features 1+2)"
```

---

## Task 5: Feature 3 — intraday Supertrend trailing (repository + monitor)

**Files:**
- Modify: `apps/api/src/modules/anand-dual-track/repositories/anand-dual-track.repository.ts` (add `setIntradayTrailing`)
- Modify: `apps/api/src/modules/anand-dual-track/services/anand-price-monitor.service.ts`
- Test: `apps/api/src/modules/anand-dual-track/services/__tests__/intraday-trailing.spec.ts`

- [ ] **Step 1: Add the repository update method**

Add inside `AnandDualTrackRepository`:

```typescript
  async setIntradayTrailing(id: string, data: { trailing: boolean; peakPrice: number }): Promise<void> {
    await this.prisma.intradayEntry.update({ where: { id }, data });
  }
```

- [ ] **Step 2: Write the failing test for the monitor's pure trailing decision**

We extract the trailing decision into a pure static method `decideIntradayTrail` so it is testable without cron/DB. Create the test:

```typescript
import { AnandPriceMonitorService } from '../anand-price-monitor.service';

const entry = { entryPrice: 100, targetPct: 5, stopPct: 5, trailing: false, peakPrice: null as number | null };

describe('AnandPriceMonitorService.decideIntradayTrail', () => {
  it('arms trailing (no exit) the first time price reaches +5%', () => {
    const d = AnandPriceMonitorService.decideIntradayTrail({ ...entry }, 105, null);
    expect(d).toEqual({ action: 'ARM_TRAIL', peakPrice: 105 });
  });

  it('stops out below -5% before trailing arms', () => {
    const d = AnandPriceMonitorService.decideIntradayTrail({ ...entry }, 94, null);
    expect(d.action).toBe('STOP');
  });

  it('holds while trailing and above the Supertrend line', () => {
    const e = { ...entry, trailing: true, peakPrice: 108 };
    const d = AnandPriceMonitorService.decideIntradayTrail(e, 110, 106);
    expect(d).toEqual({ action: 'HOLD', peakPrice: 110 });
  });

  it('exits TRAIL_ST when price drops below the Supertrend line', () => {
    const e = { ...entry, trailing: true, peakPrice: 112 };
    const d = AnandPriceMonitorService.decideIntradayTrail(e, 109, 110);
    expect(d).toEqual({ action: 'EXIT', exitReason: 'TRAIL_ST', peakPrice: 112 });
  });

  it('falls back to 2% give-back when Supertrend is unavailable', () => {
    const e = { ...entry, trailing: true, peakPrice: 120 };
    // 2% below peak 120 = 117.6; 117 < 117.6 → exit
    const d = AnandPriceMonitorService.decideIntradayTrail(e, 117, null);
    expect(d).toEqual({ action: 'EXIT', exitReason: 'TRAIL_GB', peakPrice: 120 });
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `cd apps/api && npx jest intraday-trailing.spec -i`
Expected: FAIL — `decideIntradayTrail is not a function`.

- [ ] **Step 4: Implement the monitor changes**

In `anand-price-monitor.service.ts`:

(a) Add imports at the top:

```typescript
import { supertrend } from '../../signal-generator/strategies/indicators';
```

(b) Add the pure decision function and a Supertrend fetch helper, plus rework intraday checking. Add these as members of `AnandPriceMonitorService`:

```typescript
  private static readonly TRAIL_GIVEBACK = 0.02; // 2% give-back fallback

  /**
   * Pure trailing decision for one intraday entry.
   * @param stLine current Supertrend(10,3) 15m line value, or null if unavailable
   */
  static decideIntradayTrail(
    entry: { entryPrice: number; targetPct: number; stopPct: number; trailing: boolean; peakPrice: number | null },
    ltp: number,
    stLine: number | null,
  ):
    | { action: 'HOLD'; peakPrice: number }
    | { action: 'ARM_TRAIL'; peakPrice: number }
    | { action: 'STOP' }
    | { action: 'EXIT'; exitReason: 'TRAIL_ST' | 'TRAIL_GB'; peakPrice: number } {
    const pnlPct = ((ltp - entry.entryPrice) / entry.entryPrice) * 100;

    if (!entry.trailing) {
      if (pnlPct >= entry.targetPct) return { action: 'ARM_TRAIL', peakPrice: ltp };
      if (pnlPct <= -entry.stopPct) return { action: 'STOP' };
      return { action: 'HOLD', peakPrice: ltp };
    }

    const peak = Math.max(entry.peakPrice ?? ltp, ltp);
    if (stLine != null) {
      if (ltp < stLine) return { action: 'EXIT', exitReason: 'TRAIL_ST', peakPrice: peak };
      return { action: 'HOLD', peakPrice: peak };
    }
    // Fallback: 2% give-back from the running peak.
    if (ltp <= peak * (1 - AnandPriceMonitorService.TRAIL_GIVEBACK)) {
      return { action: 'EXIT', exitReason: 'TRAIL_GB', peakPrice: peak };
    }
    return { action: 'HOLD', peakPrice: peak };
  }

  /** Latest Supertrend(10,3) line on 15m candles, or null if not enough data. */
  private async supertrend15m(token: string): Promise<number | null> {
    const to = new Date();
    const from = new Date(to.getTime() - 6 * 24 * 60 * 60 * 1000); // ~6 calendar days
    const candles = await this.adapter
      .getHistoricalData(token, 'NSE', '15m', from, to)
      .catch(() => [] as any[]);
    if (!Array.isArray(candles) || candles.length < 11) return null;
    const highs = candles.map((c) => Number(c.high));
    const lows = candles.map((c) => Number(c.low));
    const closes = candles.map((c) => Number(c.close));
    const st = supertrend(highs, lows, closes, 10, 3);
    return st ? st.value : null;
  }

  /** Intraday checking with trailing. Replaces the generic path for intraday. */
  private async checkIntraday(
    entries: Array<{ id: string; token: string | null; entryPrice: number; targetPct: number; stopPct: number; trailing: boolean; peakPrice: number | null }>,
  ): Promise<void> {
    const withToken = entries.filter((e) => e.token);
    if (withToken.length === 0) return;
    const tokens = [...new Set(withToken.map((e) => e.token as string))];
    const ltpMap = await this.adapter.getLtpsBatch('NSE', tokens).catch(() => new Map<string, number>());
    const now = new Date();

    for (const entry of withToken) {
      const ltp = ltpMap.get(entry.token as string);
      if (ltp === undefined) continue;

      // Only fetch candles when the entry is (or is about to be) trailing —
      // keeps rate-limited candle calls to a minimum.
      const pnlPct = ((ltp - entry.entryPrice) / entry.entryPrice) * 100;
      const willTrail = entry.trailing || pnlPct >= entry.targetPct;
      const stLine = entry.trailing && willTrail ? await this.supertrend15m(entry.token as string) : null;

      const d = AnandPriceMonitorService.decideIntradayTrail(entry, ltp, stLine);
      if (d.action === 'STOP') {
        this.logger.log(`[anand-intraday] ${entry.id} STOPPED at ${ltp} (${pnlPct.toFixed(2)}%)`);
        await this.repo.updateIntradayStatus(entry.id, { status: 'STOPPED', exitPrice: ltp, exitedAt: now });
      } else if (d.action === 'ARM_TRAIL') {
        this.logger.log(`[anand-intraday] ${entry.id} reached +${pnlPct.toFixed(2)}% — arming trail`);
        await this.repo.setIntradayTrailing(entry.id, { trailing: true, peakPrice: d.peakPrice });
      } else if (d.action === 'EXIT') {
        this.logger.log(`[anand-intraday] ${entry.id} TARGET_HIT via ${d.exitReason} at ${ltp} (+${pnlPct.toFixed(2)}%)`);
        await this.repo.updateIntradayStatus(entry.id, { status: 'TARGET_HIT', exitPrice: ltp, exitedAt: now, exitReason: d.exitReason });
      } else if (entry.trailing && d.peakPrice > (entry.peakPrice ?? 0)) {
        await this.repo.setIntradayTrailing(entry.id, { trailing: true, peakPrice: d.peakPrice });
      }
    }
  }
```

(c) Update `pollMarketHours` to use `checkIntraday` for the intraday track:

```typescript
  @Cron('*/30 * 9-15 * * 1-5', { timeZone: 'Asia/Kolkata' })
  async pollMarketHours(): Promise<void> {
    const [intraday, swing] = await Promise.all([
      this.repo.listWatchingIntraday(),
      this.repo.listWatchingSwing(),
    ]);

    await this.checkIntraday(intraday as any);
    await this.checkEntries(swing, 'swing');
  }
```

(d) `updateIntradayStatus` now optionally carries `exitReason`. Update `UpdateStatusInput` in the repository to include it:

In `anand-dual-track.repository.ts`, change `UpdateStatusInput`:

```typescript
export interface UpdateStatusInput {
  status: string;
  exitPrice?: number;
  exitedAt?: Date;
  exitReason?: string;
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `cd apps/api && npx jest intraday-trailing.spec -i`
Expected: PASS (5 tests).

- [ ] **Step 6: Typecheck the module**

Run: `cd apps/api && npx tsc --noEmit -p tsconfig.json 2>&1 | Select-String anand`
Expected: no errors referencing anand files (ignore any unrelated pre-existing `@td/shared` noise).

- [ ] **Step 7: Commit**

```bash
git add apps/api/src/modules/anand-dual-track/repositories/anand-dual-track.repository.ts apps/api/src/modules/anand-dual-track/services/anand-price-monitor.service.ts apps/api/src/modules/anand-dual-track/services/__tests__/intraday-trailing.spec.ts
git commit -m "feat(anand): intraday Supertrend trailing stop after +5% (Feature 3)"
```

---

## Task 6: Feature 4 — reinvestment service + pool (backend logic)

**Files:**
- Create: `apps/api/src/modules/anand-dual-track/services/reinvestment.service.ts`
- Modify: `apps/api/src/modules/anand-dual-track/repositories/anand-dual-track.repository.ts` (reinvestment CRUD + pool)
- Test: `apps/api/src/modules/anand-dual-track/services/__tests__/reinvestment.service.spec.ts`

- [ ] **Step 1: Add reinvestment repository methods**

Add inside `AnandDualTrackRepository`:

```typescript
  // ── Reinvestment (Feature 4) ─────────────────────────────────────────────
  async createReinvestmentLot(input: {
    symbol: string;
    sourceSwingEntryId: string;
    capital: number;
    entryPrice: number;
  }): Promise<{ id: string } | null> {
    // sourceSwingEntryId is @unique — a duplicate create (re-poll) throws P2002;
    // swallow it so the lot is created at most once per swing target hit.
    try {
      return await this.prisma.reinvestmentLot.create({
        data: { ...input, targetPct: 10, stopPct: 10, status: 'OPEN' },
        select: { id: true },
      });
    } catch (err: any) {
      if (err?.code === 'P2002') return null;
      throw err;
    }
  }

  async listOpenReinvestmentLots() {
    return this.prisma.reinvestmentLot.findMany({ where: { status: 'OPEN' }, orderBy: { enteredAt: 'desc' } });
  }

  async listReinvestmentLots(status?: string) {
    return this.prisma.reinvestmentLot.findMany({
      where: status ? { status } : {},
      orderBy: { enteredAt: 'desc' },
      take: 200,
    });
  }

  async closeReinvestmentLot(
    id: string,
    data: { status: string; exitPrice: number; exitedAt: Date; exitReason: string },
  ): Promise<void> {
    await this.prisma.reinvestmentLot.update({ where: { id }, data });
  }

  async getPool() {
    return this.prisma.reinvestmentPool.upsert({
      where: { id: 'singleton' },
      create: { id: 'singleton' },
      update: {},
    });
  }

  async applyPoolDelta(delta: {
    harvestedTotal?: number;
    deployedActive?: number;
    idleBalance?: number;
    realizedPnl?: number;
  }): Promise<void> {
    await this.prisma.reinvestmentPool.upsert({
      where: { id: 'singleton' },
      create: {
        id: 'singleton',
        harvestedTotal: delta.harvestedTotal ?? 0,
        deployedActive: delta.deployedActive ?? 0,
        idleBalance: delta.idleBalance ?? 0,
        realizedPnl: delta.realizedPnl ?? 0,
      },
      update: {
        harvestedTotal: { increment: delta.harvestedTotal ?? 0 },
        deployedActive: { increment: delta.deployedActive ?? 0 },
        idleBalance: { increment: delta.idleBalance ?? 0 },
        realizedPnl: { increment: delta.realizedPnl ?? 0 },
      },
    });
  }
```

- [ ] **Step 2: Write the failing test for the service**

```typescript
import { ReinvestmentService, SWING_PROFIT } from '../reinvestment.service';

function makeRepo() {
  return {
    createReinvestmentLot: jest.fn(async () => ({ id: 'lot1' })),
    applyPoolDelta: jest.fn(async () => {}),
    closeReinvestmentLot: jest.fn(async () => {}),
  };
}

describe('ReinvestmentService', () => {
  it('onSwingTargetHit deploys a ₹20k lot and updates the pool', async () => {
    const repo = makeRepo();
    const svc = new ReinvestmentService(repo as any);
    await svc.onSwingTargetHit({ swingEntryId: 's1', symbol: 'TCS', exitPrice: 110 });

    expect(repo.createReinvestmentLot).toHaveBeenCalledWith({
      symbol: 'TCS', sourceSwingEntryId: 's1', capital: SWING_PROFIT, entryPrice: 110,
    });
    expect(repo.applyPoolDelta).toHaveBeenCalledWith({ harvestedTotal: SWING_PROFIT, deployedActive: SWING_PROFIT });
  });

  it('does not touch the pool when the lot already existed (re-poll)', async () => {
    const repo = makeRepo();
    repo.createReinvestmentLot = jest.fn(async () => null);
    const svc = new ReinvestmentService(repo as any);
    await svc.onSwingTargetHit({ swingEntryId: 's1', symbol: 'TCS', exitPrice: 110 });
    expect(repo.applyPoolDelta).not.toHaveBeenCalled();
  });

  it('closeLot on a win returns capital+profit to idle and books realized pnl', async () => {
    const repo = makeRepo();
    const svc = new ReinvestmentService(repo as any);
    // +10% on ₹20k capital → lotPnl = ₹2,000; idle += 22,000
    await svc.closeLot({ id: 'lot1', capital: SWING_PROFIT, entryPrice: 100 }, 110, 'TARGET_HIT');

    expect(repo.closeReinvestmentLot).toHaveBeenCalledWith('lot1', expect.objectContaining({ status: 'TARGET_HIT', exitPrice: 110, exitReason: 'TARGET_HIT' }));
    expect(repo.applyPoolDelta).toHaveBeenCalledWith({ deployedActive: -SWING_PROFIT, idleBalance: SWING_PROFIT + 2000, realizedPnl: 2000 });
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `cd apps/api && npx jest reinvestment.service.spec -i`
Expected: FAIL — cannot find module `../reinvestment.service`.

- [ ] **Step 4: Create the service**

`apps/api/src/modules/anand-dual-track/services/reinvestment.service.ts`:

```typescript
import { Injectable, Logger } from '@nestjs/common';
import { AnandDualTrackRepository } from '../repositories/anand-dual-track.repository';

const NOTIONAL = 200_000;
/** Profit realized by a swing +10% target hit, reinvested as a new lot. */
export const SWING_PROFIT = 0.1 * NOTIONAL; // ₹20,000

@Injectable()
export class ReinvestmentService {
  private readonly logger = new Logger(ReinvestmentService.name);

  constructor(private readonly repo: AnandDualTrackRepository) {}

  /**
   * Fired when a SwingEntry hits +10%. Capital "returns to the pool"; only the
   * ₹20k profit is reinvested as a new lot in the same symbol. Idempotent per
   * swingEntryId (the lot's sourceSwingEntryId is unique).
   */
  async onSwingTargetHit(input: { swingEntryId: string; symbol: string; exitPrice: number }): Promise<void> {
    const lot = await this.repo.createReinvestmentLot({
      symbol: input.symbol,
      sourceSwingEntryId: input.swingEntryId,
      capital: SWING_PROFIT,
      entryPrice: input.exitPrice,
    });
    if (!lot) return; // already created on a prior poll — do not double-count the pool
    await this.repo.applyPoolDelta({ harvestedTotal: SWING_PROFIT, deployedActive: SWING_PROFIT });
    this.logger.log(`[reinvest] deployed ₹${SWING_PROFIT} into ${input.symbol} @ ${input.exitPrice} (lot ${lot.id})`);
  }

  /** Close an open lot at `ltp`, moving capital+pnl back to the idle pool. */
  async closeLot(
    lot: { id: string; capital: number; entryPrice: number },
    ltp: number,
    status: 'TARGET_HIT' | 'STOPPED',
  ): Promise<void> {
    const pnlPct = ((ltp - lot.entryPrice) / lot.entryPrice) * 100;
    const lotPnl = (pnlPct / 100) * lot.capital;
    await this.repo.closeReinvestmentLot(lot.id, {
      status,
      exitPrice: ltp,
      exitedAt: new Date(),
      exitReason: status,
    });
    await this.repo.applyPoolDelta({
      deployedActive: -lot.capital,
      idleBalance: lot.capital + lotPnl,
      realizedPnl: lotPnl,
    });
    this.logger.log(`[reinvest] closed lot ${lot.id} ${status} pnl=₹${lotPnl.toFixed(0)}`);
  }
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `cd apps/api && npx jest reinvestment.service.spec -i`
Expected: PASS (3 tests).

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/modules/anand-dual-track/services/reinvestment.service.ts apps/api/src/modules/anand-dual-track/repositories/anand-dual-track.repository.ts apps/api/src/modules/anand-dual-track/services/__tests__/reinvestment.service.spec.ts
git commit -m "feat(anand): reinvestment service + pool math (Feature 4 core)"
```

---

## Task 7: Feature 4 — monitor wiring (swing→lot, lot polling) + module + controller

**Files:**
- Modify: `apps/api/src/modules/anand-dual-track/services/anand-price-monitor.service.ts`
- Modify: `apps/api/src/modules/anand-dual-track/anand-dual-track.module.ts`
- Modify: `apps/api/src/modules/anand-dual-track/controllers/anand-dual-track.controller.ts`
- Test: `apps/api/src/modules/anand-dual-track/services/__tests__/reinvest-monitor.spec.ts`

- [ ] **Step 1: Inject `ReinvestmentService` into the monitor and hook swing target hits**

In `anand-price-monitor.service.ts`:

(a) Import + inject:

```typescript
import { ReinvestmentService } from './reinvestment.service';
```

```typescript
  constructor(
    private readonly repo: AnandDualTrackRepository,
    private readonly adapter: AngelOneAdapterService,
    private readonly reinvest: ReinvestmentService,
  ) {}
```

(b) In `checkEntries`, the swing `TARGET_HIT` branch must also open a reinvestment lot. Replace the existing TARGET_HIT branch with one that, for swing, calls the reinvestment service after marking the exit:

```typescript
      if (pnlPct >= entry.targetPct) {
        this.logger.log(`[anand-${track}] ${entry.id} TARGET_HIT at ${ltp} (+${pnlPct.toFixed(2)}%)`);
        if (track === 'intraday') {
          await this.repo.updateIntradayStatus(entry.id, { status: 'TARGET_HIT', exitPrice: ltp, exitedAt: now });
        } else {
          await this.repo.updateSwingStatus(entry.id, { status: 'TARGET_HIT', exitPrice: ltp, exitedAt: now });
          await this.reinvest
            .onSwingTargetHit({ swingEntryId: entry.id, symbol: (entry as any).symbol, exitPrice: ltp })
            .catch((err) => this.logger.warn(`[reinvest] failed for ${entry.id}: ${err instanceof Error ? err.message : err}`));
        }
      } else if (pnlPct <= -entry.stopPct) {
```

> Note: `checkEntries`'s `entries` param type must include `symbol`. Update its signature:
> ```typescript
>   private async checkEntries(
>     entries: Array<{ id: string; symbol: string; token: string | null; entryPrice: number; targetPct: number; stopPct: number }>,
>     track: 'intraday' | 'swing',
>   ): Promise<void> {
> ```
> (`listWatchingSwing` already returns full rows including `symbol`, so no query change is needed.)

(c) Add reinvestment-lot polling. Add a method and call it from both crons:

```typescript
  private async checkReinvestmentLots(): Promise<void> {
    const lots = await this.repo.listOpenReinvestmentLots();
    const withToken = lots.filter((l) => l.symbol);
    if (withToken.length === 0) return;
    // Lots store symbol but not token; resolve LTP via the same swing path by
    // re-using the entry's symbol→token is not available here, so fetch by the
    // lot's stored entry token. Lots inherit the symbol; resolve tokens.
    const symbols = [...new Set(withToken.map((l) => l.symbol))];
    const tokenMap = await this.repo.resolveTokens(symbols).catch(() => new Map<string, string>());
    const tokens = [...new Set([...tokenMap.values()])];
    const ltpMap = tokens.length
      ? await this.adapter.getLtpsBatch('NSE', tokens).catch(() => new Map<string, number>())
      : new Map<string, number>();

    for (const lot of lots) {
      const token = tokenMap.get(lot.symbol);
      const ltp = token ? ltpMap.get(token) : undefined;
      if (ltp === undefined) continue;
      const pnlPct = ((ltp - lot.entryPrice) / lot.entryPrice) * 100;
      if (pnlPct >= lot.targetPct) {
        await this.reinvest.closeLot({ id: lot.id, capital: lot.capital, entryPrice: lot.entryPrice }, ltp, 'TARGET_HIT');
      } else if (pnlPct <= -lot.stopPct) {
        await this.reinvest.closeLot({ id: lot.id, capital: lot.capital, entryPrice: lot.entryPrice }, ltp, 'STOPPED');
      }
    }
  }
```

Add `await this.checkReinvestmentLots();` at the end of both `pollMarketHours` and `pollOvernight` (after the swing check).

(d) Add a token resolver to the repository (reinvestment lots only store `symbol`). Add inside `AnandDualTrackRepository`:

```typescript
  /** Resolve symbol → instrument token using the most recent swing entry token. */
  async resolveTokens(symbols: string[]): Promise<Map<string, string>> {
    const out = new Map<string, string>();
    if (symbols.length === 0) return out;
    const rows = await this.prisma.swingEntry.findMany({
      where: { symbol: { in: [...new Set(symbols)] }, token: { not: null } },
      select: { symbol: true, token: true },
      orderBy: { enteredAt: 'desc' },
    });
    for (const r of rows) {
      if (r.token && !out.has(r.symbol)) out.set(r.symbol, r.token);
    }
    return out;
  }
```

- [ ] **Step 2: Write the failing monitor test**

```typescript
import { AnandPriceMonitorService } from '../anand-price-monitor.service';

describe('checkReinvestmentLots', () => {
  it('closes a lot that reached +10%', async () => {
    const reinvest = { closeLot: jest.fn(async () => {}), onSwingTargetHit: jest.fn() };
    const repo = {
      listOpenReinvestmentLots: jest.fn(async () => [{ id: 'lot1', symbol: 'TCS', entryPrice: 100, capital: 20000, targetPct: 10, stopPct: 10 }]),
      resolveTokens: jest.fn(async () => new Map([['TCS', 't1']])),
    };
    const adapter = { getLtpsBatch: jest.fn(async () => new Map([['t1', 111]])) };
    const svc = new AnandPriceMonitorService(repo as any, adapter as any, reinvest as any);
    await (svc as any).checkReinvestmentLots();
    expect(reinvest.closeLot).toHaveBeenCalledWith(
      { id: 'lot1', capital: 20000, entryPrice: 100 }, 111, 'TARGET_HIT',
    );
  });
});
```

- [ ] **Step 3: Run test to verify it fails, then passes**

Run: `cd apps/api && npx jest reinvest-monitor.spec -i`
Expected: first FAIL (method/ctor mismatch) until Step 1 is complete, then PASS.

- [ ] **Step 4: Register `ReinvestmentService` in the module**

In `anand-dual-track.module.ts`, add `ReinvestmentService` to imports and `providers`:

```typescript
import { ReinvestmentService } from './services/reinvestment.service';
```
```typescript
  providers: [AnandDualTrackRepository, AnandDualTrackService, AnandPriceMonitorService, ReinvestmentService],
```

- [ ] **Step 5: Add controller routes for the reinvestment page**

In `anand-dual-track.controller.ts`, add two endpoints (reuse the existing `enrichWithLivePrice` pattern; lots have no `targetLeftPct` need but the helper tolerates it). Add:

```typescript
  @Get('reinvest/pool')
  async reinvestPool() {
    return this.repo.getPool();
  }

  @Get('reinvest/lots')
  async reinvestLots(@Query('status') status?: string) {
    const lots = await this.repo.listReinvestmentLots(status || undefined);
    const tokenMap = await this.repo.resolveTokens(lots.map((l) => l.symbol)).catch(() => new Map<string, string>());
    const tokens = [...new Set([...tokenMap.values()])];
    const ltpMap = tokens.length
      ? await this.adapter.getLtpsBatch('NSE', tokens).catch(() => new Map<string, number>())
      : new Map<string, number>();
    return lots.map((l) => {
      const token = tokenMap.get(l.symbol);
      const currentPrice = (token ? ltpMap.get(token) : undefined) ?? l.exitPrice ?? l.entryPrice;
      const pnlPct = ((currentPrice - l.entryPrice) / l.entryPrice) * 100;
      const pnlRs = (pnlPct / 100) * l.capital;
      return { ...l, currentPrice, pnlPct, pnlRs };
    });
  }
```

- [ ] **Step 6: Full API test + typecheck**

Run: `cd apps/api && npx jest anand -i` (runs all anand specs)
Expected: all PASS.
Run: `cd apps/api && npx tsc --noEmit -p tsconfig.json 2>&1 | Select-String anand`
Expected: no anand-file errors.

- [ ] **Step 7: Commit**

```bash
git add apps/api/src/modules/anand-dual-track
git commit -m "feat(anand): reinvestment monitor wiring + controller routes (Feature 4 backend)"
```

---

## Task 8: Frontend — extend the anand API client

**Files:**
- Modify: `apps/web/src/services/anand.ts`

- [ ] **Step 1: Extend `AnandEntry` and add reinvestment types + client calls**

Add to `AnandEntry` (after `scannerName`):

```typescript
  leadCount?: number;
  leadDates?: string[];
  trailing?: boolean;
  exitReason?: string | null;
```

Append at the end of the file:

```typescript
export interface ReinvestPool {
  harvestedTotal: number;
  deployedActive: number;
  idleBalance: number;
  realizedPnl: number;
}

export interface ReinvestLot {
  id: string;
  symbol: string;
  sourceSwingEntryId: string;
  capital: number;
  entryPrice: number;
  enteredAt: string;
  targetPct: number;
  stopPct: number;
  status: string;        // OPEN | TARGET_HIT | STOPPED
  exitPrice: number | null;
  exitedAt: string | null;
  exitReason: string | null;
  currentPrice: number;
  pnlPct: number;
  pnlRs: number;
}

export async function getReinvestPool(): Promise<ReinvestPool> {
  const r = await api.get<ReinvestPool>('/anand/reinvest/pool');
  return r.data;
}

export async function listReinvestLots(status?: string): Promise<ReinvestLot[]> {
  const r = await api.get<ReinvestLot[]>('/anand/reinvest/lots', { params: { status } });
  return r.data;
}
```

- [ ] **Step 2: Commit**

```bash
git add apps/web/src/services/anand.ts
git commit -m "feat(anand-web): extend API client for leads + reinvestment"
```

---

## Task 9: Frontend — enrich swing entries with lead data + Leads column

**Files:**
- Modify: `apps/api/src/modules/anand-dual-track/controllers/anand-dual-track.controller.ts` (enrich swing list)
- Modify: `apps/web/src/pages/swing/SwingPage.tsx`

- [ ] **Step 1: Enrich the swing list response with lead data**

In `anand-dual-track.controller.ts`, replace `listSwing` so it adds `leadCount`/`leadDates`:

```typescript
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
    const withScanner = await this.enrichWithScannerName(enriched);
    const leadMap = await this.repo.getLeadStats('swing', withScanner.map((e) => e.symbol)).catch(() => new Map());
    return withScanner.map((e) => {
      const lead = leadMap.get(e.symbol);
      return { ...e, leadCount: lead?.count ?? 0, leadDates: lead?.dates ?? [] };
    });
  }
```

> `enrichWithLivePrice`'s param type already includes `[key: string]: unknown`, so `symbol` flows through untyped — add `symbol: string` to the row map access by casting: use `e.symbol as string` if tsc complains, or widen the param type to include `symbol: string`.

- [ ] **Step 2: Add the Leads column to `SwingPage`**

(a) Add a header cell. In the `<thead>` row, after the Scanner `<th>`:

```tsx
                <th className="px-3 py-2">Leads</th>
```

(b) Add a body cell in `EntryRow`, right after the Scanner `<td>` (cell #2). Insert:

```tsx
        {/* Leads */}
        <td className="px-3 py-2 tabular-nums">
          {entry.leadCount && entry.leadCount > 0 ? (
            <span
              title={distinctDays(entry.leadDates ?? []).join('\n')}
              className="rounded bg-[var(--color-bg-tertiary)] px-1.5 py-0.5 text-xs font-semibold text-[var(--color-text-secondary)]"
            >
              ×{entry.leadCount}
            </span>
          ) : (
            <span className="text-[var(--color-text-muted)]">—</span>
          )}
        </td>
```

(c) Add the `distinctDays` helper near the other format helpers at the top of the file:

```tsx
/** Collapse a lossless ISO-timestamp lead log to distinct IST calendar days, newest first. */
function distinctDays(isoList: string[]): string[] {
  const seen = new Set<string>();
  for (const iso of isoList) {
    seen.add(new Date(iso).toLocaleDateString('en-IN', { timeZone: 'Asia/Kolkata', day: '2-digit', month: 'short', year: '2-digit' }));
  }
  return [...seen].reverse();
}
```

(d) The table now has 13 columns. Update both `colSpan={12}` occurrences (the empty-state row and the expanded score row) to `colSpan={13}`.

- [ ] **Step 3: Typecheck the web app**

Run: `cd apps/web && npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add apps/api/src/modules/anand-dual-track/controllers/anand-dual-track.controller.ts apps/web/src/pages/swing/SwingPage.tsx
git commit -m "feat(anand-web): swing Leads column with distinct-day tooltip (Feature 1 UI)"
```

---

## Task 10: Frontend — intraday trailing indicator

**Files:**
- Modify: `apps/web/src/pages/intraday/IntradayPage.tsx`

- [ ] **Step 1: Show a trailing chip on open rows and exit reason on closed rows**

(a) In `EntryRow`, update the Status `<td>` to append a trailing chip / exit-reason note. Replace the Status cell with:

```tsx
        <td className={clsx('px-3 py-2 text-xs font-semibold uppercase tracking-wider', statusColor[entry.status] ?? 'text-gray-400')}>
          {entry.status.replace('_', ' ')}
          {isActive && entry.trailing && (
            <span className="ml-1 rounded bg-amber-500/20 px-1 py-0.5 text-[9px] text-amber-300">trailing</span>
          )}
          {!isActive && entry.exitReason && (
            <span className="ml-1 text-[9px] lowercase text-[var(--color-text-muted)]">
              {entry.exitReason === 'TRAIL_ST' ? 'trail·st' : entry.exitReason === 'TRAIL_GB' ? 'trail·gb' : entry.exitReason.toLowerCase()}
            </span>
          )}
        </td>
```

(b) Update the header subtitle. Replace:

```tsx
          <p className="text-sm text-[var(--color-text-muted)]">5% target · 5% stop · expires at 15:15</p>
```

with:

```tsx
          <p className="text-sm text-[var(--color-text-muted)]">5% → trailing (Supertrend 15m) · 5% stop · expires 15:15</p>
```

- [ ] **Step 2: Typecheck**

Run: `cd apps/web && npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add apps/web/src/pages/intraday/IntradayPage.tsx
git commit -m "feat(anand-web): intraday trailing chip + exit-reason label (Feature 3 UI)"
```

---

## Task 11: Frontend — Reinvestment page (new)

**Files:**
- Create: `apps/web/src/hooks/useReinvestLots.ts`
- Create: `apps/web/src/pages/reinvest/ReinvestPage.tsx`
- Modify: `apps/web/src/App.tsx`
- Modify: `apps/web/src/components/layout/Sidebar.tsx`

- [ ] **Step 1: Create the hook**

`apps/web/src/hooks/useReinvestLots.ts`:

```typescript
import { useCallback, useEffect, useState } from 'react';
import { getReinvestPool, listReinvestLots, type ReinvestLot, type ReinvestPool } from '../services/anand';

const REFRESH_MS = 30_000;

export function useReinvestLots(status?: string) {
  const [lots, setLots] = useState<ReinvestLot[]>([]);
  const [pool, setPool] = useState<ReinvestPool | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const [rows, p] = await Promise.all([listReinvestLots(status || undefined), getReinvestPool()]);
      setLots(rows);
      setPool(p);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'fetch failed');
    } finally {
      setLoading(false);
    }
  }, [status]);

  useEffect(() => {
    refresh();
    const t = window.setInterval(refresh, REFRESH_MS);
    return () => window.clearInterval(t);
  }, [refresh]);

  return { lots, pool, loading, error, refresh };
}
```

- [ ] **Step 2: Create the page**

`apps/web/src/pages/reinvest/ReinvestPage.tsx`:

```tsx
import { useState } from 'react';
import clsx from 'clsx';
import { useReinvestLots } from '../../hooks/useReinvestLots';
import type { ReinvestLot, ReinvestPool } from '../../services/anand';

const rsFmt = new Intl.NumberFormat('en-IN', { maximumFractionDigits: 0 });
function fmtRs(n: number): string {
  const sign = n > 0 ? '+' : n < 0 ? '−' : '';
  return `${sign}₹${rsFmt.format(Math.abs(Math.round(n)))}`;
}
function fmtPlainRs(n: number): string {
  return `₹${rsFmt.format(Math.round(n))}`;
}
function fmtPct(n: number): string {
  return `${n >= 0 ? '+' : ''}${n.toFixed(2)}%`;
}
function moneyColor(n: number): string {
  if (n > 0) return 'text-emerald-400';
  if (n < 0) return 'text-red-400';
  return 'text-[var(--color-text-muted)]';
}
function fmtIstDate(iso: string): string {
  return new Date(iso).toLocaleDateString('en-IN', { timeZone: 'Asia/Kolkata', day: '2-digit', month: 'short' });
}

function PoolCard({ label, value, signed }: { label: string; value: number; signed?: boolean }) {
  return (
    <div className="flex-1 min-w-[150px] rounded-lg border border-[var(--color-border-subtle)] bg-[var(--color-bg-secondary)] px-4 py-3">
      <div className="text-xs uppercase tracking-wider text-[var(--color-text-muted)]">{label}</div>
      <div className={clsx('mt-1 text-xl font-semibold tabular-nums', signed ? moneyColor(value) : 'text-[var(--color-text-primary)]')}>
        {signed ? fmtRs(value) : fmtPlainRs(value)}
      </div>
    </div>
  );
}

function PoolCards({ pool }: { pool: ReinvestPool }) {
  return (
    <div className="flex flex-wrap gap-3">
      <PoolCard label="Harvested" value={pool.harvestedTotal} />
      <PoolCard label="Deployed (active)" value={pool.deployedActive} />
      <PoolCard label="Idle Balance" value={pool.idleBalance} />
      <PoolCard label="Realized P&L" value={pool.realizedPnl} signed />
    </div>
  );
}

const FILTERS = [
  { label: 'Open', value: 'OPEN' },
  { label: 'Target Hit', value: 'TARGET_HIT' },
  { label: 'Stopped', value: 'STOPPED' },
  { label: 'All', value: undefined },
] as const;

function LotRow({ lot }: { lot: ReinvestLot }) {
  const open = lot.status === 'OPEN';
  const priceShown = open ? lot.currentPrice : lot.exitPrice ?? lot.currentPrice;
  const statusColor: Record<string, string> = {
    OPEN: 'text-blue-400',
    TARGET_HIT: 'text-emerald-400',
    STOPPED: 'text-red-400',
  };
  return (
    <tr className="border-t border-[var(--color-border-subtle)] hover:bg-[var(--color-bg-tertiary)]">
      <td className="px-3 py-2 font-mono font-medium">{lot.symbol}</td>
      <td className="px-3 py-2 tabular-nums">{fmtPlainRs(lot.capital)}</td>
      <td className="px-3 py-2 tabular-nums">₹{lot.entryPrice.toFixed(2)}</td>
      <td className={clsx('px-3 py-2 tabular-nums', moneyColor(lot.pnlPct))}>
        ₹{priceShown.toFixed(2)} <span className="text-xs">({fmtPct(lot.pnlPct)})</span>
      </td>
      <td className={clsx('px-3 py-2 font-semibold tabular-nums', moneyColor(lot.pnlRs))}>{fmtRs(lot.pnlRs)}</td>
      <td className="px-3 py-2 tabular-nums text-[var(--color-text-muted)]">{lot.targetPct}%</td>
      <td className={clsx('px-3 py-2 text-xs font-semibold uppercase tracking-wider', statusColor[lot.status] ?? 'text-gray-400')}>
        {lot.status.replace('_', ' ')}
      </td>
      <td className="px-3 py-2 tabular-nums text-[var(--color-text-muted)]">{fmtIstDate(lot.enteredAt)}</td>
      <td className="px-3 py-2 tabular-nums text-[var(--color-text-muted)]">
        {lot.exitedAt ? fmtIstDate(lot.exitedAt) : <span className="italic text-gray-500">—</span>}
      </td>
    </tr>
  );
}

export default function ReinvestPage() {
  const [filter, setFilter] = useState<string | undefined>('OPEN');
  const { lots, pool, loading, error } = useReinvestLots(filter);

  return (
    <div className="flex flex-col gap-4 p-6 text-[var(--color-text-primary)]">
      <div>
        <h1 className="text-2xl font-semibold">Reinvestment</h1>
        <p className="text-sm text-[var(--color-text-muted)]">
          Swing +10% profits redeployed into the same symbol · capital returns to the pool
        </p>
      </div>

      {pool && <PoolCards pool={pool} />}

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
      </div>

      {loading && <div className="text-[var(--color-text-muted)]">Loading…</div>}
      {error && <div className="text-red-400">Error: {error}</div>}
      {!loading && !error && (
        <div className="overflow-hidden rounded-lg border border-[var(--color-border-subtle)]">
          <table className="w-full text-sm">
            <thead className="bg-[var(--color-bg-secondary)] text-left text-xs uppercase tracking-wider text-[var(--color-text-muted)]">
              <tr>
                <th className="px-3 py-2">Symbol</th>
                <th className="px-3 py-2">Capital</th>
                <th className="px-3 py-2">Entry ₹</th>
                <th className="px-3 py-2">Price / Δ%</th>
                <th className="px-3 py-2">P&L ₹</th>
                <th className="px-3 py-2">Target</th>
                <th className="px-3 py-2">Status</th>
                <th className="px-3 py-2">Opened</th>
                <th className="px-3 py-2">Closed</th>
              </tr>
            </thead>
            <tbody>
              {lots.length === 0 && (
                <tr>
                  <td colSpan={9} className="px-3 py-8 text-center text-[var(--color-text-muted)]">
                    No reinvestment lots yet. Lots open when a swing position hits +10%.
                  </td>
                </tr>
              )}
              {lots.map((l) => <LotRow key={l.id} lot={l} />)}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
```

- [ ] **Step 3: Register the route in `App.tsx`**

Add the import alongside the other page imports:

```tsx
import ReinvestPage from '@/pages/reinvest/ReinvestPage';
```

Add the route next to the `swing` route:

```tsx
<Route path="reinvest" element={<ReinvestPage />} />
```

- [ ] **Step 4: Add the sidebar nav item in `Sidebar.tsx`**

Add `PiggyBank` to the existing `lucide-react` import, then add a nav entry after the Swing item:

```tsx
  { path: '/reinvest', label: 'Reinvest', icon: PiggyBank },
```

- [ ] **Step 5: Typecheck the web app**

Run: `cd apps/web && npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add apps/web/src/hooks/useReinvestLots.ts apps/web/src/pages/reinvest/ReinvestPage.tsx apps/web/src/App.tsx apps/web/src/components/layout/Sidebar.tsx
git commit -m "feat(anand-web): Reinvestment page, route, sidebar (Feature 4 UI)"
```

---

## Task 12: Final verification

- [ ] **Step 1: Run the full anand backend suite**

Run: `cd apps/api && npx jest anand reinvest -i`
Expected: all PASS.

- [ ] **Step 2: Typecheck both apps**

Run: `cd apps/api && npx tsc --noEmit -p tsconfig.json 2>&1 | Select-String -Pattern "anand|reinvest"`
Run: `cd apps/web && npx tsc --noEmit`
Expected: no errors in the changed files (ignore known spurious `@td/shared` standalone noise per project memory).

- [ ] **Step 3: Sanity-check the running app (optional, if API+web are up)**

Verify `/swing` shows a Leads column, `/intraday` shows the new subtitle, and `/reinvest` renders the four pool cards and an (empty) lots table. API on :4001, web on :4000.

- [ ] **Step 4: Final commit (if any stragglers)**

```bash
git add -A
git commit -m "chore(anand): finalize dual-track enhancements"
```

---

## Self-Review Notes (coverage check)

- **Feature 1 (lead counter):** Tasks 2 (repo), 4 (wire), 9 (UI). ✓
- **Feature 2 (same-day guard):** Tasks 3 (repo), 4 (wire). ✓
- **Feature 3 (intraday trail):** Task 5 (repo field + monitor + pure decision tests), 10 (UI). ✓
- **Feature 4 (reinvestment):** Tasks 1 (schema), 6 (service+repo+pool), 7 (monitor+controller+module), 8/11 (UI). ✓
- **Schema/db push:** Task 1. ✓  **Monitor symbol-set expansion:** Task 7 (lots) + Task 5 (trailing candles). ✓
- Type consistency: `decideIntradayTrail`, `setIntradayTrailing`, `bumpLeadStat`, `getLeadStats`, `hasTargetHitTodayBySymbol`, `onSwingTargetHit`, `closeLot`, `applyPoolDelta`, `resolveTokens`, `getPool`, `listReinvestmentLots`, `listOpenReinvestmentLots`, `createReinvestmentLot`, `closeReinvestmentLot` — names used consistently across tasks. ✓
- `SWING_PROFIT = ₹20,000` exported from the service and reused in tests. ✓
```
