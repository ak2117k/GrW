# Decision: Chartink scoring → pure score-based (drop hard misalignment gates)

**Date:** 2026-05-18
**Status:** Adopted — interim (see "Planned enhancement")

## Context

The Chartink alert → trade pipeline ran two parallel filtering mechanisms:

1. A **graded 0-100 score** — 10 weighted checks (Index aligned 20, Sector aligned 10,
   Relative strength 10, 9/20-EMA 10, SuperTrend 10, MACD-1d 5, MACD-5m 10, MACD-1m 10,
   S/R room 10, Volume 5). Entry threshold: score ≥ 60.
2. **Hard "misalignment" gates** — binary vetoes that rejected a stock regardless of
   the score:
   - `mtf-misaligned` — a 4-timeframe (1d/4h/1h/15m) alignment pre-screen, run *before*
     scoring.
   - `macd-misaligned` / `supertrend-misaligned` — post-score gates: even with score ≥ 60,
     a failing 5m-MACD or SuperTrend check vetoed the trade.

The mechanisms overlapped. MACD-5m and SuperTrend were **both** scored factors (10 pts
each) **and** hard gates — the gate just re-read the `passed` flag of the same check
already in the score. One failure was counted twice, and the *same* root cause could
surface as either `scored-low` (lost its points, fell under 60) or `*-misaligned`
(other factors carried it over 60, then the gate vetoed) — depending purely on whether
other factors compensated.

## Decision

Go **pure score-based** for now. Remove all three hard misalignment gates: the
`mtf-misaligned` pre-screen, the `macd-misaligned` post-score gate, and the
`supertrend-misaligned` post-score gate.

After this change the only scoring-stage rejection is `scored-low` (score < 60).
MACD-5m and SuperTrend stay as **scored factors** — misalignment now lowers the score
instead of vetoing. Misalignment "scores less" rather than producing a separate kind.

`unresolved` (symbol/token not found) and `no-direction` (no tradeable side could be
determined) are **kept** — these are genuine "cannot be scored at all" prerequisites,
not gates. `error` is kept.

## Consequences

- Removing the `mtf-misaligned` pre-screen means every alert now runs the full 10-check
  score — more broker (historical-data) calls per scan, slower live processing.
- `mtf-misaligned`, `macd-misaligned`, `supertrend-misaligned` no longer appear as
  rejection kinds in the Rejections view / `[trade-rejected]` logs.

## Planned enhancement (the "later")

This is an interim simplification. When revisited:

- If MACD-5m / SuperTrend should genuinely be non-negotiable, re-introduce them as
  **gates only** — and *remove* them from the 10-check score (redistribute their 20 pts)
  so there is no double-counting (the "Option B" design).
- Revisit `no-direction` volume — consider defaulting direction to the Chartink scan's
  stated bias (e.g. a "BULLISH" scanner → BUY) so directionless stocks still get scored
  instead of being dropped before scoring.
