# Watch Monitor — Section P/L Totals, Scanner Column, Date Filter

> Design spec | 2026-05-15

## 1. Goal

Three additions to the Watch Monitor page (`apps/web/src/pages/watch/`), each applying
across all five section tabs — **All, Watching, Traded, Stopped, Target Hit**:

1. **Section Total P/L** — a live running profit/loss total for the currently-listed entries.
2. **Scanner column** — show which Chartink scanner triggered each entry.
3. **Date filter** — view entries for a single day; defaults to the current date.

## 2. Current State

- `WatchPage.tsx` — status-filter tabs, `useWatchEntries(filter)` hook, renders `WatchTable` + `WatchDetailPanel`.
- `WatchTable.tsx` — table with a per-row running P&L (`profitView`: `currentPrice` vs reference price, side-adjusted, × dynamic qty).
- `GET /api/watch?status=&limit=` → `WatchController.list` → `WatchRepository.list` (`orderBy createdAt desc`, `take 50`).
- Data model:
  - `WatchEntry` — loose `String` refs `alertId`, `paperTradeId`, `liveTradeId` (NOT Prisma `@relation`s — intentional, keeps Chartink/trade lifecycles decoupled).
  - `ChartinkAlert.scannerId` → `ChartinkScanner.scanName`.
  - `Trade.pnl` — realized P/L, populated when the trade is closed.

## 3. Approach

**Read-time enrichment, no schema migration.** The watch list endpoint enriches each
entry on read. The alternative (denormalize `scannerName` onto `WatchEntry` via a
migration + backfill) adds write-path complexity and a migration for no real benefit on
a low-traffic monitoring page.

## 4. Feature 1 — Section Total P/L

A badge rendered above the table, showing the summed P/L of the entries currently listed.

Per-entry contribution:

| Entry status | Contribution |
|--------------|--------------|
| `WATCHING`, `TRADED` (open) | live price-based P/L — the existing `profitView(entry).abs` |
| `STOPPED`, `TARGET_HIT`, `EXITED` (closed) | the linked trade's realized `pnl` (`realizedPnl`) |
| closed but never executed (no linked trade) | `0` |

- Total is formatted `₹` and coloured green (≥ 0) / red (< 0).
- Recomputes on every WebSocket-driven refetch — genuinely live for open entries.
- In the **Watching** section the badge is labelled **"Total P/L (what-if)"** — those
  entries are not real trades, so the figure is hypothetical.
- In **All**, each row contributes per its own status using the table above.

## 5. Feature 2 — Scanner Column

- New **"Scanner"** column in `WatchTable`, placed immediately after **Symbol**.
- Value: `scannerName`, resolved server-side: `alertId` → `chartink_alerts.scannerId` → `chartink_scanners.scanName` (e.g. `"Anand Superbullish scanner May26"`).
- `null` (no `alertId`, or scanner not found) → renders `"—"`.
- Scanner names are long → cell truncates with ellipsis; full name shown via the `title` tooltip.
- Display only — not filterable (out of scope).

## 6. Feature 3 — Date Filter

- A native `<input type="date">` beside the filter tabs in `WatchPage`, default = current date (IST).
- Changing it refetches the list for that day. Applies to every section tab.
- Server-side filtering — `GET /api/watch` accepts `date=YYYY-MM-DD`. Client-side filtering
  is not viable: `repo.list` only returns the 50 most-recent rows, so an older date would show nothing.
- Filters on **`createdAt`** — the only timestamp present on every entry (`WATCHING` entries
  never execute, so `executedAt` is null for them).
- The server converts the IST calendar day to a UTC `createdAt` range (`createdAt` is stored UTC).
- When a `date` is supplied, the list cap is raised from 50 to **200** so a full busy day is visible.

## 7. Backend Changes (`apps/api`)

- **`WatchRepository.list({ status?, date?, limit? })`** — when `date` is given, add
  `where.createdAt = { gte: <IST day start UTC>, lte: <IST day end UTC> }` and use `take: 200`.
- **`WatchRepository`** gains two batch-lookup helpers (it already holds `PrismaService`):
  - `findScannerNames(alertIds: string[]): Map<alertId, scanName>` — one
    `chartinkAlert.findMany({ where:{id:{in}}, include:{scanner:true} })`.
  - `findRealizedPnls(tradeIds: string[]): Map<tradeId, pnl>` — one `trade.findMany({ where:{id:{in}} })`.
- **`WatchService.list({ status?, date? })`** (new) — calls `repo.list`, then enriches each
  entry with `scannerName` and `realizedPnl` (the latter only for entries with a linked trade).
- **`WatchController.list`** — accepts `@Query('date')`, validates `YYYY-MM-DD` shape,
  delegates to `WatchService.list` instead of `repo.list` directly.
- **Response shape** — each entry: existing `WatchEntry` fields + `scannerName: string | null` + `realizedPnl: number | null`.

## 8. Frontend Changes (`apps/web`)

- `types/watch.types.ts` — `WatchEntry` gains `scannerName: string | null` and `realizedPnl: number | null`.
- `services/watch.service.ts` — `watchApi.list(status?, date?)` appends the `date` query param.
- `hooks/useWatchEntries.ts` — accepts `date`, includes it in the fetch and as an effect dependency.
- `WatchPage.tsx` — `date` state (default today, IST); `<input type="date">` beside the tabs;
  renders the Total P/L badge computed from `entries`.
- `WatchTable.tsx` — new "Scanner" column; closed rows' P&L column shows `realizedPnl`
  (so the column and the section total agree).
- A small pure helper `sectionTotalPnl(entries)` — `sum(open → profitView.abs, closed → realizedPnl ?? 0)`.

## 9. Edge Cases

- Entry with no `alertId` / unresolved scanner → `scannerName` null → `"—"`.
- Closed entry that never executed (no linked trade) → `realizedPnl` null → contributes `0`, shows `"—"`.
- Date with no entries → empty table, total `₹0`.
- Timezone — "today" and the day boundaries are computed in IST; the server maps the IST day to a UTC range.

## 10. Testing

- **Backend** — `WatchRepository.list` date filtering uses correct IST→UTC boundaries;
  enrichment maps `scannerName` / `realizedPnl` correctly (incl. null cases). Unit tests with mocked Prisma.
- **Frontend** — `sectionTotalPnl` helper: open contributes live P/L, closed contributes
  `realizedPnl`, never-executed contributes 0.
- All existing watch-monitor tests stay green.

## 11. Out of Scope

- Filtering the list *by* scanner (the scanner is a display column only).
- Date ranges (single date only).
- Historical / cumulative P/L charts.
