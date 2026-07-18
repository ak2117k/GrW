# Chart Trade Annotations — Design Spec

**Date:** 2026-07-17

## 1. Goal

On the app's own chart (NOT Angel One — third-party, cannot be drawn on), annotate
a symbol's realized trades: an **entry marker** (with where the signal came from)
and an **exit marker at each sell**, whose hover shows **quantity sold, quantity
remaining, and the source**. Works for historical trades by construction (it just
queries the DB).

## 2. Fixed contract (both sides build against this)

`GET /api/portfolio/chart-trades?token=<token>` — auth'd, the current user's trades
for that instrument.

```ts
interface ChartTradeExit {
  time: number;              // epoch MILLISECONDS
  price: number;
  quantitySold: number;
  quantityRemaining: number; // cumulative: entryQty − running sold
  reason: string | null;     // e.g. "TARGET_HIT" | "SL_HIT" | "PARTIAL_EXIT" | exitReasonTag
}
interface ChartTrade {
  tradeId: string;
  side: string;              // "BUY" | "SELL" (position direction)
  provenance: string;        // "Chartink (chartink-gated)" | "Manual" | "Signal: RSI" | source
  entry: { time: number; price: number; quantity: number } | null;  // time = epoch MS
  exits: ChartTradeExit[];   // sorted by time asc
}
// response body: { trades: ChartTrade[] }
```

## 3. Backend

Add `@Get('chart-trades')` to `apps/api/src/modules/portfolio/controllers/portfolio.controller.ts`
(base `api/portfolio`). Query the user's trades for the token WITH their events:
`trade.findMany({ where: { userId, instrument: { token } }, include: { events: true } })`
(Trade → Instrument by `instrumentId`; scope userId the same way the other
portfolio routes do — SYSTEM_USER_ID / @CurrentUser per the app convention).

Per trade build the contract object:
- **entry:** prefer the `FILLED` event (price, quantity, createdAt); else the
  Trade's `entryTime`/`entryPrice`/`quantity`. `time` = epoch ms.
- **exits:** `TradeEvent`s with `eventType ∈ {PARTIAL_EXIT, SL_HIT, TARGET_HIT,
  CLOSED}`, each → `{ time: createdAt ms, price, quantitySold: event.quantity ??
  (remaining for CLOSED), quantityRemaining: entryQty − cumulativeSold, reason:
  eventType or trade.exitReasonTag }`. Sort ascending by time.
- **provenance:** derive from `source` + `strategy`: source SCANNER/AUTO with a
  `chartink` strategy → "Chartink (<strategy>)"; MANUAL → "Manual"; AUTO with a
  strategy → "Signal: <strategy>"; else the raw `source`. (v1 depth — the exact
  Chartink scanner name via trade→signal→alert→scanner is a fast-follow.)

DTO + a repository/service method + unit tests (cumulative-remaining maths across
multiple PARTIAL_EXITs; provenance mapping; empty when no trades).

## 4. Frontend

- `apps/web/src/services/chartTrades.service.ts` — `getChartTrades(token)` →
  `api.get('/portfolio/chart-trades', { params: { token } })`.
- `useChartTrades(token)` hook (mirror the existing chart-data hooks).
- `apps/web/src/components/charts/TradeMarkerOverlay.tsx`:
  - Entry marker (▲ for BUY, ▼ for SELL) at entry time/price; exit markers (●) at
    each exit. Rendered as **custom positioned elements** via
    `chart.timeScale().timeToCoordinate()` + `series.priceToCoordinate()` — NOT
    `series.setMarkers()`, which `PatternOverlay` already owns and which REPLACES
    all markers (they would clobber each other).
  - **Map trade epoch-ms times to the chart's compressed time axis using the same
    utility the pattern overlay uses** (`mapPatternsToChartTime.ts`) — the axis is
    gap-compressed, so raw timestamps won't land correctly otherwise.
  - **Hover** an exit → tooltip (HTML div) with "sold X / total, Y remaining,
    src: <provenance>"; hover entry → provenance. Follow the disposal-guard /
    cleanup conventions of the sibling overlays (try/catch on series calls; clear
    on unmount — see `OIOverlay` lesson).
- Wire `<TradeMarkerOverlay>` into `CandlestickChart.tsx` next to the other
  overlays, scoped to the open symbol's token + timeframe.
- Types mirror the §2 contract exactly.

## 5. Testing

- Backend: cumulative remaining across 2+ partial exits; CLOSED with null event
  qty falls back to remaining; provenance mapping cases; no-trades → empty.
- Frontend: the time-mapping produces coordinates; hover shows the right numbers;
  overlay cleans up on unmount without throwing (disposed-series guard).

## 6. Out of scope (v1)

- Deep Chartink scanner-name provenance (trade→signal→alert→scanner join).
- Annotating anything outside the app's own chart (Angel One is impossible).
- Live/streaming updates — fetch on symbol/timeframe change is enough.

---

## CORRECTION (2026-07-18) — real data source & status/% model

The first cut queried the `trades` table (empty) with a share-quantity model.
Actual paper positions live in `swing_entries` (35), `intraday_entries`,
`breakout_swing_entries` — **no per-user scoping (query by `token`)** and **no
share quantities** (percentage/fraction-based). Rebuild to these tables and show
status + % result, not sold/remaining quantities.

### Corrected contract — `GET /api/portfolio/chart-trades?token=<token>` → `{ positions: PositionMarker[] }`
```ts
interface PositionMarker {
  id: string;
  track: 'SWING' | 'INTRADAY' | 'BREAKOUT';
  provenance: string;   // scanner name via alertId→chartink_alerts→chartink_scanners.scanName; else the track label
  status: string;       // TRADED (open) | STOPPED | TARGET_HIT | QUEUED | ...
  targetPct: number;
  stopPct: number;
  entry: { time: number; price: number } | null;                          // enteredAt/entryPrice; null if not entered (breakout QUEUED)
  partial: { time: number; price: number; fraction: number } | null;      // intraday only (partialBookedAt/partialExitPrice/partialFraction)
  exit: { time: number; price: number; status: string; pnlPct: number; reason: string | null } | null; // when exitedAt+exitPrice present
}
```
- All `time` = epoch MS. Positions are LONG: `pnlPct = (exitPrice − entryPrice) / entryPrice * 100`.
- Fields per table: SwingEntry {entryPrice, enteredAt, exitPrice, exitedAt, status, targetPct, stopPct, alertId}; IntradayEntry adds {partialBookedAt, partialExitPrice, partialFraction, exitReason}; BreakoutSwingEntry {entryPrice?, enteredAt?, status, targetPct, stopPct, alertId} (skip rows with no entry).
- Provenance: batch-resolve alertIds → scanner names in one pass.

### Display (frontend tooltips — replace sold/remaining)
- ▲ Entry: "Entered ₹<price> · from <provenance>" (hover: target/stop %).
- ◐ Partial (intraday): "Booked <fraction%> at ₹<price>".
- ● Exit: "Exited ₹<price> · <status> · <pnlPct>%" (hover: reason).
- Open position (no exit) → entry marker only.
