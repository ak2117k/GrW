# Sold-Trades view (with daily high/low series) — Design

**Date:** 2026-07-13 · **Branch:** `feature/sold-trades` · Status: approved (brainstorming)

## Goal
A "Sold" view on the Portfolio page listing the stocks the user has sold (from the
persistent CLOSED trade-tracker rows): symbol, qty, exit price, when sold, entry,
P&L. Per sold trade, the user can **download the stock's daily high/low SERIES**
over the trade's window (hold + a short post-exit tail) as Excel/PDF — for
post-trade review ("did I sell too early / how far did it run").

Builds on existing infra: CLOSED `TradeTracker` rows (persistent record of sold
positions/holdings, already carry entry/exit/qty/high-low) + Angel One historical
daily candles (`AngelOneAdapterService.getHistoricalData`) for the OHLC series.
No new table (OHLC fetched on demand). No migration.

## Backend (trade-tracker module)
- `GET /api/portfolio/sold` → `{ sold: SoldTradeDto[] }` — the caller's CLOSED
  trackers, newest exit first. Reuse `TradeTrackerService` (add `listSold(userId)`
  = list filtered to `status:'CLOSED'`, mapped to the DTO).
  ```ts
  interface SoldTradeDto {
    id: string; symbol: string; exchange: string; token: string;
    kind: 'POSITION' | 'HOLDING';
    entryPrice: number; qty: number;
    exitPrice: number | null; exitTime: string | null; // ISO
    pnl: number | null; pnlPercent: number | null;
    holdingHigh: number | null; holdingLow: number | null;
  }
  ```
- `GET /api/portfolio/sold/:id/ohlc` → `{ symbol: string; ohlc: DailyOhlcDto[] }` —
  daily OHLC for that tracker's token over `[entryTime − few days, exitTime + ~10
  days]` (fallback ~30-day lookback before exit if entryTime missing), via
  `AngelOneAdapterService.getHistoricalData(token, exchange, 'ONE_DAY'|daily, from, to)`.
  Caller-scoped (the tracker must belong to userId → else 404).
  ```ts
  interface DailyOhlcDto { date: string; open: number; high: number; low: number; close: number }
  ```
- Tests: `listSold` filters CLOSED + maps DTO; the OHLC window computation
  (entry→exit+tail, lookback fallback); ownership 404.

## Frontend (Portfolio page)
- `useSoldTrades()` → `GET /portfolio/sold` (fetch on mount + refresh), type
  `SoldTrade` = SoldTradeDto.
- A **"Sold"** section (below Trades (Angel One)): table — Symbol · Exch · Kind ·
  Qty · Entry · Exit · Exit Time · P&L · Holding H/L · **Download ▾**.
- Per-row **Download ▾** → fetch `GET /portfolio/sold/:id/ohlc`, then export the
  daily high/low series (Date · Open · High · Low · Close) as **Excel/PDF**
  (`sold-<symbol>-<date>.xlsx|pdf`). Reuse the `exportTrackers` SheetJS/jsPDF
  helpers pattern; extract a pure `buildOhlcRows(symbol, ohlc)` for unit testing.
- Match PortfolioPage aesthetic (TH/TDR classes, CSS vars, tabular-nums).

## Out of scope (v1)
- Persisting the OHLC series (fetched on demand). Sourcing sells from the broker
  trade book directly (uses CLOSED trackers, the persistent record). Per-day P&L.
