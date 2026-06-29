# Watch System — Improvement Backlog

> R&D findings from the 2026-06-07 P&L audit. Source data: 388 closed gated watch trades.
> Headline: win rate 20.4% (breakeven ~22.4%), net -₹15,410. Edge exists, diluted by low-quality entries and over-tight stops.

## Key evidence (gated watch, 388 closed trades)

| Metric | Value |
|--------|-------|
| Win rate | 20.4% |
| Avg win | +₹1,501 |
| Avg loss | -₹434 |
| Net P&L | -₹15,410 |

**Score band P&L** — only the 75+ band is green (+₹3,265, 24.3% win). 47–54 band is poison (12.1% win, -₹13,453).

**Exit reason P&L** — `loss-cut` drains -₹1,16,992 (159 trades); `trailing-stop` prints +₹81,204 (57 trades); `target-hit` +₹35,526 (18). `sl-score-decay` is 96.7% correct (keep it).

**Target source** — 91.8% of trades use `fallback-2pct` (arbitrary); `indicator-sr` fires only 8.2% of the time.

---

## Backlog (prioritised)

### [ ] 3. 90-minute no-progress exit  — ACCEPTED, not yet implemented
Any TRADED watch entry that has sat between -0.2% and +0.3% unrealised for 90 minutes from execution → exit at market. Frees the cap slot + capital for a better setup; cuts the dead-trade drag currently absorbed by EOD square-off (22 trades).
- Open design Qs: measure 90 min from `executedAt`; band ±? on deployed-capital P&L or price %; interaction with partial-exit state (skip if already partial-exited).

### (deferred — discussed, not yet accepted)
- 1. Raise admission floor to 65 (kills the 47–64 poison/breakeven bands).
- 2. ATR-based stop-loss (1×ATR 5m, floor 0.6%, cap 1.0%) to stop bleeding -₹1.17L to noise loss-cuts.
- Rebalance 15-factor scoring weights (MACD-1m 22pts → observability; Volume 7→15; Daily 3→10).
