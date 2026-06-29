# Order Ticket Enrichment — Design Spec

> **Date:** 2026-06-11 · **Branch:** `worktree-feature+order-ticket-enrich` · **Status:** approved, building

## Goal
Make the Manual Trade order ticket informative and interactive, and fix the ₹0 estimate bug. Frontend-only — no backend changes; the frozen paper/live execution path is untouched.

## Root bug folded in
`OrderTicket.fetchLTP` calls `GET /market-data/ltp/:sym` which **404s** (no such route); the catch sets `ltp = 0`, so `estimatedValue = qty × 0 = ₹0`. The real route is `GET /market-data/instruments/:token/quote` → `{ token, quote: { ltp, open, high, low, close, change, changePercent, ... } }`. Fix: fetch the quote by token and read `quote.ltp`.

## Scope (all approved)
1. **Live price header** — ticking LTP + day change (₹/%), O/H/L, green/red.
2. **Capital & affordability** — order value, % of capital limit, remaining, max affordable qty.
3. **Risk/Reward preview** — ₹ risk, ₹ reward, R:R, % to SL/target (when SL/target set).
4. **Interactive polish** — qty stepper + presets (25/50/100/500), BUY/SELL theming, transitions, tighter layout.

## Architecture
- **`apps/web/src/hooks/useInstrumentQuote.ts`** — `useInstrumentQuote(token, exchange)` → `{ ltp, open, high, low, close, change, changePct, isStale, loading }`. Polls `GET /market-data/instruments/:token/quote` every **3s** while token is set; unwraps `data.quote`; clears on token change; aborts in-flight on change/unmount (mirror `useZones` pattern). Robust over wiring the Angel WS feed (50-token subscription limit); the ticket needs only one symbol live.
- **`apps/web/src/components/trading/order-ticket/order-math.ts`** — pure, unit-tested:
  - `estimatedValue(qty, entryPrice): number` → `qty * entryPrice` (0 if either ≤ 0).
  - `maxAffordable(remaining, entryPrice): number` → `entryPrice > 0 ? Math.floor(remaining / entryPrice) : 0`.
  - `riskReward({ entry, sl?, target?, qty, side }): { riskAmt, rewardAmt, rr, slPct, tgtPct }` — BUY: risk `(entry-sl)*qty`, reward `(target-entry)*qty`; SELL inverted; `rr = rewardAmt>0 && riskAmt>0 ? reward/risk : null`; pct fields null when that leg absent; values clamped to ≥0 for display, `rr` null if undefined legs.
- **Presentational leaves** under `components/trading/order-ticket/` (pure, props-only, no data fetching):
  - `PriceHeader` — props `{ ltp, change, changePct, high, low, open, loading? }`. Shows "—" when `ltp<=0`. Flash on change.
  - `CapitalStrip` — props `{ orderValue, capitalLimit, capitalDeployed, maxAffordable }`. Bar amber/red as `(deployed+orderValue)/limit` rises.
  - `RiskRewardBar` — props `{ riskAmt, rewardAmt, rr, slPct, tgtPct }`. Parent renders only when SL or target set. Warn tint if `rr != null && rr < 1`.
  - `QuantityField` — props `{ value, onChange, presets? = [25,50,100,500], min? = 1 }`. Stepper −/+ and preset chips.
- **`OrderTicket.tsx`** becomes the composition: owns form state, calls `useInstrumentQuote(selectedInstrument?.token, …)`, derives entry price (`needsPrice ? price : ltp`), computes math via `order-math`, and renders the leaves. Removes the dead `fetchLTP`/`/ltp/:sym` call. `submitOrder` payload + paper/live logic unchanged.

## Frozen prop contracts
The leaves and the hook are built against the prop/return shapes above — agents must not change them, so the wiring step composes cleanly.

## Error handling
- Quote fetch failure / `ltp<=0` → header shows "—", estimate shows ₹0 gracefully (no NaN); no crash.
- R:R hidden unless SL or target present; division guards (`rr` null on zero/absent legs).
- Poll aborts on token change/unmount; no state writes after unmount.

## Testing
- `order-math.spec.ts` — estimate, max-affordable (incl. price 0), riskReward BUY/SELL, missing SL/target, rr null cases.
- `useInstrumentQuote.spec.ts` — unwraps `data.quote.ltp`; sends to the `:token/quote` route.
- Browser click-through: select RELIANCE → header ₹1,263 live, estimate non-zero, capital + R:R update on qty/SL/target change.

## Out of scope
Backend changes; live-order 503 / live-confirm gate (separate, tracked); WS tick wiring (poll suffices).
