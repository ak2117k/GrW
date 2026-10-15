# Exit Discipline — Design

**Date:** 2026-10-14 · **Status:** draft for owner review · **Trigger:** the first live AI exit
(CRUDEOIL17NOV269000CE, 2026-10-14) sold at ₹527.1 (+₹520) at 16:31 IST; the premium then ran to ₹542 (owner
report) — ~₹1,500 left on the table.

## 1. What went wrong (evidence)

From entry (₹521.9, 15:39) to exit (16:31):
- Premium chopped ₹518–₹539.5 with ~₹10 swings every few minutes (1-minute candles, token 582930).
- Underlying CRUDEOIL futures stayed 8995–9018 — far above the sentinel's own invalidation (8946 support /
  8932 thesis invalidation) — and was **rising (9003) at the exit**.
- The green floor was ₹524.85: breakeven + `GREEN_FLOOR_MARGIN_RUPEES = 150` = **₹1.50 of premium above
  entry on 100 units** — inside the noise, so it was touched repeatedly.
- `givebackOffPeak` (`GIVEBACK_FRACTION = 0.4`) fired on almost every verdict: 76 % of a ₹12 excursion is ₹9,
  i.e. ordinary chop.
- Verdicts flip-flopped EXIT_NOW ↔ EXIT_ARMED six times; in live mode the first unblocked EXIT_NOW sold.

**Root cause:** a "protect profit beyond charges" mandate plus a floor and a giveback sensor that are blind to
volatility made the AI exit on **premium noise while the thesis was intact**.

## 2. Goals / non-goals
**Goals:** exits only on thesis failure, hard risk, or confirmed weakness; floors and sensors scaled to the
instrument's own noise; no flip-flop sells; every AI exit scored afterwards so thresholds are tuned on evidence.
**Non-goals (later):** partial exits (scale-out) — separate step; ML exit model (SP3).

## 3. The noise unit `N`
For each watched position: `N` = ATR(14) of the **contract's 1-minute bars** (premium for options, price for
futures), from the hub candle store / the live tick aggregator (no new broker historical calls). Fallbacks: if
< 14 bars, use the high–low range of the bars available ÷ √bars; if nothing, `N` unknown ⇒ the floor/giveback
rules fall back to today's behaviour **but** the thesis gate (§6) still applies. `N` and its source go into the
packet as `flow.noiseUnit` (a block) so the LLM sees it.

## 4. Noise-aware profit floor
Replace the fixed-margin floor with:
- **Arms** only when the best excursion ≥ `FLOOR_ARM_N` × N (default 1.5) beyond breakeven-after-charges.
- **Level** = max(breakeven-after-charges, peak − `FLOOR_TRAIL_N` × N) (default 2.0) — trails the peak, never
  sits inside one noise unit of the price.
- Unknown N ⇒ today's floor (breakeven + ₹150), flagged `floorBasis: 'fixed'` in the packet.
- Applies to the packet's `money.greenFloorPrice/greenFloorArmed` (what the LLM and tripwires read) and to the
  latch logic (tighten-only latch stays).

## 5. Noise-aware giveback sensor
`givebackOffPeak` fires only when **both**: the excursion ≥ `FLOOR_ARM_N` × N, and the pullback from the peak ≥
`GIVEBACK_N` × N (default 1.5). Unknown N ⇒ current 40 % rule. (Today: excursion 12.7, N≈4–5 ⇒ arm needs
≥ ~7, pullback needs ≥ ~7 — a ₹9 pullback would still fire once, but the floor at peak−2N ≈ ₹525 would not be
"breached" by noise, and §6 would gate the sell.)

## 6. Thesis gate on EXIT_NOW (code, in the executor — not the prompt)
Before an AI EXIT_NOW may sell, at least one **exit justification** must hold, computed from the verdict's own
packet (no new reads):
1. **Thesis broken:** the underlying is beyond the thesis invalidation (`thesis.value.invalidation`) or beyond the
   nearest protective level (`structure.nearestSupport` for a long exposure / `nearestResistance` for short),
   on the underlying's scale (direction from the position's exposure, incl. puts).
2. **Hard risk:** net loss ≥ the per-trade max loss (existing setting), or `session.minutesToClose` ≤
   `GATE_CLOSE_MIN` (default 10) for an intraday product, or expiry day with ≤ 30 min to close, or the daily
   loss limit is breached.
3. **Confirmed floor breach:** the premium is below the (noise-aware) armed floor **and** the underlying has
   moved against the position by ≥ `GATE_UNDERLYING_N` × N_underlying (default 1.0) since the last HOLD, or is
   below VWAP (long) / above VWAP (short).
If none holds, the EXIT_NOW is **not executed**: an `ai_exit_executions` row is written `SKIPPED:
GATED_THESIS_INTACT` with the measured values (underlying, levels, N, floor), and the next verdict is awaited.
MANUAL (owner Exit button) and PRICE_TRIGGER (a pre-agreed level) exits **bypass** the gate.

## 7. No flip-flop sells (persistence)
An AI EXIT_NOW that passes the gate executes only if **either** the previous verdict on the tracker was also
EXIT_NOW (≤ `PERSIST_WINDOW_SEC`, default 300 s apart) **or** ≥ `PERSIST_MIN_SEC` (default 120 s) have passed
since the first EXIT_NOW with no intervening HOLD. Hard-risk justifications (§6.2) and thesis-broken by a
clear margin (underlying beyond invalidation by ≥ 0.5 N_underlying) **bypass** persistence. Otherwise
`SKIPPED: AWAITING_CONFIRMATION`.

## 8. Post-exit scoring
For every AI exit attempt that ended PLACED/FILLED (live) or DRY_RUN, and every gated/awaiting skip:
at exit + 60 min (and at the exchange close if sooner), fetch the contract's 1-minute candles for the window
(one paced historical call per exit, run after the market or via the existing pacing gate) and record in a new
table `ai_exit_outcomes`: max/min price after the decision, close at +15/+30/+60 min, **missed P&L** (best price
after − exit price) × qty and **saved P&L** (exit price − worst price after) × qty, for both executed and skipped
decisions (the skipped ones answer "would exiting have been right?"). Shown in the AI exits list; written to
the SP3 corpus outcome of the verdict; a daily scorecard line in the log. This is how the multipliers in §4–§7
get tuned — on evidence, not guesses.

## 9. Prompt v7 (mandate)
Replace "When the trade is in profit beyond charges, protect that profit" with: protect **meaningful** profit —
profit measured in noise units (`flow.noiseUnit`); do not call EXIT_NOW on a pullback smaller than the
instrument's normal swing while the underlying thesis holds; EXIT_NOW is for thesis failure, hard risk, or
weakness confirmed on the underlying. Tell it that a code gate enforces this (so it should state the
justification), and describe `flow.noiseUnit`. Version bump + golden snapshot attribution.

## 10. Configuration (defaults; all in `api.env`)
`EXIT_DISCIPLINE_ENABLED=true` (master; off = today's behaviour), `FLOOR_ARM_N=1.5`, `FLOOR_TRAIL_N=2.0`,
`GIVEBACK_N=1.5`, `GATE_CLOSE_MIN=10`, `GATE_UNDERLYING_N=1.0`, `PERSIST_WINDOW_SEC=300`, `PERSIST_MIN_SEC=120`,
`EXIT_OUTCOME_WINDOW_MIN=60`.

## 11. Safety
The gate and persistence can only **prevent** AI sells; they never place orders, never touch MANUAL or
PRICE_TRIGGER exits, never block a hard-risk exit, and never affect the broker stop-loss (which stays the
owner's protection). Exits blocked by the gate are visible as rows with the numbers that blocked them.

## 12. Testing
Replay today's CRUDEOIL verdict sequence (packets are stored): with the package on, no EXIT_NOW executes before
a thesis/hard-risk justification exists; with a synthetic break below 8932 it executes immediately. Unit tables
for N (ATR, fallbacks), floor arming/trailing, giveback scaling, every gate clause incl. puts/shorts, persistence
windows and bypasses; outcome computation (missed/saved) for long/short.

## 13. Owner decisions (defaults)
- **E1** default multipliers as in §10. *(yes)*
- **E2** gate bypass for MANUAL and PRICE_TRIGGER. *(yes)*
- **E3** close-of-session hard exit for intraday products at ≤ 10 min. *(yes; carry-forward products exempt —
  the overnight review handles them)*
- **E4** score skipped (gated) decisions too. *(yes)*
