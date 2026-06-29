# Per-Factor Score Breakdown on Rejected Trades Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Surface the per-parameter `scoreBreakdown` (already persisted on every `ChartinkAlertSetup` row) on each rejection row, and render it as 10 small factor cells in the `/signals/rejections` table — same factor order the watch table already uses for accepted setups.

**Architecture:** No schema change, no new endpoint. Backend's `ChartinkRejectionsService` already gets `scoreBreakdown` from the repo's Prisma query — just forward it on each `RejectionRow`. Frontend mirrors the type, extracts the watch table's `FACTOR_COLUMNS` to a shared util so both pages agree, and the rejections table renders the 10 factor cells via a tiny `<FactorScoreCell>` and a `factorPoints` helper.

**Tech Stack:** NestJS + Jest (API), React + Vite + vitest (web). Spec: `docs/superpowers/specs/2026-05-20-rejection-score-breakdown-design.md`.

---

## File Structure

- **Modify** `apps/api/src/modules/chartink/services/chartink-rejections.service.ts` — extend `RejectionRow` with `scoreBreakdown`; forward the field from the repo row.
- **Modify** `apps/api/src/modules/chartink/services/chartink-rejections.service.spec.ts` — extend the existing fixture/assertions; add a defensive-mapping test.
- **Create** `apps/web/src/utils/factorColumns.ts` — the shared 10-factor list.
- **Modify** `apps/web/src/pages/watch/WatchTable.tsx` — import `FACTOR_COLUMNS` from the new util (drop the local declaration).
- **Modify** `apps/web/src/services/chartink.ts` — add `scoreBreakdown` to the frontend `RejectionRow`.
- **Modify** `apps/web/src/pages/signals/RejectionsTab.tsx` — export a small `factorPoints` helper; add a `<FactorScoreCell>` and 10 `<th>` / `<td>` cells.
- **Modify** `apps/web/src/pages/signals/RejectionsTab.spec.ts` — unit-test `factorPoints`.

**Implementation order:** backend → factor list extraction → frontend type → frontend helper+tests → table render → verify. Each task is independently committable.

---

### Task 1: Backend — `scoreBreakdown` on `RejectionRow`

**Files:**
- Modify: `apps/api/src/modules/chartink/services/chartink-rejections.service.ts`
- Test: `apps/api/src/modules/chartink/services/chartink-rejections.service.spec.ts`

The repo's `findAlertSetupsInRange` already returns the `scoreBreakdown` JSON column on every row (default Prisma `findMany` returns all scalar columns). The service currently drops it during the `.map(...)` to `RejectionRow`. Forward it, treating any non-array value as `null`.

- [ ] **Step 1: Update the test fixture + add the failing assertions**

In `apps/api/src/modules/chartink/services/chartink-rejections.service.spec.ts`:

a) Add a `scoreBreakdown` field to the `r3` fixture (the `scored-low` INFY row). Change the existing row from:

```typescript
    {
      id: 'r3',
      processedAt: new Date('2026-05-18T05:00:00.000Z'),
      symbol: 'INFY',
      kind: 'scored-low',
      rejectReason: 'score below threshold',
      score: 42,
      hitPrice: 1500.5,
      alert: { scanner: { scanName: 'Breakout Scan' } },
    },
```

to:

```typescript
    {
      id: 'r3',
      processedAt: new Date('2026-05-18T05:00:00.000Z'),
      symbol: 'INFY',
      kind: 'scored-low',
      rejectReason: 'score below threshold',
      score: 42,
      hitPrice: 1500.5,
      alert: { scanner: { scanName: 'Breakout Scan' } },
      scoreBreakdown: [
        { name: 'Sector aligned', points: 8, pointsPossible: 10, passed: true },
        { name: 'MACD on 1d', points: 6, pointsPossible: 8, passed: true },
        { name: 'MACD on 5m', points: 0, pointsPossible: 8, passed: false },
      ],
    },
```

b) Update the `toEqual` in the `maps rejection rows to the contract shape, processedAt DESC` test (around line 92) to include the new field. Replace the existing block:

```typescript
      expect(res.rejections[0]).toEqual({
        id: 'r3',
        processedAt: '2026-05-18T05:00:00.000Z',
        symbol: 'INFY',
        scanner: 'Breakout Scan',
        kind: 'scored-low',
        reason: 'score below threshold',
        score: 42,
        hitPrice: 1500.5,
      });
```

with:

```typescript
      expect(res.rejections[0]).toEqual({
        id: 'r3',
        processedAt: '2026-05-18T05:00:00.000Z',
        symbol: 'INFY',
        scanner: 'Breakout Scan',
        kind: 'scored-low',
        reason: 'score below threshold',
        score: 42,
        hitPrice: 1500.5,
        scoreBreakdown: [
          { name: 'Sector aligned', points: 8, pointsPossible: 10, passed: true },
          { name: 'MACD on 1d', points: 6, pointsPossible: 8, passed: true },
          { name: 'MACD on 5m', points: 0, pointsPossible: 8, passed: false },
        ],
      });
```

c) In the `defaults missing scanner and reason to empty string` test (around line 104), extend the `r1` assertion to also check `scoreBreakdown` is `null` (the `r1` fixture has no `scoreBreakdown` field). Append a line after the existing `expect(r1.scanner).toBe('');`:

```typescript
      expect(r1.scoreBreakdown).toBeNull();
```

d) Add a new test immediately after the `excludes setup rows from the rejections list` test, inside the same `describe('getRejections aggregation', ...)` block:

```typescript
    it('maps a non-array scoreBreakdown to null (defensive — corrupted JSON)', async () => {
      mockRepo.findAlertSetupsInRange.mockResolvedValue([
        {
          id: 'rx',
          processedAt: new Date('2026-05-18T07:00:00.000Z'),
          symbol: 'BEL',
          kind: 'error',
          rejectReason: 'indicator crash',
          score: null,
          hitPrice: 429.13,
          alert: { scanner: { scanName: 'X' } },
          scoreBreakdown: 'oops-not-an-array',
        },
      ]);
      const res = await service.getRejections({});
      expect(res.rejections[0].scoreBreakdown).toBeNull();
    });
```

- [ ] **Step 2: Run the tests, verify they fail**

Run: `cd apps/api && npx jest src/modules/chartink/services/chartink-rejections.service.spec.ts`
Expected: FAIL — the `toEqual` block now expects a `scoreBreakdown` field the service doesn't return.

- [ ] **Step 3: Extend the service**

In `apps/api/src/modules/chartink/services/chartink-rejections.service.ts`, add the score-check type just above `RejectionRow` and extend the interface, then forward the value in `.map(...)`. Replace the existing `RejectionRow` and the `.map(...)` block.

Replace:

```typescript
export interface RejectionRow {
  id: string;
  processedAt: string;
  symbol: string;
  scanner: string;
  kind: string;
  reason: string;
  score: number | null;
  hitPrice: number;
}
```

with:

```typescript
export interface RejectionScoreCheck {
  name: string;
  points: number;
  pointsPossible: number;
  passed: boolean;
}

export interface RejectionRow {
  id: string;
  processedAt: string;
  symbol: string;
  scanner: string;
  kind: string;
  reason: string;
  score: number | null;
  hitPrice: number;
  scoreBreakdown: RejectionScoreCheck[] | null;
}
```

And replace the existing `.map((r) => ({...}))` block (around lines 86–96):

```typescript
      .map((r) => ({
        id: r.id,
        processedAt: r.processedAt.toISOString(),
        symbol: r.symbol,
        scanner: r.alert?.scanner?.scanName ?? '',
        kind: r.kind,
        reason: r.rejectReason ?? '',
        score: r.score ?? null,
        hitPrice: r.hitPrice,
      }));
```

with:

```typescript
      .map((r) => ({
        id: r.id,
        processedAt: r.processedAt.toISOString(),
        symbol: r.symbol,
        scanner: r.alert?.scanner?.scanName ?? '',
        kind: r.kind,
        reason: r.rejectReason ?? '',
        score: r.score ?? null,
        hitPrice: r.hitPrice,
        // Forward the persisted breakdown verbatim. The column is `Json?` in
        // Prisma — when it isn't an array (missing or a corrupted scalar) we
        // emit null so the frontend's per-factor renderer can fall back to "·".
        scoreBreakdown: Array.isArray(r.scoreBreakdown)
          ? (r.scoreBreakdown as RejectionScoreCheck[])
          : null,
      }));
```

- [ ] **Step 4: Run the tests, verify they pass**

Run: `cd apps/api && npx jest src/modules/chartink/services/chartink-rejections.service.spec.ts`
Expected: PASS — every test green.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/modules/chartink/services/chartink-rejections.service.ts apps/api/src/modules/chartink/services/chartink-rejections.service.spec.ts
git commit -m "feat(chartink): expose scoreBreakdown on each rejection row"
```

---

### Task 2: Extract `FACTOR_COLUMNS` to a shared util

**Files:**
- Create: `apps/web/src/utils/factorColumns.ts`
- Modify: `apps/web/src/pages/watch/WatchTable.tsx`

No behaviour change here — just a move. The watch and rejections tables will share one list.

- [ ] **Step 1: Create the shared module**

Create `apps/web/src/utils/factorColumns.ts`:

```typescript
/**
 * The 10 ChartinkScoringService scoring factors, in fixed display order.
 * The /watch table (`WatchTable.tsx`) and the /signals/rejections table
 * (`RejectionsTab.tsx`) both read from this single list so the two views
 * always agree visually. Edit here, not in either page.
 */
export const FACTOR_COLUMNS: ReadonlyArray<{ name: string; short: string }> = [
  { name: 'Index aligned',        short: 'Idx'  },
  { name: 'Sector aligned',       short: 'Sect' },
  { name: 'Relative strength',    short: 'RS'   },
  { name: 'Price vs 20-EMA',      short: 'EMA'  },
  { name: 'SuperTrend match',     short: 'ST'   },
  { name: 'MACD on 1d',           short: 'M1d'  },
  { name: 'MACD on 5m',           short: 'M5m'  },
  { name: 'MACD on 1m',           short: 'M1m'  },
  { name: 'S/R room',             short: 'S/R'  },
  { name: 'Volume confirmation',  short: 'Vol'  },
];
```

- [ ] **Step 2: Re-point `WatchTable.tsx` to the shared list**

In `apps/web/src/pages/watch/WatchTable.tsx`:

a) Add a new import near the existing imports at the top:

```typescript
import { FACTOR_COLUMNS } from '../../utils/factorColumns';
```

b) Delete the local declaration (the existing block, around lines 52–64):

```typescript
/** The 10 scoring factors, in fixed column order (short header → full name). */
const FACTOR_COLUMNS: ReadonlyArray<{ name: string; short: string }> = [
  { name: 'Index aligned', short: 'Idx' },
  { name: 'Sector aligned', short: 'Sect' },
  { name: 'Relative strength', short: 'RS' },
  { name: 'Price vs 20-EMA', short: 'EMA' },
  { name: 'SuperTrend match', short: 'ST' },
  { name: 'MACD on 1d', short: 'M1d' },
  { name: 'MACD on 5m', short: 'M5m' },
  { name: 'MACD on 1m', short: 'M1m' },
  { name: 'S/R room', short: 'S/R' },
  { name: 'Volume confirmation', short: 'Vol' },
];
```

`FACTOR_STATE_CLASS` and all other helpers stay where they are.

- [ ] **Step 3: Type-check + tests**

Run: `cd apps/web && npx tsc -b` — no NEW errors in `WatchTable.tsx` (ignore the pre-existing errors in `SignalCard.tsx`/`useChartData.ts`/`ChartsPage.tsx`/`signal-store.ts`).
Run: `cd apps/web && npx vitest run` — all green (no test asserts on the local-vs-shared FACTOR_COLUMNS location; rendering is unchanged).

- [ ] **Step 4: Commit**

```bash
git add apps/web/src/utils/factorColumns.ts apps/web/src/pages/watch/WatchTable.tsx
git commit -m "refactor(web): extract FACTOR_COLUMNS to a shared util"
```

---

### Task 3: Frontend — `RejectionRow` type + `factorPoints` helper + tests

**Files:**
- Modify: `apps/web/src/services/chartink.ts`
- Modify: `apps/web/src/pages/signals/RejectionsTab.tsx`
- Test: `apps/web/src/pages/signals/RejectionsTab.spec.ts`

- [ ] **Step 1: Write the failing test for `factorPoints`**

Append to `apps/web/src/pages/signals/RejectionsTab.spec.ts` (the file currently imports `buildKindBreakdown, acceptanceRate` — extend the import to include `factorPoints`, then add a new describe block at the end):

a) Update the import on line 2:

```typescript
import { buildKindBreakdown, acceptanceRate, factorPoints } from './RejectionsTab';
```

b) Append after the `acceptanceRate` block:

```typescript
describe('factorPoints', () => {
  const breakdown = [
    { name: 'Sector aligned', points: 8, pointsPossible: 10, passed: true },
    { name: 'MACD on 5m', points: 0, pointsPossible: 8, passed: false },
  ];

  it('returns the matching check looked up by factor name', () => {
    expect(factorPoints(breakdown, 'Sector aligned')).toEqual({
      points: 8,
      pointsPossible: 10,
      passed: true,
    });
  });

  it('returns null when the factor is not present in the breakdown', () => {
    expect(factorPoints(breakdown, 'Index aligned')).toBeNull();
  });

  it('returns null when the entire breakdown is null', () => {
    expect(factorPoints(null, 'Sector aligned')).toBeNull();
  });
});
```

- [ ] **Step 2: Run the test, verify it fails**

Run: `cd apps/web && npx vitest run src/pages/signals/RejectionsTab.spec.ts`
Expected: FAIL — `factorPoints` is not exported from `./RejectionsTab`.

- [ ] **Step 3: Add `scoreBreakdown` to the frontend `RejectionRow` type**

In `apps/web/src/services/chartink.ts`, extend the interface. Replace:

```typescript
export interface RejectionRow {
  id: string;
  processedAt: string; // ISO
  symbol: string;
  scanner: string;
  kind: string;
  reason: string;
  score: number | null;
  hitPrice: number;
}
```

with:

```typescript
export interface RejectionScoreCheck {
  name: string;
  points: number;
  pointsPossible: number;
  passed: boolean;
}

export interface RejectionRow {
  id: string;
  processedAt: string; // ISO
  symbol: string;
  scanner: string;
  kind: string;
  reason: string;
  score: number | null;
  hitPrice: number;
  /** Per-factor scoring detail when scoring ran; null for kinds like
   *  `unresolved`, `no-direction`, `error` where scoring never executed. */
  scoreBreakdown: RejectionScoreCheck[] | null;
}
```

- [ ] **Step 4: Add `factorPoints` to `RejectionsTab.tsx`**

In `apps/web/src/pages/signals/RejectionsTab.tsx`:

a) Extend the existing type import on line 5 — add `RejectionScoreCheck` to the type-only import (and keep the existing names):

```typescript
import type {
  RejectionKindCount,
  RejectionRow,
  RejectionScoreCheck,
  RejectionSummary,
} from '@/services/chartink';
```

b) Add the helper right after `acceptanceRate` (after the existing `// --- Pure helpers ...` section), so it sits next to its siblings:

```typescript
/**
 * Look up the matching check in a rejection row's per-factor breakdown.
 * Returns null when the row had no breakdown (scoring never ran) or the
 * factor isn't in the row — the cell renderer falls back to "·" then.
 */
export function factorPoints(
  breakdown: RejectionRow['scoreBreakdown'],
  factorName: string,
): { points: number; pointsPossible: number; passed: boolean } | null {
  if (!breakdown) return null;
  const c = breakdown.find((x) => x.name === factorName);
  return c
    ? { points: c.points, pointsPossible: c.pointsPossible, passed: c.passed }
    : null;
}
```

(The unused `RejectionScoreCheck` import will become used in Task 4 when the cell is added — leave it imported.)

- [ ] **Step 5: Run the tests, verify they pass**

Run: `cd apps/web && npx vitest run src/pages/signals/RejectionsTab.spec.ts`
Expected: PASS — all `factorPoints` tests + the existing `buildKindBreakdown` / `acceptanceRate` tests.

- [ ] **Step 6: Commit**

```bash
git add apps/web/src/services/chartink.ts apps/web/src/pages/signals/RejectionsTab.tsx apps/web/src/pages/signals/RejectionsTab.spec.ts
git commit -m "feat(web): RejectionRow.scoreBreakdown type + factorPoints helper"
```

---

### Task 4: Render 10 factor cells in `RejectionsTable`

**Files:**
- Modify: `apps/web/src/pages/signals/RejectionsTab.tsx`

- [ ] **Step 1: Import the shared factor list**

In `apps/web/src/pages/signals/RejectionsTab.tsx`, add to the existing import block near the top:

```typescript
import { FACTOR_COLUMNS } from '@/utils/factorColumns';
```

- [ ] **Step 2: Add the `<FactorScoreCell>` component**

Add this small subcomponent immediately above the existing `function RejectionsTable(...)` definition:

```typescript
/**
 * One factor cell on a rejection row. Shows the obtained `points` value
 * (green when `passed`, red otherwise) with a `factor — points/possible`
 * tooltip; a muted "·" when the row has no breakdown OR the factor is
 * absent from it (e.g. unresolved / no-direction / error kinds).
 */
function FactorScoreCell({
  factor,
  breakdown,
}: {
  factor: { name: string };
  breakdown: RejectionRow['scoreBreakdown'];
}) {
  const pts = factorPoints(breakdown, factor.name);
  if (!pts) {
    return (
      <td className="px-2 py-2 text-center tabular-nums">
        <span className="text-gray-500">·</span>
      </td>
    );
  }
  return (
    <td
      className="px-2 py-2 text-center tabular-nums"
      title={`${factor.name} — ${pts.points}/${pts.pointsPossible}`}
    >
      <span className={pts.passed ? 'text-emerald-300' : 'text-red-300'}>
        {pts.points}
      </span>
    </td>
  );
}
```

- [ ] **Step 3: Add the 10 `<th>` headers**

In the `RejectionsTable` `<thead>`, replace this block:

```typescript
        <thead className="bg-gray-800/60 text-left text-[11px] uppercase tracking-wider text-gray-500">
          <tr>
            <th className="px-3 py-2">Time</th>
            <th className="px-3 py-2">Symbol</th>
            <th className="px-3 py-2">Scanner</th>
            <th className="px-3 py-2">Kind</th>
            <th className="px-3 py-2">Reason</th>
            <th className="px-3 py-2 text-right">Score</th>
          </tr>
        </thead>
```

with:

```typescript
        <thead className="bg-gray-800/60 text-left text-[11px] uppercase tracking-wider text-gray-500">
          <tr>
            <th className="px-3 py-2">Time</th>
            <th className="px-3 py-2">Symbol</th>
            <th className="px-3 py-2">Scanner</th>
            <th className="px-3 py-2">Kind</th>
            <th className="px-3 py-2">Reason</th>
            <th className="px-3 py-2 text-right">Score</th>
            {FACTOR_COLUMNS.map((f) => (
              <th
                key={f.name}
                className="px-2 py-2 text-center font-medium"
                title={f.name}
              >
                {f.short}
              </th>
            ))}
          </tr>
        </thead>
```

- [ ] **Step 4: Add the 10 `<td>` cells per row**

Inside the existing `rows.map((r) => (...))` block, after the last existing `<td>` (the `Score` cell), append the factor cells. Replace the existing trailing block of the row:

```typescript
              <td className="px-3 py-2 text-right tabular-nums text-gray-300">
                {r.score ?? '—'}
              </td>
            </tr>
          ))}
```

with:

```typescript
              <td className="px-3 py-2 text-right tabular-nums text-gray-300">
                {r.score ?? '—'}
              </td>
              {FACTOR_COLUMNS.map((f) => (
                <FactorScoreCell key={f.name} factor={f} breakdown={r.scoreBreakdown} />
              ))}
            </tr>
          ))}
```

- [ ] **Step 5: Type-check + tests**

Run: `cd apps/web && npx tsc -b` — no NEW errors in `RejectionsTab.tsx`.
Run: `cd apps/web && npx vitest run` — all green.

- [ ] **Step 6: Visual smoke check**

Vite hot-reloads. Open `http://localhost:4000` → `Signals` → `Rejections` tab → pick yesterday's date (`2026-05-19`). Confirm:
- The header row shows `… · Score · Idx · Sect · RS · EMA · ST · M1d · M5m · M1m · S/R · Vol`.
- A `scored-low` row (e.g. MICEL / BCG / UFBL from today, or any from yesterday) shows numbers in the 10 cells — some green, some red.
- An `unresolved` row shows `·` across all 10 cells.

- [ ] **Step 7: Commit**

```bash
git add apps/web/src/pages/signals/RejectionsTab.tsx
git commit -m "feat(web): 10 factor cells per rejection row in RejectionsTable"
```

---

### Task 5: Full verification

- [ ] **Step 1: Run both test suites**

Run:
```
cd apps/api && npx jest src/modules/chartink
cd apps/web && npx vitest run
```
Expected: API chartink tests all green; web 14 files / ~134 tests all green (was 131 + 3 new `factorPoints` tests + 1 new backend test under the api spec → web grew by 3, api spec grew by 1).

- [ ] **Step 2: Type-check**

Run: `cd apps/web && npx tsc -b` — no NEW errors in `factorColumns.ts`, `WatchTable.tsx`, `chartink.ts`, `RejectionsTab.tsx`. Pre-existing errors in `SignalCard.tsx` / `useChartData.ts` / `ChartsPage.tsx` / `signal-store.ts` — ignore.

- [ ] **Step 3: API restart (so the new mapped field reaches the wire)**

The API runs `dist/main`. After this task lands, rebuild:
```
cd apps/api && npm run build
```
The existing supervisor (PID 32204 family from earlier) will respawn `node dist/main` against the fresh `dist`. Verify `:4001` is still serving with `curl -s -m 5 -o /dev/null -w "%{http_code}\n" http://127.0.0.1:4001/api/trades/paper-account` → expect `200`. If a respawn doesn't happen automatically, stop the live API process and run `npm run start` in the background.

- [ ] **Step 4: End-to-end check**

```
curl -s "http://127.0.0.1:4001/api/chartink/rejections?from=2026-05-19T00:00:00.000Z&to=2026-05-19T23:59:59.999Z&limit=5"
```
Expected: each `rejections[i]` object has a `scoreBreakdown` field — an array for scored kinds, `null` for unresolved/no-direction/error.

- [ ] **Step 5: Commit any test-expectation adjustments**

```bash
git status
# commit any final tweaks if needed
```

---

## Notes for the implementer

- The repo's `findAlertSetupsInRange` already returns the `scoreBreakdown` column (default Prisma `findMany` returns all scalar columns). No repo change is needed.
- The `RejectionScoreCheck` shape is identical on backend and frontend — duplication is acceptable for this small interface; centralising it via `@td/shared` would be over-engineering for two files.
- Keep `RejectionsTab.tsx` style with its existing Tailwind palette (`text-gray-…`, `text-emerald-…`, `text-red-…`) — don't drift to the watch table's `var(--color-…)` tokens; the two pages use different palettes.
- The visual smoke check in Task 4 assumes Vite HMR is running. If it isn't, restart the web dev server (`npm run dev:web`).
