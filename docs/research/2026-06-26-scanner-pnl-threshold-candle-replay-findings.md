# Scanner P&L Attribution + Take-Profit/Stop-Loss Threshold Backtest

**Date:** 2026-06-26
**Area:** Ungated/gated paper tracks, Chartink scanner attribution, exit-threshold optimization
**Status:** Research findings — analysis only, nothing shipped. Recommendations unvalidated out-of-sample.

---

## Question chain (what was asked)

1. Compare gated vs ungated tracks — which is more profitable, which loses most.
2. Which Chartink scanners generated the most profitable / most loss-making trades.
3. What take-profit / stop-loss thresholds make the last-30-day result profitable using the top 2–3 scanners.
4. Validate (3) with a real 1-minute candle-replay backtest.

All figures below are **cumulative realized paper P&L** unless a 30-day window is stated.

---

## 1. Gated vs Ungated (cumulative, all-time)

| Track | Trades | Win% | Net P&L | Per-trade |
|-------|------:|-----:|--------:|----------:|
| Gated-WATCH | 205 | 34% | −₹21,263 | −₹104 |
| Ungated | 941 | 37% | −₹26,337 | −₹28 |
| Adaptive-Stop (context) | 161 | 45% | −₹11,704 | — |
| MANUAL (user orders, not a script) | 459 | 22% | −₹66,308 | — |

- **Absolute:** gated has the smaller loss (−₹21k vs −₹26k), so the gate looks ~₹5k "better".
- **Per-trade / win-rate:** ungated is actually better (−₹28 vs −₹104, 37% vs 34%). The gate's only edge is that it trades **4.6× less often** (volume artifact, not selection quality).
- Verdict: the gate is **not** selecting better trades.

Data model: gated = `trades` table (`isPaperTrade=true`, `source=WATCH`); ungated = `ungated_trades` table. The built-in `UngatedComparisonService.daily()` does this per-day; we aggregated cumulative.

---

## 2. P&L by Chartink scanner (combined gated + ungated)

Attribution path: `WatchEntry.alertId → ChartinkAlert → ChartinkScanner.scanName` (scanner name is **not** denormalized onto trades; reached via `findScannerNames`).

**Profitable (only 2 of 14 are net-positive):**

| Scanner | Trades | Win% | Net |
|---------|------:|-----:|----:|
| **Anand 100Hull >200 hull** | 559 | 41% | **+₹54,048** |
| ANAND BUY STRATEGY | 35 | 31% | +₹11,845 |

**Most loss-making:**

| Scanner | Trades | Win% | Net |
|---------|------:|-----:|----:|
| **ANAND HIGH GAINER BULLISH MAY26** | 220 | 26% | **−₹50,131** |
| Anand Superbullish scanner May26 | 83 | 30% | −₹45,742 |
| Scanner- FNO stocks Bullish Trend | 60 | 25% | −₹19,987 |
| ANAND BULLISH TREND FINDER9 | 180 | 26% | −₹19,242 |

**Key findings:**
- The edge is **concentrated in one scanner** (`Anand 100Hull >200 hull`). Everything else collectively loses ~₹176k vs +₹66k from the two winners.
- The losers share an archetype: **buy already-extended bullish momentum** (25–30% win rates) → systematically buys tops.
- **The gate destroys the best signal:** the Hull scanner is **+₹59,223 ungated** but **−₹5,176 gated** — same alerts, the gate filtered out the winners.
- `Anand Superbullish` loses −₹32k ungated *despite a 46% win rate* → payoff-asymmetry (wins small, loses huge), not a hit-rate problem. A win-rate filter would never catch it; only a tail-risk cap would.

---

## 3. Threshold question — premise already satisfied

Restricting the last 30 days to the top scanners (ungated) is **already profitable with no threshold change**:

- Top-2 (`100Hull`, `BUY STRATEGY`): 408 trades, 40% win, **+₹59,223**
- Top-3 (+ `ANAND SWING`): 467 trades, 39% win, **+₹62,012**

The whole-book loss came from the **other (bad) scanners**, not the exit thresholds. The lever that flips the month positive is **scanner selection**, not threshold tuning.

Realized-return distribution (top-3, 30d): `min/p10/p25/median = −0.40%` (the hard stop), `p75 +0.77%`, `p90 +1.15%`, `max +2.69%`. All 282 losers sit at ~−0.40% — the stop is **already tight and applied**; there is no fat loss tail left to cut.

**Data-quality bug found:** `maxFavorable` / `maxAdverse` are **100% null** on all 719 ungated entries (the tick-poller never wrote them). So a faithful threshold sweep is impossible from stored fields alone — it required a candle replay (below). *Worth fixing so future optimization needs no re-fetch.*

---

## 4. Candle-replay backtest (real 1-minute paths)

Script: `tmp-topscanner-candle-bt.mjs` (adapted from `tmp-adaptive-target-stop-grid.mjs`). Logs into Angel One (TOTP), fetches 1m candles entry→15:30 IST, dedupes by (token, day) → **454 fetches, noData=0**, caches to `tmp-topscanner-bars.json`. `sim()` walks bars; **pessimistic** within-bar tie-break (low≤stop AND high≥target ⇒ stop wins). Fees 0.04% round-trip.

**Reported optimum (all three universes): target +3% / stop −1.5%**

| Universe | Trades / days | Baseline | Optimal (+3%/−1.5%) | Δ |
|----------|------:|------:|------:|------:|
| Top-3 | 481 / 13 | +₹112,861 | +₹194,262 | +₹81,401 |
| Top-2 = Hull-only | 430 / 6 | +₹109,462 | +₹160,533 | +₹51,071 |

(Top-2 == Hull-only ⇒ `ANAND BUY STRATEGY` had **0 BUY trades** in the window; tradeable edge ≈ Hull alone.)

### ⚠️ Critical caveat — boundary optimum

The NET grid is **monotonic**: P&L rises with both bigger target and wider stop, so the "optimum" is the **bottom-right corner of the tested range**, not a true interior peak. The honest reading is *"in this sample, exiting early costs money — ride toward EOD"*, **not** "+3%/−1.5% is the magic number." Treating it as a deployable setting = overfitting to the grid corner.

### What IS robust

1. **Current live stop (~0.4%) sits in the worst region** of the grid — the −0.3%/−0.4% columns are the lowest-P&L, deeply negative at small targets. Confirms the long-standing "stop too tight" hypothesis, now on real paths.
2. **Wider stop raises both win% AND net** (40%→65% across the stop axis) — signature of a momentum-continuation edge where stopped-out trades were eventual winners.

### Defensible direction (NOT the corner value)

- Loosen live stop **0.4% → ~1.0–1.5%**; let target/trailing run to **~2.5–3%+** instead of booking early.
- Do **not** hard-code +3%/−1.5%.

### Limitations

- Only **6 active trading days** (Hull) / 13 (top-3) — data effectively ends ~2026-06-18. Green-days metric too thin to trust.
- **In-sample only**, no out-of-sample split. Boundary optimum + small sample = real overfit risk.
- Replay assumes clean MARKET fill at threshold price; **slippage on the wider stop not modeled**.

---

## Recommended next steps

1. **Extend the grid** (target→+5%, stop→−2.5%, plus a "no-stop / EOD-only" column) to find where the curve actually peaks.
2. **Out-of-sample split** — fit on earlier days, test on later days.
3. **Model slippage** on the wider stop.
4. **Fix the null `maxFavorable`/`maxAdverse` capture** in the ungated tick-poller so future sweeps need no candle re-fetch.
5. Product decision: **drop/de-weight the bottom-4 momentum-chasing scanners**; consider bypassing the gate for the Hull scanner (gate is net-destructive on it).

---

## Scripts / artifacts (repo root, untracked tmp-*)

| File | Role |
|------|------|
| `tmp-gated-vs-ungated-cumulative.mjs` | Cumulative gated vs ungated by source |
| `tmp-pnl-by-scanner.mjs` | P&L grouped by scanner (gated/ungated/combined) |
| `tmp-return-dist.mjs` | Realized-return distribution + loss-tail composition |
| `tmp-threshold-sweep.mjs` | Threshold sweep on realized P&L (superseded — excursion fields null) |
| `tmp-excursion-coverage.mjs` | Proved `maxFavorable`/`maxAdverse` 100% null |
| `tmp-topscanner-candle-bt.mjs` | **Candle-replay backtest** (the authoritative one) |
| `tmp-topscanner-bars.json` | Cached 1m paths — re-run grids in seconds |

## Source-of-truth files

| File | Role |
|------|------|
| `apps/api/src/modules/ungated-track/services/ungated-comparison.service.ts` | Built-in daily gated-vs-ungated comparison |
| `apps/api/src/modules/watch-monitor/repositories/watch.repository.ts` | `findScannerNames` (alertId → scanName) |
| `apps/api/src/modules/chartink/repositories/chartink.repository.ts` | Scanner/alert/setup persistence |
| `apps/api/src/modules/watch-monitor/services/watch.service.ts` | `HARD_STOP_PCT = 0.004` (the ~0.4% live stop) |
| `prisma/schema.prisma` | `UngatedWatchEntry.maxFavorable/maxAdverse` (currently never written) |
