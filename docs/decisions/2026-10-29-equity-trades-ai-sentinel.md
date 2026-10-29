# Decision: The AI sentinel handles cash-equity trades with the same logic as F&O, scaled by each stock's own volatility

**Date:** 2026-10-29
**Status:** Adopted. Steps A and B are being built today; step D (live equity exits) is NOT approved.
**Research:** `docs/superpowers/specs/2026-10-29-equity-sentinel-factors.md` (file:line for every finding below)

## Context

Until today the AI trade sentinel only watched F&O. `roster.service.ts:162` kept F&O positions only, and the
auto-exit executor can trade only NFO / BFO / MCX (`AUTO_EXIT_EXCHANGES`). The owner's live intraday
equity trade (JPL-EQ, 40 shares at ₹1,481.70, opened 09:25 IST, about −₹2,356 by midday) had **zero AI looks**,
and neither did any other live equity position. In prod, nothing live is in AI control yet, F&O included
(`LIVE_TRADING_ENABLED=false`, `SENTINEL_TRIGGERS_ENABLED=false`, sentinel in observe mode).

The owner's instruction: *use the same logic as for futures; the only difference is that futures are highly
volatile and equity much less. Research other factors and add them.*

## Decisions

1. **Same logic, normalised by the stock's own volatility.** Every equity rule and factor is measured in noise units
   `N` (the instrument's own 1-minute ATR), as the F&O exit discipline already is. Lower equity volatility then
   comes through `N`, not through a second, parallel rule set. F&O numbers do not change.
2. **Step A: the live AI watches live intraday cash-equity positions, observe-only.** It records looks and
   verdicts for `EQ_INTRADAY` positions. Holdings and delivery stay out. F&O always takes the 5 watch slots first.
   The executor's F&O-only exchange gate stays, and a test proves an NSE/BSE verdict can never reach an order.
   Switch: `SENTINEL_WATCH_EQUITY_INTRADAY` (default on).
3. **Step B: paper equity trades get the full paper sentinel.** That means AI looks, AI_EXIT (an EXIT_NOW the exit
   gate passes), AI_TRIGGER, the AI closing the paper trade, and the HELD follow for the night review, all exactly
   as for F&O paper trades. For a stock the contract and the underlying are the same price, so any AI trigger is
   set on the stock's own price, on the protective side, within the **10 %** distance limit (not the 60 % premium
   limit). Switch: `PAPER_SENTINEL_EQUITY` (default on).
4. **Step C: review before any live action.** After 1–2 weeks of A and B, the nightly review compares AI exits
   with holding (HELD rows) for equity.
5. **Step D: live equity exits (the executor closing NSE/BSE intraday positions) need the owner's explicit approval**
   after step C. They would sit behind their own switch and the existing safety checks.

## Findings adopted into the build

### Volatility thresholds (sized for derivatives today)

| # | Finding | Decision for cash equity |
|---|---|---|
| T1 | With no hub 1-min bars, a stock gets **no noise unit**, so the noise floor and noise giveback switch off and it falls back to the fixed ₹150 floor and the 40 % rule | Fall back to the stock's daily-ATR-based noise unit. **The single biggest fix.** |
| T2 | Adverse-move bypass of the judge rate cap is a fixed **4 %** (`SENTINEL_ADVERSE_MOVE_PCT`): small for an option, huge for a stock | **6 × N**, with 0.8 % (`SENTINEL_ADVERSE_MOVE_PCT_EQ`) only when N is unknown |
| T3/T4 | Re-judge material move and the quiet-heartbeat move are a fixed 1 % | **3 × N**, with 0.4 % as the fallback |
| T6 | The hard-risk close window opens at 15:20 (10 min before 15:30), but **Angel auto-squares-off MIS equity at 15:15** | For MIS equity, count to 15:15, so the window opens at 15:05 |
| — | "Near a level" and the volume-spike sensor are F&O-sized; the volume spike fires on opening bars just because they are opening bars | "Near" = 0.25 × daily ATR; no spike on opening bars |

### New equity factors for the AI's view of each trade

These go in an `equity` block on cash positions only, so F&O packets stay byte-identical. Each unknown reading says why.

1. **Square-off clock:** minutes to Angel's 15:15 MIS square-off (today's `minutesToClose` counts to 15:30 and
   overstates the time left by 15 min).
2. **Price band:** distance to the circuit that hurts the position (in N and %), plus buy/sell quantity near a
   limit (at a lower circuit a market exit may not fill).
3. **VWAP distance** in N, signed for the position's side.
4. **Day range:** today's range as a multiple of daily ATR (QUIET … BIG-MOVE DAY), gap, move since entry, pullback
   from peak. This is the volatility context that held up in earlier walk-forward research.
5. **Relative strength** vs NIFTY (and the sector index when free): market-driven or stock-specific move.
6. **Relative volume:** today's volume vs this stock's normal for the time of day.
7. **Event risk:** results, board meeting or ex-date, from events already in the packet.

No factor needs a new broker call: the quotes we already fetch carry the data, but the code discards circuit
limits, buy/sell quantities, average price and 52-week high/low. Factors 2 and 6 are built only if the exact
broker field names are confirmed against a logged raw quote. They are not guessed into production.

### Problems found, to fix or carry

- **Wrong text to the judge:** cash positions are told "no options chain for this symbol" about OI walls. That
  is false for F&O stocks; walls are simply not captured when there is no expiry. *Fix in this build.*
- **Unknown product type:** `trade_trackers` has no product field, so whether a cash position is **MIS or CNC is
  assumed, not known**. *Open.* It decides which square-off rule applies, so it must be recorded before step D.
- **ASM/GSM surveillance list:** the `cautionary_symbols` table exists but nothing ever writes it. *Deferred.*
- **Market breadth:** the breadth service counts only about 20 instruments, so it is not real breadth. *Deferred.*
- **F&O ban list, overnight / T+1 gap risk:** *deferred* (delivery positions are not watched yet).

## Consequences

- More AI judge calls (owner's CLI subscription) once equity positions are watched; F&O keeps priority for slots.
- Paper P&L for equity trades starts to reflect the AI's exits, with HELD rows keeping the "what if we had held"
  number for the night review.
- Nothing in this decision lets the system place, modify or cancel a live equity order.
