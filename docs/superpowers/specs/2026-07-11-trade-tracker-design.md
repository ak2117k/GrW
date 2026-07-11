# Feature 1 — Per-Trade Tracker + Export — Design

**Date:** 2026-07-11
**Status:** Approved (brainstorming) — pending implementation
**Branch:** `feature/trade-tracker`

---

## 1. Goal

For each real Angel One **position and holding** shown on the Portfolio page,
maintain a persistent "tracker" that records: entry (avg cost), exit + exit time,
the **holding-period** high/low, the **day's** high/low, latest LTP and P&L %.
Data is stored in the DB and **downloadable** from the page as **Excel or PDF**.
On first run it **backfills** the current book ("fills the data first").

## 2. Decisions (brainstorming)

| Decision | Choice |
|----------|--------|
| What is a "trade" | Real Angel One **positions + holdings** |
| Price source | **Socket** (live market feed) for real per-stock prices |
| Book composition (entry/exit) | Periodic **broker snapshot** (positions+holdings) |
| High/low meaning | **Both** — day OHLC high/low AND holding-period extreme |
| Export | **Both** Excel (.xlsx) + PDF, user picks on the Download button |
| Scope | Both positions & holdings |

## 3. Data model — `trade_trackers`

```prisma
model TradeTracker {
  id          String   @id @default(cuid())
  userId      String
  user        User     @relation(fields: [userId], references: [id], onDelete: Cascade)
  symbol      String
  exchange    String
  token       String
  kind        String   // 'POSITION' | 'HOLDING'
  entryPrice  Float
  qty         Float
  entryTime   DateTime @default(now())
  exitPrice   Float?
  exitTime    DateTime?
  status      String   @default("OPEN") // 'OPEN' | 'CLOSED'
  holdingHigh Float?
  holdingLow  Float?
  dayHigh     Float?
  dayLow      Float?
  dayDate     String?  // 'YYYY-MM-DD' IST — day-rollover marker
  lastLtp     Float?
  pnl         Float?
  pnlPercent  Float?
  createdAt   DateTime @default(now())
  updatedAt   DateTime @updatedAt
  @@index([userId, status])
  @@map("trade_trackers")
}
```
- `User` gains `tradeTrackers TradeTracker[]`.
- **Partial unique index** (migration SQL, one OPEN row per instrument):
  `CREATE UNIQUE INDEX "trade_trackers_open_key" ON "trade_trackers" ("userId","token","kind") WHERE "status" = 'OPEN';`

## 4. The "agent" — reconciler + tick updater (backend)

New module `trade-tracker` (`apps/api/src/modules/trade-tracker/`).

### 4.1 `TradeTrackerService`
- **reconcile(userId, positions, holdings):** for each open position/holding →
  upsert an OPEN tracker (create on first-seen: entry = avg cost, qty, entryTime =
  now, seed holdingHigh/Low + dayHigh/Low from current ltp). Any OPEN tracker whose
  instrument is no longer in the book → mark CLOSED (exitPrice = lastLtp, exitTime =
  now, final pnl/pnlPercent). Idempotent (safe to run repeatedly).
- **applyTick(token, ltp):** for every OPEN tracker on `token` → update holdingHigh/
  Low (running max/min), dayHigh/Low (max/min for `dayDate`; reset when the IST date
  rolls), lastLtp, pnl, pnlPercent. Writes DEBOUNCED (batch every few seconds), not
  per-tick.
- **backfill(userId):** first-run path — reconcile the current book so existing
  positions/holdings appear immediately.
- **list(userId):** OPEN + CLOSED trackers for the page (newest first).

### 4.2 `TradeTrackerPoller` (cron)
- Runs every ~10 min during market hours. For each user with a broker credential:
  take a per-user broker snapshot (positions + holdings) via the per-user session
  (`PerUserBrokerSessionFactory` + `CredentialDecryptor`, reason `'REVALIDATE'`, or
  reuse `BrokerOverviewService`), then `reconcile(...)`. Ensures each OPEN tracker's
  token is **subscribed to the market feed** (`MarketFeedService`).
- Follow the existing poller patterns (`ungated-tick-poller`, `watch-backstop-poller`).

### 4.3 Price source (socket)
- The reconciler subscribes tracked tokens to `MarketFeedService` (so the shared
  socket carries their ticks — ticks are market-wide, valid for any user's holdings).
- The tick updater reads live prices via the feed. Preferred integration: a periodic
  (~3–5s) sweep reading `MarketFeedService.getQuote(token)` for each OPEN tracker and
  calling `applyTick` — the quote cache is socket-fed, so this is "real prices from
  the socket" without coupling to the raw WS event loop. (If an in-process tick
  event exists on MarketFeedService, hooking it is equally acceptable.)

## 5. API

- `GET /api/portfolio/trackers` → `{ trackers: TradeTrackerDto[] }` (caller-scoped
  via `@CurrentUser('userId')`).
- **DTO** (the exact shape the frontend consumes):
  ```ts
  interface TradeTrackerDto {
    id: string; symbol: string; exchange: string; token: string;
    kind: 'POSITION' | 'HOLDING';
    entryPrice: number; qty: number; entryTime: string; // ISO
    exitPrice: number | null; exitTime: string | null;  // ISO|null
    status: 'OPEN' | 'CLOSED';
    holdingHigh: number | null; holdingLow: number | null;
    dayHigh: number | null; dayLow: number | null;
    lastLtp: number | null; pnl: number | null; pnlPercent: number | null;
    updatedAt: string; // ISO
  }
  ```
- Optional `POST /api/portfolio/trackers/refresh` → triggers an on-demand
  reconcile+backfill for the caller (so the page can force a fill without waiting
  for the cron). Returns the fresh list.

## 6. Frontend — Portfolio page "Trade Tracker" section

- New hook `useTradeTrackers` → `GET /portfolio/trackers` (fetch on mount + manual
  refresh; may reuse the Portfolio Refresh).
- New section on `PortfolioPage`: a table of trackers — Symbol · Exch · Kind ·
  Entry · Qty · Exit · Exit Time · Holding H/L · Day H/L · P&L (₹+%) · Status.
  Color P&L by sign; show OPEN vs CLOSED.
- **Download ▾ button** (client-side export of the loaded rows):
  - **Excel (.xlsx)** via SheetJS (`xlsx`), **PDF** via `jspdf` + `jspdf-autotable`.
  - Same columns as the table; filename `trade-tracker-<date>.xlsx|pdf`.
- Export helpers live in `apps/web/src/utils/exportTrackers.ts` (pure functions,
  unit-testable: rows → worksheet/doc).

## 7. Testing

- `TradeTrackerService.reconcile`: new→OPEN, gone→CLOSED, idempotent re-run,
  backfill seeds extremes.
- `applyTick`: holding high/low accumulation, day high/low + IST day rollover reset,
  pnl/pnlPercent math.
- Export helpers: rows → xlsx cells + pdf rows mapping, empty state.
- `GET /trackers`: caller-scoped, DTO shape (ISO dates, nulls).

## 8. Constraints / out of scope (v1)

- **Feed budget:** tracked tokens share the ~50-token feed; a large book rotates.
- **Per-user poll cost:** one broker login per user per reconcile cycle.
- **entryTime** = first-observed time (broker gives no per-lot buy timestamp).
- Client-side export covers the loaded rows; large closed-history paging/server-side
  export is deferred.
- No per-day high/low *history series* (only current day + holding extreme); a
  `tracker_day_stats` child table is a future extension.
- Read-only: no trade actions from this section.
