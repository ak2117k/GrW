# Portfolio Page — real holdings + positions (read-only) — Design

**Date:** 2026-07-11
**Status:** Approved (brainstorming) — pending implementation
**Branch:** `feature/portfolio-page`

---

## 1. Goal

Surface the connected Angel One account's **real equity holdings** (delivered
stocks) and **open positions**, read-only, on a dedicated **Portfolio** page — so
the operator can see the actual broker book alongside GrW's own analysis while
managing ongoing MTF trades.

Positions + funds are already fetched by `BrokerOverviewService`. The missing
piece is **holdings**, which Angel One exposes via `getAllHolding()` (SDK route
`get_all_holding`) — returning both the holdings list and a `totalholding`
summary.

## 2. Backend — extend the ephemeral broker read

The overview already performs ONE ephemeral broker login (TOTP + generateSession)
and fetches funds + profile + positions inside a single disposable session
(TDA-011 lease). Holdings are added to that SAME session — no extra broker login.

### 2.1 `UserBrokerSession` (per-user-broker-session.factory.ts)
- `UserSmartApiLike` gains `getAllHolding(): Promise<any>` (name matches
  smartapi-javascript@1.0.27).
- `UserBrokerSession` gains `getHoldings(): Promise<any>` — returns the raw broker
  `data` (or null), guarded by the same disposed-check + `BROKER_CALL_TIMEOUT_MS`
  as `getFunds`/`getPositions` (via the existing private `read()` helper).

### 2.2 `BrokerOverviewService`
- `buildOverview` also calls `session.getHoldings()` in the same session.
- `mapHoldings(raw)` sanitizes `data.holdings[]` → each:
  `{ symbol, exchange, qty, avgPrice, ltp, close, currentValue, pnl, pnlPercent, dayChangePercent }`
  (currentValue = ltp × qty; dayChangePercent = (ltp − close)/close × 100, 0 when
  close is 0/missing). Empty/missing section → `[]`.
- `mapHoldingSummary(raw)` from `data.totalholding` →
  `{ investedValue, currentValue, totalPnl, totalPnlPercent }` (zeros when absent).
- `BrokerOverview` type gains `holdings: Holding[]` and `holdingSummary: {...}`.
- No secret fields read/logged; same sanitize-only contract as funds/positions.

### 2.3 Response
`GET /api/broker/overview` (unchanged route, admin/owner-scoped as today) now also
returns `holdings` + `holdingSummary`. The dashboard overview simply ignores the
new fields; the Portfolio page consumes them.

## 3. Frontend — new `/portfolio` page

- New left-nav item **"Portfolio"** (icon: briefcase/pie) → route `/portfolio`.
- `useBrokerOverview` type extended with `holdings` + `holdingSummary`.
- Page layout:
  - **Summary strip:** Available Cash (funds), Invested, Current Value, Total P&L
    (₹ + %), colored by sign.
  - **Holdings table:** Symbol · Exchange · Qty · Avg Cost · LTP · Current Value ·
    P&L (₹ + %) · Day %. Sorted by current value desc.
  - **Open Positions table:** Symbol · Qty · Side · LTP · P&L (from existing
    `positions`).
- **Refresh model:** fetch on mount + a manual **Refresh** button. NO auto-poll —
  each read is a full ephemeral broker login, so manual keeps it cheap and within
  Angel One rate limits. Show a subtle "as of <time>" stamp.
- **States:** loading skeleton; not-connected → prompt to connect on the Dashboard;
  empty holdings → friendly empty state; error → retry.

## 4. Testing

- `mapHoldings`: field mapping, currentValue/dayChangePercent math, empty/missing
  `holdings` → `[]`, malformed rows tolerated.
- `mapHoldingSummary`: totals mapping, missing `totalholding` → zeros.
- `buildOverview` now includes holdings + summary (session `getHoldings` mocked).
- `getHoldings()` session method: disposed-guard rejects after dispose; timeout
  path; returns `data` envelope (mirrors `getFunds`).

## 5. Out of scope (v1)

- Overlaying live market-feed **ticks** onto holdings LTP (v1 = Angel One snapshot
  values; Refresh updates them). Reconciling arbitrary holdings to the ~50-token
  feed is a separate feature.
- Auto-refresh / polling; historical portfolio-value chart; per-holding drill-down.
- Any write/trade action from this page (strictly read-only).
