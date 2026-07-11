# Feature 2 — Stock Monitor (target-profit watcher) — Design

**Date:** 2026-07-11
**Status:** Approved (brainstorming) — pending implementation
**Branch:** `feature/stock-monitor`

---

## 1. Goal

A dedicated page to add stocks to monitor. Each has a **target profit %** measured
from the **price captured when it was added**. A backend poller watches live
prices (socket) and, when a stock reaches its target, **fires an alert** (persisted
`Alert` row + WebSocket `alert` toast, even if the user isn't on the page) and marks
the row `TARGET_HIT`. Distinct from the existing browser-local watchlist (which is
display-only, no target/monitoring).

## 2. Decisions (brainstorming)

| Decision | Choice |
|----------|--------|
| Target basis | **% above the price when added** (reference captured at add-time) |
| On target hit | **Server-side alert + visual** (poller watches always) |
| Delivery | Persisted `Alert` row + WebSocket `alert` event (in-app toast) |
| Access | Any authenticated user (NOT subscription-gated) — personal utility |
| Direction | Upside target only (v1) |

## 3. Data model — `stock_monitors` (per-user)

```prisma
model StockMonitor {
  id             String    @id @default(cuid())
  userId         String
  user           User      @relation(fields: [userId], references: [id], onDelete: Cascade)
  symbol         String
  exchange       String
  token          String
  referencePrice Float?    // LTP captured at add-time (null until first priced)
  targetPercent  Float
  targetPrice    Float?    // referencePrice * (1 + targetPercent/100)
  status         String    @default("WATCHING") // 'WATCHING' | 'TARGET_HIT'
  lastLtp        Float?
  currentPercent Float?    // (lastLtp - referencePrice) / referencePrice * 100
  triggeredAt    DateTime?
  createdAt      DateTime  @default(now())
  updatedAt      DateTime  @updatedAt
  @@unique([userId, token])   // one monitor per stock per user
  @@index([userId, status])
  @@map("stock_monitors")
}
```
- `User` gains `stockMonitors StockMonitor[]`.
- Migration applied locally AND to prod Neon BEFORE deploy (migrations are
  out-of-band; a missing table would crash boot).

## 4. Backend — new `stock-monitor` module (`apps/api/src/modules/stock-monitor/`)

### 4.1 `StockMonitorService`
- `add(userId, { symbol, exchange, token, targetPercent })`: subscribe the token to
  `MarketFeedService`; capture `referencePrice` from `MarketFeedService.getQuote(token)`
  (if unpriced, leave null — the sweep sets it on first tick); `targetPrice = ref*(1+pct/100)`
  when priced; create a `WATCHING` row (upsert-safe on the unique key → 409/replace on
  duplicate token). Returns the DTO.
- `list(userId)`: monitors newest first → DTO (ISO dates).
- `remove(userId, id)`: delete the caller's row.
- `sweep()`: for each `WATCHING` monitor, read `getQuote(token)`; if referencePrice is
  still null, set it now (+targetPrice) and skip; else update `lastLtp` + `currentPercent`;
  if `lastLtp >= targetPrice` → set `status='TARGET_HIT'`, `triggeredAt=now`, and **fire
  once** (guarded by status so it never re-alerts).
- Exported pure helpers (unit-testable): `computePercent(ref, ltp)`, `computeTargetPrice(ref, pct)`, `isHit(ltp, targetPrice)`.

### 4.2 Alert firing (reuse existing infra)
- On hit: create an `Alert` row (`type:'price'`, `condition:'above'`, `value:targetPrice`,
  `message` like `"<symbol> hit target +<pct>% (₹<targetPrice>)"`, `isActive:false`,
  `triggeredAt:now`) via the alerts module/service if it exposes a create/trigger; else
  `prisma.alert.create`.
- Emit the WebSocket `alert` event to the user via the market-data gateway (the frontend
  already handles an `alert` WS event). Investigate `MarketDataGateway` for the emit path;
  keep it best-effort (a WS hiccup must not block the DB write).

### 4.3 `StockMonitorPoller`
- Subscribes all `WATCHING` tokens to `MarketFeedService` (cron ~every 5 min re-subscribe +
  on add). `@Interval(~5000)` `sweep()` guarded by `feed.isMarketOpen()`.
- Mirror the trade-tracker poller/patterns.

### 4.4 API — `StockMonitorController`
- `POST /api/monitor` body `{ symbol, exchange, token, targetPercent }` (class-validator DTO)
  → `StockMonitorDto`.
- `GET /api/monitor` → `{ monitors: StockMonitorDto[] }`.
- `DELETE /api/monitor/:id` → 204.
- All `@CurrentUser('userId')`-scoped (global JwtAuthGuard). Register module in `app.module.ts`.

### 4.5 DTO (frontend contract)
```ts
interface StockMonitorDto {
  id: string; symbol: string; exchange: string; token: string;
  referencePrice: number | null; targetPercent: number; targetPrice: number | null;
  status: 'WATCHING' | 'TARGET_HIT';
  lastLtp: number | null; currentPercent: number | null;
  triggeredAt: string | null; createdAt: string; // ISO
}
```

## 5. Frontend — new `/monitor` page

- New left-nav item **"Monitor"** (USER-visible) → route `/monitor`.
- **Add form:** instrument search (reuse the existing search hook/component used by the
  watchlist/market search — e.g. `useInstrumentSearch`) to pick symbol+token+exchange, plus
  a target-profit **%** number input → `POST /monitor`.
- **Table:** Symbol · Ref Price · LTP · Change % (from ref) · Target % · Target Price ·
  progress bar (currentPercent / targetPercent, clamped 0–100) · Status badge
  (WATCHING / TARGET_HIT) · Remove (✕ → DELETE).
- **Live:** `useStockMonitors` hook — fetch on mount + poll `GET /monitor` every ~10s;
  subscribe to the WS `alert` event (via the existing `wsService`) to toast on a hit.
- Empty / loading states consistent with the Portfolio page styling (CSS vars, tabular-nums).

## 6. Testing

- Service: `add` captures reference + targetPrice (and the deferred-reference path when
  unpriced); `sweep` updates percent and flips to TARGET_HIT + fires exactly once
  (idempotent re-sweep does NOT re-alert); pure helpers (percent/target/isHit).
- Poller: subscribe + market-hours-guarded sweep.
- Frontend: add-form submit, progress/percent formatting, WS `alert` toast, remove.

## 7. Out of scope (v1)

- Downside/stop alerts (upside only), email/push (in-app toast + Alert row only),
  auto re-arm after a hit, editing target in place (remove + re-add), per-tick WS price
  on the page (polling is sufficient since the backend does detection).
