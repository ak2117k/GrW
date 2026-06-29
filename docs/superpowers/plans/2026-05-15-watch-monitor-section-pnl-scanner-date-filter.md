# Watch Monitor — Section P/L Totals, Scanner Column, Date Filter — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a live section Total-P/L badge, a Chartink "Scanner" column, and a single-date filter (default today) to the Watch Monitor page.

**Architecture:** Read-time enrichment — the `GET /api/watch` endpoint gains a `date` filter and enriches each entry with `scannerName` (via `alertId → chartink_alerts → chartink_scanners`) and `realizedPnl` (via the linked trade's `pnl`). The frontend adds a date picker, a Total-P/L badge, and a Scanner column.

**Tech Stack:** NestJS + Prisma (backend), React + Vite + TypeScript (frontend), Jest.

**Spec:** `docs/superpowers/specs/2026-05-15-watch-monitor-section-pnl-scanner-date-filter-design.md`

**Commits:** intentionally omitted from steps — the repo has unrelated uncommitted work; the user commits separately. Each task ends with a test-run checkpoint instead.

**Tracks A (backend) and B (frontend) are independent and may be executed in parallel** — the API contract below is the interface. Track C integrates them.

**API contract:** `GET /api/watch?status=<S>&date=YYYY-MM-DD` returns `WatchEntry[]` where each entry additionally carries `scannerName: string | null` and `realizedPnl: number | null`.

---

## File Structure

**Backend (`apps/api`):**
- `src/modules/watch-monitor/repositories/watch.repository.ts` — MODIFY: `istDayRange` helper, `list` date filter, `findScannerNames`, `findRealizedPnls`.
- `src/modules/watch-monitor/services/watch.service.ts` — MODIFY: new `list()` enrichment method.
- `src/modules/watch-monitor/controllers/watch.controller.ts` — MODIFY: `list` accepts `date`, delegates to service.
- Test files (exist): `watch.repository.spec.ts`, `watch.service.spec.ts`, `watch.controller.spec.ts`.

**Frontend (`apps/web`):**
- `src/types/watch.types.ts` — MODIFY: add `scannerName`, `realizedPnl` to `WatchEntry`.
- `src/services/watch.service.ts` — MODIFY: `watchApi.list` accepts `date`.
- `src/hooks/useWatchEntries.ts` — MODIFY: accept `date`.
- `src/utils/watchPnl.ts` — CREATE: `MAX_INVESTMENT_PER_TRADE`, `profitView`, `sectionTotalPnl`.
- `src/utils/watchPnl.spec.ts` — CREATE: tests for `sectionTotalPnl`.
- `src/pages/watch/WatchTable.tsx` — MODIFY: import util, add Scanner column, closed rows show `realizedPnl`.
- `src/pages/watch/WatchPage.tsx` — MODIFY: date picker + Total-P/L badge.

---

## Track A — Backend

### Task A1: `istDayRange` helper + `WatchRepository.list` date filter

**Files:**
- Modify: `apps/api/src/modules/watch-monitor/repositories/watch.repository.ts`
- Test: `apps/api/src/modules/watch-monitor/repositories/watch.repository.spec.ts`

- [ ] **Step 1: Write the failing tests** — append inside the `describe('WatchRepository', …)` block:

```ts
  it('istDayRange maps an IST calendar day to the correct UTC range', () => {
    const { start, end } = istDayRange('2026-05-15');
    // IST 00:00 = UTC 18:30 on the previous day
    expect(start.toISOString()).toBe('2026-05-14T18:30:00.000Z');
    expect(end.toISOString()).toBe('2026-05-15T18:29:59.999Z');
  });

  it('list applies a createdAt range when date is given', async () => {
    prisma.watchEntry.findMany.mockResolvedValue([]);
    await repo.list({ date: '2026-05-15' });
    const args = prisma.watchEntry.findMany.mock.calls[0][0];
    expect(args.where.createdAt.gte.toISOString()).toBe('2026-05-14T18:30:00.000Z');
    expect(args.where.createdAt.lte.toISOString()).toBe('2026-05-15T18:29:59.999Z');
    expect(args.take).toBe(200);
  });
```

Add `istDayRange` to the import: `import { WatchRepository, istDayRange } from './watch.repository';`

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd apps/api && npx jest src/modules/watch-monitor/repositories/watch.repository.spec.ts -t "istDayRange|createdAt range"`
Expected: FAIL — `istDayRange` is not exported.

- [ ] **Step 3: Implement** — in `watch.repository.ts`, add the exported helper above the class and modify `list`:

```ts
/**
 * Convert an IST calendar day (YYYY-MM-DD) to its UTC instant range.
 * IST = UTC+5:30, so IST 00:00 is 18:30 UTC on the previous day.
 */
export function istDayRange(date: string): { start: Date; end: Date } {
  return {
    start: new Date(`${date}T00:00:00.000+05:30`),
    end: new Date(`${date}T23:59:59.999+05:30`),
  };
}
```

Replace the `list` method:

```ts
  async list(opts: {
    status?: WatchStatus;
    date?: string;
    limit?: number;
  }): Promise<WatchEntry[]> {
    const where: Prisma.WatchEntryWhereInput = {};
    if (opts.status) where.status = opts.status;
    if (opts.date) {
      const { start, end } = istDayRange(opts.date);
      where.createdAt = { gte: start, lte: end };
    }
    return this.prisma.watchEntry.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      take: opts.limit ?? (opts.date ? 200 : 50),
    });
  }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd apps/api && npx jest src/modules/watch-monitor/repositories/watch.repository.spec.ts`
Expected: PASS (all).

- [ ] **Step 5: Checkpoint** — tests green.

---

### Task A2: `WatchRepository` batch lookups

**Files:**
- Modify: `apps/api/src/modules/watch-monitor/repositories/watch.repository.ts`
- Test: `apps/api/src/modules/watch-monitor/repositories/watch.repository.spec.ts`

- [ ] **Step 1: Write the failing tests** — extend the prisma mock in `beforeEach` to add `chartinkAlert` and `trade`:

```ts
    prisma = {
      watchEntry: { create: jest.fn(), findUnique: jest.fn(), findFirst: jest.fn(), findMany: jest.fn(), update: jest.fn(), count: jest.fn() },
      watchEvent: { create: jest.fn(), findMany: jest.fn() },
      chartinkAlert: { findMany: jest.fn() },
      trade: { findMany: jest.fn() },
    };
```

Add tests:

```ts
  it('findScannerNames maps alertId -> scanner.scanName', async () => {
    prisma.chartinkAlert.findMany.mockResolvedValue([
      { id: 'a1', scanner: { scanName: 'Anand Superbullish scanner May26' } },
    ]);
    const map = await repo.findScannerNames(['a1', 'a1']);
    expect(map.get('a1')).toBe('Anand Superbullish scanner May26');
    // deduped to one id
    expect(prisma.chartinkAlert.findMany.mock.calls[0][0].where.id.in).toEqual(['a1']);
  });

  it('findScannerNames returns an empty map for no ids (no query)', async () => {
    const map = await repo.findScannerNames([]);
    expect(map.size).toBe(0);
    expect(prisma.chartinkAlert.findMany).not.toHaveBeenCalled();
  });

  it('findRealizedPnls maps tradeId -> pnl, skipping null pnl', async () => {
    prisma.trade.findMany.mockResolvedValue([
      { id: 't1', pnl: 1525 },
      { id: 't2', pnl: null },
    ]);
    const map = await repo.findRealizedPnls(['t1', 't2']);
    expect(map.get('t1')).toBe(1525);
    expect(map.has('t2')).toBe(false);
  });
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd apps/api && npx jest src/modules/watch-monitor/repositories/watch.repository.spec.ts -t "findScannerNames|findRealizedPnls"`
Expected: FAIL — methods not defined.

- [ ] **Step 3: Implement** — add to the `WatchRepository` class:

```ts
  /** Resolve alertId -> Chartink scanner name. Batched; deduped. */
  async findScannerNames(alertIds: string[]): Promise<Map<string, string>> {
    const ids = [...new Set(alertIds.filter((x): x is string => !!x))];
    if (ids.length === 0) return new Map();
    const alerts = await this.prisma.chartinkAlert.findMany({
      where: { id: { in: ids } },
      include: { scanner: true },
    });
    return new Map(alerts.map((a) => [a.id, a.scanner.scanName]));
  }

  /** Resolve tradeId -> realized pnl. Batched; null pnl is omitted. */
  async findRealizedPnls(tradeIds: string[]): Promise<Map<string, number>> {
    const ids = [...new Set(tradeIds.filter((x): x is string => !!x))];
    if (ids.length === 0) return new Map();
    const trades = await this.prisma.trade.findMany({
      where: { id: { in: ids } },
      select: { id: true, pnl: true },
    });
    return new Map(
      trades
        .filter((t) => t.pnl != null)
        .map((t) => [t.id, t.pnl as number]),
    );
  }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd apps/api && npx jest src/modules/watch-monitor/repositories/watch.repository.spec.ts`
Expected: PASS (all).

- [ ] **Step 5: Checkpoint** — tests green.

---

### Task A3: `WatchService.list` enrichment

**Files:**
- Modify: `apps/api/src/modules/watch-monitor/services/watch.service.ts`
- Test: `apps/api/src/modules/watch-monitor/services/watch.service.spec.ts`

- [ ] **Step 1: Write the failing test** — append a new `describe` to `watch.service.spec.ts` (reuse the existing imports):

```ts
describe('WatchService.list — enrichment', () => {
  it('attaches scannerName and realizedPnl to each entry', async () => {
    const repo = {
      list: jest.fn().mockResolvedValue([
        { id: 'w1', alertId: 'a1', paperTradeId: 't1', liveTradeId: null, status: 'TARGET_HIT' },
        { id: 'w2', alertId: null, paperTradeId: null, liveTradeId: null, status: 'WATCHING' },
      ]),
      findScannerNames: jest.fn().mockResolvedValue(new Map([['a1', 'Scanner X']])),
      findRealizedPnls: jest.fn().mockResolvedValue(new Map([['t1', 4200]])),
    };
    const mod = await Test.createTestingModule({
      providers: [
        WatchService,
        { provide: WatchRepository, useValue: repo },
        { provide: TargetCalculatorService, useValue: { compute: jest.fn() } },
        { provide: StrikeSelectorService, useValue: { pick: jest.fn() } },
        { provide: MarketFeedService, useValue: {} },
        { provide: LevelBookService, useValue: { getLevels: jest.fn() } },
        { provide: WatchGateway, useValue: {} },
        { provide: TradeExecutionService, useValue: mockTrade },
      ],
    }).compile();
    const svc = mod.get(WatchService);

    const result = await svc.list({ status: undefined, date: '2026-05-15' });

    expect(repo.list).toHaveBeenCalledWith({ status: undefined, date: '2026-05-15' });
    expect(result[0]).toMatchObject({ id: 'w1', scannerName: 'Scanner X', realizedPnl: 4200 });
    expect(result[1]).toMatchObject({ id: 'w2', scannerName: null, realizedPnl: null });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/api && npx jest src/modules/watch-monitor/services/watch.service.spec.ts -t "enrichment"`
Expected: FAIL — `svc.list` is not a function.

- [ ] **Step 3: Implement** — add to `WatchService` (the class already injects `repo`):

```ts
  /**
   * List watch entries (optionally a single IST day) enriched with the
   * triggering Chartink scanner name and, for closed entries, the linked
   * trade's realized P/L.
   */
  async list(opts: { status?: WatchStatus; date?: string }): Promise<
    Array<WatchEntry & { scannerName: string | null; realizedPnl: number | null }>
  > {
    const entries = await this.repo.list(opts);
    const alertIds = entries
      .map((e) => e.alertId)
      .filter((x): x is string => !!x);
    const tradeIds = entries
      .map((e) => e.paperTradeId ?? e.liveTradeId)
      .filter((x): x is string => !!x);
    const [scannerNames, realizedPnls] = await Promise.all([
      this.repo.findScannerNames(alertIds),
      this.repo.findRealizedPnls(tradeIds),
    ]);
    return entries.map((e) => {
      const tradeId = e.paperTradeId ?? e.liveTradeId;
      return {
        ...e,
        scannerName: e.alertId ? scannerNames.get(e.alertId) ?? null : null,
        realizedPnl: tradeId ? realizedPnls.get(tradeId) ?? null : null,
      };
    });
  }
```

`WatchEntry` is already imported from `@prisma/client` at the top of the file.

- [ ] **Step 4: Run test to verify it passes**

Run: `cd apps/api && npx jest src/modules/watch-monitor/services/watch.service.spec.ts`
Expected: PASS (all).

- [ ] **Step 5: Checkpoint** — tests green.

---

### Task A4: `WatchController.list` accepts `date`

**Files:**
- Modify: `apps/api/src/modules/watch-monitor/controllers/watch.controller.ts`
- Test: `apps/api/src/modules/watch-monitor/controllers/watch.controller.spec.ts`

- [ ] **Step 1: Write the failing test** — append to `watch.controller.spec.ts`. The existing `beforeEach` builds a `watch` mock — add `list` to it. Add a new describe:

```ts
describe('WatchController.list', () => {
  let controller: WatchController;
  let watch: { list: jest.Mock };

  beforeEach(async () => {
    watch = { list: jest.fn().mockResolvedValue([]) };
    const mod = await Test.createTestingModule({
      controllers: [WatchController],
      providers: [
        { provide: WatchRepository, useValue: {} },
        { provide: WatchService, useValue: watch },
        { provide: RiskGuardService, useValue: {} },
      ],
    }).compile();
    controller = mod.get(WatchController);
  });

  it('delegates to WatchService.list with status and date', async () => {
    await controller.list('WATCHING', '2026-05-15');
    expect(watch.list).toHaveBeenCalledWith({ status: 'WATCHING', date: '2026-05-15' });
  });

  it('rejects a malformed date', async () => {
    await expect(controller.list(undefined, '15-05-2026')).rejects.toThrow();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/api && npx jest src/modules/watch-monitor/controllers/watch.controller.spec.ts -t "list"`
Expected: FAIL — `list` still calls `repo.list` / signature mismatch.

- [ ] **Step 3: Implement** — replace the `list` handler in `watch.controller.ts`:

```ts
  @Get()
  async list(
    @Query('status') status?: string,
    @Query('date') date?: string,
  ) {
    if (status && !(status in WatchStatus)) {
      throw new BadRequestException(`Invalid status: ${status}`);
    }
    if (date && !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      throw new BadRequestException(`Invalid date (expected YYYY-MM-DD): ${date}`);
    }
    return this.watch.list({
      status: status ? (status as WatchStatus) : undefined,
      date,
    });
  }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd apps/api && npx jest src/modules/watch-monitor/controllers/watch.controller.spec.ts`
Expected: PASS (all).

- [ ] **Step 5: Checkpoint** — run the whole watch-monitor backend suite: `cd apps/api && npx jest src/modules/watch-monitor` — all green.

---

## Track B — Frontend

### Task B1: `WatchEntry` type gains `scannerName` + `realizedPnl`

**Files:**
- Modify: `apps/web/src/types/watch.types.ts`

- [ ] **Step 1: Implement** — in the `WatchEntry` interface, add before `createdAt`:

```ts
  /** Chartink scanner that triggered this entry (server-enriched). */
  scannerName: string | null;
  /** Realized P/L of the linked trade once closed (server-enriched). */
  realizedPnl: number | null;
```

- [ ] **Step 2: Verify it compiles**

Run: `cd apps/web && npx tsc --noEmit`
Expected: PASS (no type errors).

- [ ] **Step 3: Checkpoint** — typecheck clean.

---

### Task B2: `watchApi.list` accepts `date`

**Files:**
- Modify: `apps/web/src/services/watch.service.ts`

- [ ] **Step 1: Implement** — replace the `list` method:

```ts
  async list(status?: WatchStatus, date?: string): Promise<WatchEntry[]> {
    const params = new URLSearchParams();
    if (status) params.set('status', status);
    if (date) params.set('date', date);
    return asJson(await fetch(`${API_BASE}/api/watch?${params.toString()}`));
  },
```

- [ ] **Step 2: Verify it compiles**

Run: `cd apps/web && npx tsc --noEmit`
Expected: PASS.

- [ ] **Step 3: Checkpoint** — typecheck clean.

---

### Task B3: `useWatchEntries` accepts `date`

**Files:**
- Modify: `apps/web/src/hooks/useWatchEntries.ts`

- [ ] **Step 1: Implement** — change the signature and the fetch call:

```ts
export function useWatchEntries(status?: WatchStatus, date?: string) {
```

In `refetch`, change the API call and the dependency array:

```ts
      const data = await watchApi.list(status, date);
```

```ts
  }, [status, date]);
```

(The `useEffect` blocks already depend on `refetch`, so no further change.)

- [ ] **Step 2: Verify it compiles**

Run: `cd apps/web && npx tsc --noEmit`
Expected: PASS.

- [ ] **Step 3: Checkpoint** — typecheck clean.

---

### Task B4: `watchPnl` util — extract `profitView`, add `sectionTotalPnl`

**Files:**
- Create: `apps/web/src/utils/watchPnl.ts`
- Create: `apps/web/src/utils/watchPnl.spec.ts`

- [ ] **Step 1: Write the failing test** — `apps/web/src/utils/watchPnl.spec.ts`:

```ts
import { sectionTotalPnl } from './watchPnl';
import type { WatchEntry } from '../types/watch.types';

function entry(o: Partial<WatchEntry>): WatchEntry {
  return {
    id: 'w', alertId: null, setupId: null, symbol: 'X', token: '1', exchange: 'NSE',
    side: 'BUY', initialPrice: 100, initialScore: 60, initialBreakdown: null,
    initialAt: '', profitTarget: 110, profitTargetSource: 'fallback-2pct',
    stopLossScore: 60, status: 'WATCHING', currentPrice: null, currentScore: null,
    maxFavorable: null, maxAdverse: null, lastTickAt: null, lastRescoreAt: null,
    optionsToken: null, optionsType: null, optionsExpiry: null, optionsStrike: null,
    optionsLotSize: null, optionsSelectionScore: null, paperTradeId: null,
    liveTradeId: null, executedAt: null, executedPrice: null, closedAt: null,
    closedReason: null, notes: null, partialExitedAt: null, partialExitPrice: null,
    partialQty: null, remainingQty: null, trailingHighWater: null,
    trailingStopPrice: null, scannerName: null, realizedPnl: null,
    createdAt: '', updatedAt: '', ...o,
  };
}

describe('sectionTotalPnl', () => {
  it('open entries contribute live price-based P/L', () => {
    // TRADED, executed @100, live 105, qty floor(200000/100)=2000 → +10,000
    const e = entry({ status: 'TRADED', executedPrice: 100, currentPrice: 105 });
    expect(sectionTotalPnl([e])).toBeCloseTo(10000, 0);
  });

  it('closed entries contribute realized pnl, not price estimate', () => {
    const e = entry({ status: 'TARGET_HIT', executedPrice: 100, currentPrice: 999, realizedPnl: 4200 });
    expect(sectionTotalPnl([e])).toBe(4200);
  });

  it('closed entry with no linked trade contributes 0', () => {
    const e = entry({ status: 'STOPPED', realizedPnl: null });
    expect(sectionTotalPnl([e])).toBe(0);
  });

  it('sums a mixed section', () => {
    const open = entry({ status: 'TRADED', executedPrice: 100, currentPrice: 105 }); // +10,000
    const closed = entry({ status: 'STOPPED', realizedPnl: -1500 });
    expect(sectionTotalPnl([open, closed])).toBeCloseTo(8500, 0);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/web && npx jest src/utils/watchPnl.spec.ts`
Expected: FAIL — `watchPnl.ts` does not exist.

- [ ] **Step 3: Implement** — `apps/web/src/utils/watchPnl.ts` (moves `profitView` verbatim out of `WatchTable.tsx`, adds `sectionTotalPnl`):

```ts
import type { WatchEntry } from '../types/watch.types';

/** Max ₹ deployed per trade — mirrors backend MAX_INVESTMENT_PER_TRADE.
 *  Per-row quantity is floor(this / referencePrice) so P&L scales with stock price. */
export const MAX_INVESTMENT_PER_TRADE = 200_000;

export interface ProfitView {
  abs: number;
  pct: number;
  ref: number;
  qty: number;
  hasLivePrice: boolean;
}

/**
 * Live price-based P/L for an open entry: currentPrice vs reference
 * (executedPrice for TRADED, initialPrice for WATCHING), side-adjusted,
 * × dynamic qty = floor(MAX_INVESTMENT_PER_TRADE / ref).
 */
export function profitView(entry: WatchEntry): ProfitView {
  const ref = entry.executedPrice ?? entry.initialPrice;
  const curr = entry.currentPrice ?? ref;
  const sideMul = entry.side === 'BUY' ? 1 : -1;
  const diff = (curr - ref) * sideMul;
  const qty = Math.max(1, Math.floor(MAX_INVESTMENT_PER_TRADE / Math.max(ref, 1)));
  return {
    abs: diff * qty,
    pct: ref > 0 ? (diff / ref) * 100 : 0,
    ref,
    qty,
    hasLivePrice: entry.currentPrice != null,
  };
}

const CLOSED: ReadonlyArray<string> = ['STOPPED', 'TARGET_HIT', 'EXITED', 'DISMISSED'];

export function isClosed(status: string): boolean {
  return CLOSED.includes(status);
}

/**
 * Section running total: open entries (WATCHING/TRADED) contribute live
 * price-based P/L; closed entries contribute their linked trade's realized
 * P/L (0 if the entry never executed).
 */
export function sectionTotalPnl(entries: WatchEntry[]): number {
  return entries.reduce((total, e) => {
    if (isClosed(e.status)) return total + (e.realizedPnl ?? 0);
    return total + profitView(e).abs;
  }, 0);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd apps/web && npx jest src/utils/watchPnl.spec.ts`
Expected: PASS (all 4).

- [ ] **Step 5: Checkpoint** — tests green.

---

### Task B5: `WatchTable` — Scanner column + closed-row realized P&L

**Files:**
- Modify: `apps/web/src/pages/watch/WatchTable.tsx`

- [ ] **Step 1: Implement** — at the top of `WatchTable.tsx`, replace the local `MAX_INVESTMENT_PER_TRADE` const and the local `profitView`/`ProfitView` definitions with an import:

```ts
import type { WatchEntry } from '../../types/watch.types';
import { profitView, isClosed } from '../../utils/watchPnl';
```

Delete the now-duplicated `MAX_INVESTMENT_PER_TRADE`, `interface ProfitView`, and `function profitView` from this file. Keep `pctChange`, `statusColor`, `profitColor`, `fmtRupees`.

- [ ] **Step 2: Add the Scanner column header** — in `<thead>`, insert immediately after the Symbol `<th>`:

```tsx
          <th className="py-2 px-3 text-left">Scanner</th>
```

- [ ] **Step 3: Add the Scanner column cell** — in `<tbody>`, insert immediately after the Symbol `<td>` (the one rendering `e.symbol`):

```tsx
              <td
                className="py-2 px-3 text-left text-[var(--color-text-secondary)] max-w-[160px] truncate"
                title={e.scannerName ?? undefined}
              >
                {e.scannerName ?? '—'}
              </td>
```

- [ ] **Step 4: Closed rows show realized P&L** — replace the P&L `<td>` and the P&L-% `<td>` cells. For a closed entry, show `e.realizedPnl`; for an open entry, keep the live `profitView`:

```tsx
              {isClosed(e.status) ? (
                <>
                  <td className={`py-2 px-3 text-right font-medium tabular-nums ${
                    e.realizedPnl == null ? 'text-[var(--color-text-muted)]'
                      : e.realizedPnl >= 0 ? 'text-emerald-400' : 'text-red-400'
                  }`}>
                    {e.realizedPnl == null ? '—' : fmtRupees(e.realizedPnl)}
                  </td>
                  <td className="py-2 px-3 text-right tabular-nums text-[var(--color-text-muted)]">
                    realized
                  </td>
                </>
              ) : (
                <>
                  <td
                    className={`py-2 px-3 text-right font-medium tabular-nums ${profitColor(p.abs, p.hasLivePrice)}`}
                    title={`${p.qty} shares @ ₹${p.ref.toFixed(2)} = ₹${(p.qty * p.ref).toFixed(0)} invested`}
                  >
                    {p.hasLivePrice ? fmtRupees(p.abs) : '—'}
                  </td>
                  <td className={`py-2 px-3 text-right tabular-nums ${profitColor(p.abs, p.hasLivePrice)}`}>
                    {p.hasLivePrice ? `${p.pct >= 0 ? '+' : ''}${p.pct.toFixed(2)}%` : '—'}
                  </td>
                </>
              )}
```

(The `const p = profitView(e);` line at the top of the `.map` callback stays — it is still used for open rows and the Qty/Price tooltips.)

- [ ] **Step 5: Verify it compiles**

Run: `cd apps/web && npx tsc --noEmit`
Expected: PASS.

- [ ] **Step 6: Checkpoint** — typecheck clean; the table renders a Scanner column and closed rows show realized P&L.

---

### Task B6: `WatchPage` — date picker + Total-P/L badge

**Files:**
- Modify: `apps/web/src/pages/watch/WatchPage.tsx`

- [ ] **Step 1: Implement the imports + state** — add imports:

```ts
import { sectionTotalPnl } from '../../utils/watchPnl';
```

Add a helper above the component for today's IST date, and `date` state inside the component:

```ts
/** Today's date as YYYY-MM-DD in IST (en-CA locale yields ISO format). */
function todayIST(): string {
  return new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
}
```

Inside `WatchPage`, add state and pass `date` to the hook:

```ts
  const [date, setDate] = useState<string>(todayIST());
  const { entries, loading, error } = useWatchEntries(filter, date);
```

- [ ] **Step 2: Add the date picker** — inside the filter-tabs row `<div className="flex gap-2 mb-4">`, after the `FILTERS.map(...)` buttons, add:

```tsx
        <input
          type="date"
          value={date}
          onChange={(e) => setDate(e.target.value)}
          className="ml-auto px-2 py-1 text-sm rounded bg-[var(--color-bg-tertiary)] text-[var(--color-text-secondary)]"
        />
```

- [ ] **Step 3: Add the Total-P/L badge** — replace the `!loading && !error && (...)` block's opening so the badge sits above the grid:

```tsx
      {!loading && !error && (
        <>
          {(() => {
            const total = sectionTotalPnl(entries);
            const isWatchingTab = filter === 'WATCHING';
            return (
              <div className="mb-3 text-sm">
                <span className="text-[var(--color-text-muted)]">
                  {isWatchingTab ? 'Total P/L (what-if): ' : 'Total P/L: '}
                </span>
                <span className={`font-semibold tabular-nums ${
                  total > 0 ? 'text-emerald-400' : total < 0 ? 'text-red-400' : 'text-[var(--color-text-secondary)]'
                }`}>
                  {total >= 0 ? '+' : ''}₹{Math.abs(total) < 1 ? total.toFixed(2) : total.toFixed(0)}
                </span>
              </div>
            );
          })()}
          <div className="grid grid-cols-3 gap-4">
```

Close the extra fragment: the existing block already ends with `</div>` after `WatchDetailPanel`'s wrapper — add `</>` before the `)}`:

```tsx
          </div>
        </>
      )}
```

- [ ] **Step 4: Verify it compiles**

Run: `cd apps/web && npx tsc --noEmit`
Expected: PASS.

- [ ] **Step 5: Checkpoint** — typecheck clean; the page shows a date picker (default today) and a Total-P/L badge per section.

---

## Track C — Integration verification

### Task C1: End-to-end verification

**Files:** none (verification only).

- [ ] **Step 1: Run the full affected backend suite**

Run: `cd apps/api && npx jest src/modules/watch-monitor src/modules/trade-engine`
Expected: PASS (all).

- [ ] **Step 2: Run the frontend tests + typecheck**

Run: `cd apps/web && npx jest src/utils/watchPnl.spec.ts && npx tsc --noEmit`
Expected: PASS.

- [ ] **Step 3: Manual smoke test** — with the dev server running:

```bash
curl "http://localhost:4001/api/watch?date=2026-05-15" | head -c 600
```

Expected: JSON array; each entry includes `scannerName` and `realizedPnl` keys. Confirm `GET /api/watch?date=2099-01-01` returns `[]` and `?date=bad` returns HTTP 400.

- [ ] **Step 4: Browser check** — open `http://localhost:4000`, Watch Monitor page:
  - Date picker defaults to today; switching dates re-filters every tab.
  - A "Total P/L" badge appears above the table (labelled "(what-if)" on the Watching tab).
  - The table has a "Scanner" column; closed rows show realized P&L labelled "realized".

- [ ] **Step 5: Checkpoint** — all tests green, smoke test passes.

---

## Self-Review Notes

- **Spec coverage:** Feature 1 (total P/L) → B4 + B6 + A3; Feature 2 (scanner column) → A2 + A3 + B5; Feature 3 (date filter) → A1 + A4 + B2 + B3 + B6. All covered.
- **Type consistency:** `scannerName`/`realizedPnl` defined in B1, produced in A3, consumed in B4/B5. `profitView`/`sectionTotalPnl`/`isClosed` defined in B4, consumed in B5/B6. `istDayRange` defined + exported in A1.
- **Parallelism:** Track A and Track B share only the API contract (declared above) — no shared files — so they are safe to run concurrently. Track C runs after both.
