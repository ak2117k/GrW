# Design Spec — Manual Trade Terminal

**Date:** 2026-06-10
**Status:** Approved (user green-lit; build with parallel agent team)
**Author:** Session (brainstorming → writing-plans)

---

## 1. Problem & Goal

The platform has rich automated/gated/paper tracks but **no dedicated manual order
terminal**. Today the only way to place an ad-hoc manual trade is the
`ExecuteTradeModal` overlay reachable from Auto-Trade and Positions pages.

**Goal:** A dedicated `/manual-trade` page that behaves like Groww / Angel One's
order screen:
- Search any instrument, see its live LTP.
- Fire a BUY/SELL order (MARKET / LIMIT / SL / SL-M, INTRADAY/DELIVERY, optional SL & target).
- Watch open positions update live and exit any of them with one tap.
- See an order book (open + recent trades).
- **Paper is the default.** Live order placement requires an explicit confirmation step.

This is overwhelmingly a **frontend composition** job — the backend already exposes
every endpoint needed. The single backend change is a safety-critical per-order
paper/live flag.

---

## 2. What already exists (reuse, don't rebuild)

Backend (no changes needed except item in §4):
- `POST /api/trades/execute` — full order ticket DTO (symbol, token, exchange, side,
  orderType, quantity, price?, triggerPrice?, positionType, stoploss?, target?,
  entryReason?, entryTags?). Runs `RiskManagerService.validateTrade()` (kill-switch →
  daily-loss → position limit → capital cap → market hours → duplicate) on **every**
  order — **not bypassable**. Routes to paper simulator or live Angel One adapter.
- `POST /api/trades/:id/close` — close one trade (needs `exitReasonTag`).
- `POST /api/trades/close-all` — kill switch.
- `GET /api/trades/open` — open trades.
- `GET /api/trades/positions` — live positions with P&L.
- `GET /api/trades` — paginated trade history (order book "recent").
- `GET /api/trades/risk-status` — `{ dailyLossUsed, dailyLossLimit, positionsUsed,
  positionsLimit, capitalDeployed, capitalLimit }`.
- `GET /api/market-data/instruments?search=` — 3-tier instrument lookup → `{ symbol,
  token, exchange, name, lotSize, tickSize, ... }`.
- `GET /api/market-data/ltp/{symbol}` — last traded price.

Frontend:
- `useTradeStore` (zustand) already has: `executeTrade(dto)`, `fetchOpenTrades()`,
  `fetchPositions()`, `fetchRiskStatus()`, `closeTrade(id)`, `closeAllPositions()`,
  `positions`, `openTrades`, `riskStatus`, `isKillSwitchActive`.
- `ExecuteTradeModal.tsx` — the existing, feature-complete order form (symbol
  autocomplete, side, order type, qty/price/trigger, SL/target, entry reason+tags,
  estimated value, risk %).
- `wsService` ticks (`'tick'` event) + `market-store` quotes for live LTP.
- `Sidebar.tsx` `navItems[]` array; `App.tsx` `<Routes>`.

---

## 3. Architecture & Components

### 3.1 Reusable `OrderTicket` (extraction)

Extract the form body of `ExecuteTradeModal` into
`apps/web/src/components/trading/OrderTicket.tsx`. The modal becomes a thin wrapper
that renders `<OrderTicket onSubmitted={onClose} />` inside `<Modal>`. **The modal's
existing behavior must not change** (Auto-Trade and Positions pages depend on it).

**Contract (pin this — page agent builds against it):**
```tsx
export interface OrderTicketProps {
  /** Called after a successful submit (paper) or confirmed live submit. */
  onSubmitted?: () => void;
  /** Pre-fill the symbol search (e.g. clicking a position to add/exit). Optional. */
  initialSymbol?: string;
  /** Visual density: 'modal' (default) keeps current spacing; 'panel' for the page. */
  variant?: 'modal' | 'panel';
}
export default function OrderTicket(props: OrderTicketProps): JSX.Element;
```

All current state (symbol search, side, orderType, qty, price, trigger, positionType,
SL, target, entryReason, entryTags, ltp, risk %) moves into `OrderTicket` unchanged.

### 3.2 Paper / Live toggle + confirmation

- `OrderTicket` gains a **Paper | Live** segmented control. Default value = current
  `settings.paperTrading ? 'paper' : 'live'` but rendered explicitly so the trader
  always sees the mode.
- On submit:
  - **Paper** → submit immediately (existing path), pass `isPaper: true` in the DTO.
  - **Live** → open `ConfirmLiveTradeModal` showing a plain-language summary
    (SIDE qty SYMBOL @ type, est. value, SL/target). Only on explicit "Confirm Live
    Order" does it submit with `isPaper: false`.
- `ConfirmLiveTradeModal.tsx` — new small component in `components/trading/`.

### 3.3 `ManualTradePage`

`apps/web/src/pages/manual-trade/ManualTradePage.tsx` — composes:
- **Risk strip (top):** reads `riskStatus`; shows capital deployed / limit (with %),
  daily P&L (color-coded), positions used / limit, and a **Kill Switch** button
  (`closeAllPositions`, with a confirm). Reuse existing styling tokens.
- **Order ticket (left):** `<OrderTicket variant="panel" onSubmitted={refetch} />`.
- **Positions panel (right-top):** maps `positions`; each row shows symbol, side, qty,
  entry, LTP, P&L (₹ + %), and an **Exit** button → `closeTrade(id)` (or a small
  exit-reason quick pick; default `OTHER` via store is acceptable for v1). Live P&L
  refreshes from ws `'tick'` updates / `fetchPositions` poll.
- **Order book (right-bottom):** tabbed **Open | Recent**. Open = `openTrades`; Recent
  = `GET /api/trades?limit=20` (status mix). Show status pill (OPEN/CLOSED/REJECTED).
- On mount: `fetchPositions()`, `fetchOpenTrades()`, `fetchRiskStatus()`; subscribe to
  ws ticks for live updates; poll positions every ~5s as a fallback.

### 3.4 Routing & nav

- `App.tsx`: add `<Route path="manual-trade" element={<ManualTradePage />} />`.
- `Sidebar.tsx`: add `{ path: '/manual-trade', label: 'Manual Trade', icon: Send }`
  inserted just before `/positions`. (Icon `Send` from lucide-react; alternative
  `Crosshair`/`Receipt` acceptable.)

---

## 4. Backend change (safety-critical, minimal)

Make `POST /api/trades/execute` honor a **per-order** paper/live flag:
- Accept optional `isPaper?: boolean` on `ExecuteTradeDto`.
- In `TradeExecutionService.executeTrade()`, resolve effective paper mode as:
  `const isPaperTrade = dto.isPaper ?? settings.paperTrading;`
  i.e. **explicit flag wins; absent flag falls back to the global setting (which
  defaults to paper).** Never default a missing flag to live.
- `RiskManagerService.validateTrade()` must continue to run **before** routing,
  unchanged, for both paper and live.
- If the MCP `place_trade`/`confirm_live_trade` already send `isPaper`, keep them
  working (this change is additive).

Verification: a live order (`isPaper:false`) still passes through risk checks; a
paper order (or missing flag) routes to the simulator.

---

## 5. Safety (non-negotiable, per CLAUDE.md §9)

- Paper default everywhere; live requires the confirmation modal AND an explicit
  per-order `isPaper:false`.
- Kill switch present on the page and always squares off all positions.
- Risk manager runs on every order; UI never bypasses `/trades/execute`.
- Live mode is visually unmistakable (red accent + "LIVE" badge on the submit button
  and confirm modal).

---

## 6. Out of scope (YAGNI for v1)

- Persistent watchlist / favorites (a lightweight "recent symbols" row is optional).
- Options chain integration / Greeks in the ticket (use existing Options page).
- Holdings/funds from broker margin API (show platform risk-status numbers only).
- Order modification from the order book (existing `PUT /trades/:id` not surfaced here).
- Bracket/cover order types beyond what execute already supports.

---

## 7. Work breakdown (parallel agent team)

| # | Agent | Scope | Files |
|---|-------|-------|-------|
| 1 | Backend | Per-order `isPaper` in execute (paper-safe default); confirm risk manager unconditional | `apps/api/src/modules/trade-engine/**` |
| 2 | Frontend-core | Extract `OrderTicket`; add Paper/Live toggle + `ConfirmLiveTradeModal`; modal becomes wrapper | `apps/web/src/components/trading/**` |
| 3 | Frontend-page | `ManualTradePage` (risk strip, positions, order book) + route + nav | `apps/web/src/pages/manual-trade/**`, `App.tsx`, `Sidebar.tsx` |

Agents 2 and 3 share the `OrderTicket` contract in §3.1 — agent 3 builds against the
pinned interface, so the two can run concurrently. Backend agent is independent.

---

## 8. Acceptance criteria

- New "Manual Trade" nav item routes to a working page.
- Search → select instrument → live LTP shows.
- Paper order places, appears in Positions + Order Book, toast confirms.
- Live toggle → confirm modal → on confirm, order routes live (risk-checked); on
  cancel, nothing happens.
- Exit button on a position closes it; kill switch squares off all.
- Existing `ExecuteTradeModal` (Auto-Trade / Positions pages) still works unchanged.
- `pnpm -C apps/web build` (tsc) and `pnpm -C apps/api build` pass.
