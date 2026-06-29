# Anand Dual-Track UI Enhancements
**Date:** 2026-06-04  
**Status:** Approved  
**Scope:** Intraday (`/intraday`) and Swing (`/swing`) pages only — isolated from gated/ungated watch

---

## 1. Goals

1. Richer table columns matching the visual density of the gated/ungated watch table
2. P&L bar showing daily/weekly/monthly/yearly ₹ totals (₹2L notional per trade)
3. Swing table extras: Start Date, End Date, Days elapsed
4. Scanner name column showing which Chartink signal sourced each entry
5. Duplicate symbol guard: block a new entry when an active TRADED entry for the same symbol already exists (checked independently per track)
6. Default status changed from `WATCHING` → `TRADED` for both IntradayEntry and SwingEntry

---

## 2. Out of Scope

- No changes to gated (`WatchEntry`) or ungated (`UngatedWatchEntry`) models or pages
- No `qty` field added to schema — P&L is computed from ₹2L fixed notional
- No cooldown after exit — guard lifts the moment a trade reaches TARGET_HIT / STOPPED / EXPIRED
- No WebSocket / live push — pages continue polling every 30s

---

## 3. Schema Changes (`prisma/schema.prisma`)

### 3.1 Default status

```prisma
// IntradayEntry
status  String  @default("TRADED")   // was "WATCHING"

// SwingEntry
status  String  @default("TRADED")   // was "WATCHING"
```

Apply with `npx prisma db push` (not migrate).

---

## 4. Backend Changes

### 4.1 Duplicate symbol guard (`anand-dual-track.service.ts`)

In `createEntries()`, before each `create*Entry` call, add an independent guard:

**Intraday guard:**
```ts
const activeIntraday = await this.repo.findActiveTradedBySymbol('intraday', input.symbol);
if (activeIntraday) {
  this.logger.log(`[anand] intraday: ${input.symbol} already has active TRADED entry — skipping`);
  // do not throw; continue to swing check below
}
```

**Swing guard (independent):**
```ts
const activeSwing = await this.repo.findActiveTradedBySymbol('swing', input.symbol);
if (activeSwing) {
  this.logger.log(`[anand] swing: ${input.symbol} already has active TRADED entry — skipping`);
}
```

`findActiveTradedBySymbol(track, symbol)` → queries `IntradayEntry` or `SwingEntry` for `{ symbol, status: 'TRADED' }`, returns first match or null.

The two guards are independent: a TRADED intraday entry does not block a swing entry and vice versa.

### 4.2 P&L summary (`anand-dual-track.repository.ts`)

Current return shape per period:
```ts
{ avgExitPct: number; count: number; winCount: number }
```

Add `totalPnlRs`:
```ts
{ avgExitPct: number; count: number; winCount: number; totalPnlRs: number }
```

Computation:
```ts
const NOTIONAL = 200_000; // ₹2L per trade
totalPnlRs = entries.reduce((sum, e) => {
  const pct = ((e.exitPrice - e.entryPrice) / e.entryPrice);
  return sum + pct * NOTIONAL;
}, 0);
```

Only closed entries (exitPrice != null) are included — same filter already in place.

### 4.3 Scanner name enrichment (`anand-dual-track.controller.ts` + repository)

`listIntradayEntries()` and `listSwingEntries()` currently return raw `alertId`. Enrich with `scannerName`:

**Repository:** Add `findScannerNamesByAlertIds(alertIds: string[]): Promise<Map<string, string>>` — batch query:
```ts
prisma.chartinkAlert.findMany({
  where: { id: { in: alertIds } },
  select: { id: true, scanner: { select: { scanName: true } } },
})
```
Returns `Map<alertId, scanName>`. Handles `alertId: null` entries by not including them in the batch.

**Controller:** After fetching entries, batch-resolve scanner names and attach `scannerName: string | null` to each entry before returning.

`ChartinkAlert.scannerId` → `ChartinkScanner.scanName` (note: field is `scanName`, not `name`). `alertId` on IntradayEntry/SwingEntry is a plain String (no FK constraint) but the join works fine via Prisma.

---

## 5. Frontend Changes

### 5.1 Service type (`apps/web/src/services/anand.ts`)

Add fields to `AnandEntry`:
```ts
scannerName: string | null;   // resolved from alertId
```

Add field to `PnlSummary` period:
```ts
totalPnlRs: number;
```

### 5.2 Intraday table columns (`IntradayPage.tsx`)

Replace the current minimal table with:

| # | Column | Content | Notes |
|---|--------|---------|-------|
| 1 | Symbol | `symbol` | Bold |
| 2 | Scanner | `scannerName` | Gray if null ("—") |
| 3 | Entry Price | `entryPrice` formatted ₹ | |
| 4 | Price / Δ% | `currentPrice` (live) or `exitPrice` + % change | Green/red |
| 5 | P&L ₹ | `(pnlPct/100) × 2,00,000` | Green if >0, red if <0 |
| 6 | P&L % | `pnlPct` | Same color |
| 7 | Target | `targetPct`% (5%) | Static label |
| 8 | Status | Badge | TRADED(blue) / TARGET_HIT(emerald) / STOPPED(red) / EXPIRED(gray) |
| 9 | Entry Time | `enteredAt` IST HH:MM | |

Row expansion (click): score breakdown cards — keep existing behavior.

### 5.3 Swing table columns (`SwingPage.tsx`)

Same as Intraday, plus three additional columns after Entry Time:

| # | Column | Content | Notes |
|---|--------|---------|-------|
| 10 | Start Date | `enteredAt` formatted DD MMM | Date only, no time |
| 11 | End Date | `exitedAt` formatted DD MMM, or "Ongoing" | Gray italic if ongoing |
| 12 | Days | `⌈(exitedAt ?? now) − enteredAt⌉` in calendar days | e.g. "3d" |

Status badges for Swing: TRADED(blue) / TARGET_HIT(emerald) / STOPPED(red) — no EXPIRED.

### 5.4 P&L bar (both pages)

Replace current `PnlBar` (avgExitPct / count / winCount) with four cards side by side:

```
┌─────────────────┐ ┌─────────────────┐ ┌─────────────────┐ ┌─────────────────┐
│  Daily P&L      │ │  Weekly P&L     │ │  Monthly P&L    │ │  Yearly P&L     │
│  +₹14,200       │ │  +₹42,600       │ │  −₹8,400        │ │  +₹1,84,000     │
│  7t · 5W        │ │  22t · 14W      │ │  18t · 9W       │ │  94t · 61W      │
└─────────────────┘ └─────────────────┘ └─────────────────┘ └─────────────────┘
```

- ₹ value: green if positive, red if negative, gray if 0 / no trades
- `Nt · NW` = trade count · win count
- `totalPnlRs` comes from backend; no client-side multiplication needed

---

## 6. Affected Files

| File | Change |
|------|--------|
| `prisma/schema.prisma` | Default status TRADED for both models |
| `apps/api/src/modules/anand-dual-track/repositories/anand-dual-track.repository.ts` | `findActiveTradedBySymbol()`, `findScannerNamesByAlertIds()`, `totalPnlRs` in getPnlSummary |
| `apps/api/src/modules/anand-dual-track/services/anand-dual-track.service.ts` | Duplicate symbol guard in `createEntries()` |
| `apps/api/src/modules/anand-dual-track/controllers/anand-dual-track.controller.ts` | Scanner name enrichment on list endpoints |
| `apps/web/src/services/anand.ts` | Add `scannerName`, `totalPnlRs` to types |
| `apps/web/src/pages/intraday/IntradayPage.tsx` | New table columns, new P&L bar |
| `apps/web/src/pages/swing/SwingPage.tsx` | New table columns (+ date/days), new P&L bar |

No changes to hooks (`useIntradayEntries`, `useSwingEntries`) — they pass through whatever the service returns.

---

## 7. Constraints

- `npx prisma db push` required after schema change (not migrate)
- `findScannerNamesByAlertIds` must handle `alertId: null` entries gracefully (return `null` for scannerName)
- P&L bar ₹ values use `Intl.NumberFormat('en-IN')` formatting (e.g. ₹1,84,000)
- Days column uses `Math.ceil` so a trade opened and closed same day shows "1d"
