# Breakout Swing Track — Design Spec

**Date:** 2026-06-16
**Status:** approved (verbal), implementing

A new paper-trading track parallel to Swing/Intraday/Adaptive — a **breakout** variant
of the Anand swing. Fed by the same `ANAND_SWING` Chartink scanner. Separate page,
table, entries.

## Strategy

### Entry (all must hold, evaluated when an ANAND_SWING alert fires)
1. **Near resistance** — the stock is within `NEAR_RES_PCT` (default **1.0%**) *below*
   its nearest overhead resistance (use the swing-pivot / S/R logic; `detectSwingPivots`
   on a multi-day 15m series — swing highs above price; nearest one).
2. **Above previous day's CLOSE** — current price > previous trading day's close.
3. If 1 & 2 hold → **arm a resting limit-buy** at `currentPrice × (1 + LIMIT_PCT)`
   (default **+1.5%**). Status = `QUEUED`. The order rests intraday and **expires at EOD**
   if unfilled (`EXPIRED`). It fills (`TRADED`) when the live price reaches the limit
   (breakout). No score filter.

### Sizing / base (mirror Anand swing)
- `NOTIONAL = ₹200,000` per trade; qty = `floor(NOTIONAL / fillPrice)`.
- Base **target = +10%**, initial **SL = −10%** from the fill price. Holds overnight.

### Exit / management
- **Trailing after +7% (#4):** once unrealized gain ≥ **+7%**, set `trailing=true` and
  trail a stop **2% below the high-water** (`TRAIL_GIVEBACK_PCT`, default 2%), ratcheting
  up; this replaces the −10% SL. Position is HELD with the trailing stop.
- **Big-day-mover exit (#1):** if the **STOCK is up > 7% on the day** (vs previous close),
  force-exit by **15:15 IST** (`exitReason='big-mover-eod'`) — don't carry an
  over-extended intraday mover overnight. (Stock's daily move, NOT the trade's gain.)
- Otherwise normal: `target-hit` (+10%), `stopped` (−10% or trailed), and a final
  EOD square-off consistent with the swing track.
- Exit eval only on FRESH price (mirror existing tracks' poller pattern).

### Rule interaction
#1 (stock day-move) and #4 (trade gain) measure different things and can both apply.
When a trade is up >7% (trailing) AND the stock is up >7% on the day, the **15:15
deadline wins** (hard exit); the trailing stop protects until then.

## Architecture (clone `adaptive-stop-track`)
- **Module:** `apps/api/src/modules/breakout-swing-track/` registered in `app.module.ts`.
- **DB:** `BreakoutSwingEntry` (single table, see schema). Status:
  `QUEUED → TRADED → {TARGET_HIT|STOPPED|BIG_MOVER_EOD|EXPIRED|DISMISSED}`.
- **Entry service** `createFromAlert({alertId,symbol,token,hitPrice,...})`: fetch
  multi-day 15m candles + prev-day close + live quote, evaluate entry conditions, arm
  the QUEUED limit (or reject). Reuse the live-quote/candle adapter like adaptive-stop.
- **Tick-poller** (REST cron, like `adaptive-stop-tick-poller`): for QUEUED entries, fill
  when price ≥ limit; for TRADED entries, run target/SL/trailing/big-mover-EOD/EOD logic.
- **Repository / Controller / Gateway / Constants** mirror adaptive-stop.
- **Capital:** NOTIONAL-derived (no separate paper-account table), like Anand swing.

## Wiring
In `chartink-process.service.ts` step 1b (next to the Anand dual-track), also call
`breakoutSwingService.createFromAlert(...)` for `scannerCategory === 'ANAND_SWING'`,
in its own try/catch (must not affect other tracks).

## Frontend (clone `SwingPage` + `useSwingEntries`)
- Page `/breakout-swing`, nav link "Breakout Swing".
- Show: queued (resting) orders with limit price + distance-to-fill, open positions
  with live P&L + trailing flag, and recent exits. Reuse swing page patterns.

## Tunable constants (defaults)
`NEAR_RES_PCT=1.0`, `LIMIT_PCT=1.5`, `TARGET_PCT=10`, `INIT_STOP_PCT=10`,
`TRAIL_TRIGGER_PCT=7`, `TRAIL_GIVEBACK_PCT=2`, `BIG_MOVER_DAY_PCT=7`,
`BIG_MOVER_EXIT_HHMM='15:15'`, `NOTIONAL=200000`.

## Out of scope (v1)
Reinvestment pool, separate paper-account ledger, shorting. BUY-only.
