# Swing Open Book — Design Spec

> Date: 2026-06-05
> Status: Approved (design); pending implementation plan
> Scope: `apps/web` (Swing page only). No backend or schema changes.

## Problem

The Swing page's header counters — **"N open"** and the **unrealized P&L** badge — are
derived from the page's date-filtered entry list. The date filter (`from`) defaults to
**today (IST)**:

```ts
// apps/web/src/pages/swing/SwingPage.tsx
const [from, setFrom] = useState(todayIST());
const { entries } = useSwingEntries(filter, from);   // API filters enteredAt >= from
const openEntries = entries.filter((e) => e.exitPrice == null);
const openCount = openEntries.length;                // derived from filtered list
```

Swing positions hold **overnight / multi-day**. A position entered yesterday is still open
today, but `enteredAt` falls before today's `from` cutoff, so the API excludes it. The
result observed on 2026-06-05: 4 genuinely-open positions (entered 2026-06-04), yet the
header reads **"0 open"** and the table shows *"No swing entries yet."*

**Root cause:** a live-state counter (open exposure) is computed downstream of a UI
view-filter meant for historical browsing. The two responsibilities are conflated into one
list and one counter.

## Goal

The open-positions counter and the Open Book must reflect **all** currently-open swing
positions, always, independent of any date filter — while the date filter remains useful for
auditing per-day activity ("what fired on June 4?").

Non-goals: no change to intraday, reinvest, ungated, or the main Dashboard; no backend or
schema change; no change to P&L period cards (already filter-independent).

## Definitions

- **Open swing position** ⟺ `status = 'TRADED'` ⟺ `exitPrice = null`. On exit the status
  flips to `TARGET_HIT` / `STOPPED` / `EXPIRED` with `exitPrice` set
  (`prisma/schema.prisma:808`, `@@index([status, enteredAt])`).

## Approach (chosen: A — split open book from date-filtered log)

Separate the two responsibilities into two data sources and two UI sections.

Rejected alternatives:
- **B — union open positions into the filtered query.** Older open positions bleed into the
  selected day, so the per-day entry count is no longer verifiable. Rejected: breaks the
  audit counter.
- **C — default the filter to "All".** One-line change, but the conflict returns the moment a
  user picks a date to verify a day. Rejected: treats the symptom, not the structure.

## Design

### Backend
None. `GET /api/anand/swing/entries?status=TRADED` (no `from`) already returns all open
positions enriched with live price (`currentPrice`, `pnlPct`) and `leadCount`. The query is
served by `@@index([status, enteredAt])`.

### Frontend — `apps/web/src/pages/swing/SwingPage.tsx` and supporting files

1. **`useSwingOpenBook()`** — new hook (`apps/web/src/hooks/useSwingOpenBook.ts`).
   Fetches `listSwingEntries({ status: 'TRADED' })` with **no** date filter; polls every
   30s (mirrors `useSwingEntries`). Returns `{ openEntries, loading, error, refresh }`.
   This is the always-on source of truth for live exposure.

2. **`summarizeOpenBook(openEntries, notional)`** — new pure helper
   (`apps/web/src/utils/swingOpenBook.ts`) returning `{ openCount, unrealizedRs }`:
   - `openCount = openEntries.length`
   - `unrealizedRs = Σ (pnlPct / 100) * notional`

   The header's "N open" counter and unrealized badge derive from **this**, fed by the open
   book — never from the date-filtered list. This severs the counter from the date filter and
   is the actual fix.

3. **"Open Book" panel** — new section rendered **above** the existing table, reusing the
   existing table markup and `EntryRow`, fed by `openEntries`. Heading: `Open Book · N open`.
   Always shows every open position regardless of the `from` date or the status buttons.
   Empty state: `"No open positions."`

4. **"Entries" log** — the existing table, unchanged in behavior: still scoped by the `from`
   date input and the status buttons (`All / Traded / Target Hit / Stopped`). These controls
   now affect **only** this log. Heading clarifies it is the date-filtered view. Existing empty
   message retained (`"No swing entries yet. Waiting for Anand Swing scanner alerts."`).

### Accepted trade-off
A position entered **today** that is still open appears in both panels (Open Book, and
today's Entries log). This is intentional — the same truth in two lenses — and is clearer
than suppressing it from either view.

## Data flow

```
useSwingOpenBook  ──> listSwingEntries({status:'TRADED'})  ──> openEntries
        │                                                         │
        └─> summarizeOpenBook(openEntries, NOTIONAL) ──> {openCount, unrealizedRs}  ──> header
        └─> Open Book panel (all open, always)

useSwingEntries(filter, from) ──> listSwingEntries({status, from}) ──> entries ──> Entries log
getSwingPnl() ──> PnlSummary ──> period P&L cards   (unchanged, already filter-independent)
```

## Error handling
- Open-book fetch failure: surface a non-blocking error in the Open Book panel; the header
  counter falls back to showing the last good value or `—`, and the Entries log continues to
  render independently (the two hooks fail independently).
- No new error modes on the backend (read-only, existing endpoint).

## Testing
- **Unit (new):** `apps/web/src/utils/swingOpenBook.spec.ts` — `summarizeOpenBook`:
  - empty list → `{ openCount: 0, unrealizedRs: 0 }`
  - mixed signs → correct sum and count
  - result is identical regardless of any date value (the helper takes no date — proves the
    counter is structurally decoupled from the filter).
- **Manual:** with 4 open positions entered on a prior day and `from = today`, the header
  reads "4 open" with correct unrealized, the Open Book lists all 4, and the Entries log is
  empty for today.

## Out of scope / future
- Optional later optimization: share a single poll between the two hooks to avoid a duplicate
  fetch. Not needed now.
- Applying the same Open Book pattern to the Intraday page (intraday is same-day, so lower
  priority).
