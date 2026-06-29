# Per-Factor Score Breakdown on Rejected Trades — Design Spec

**Date:** 2026-05-20
**Status:** Approved (design)
**Branch:** `feature/rejection-score-breakdown`

## Problem

The `/signals/rejections` tab in `apps/web/src/pages/signals/RejectionsTab.tsx` shows why Chartink-scanned stocks didn't become trades — a table of Time / Symbol / Scanner / Kind / Reason / Score. The total **Score** column tells you a `scored-low` row missed the 60 floor, but **not which parameters failed**. The factor-level data (`scoreBreakdown` — an array of `{ name, points, pointsPossible, passed }`) is already persisted on every `ChartinkSetup` row by `ChartinkProcessService.processOne`, and the `/watch` table already renders it for accepted setups via 10 small factor cells (Idx · Sect · RS · EMA · ST · M1d · M5m · M1m · S/R · Vol).

The rejections endpoint just doesn't pass that data through, and the rejections table doesn't render it.

## Requirements

**R1 — Backend exposes the per-row breakdown.** `GET /api/chartink/rejections` returns each `RejectionRow` with a `scoreBreakdown` field — the array of `{name, points, pointsPossible, passed}` checks — when scoring ran (so for `scored-low` and any other kind that reached scoring). For kinds where scoring never ran (`unresolved`, `no-direction`, `error`), `scoreBreakdown` is `null`.

**R2 — Frontend type mirrors.** `RejectionRow` in `apps/web/src/services/chartink.ts` gains the same optional field.

**R3 — Ten factor mini-cells in the rejections table.** After the existing **Score** column, the table renders ten compact cells in the order used by `WatchTable.tsx`: `Idx · Sect · RS · EMA · ST · M1d · M5m · M1m · S/R · Vol`. Each cell shows the obtained `points` value for that factor, colour-coded green when `passed` is `true` and red otherwise. A muted `·` is shown when the factor is missing from the row's breakdown (e.g. an `unresolved` row, where `scoreBreakdown` is `null` — every cell renders `·`). Tooltip on each numeric cell: `<factor name> — <points>/<pointsPossible>`.

**R4 — Same factor order in both tables.** The watch table and the rejections table read the column list from one shared source so the visual mapping is preserved if either list changes later.

## Design

### Backend — `apps/api/src/modules/chartink/services/chartink-rejections.service.ts`

Extend the backend `RejectionRow` interface:

```ts
export interface RejectionRow {
  id: string;
  processedAt: string;
  symbol: string;
  scanner: string;
  kind: string;
  reason: string;
  score: number | null;
  hitPrice: number;
  scoreBreakdown: Array<{ name: string; points: number; pointsPossible: number; passed: boolean }> | null;
}
```

`ChartinkRepository.findAlertSetupsInRange` already returns the JSON `scoreBreakdown` column. The mapping in `ChartinkRejectionsService.getRejections` currently drops it; pass it through verbatim, with one normalisation rule:

- If the column is missing or not an array → emit `null`.
- Otherwise → emit the array unchanged.

No new repo query, no new DB column, no migration.

### Frontend — `apps/web/src/services/chartink.ts`

Add the identical optional field to the frontend `RejectionRow`:

```ts
export interface RejectionRow {
  // …existing fields…
  scoreBreakdown: Array<{ name: string; points: number; pointsPossible: number; passed: boolean }> | null;
}
```

### Frontend — extract `FACTOR_COLUMNS` to a shared module

The constant currently lives as a non-exported `const FACTOR_COLUMNS` in `apps/web/src/pages/watch/WatchTable.tsx`. Move it to a new shared file **`apps/web/src/utils/factorColumns.ts`**:

```ts
/** The 10 scoring factors, in fixed display order. The watch and rejections
 *  tables both read from this list so they always agree visually. */
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

`WatchTable.tsx` imports from there instead of declaring locally — the JSX is unchanged.

### Frontend — `apps/web/src/pages/signals/RejectionsTab.tsx`

Add a small pure helper next to the existing exports:

```ts
/** Find the points record for a named factor in a row's scoreBreakdown.
 *  Returns null when the breakdown is absent or the factor isn't present. */
export function factorPoints(
  breakdown: RejectionRow['scoreBreakdown'],
  factorName: string,
): { points: number; pointsPossible: number; passed: boolean } | null {
  if (!breakdown) return null;
  const c = breakdown.find((x) => x.name === factorName);
  return c ? { points: c.points, pointsPossible: c.pointsPossible, passed: c.passed } : null;
}
```

In `RejectionsTable`:

- After the existing `<th>Score</th>`, render ten more `<th>` cells using `FACTOR_COLUMNS` — same compact `text-[10px]/tabular` styling the watch table uses.
- After the existing per-row Score `<td>`, render ten cells. For each factor: look up its points via `factorPoints(r.scoreBreakdown, factor.name)`:
  - `null` → muted `·` in `text-gray-500`.
  - hit → the `points` number; `text-emerald-300` when `passed`, `text-red-300` otherwise. Tooltip `${factor.name} — ${points}/${pointsPossible}`.

The cell is `text-center` and a fixed narrow column, matching the watch table's factor cells.

## Files

- **Modify:** `apps/api/src/modules/chartink/services/chartink-rejections.service.ts` (+ its spec)
- **Modify:** `apps/web/src/services/chartink.ts` — extend the `RejectionRow` type.
- **Create:** `apps/web/src/utils/factorColumns.ts` — the shared factor list.
- **Modify:** `apps/web/src/pages/watch/WatchTable.tsx` — drop the local `FACTOR_COLUMNS`, import from the new module.
- **Modify:** `apps/web/src/pages/signals/RejectionsTab.tsx` — `factorPoints` helper + 10 new `<th>` and `<td>` cells.
- **Modify:** `apps/web/src/pages/signals/RejectionsTab.spec.ts` — unit-test `factorPoints`.

## Edge cases

- `scoreBreakdown == null` (unresolved / no-direction / error rows) → every factor cell renders `·`.
- A factor present in `FACTOR_COLUMNS` but missing from a row's `scoreBreakdown` (e.g. scoring threw partway) → `·` for just that cell.
- A check with `passed === false` and a non-zero `points` (partial credit) → renders in red with the partial number. The tooltip shows the partial fraction.
- A check with `pointsPossible === 0` (defensive; shouldn't occur) → still rendered as `<points>` with the tooltip showing `0/0`.

## Testing

- **Backend** — `chartink-rejections.service.spec.ts`: add a test that the mapped rejection row carries `scoreBreakdown` verbatim from the repo row; add a test that an `unresolved` row's missing/null `scoreBreakdown` becomes `null` on the output.
- **Frontend** — `RejectionsTab.spec.ts`: unit-test `factorPoints` — happy path (returns the matched check), unknown factor (`null`), null breakdown (`null`).
- **Frontend** — `factorColumns.ts`: no dedicated tests needed (a plain `const`). The fact that `WatchTable.tsx` imports the same list is covered by its existing render path.

## Risk

- **Cross-import.** The new `utils/factorColumns.ts` is consumed by two pages. That's the right shape — the data is shared by design. The only concern is bundle layering; the list is ~10 plain objects, no risk.
- **Type drift.** The backend and frontend `RejectionRow` types are duplicated (already true today). Both must add the same field; the type spec test on the backend pins the shape.

## Out of scope

- No new endpoint and no schema change — the persisted JSON column already holds the breakdown.
- No change to the accepted-setup display in `WatchTable.tsx` (its existing ✓/✗ factor cells via `breakdownChecks` are unchanged — only the source of `FACTOR_COLUMNS` moves).
- No new server-side filter / sort by individual factor scores — out of scope unless requested.
