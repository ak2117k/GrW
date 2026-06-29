# Chartink Trade-Quality Score — Per-Factor IC Analysis & Reweighting Prescription

**Date:** 2026-06-28
**Area:** `chartink-scoring.service.ts` (the 15-check trade-quality score that ranks/gates every Chartink signal and sets lot size)
**Status:** Research findings — analysis only, nothing changed. Univariate, in-sample; not yet out-of-sample validated.

---

## TL;DR

The Chartink score does **not** predict trade outcomes — it is mildly **anti-predictive** (losers average a *higher* score than winners). The cause is structural: the score's largest weights sit on the **most anti-predictive** checks (VWAP, multi-day breakout), while the **most predictive** checks (S/R-room, sector) carry **zero weight**. Re-fitting weights to realized outcomes — and *inverting* the extension/breakout factors — is the fix.

---

## 1. Does the score predict winners? (No.)

Score-bucket vs realized outcome, 1,597 closed paper trades (gated + ungated), base win rate 29.6%:

| Score bucket | n | Win% | Avg net |
|---|--:|--:|--:|
| <42 | 340 | **37%** | −₹145 |
| 42–59 | 531 | 29% | −₹56 |
| 60–74 | 446 | **26%** | −₹112 |
| 75+ | 280 | 29% | +₹67 |

**Avg score — winners 53.2 vs losers 55.9.** Higher score ⇒ *slightly lower* win rate. The 60–74 bucket (where lot-sizing scales to 2 lots) is the worst. The score is anti-predictive, and lot-sizing amplifies the error.

---

## 2. Per-factor Information Coefficient

For each of the 15 checks: win-rate when the check **passed** vs **failed**, across the same 1,597 trades. `winLift = win%(pass) − win%(fail)`. Keyed on the `passed` boolean by check name (version-independent — point weights changed over time, `passed` did not).

| Check | passN | failN | win% pass | win% fail | **winLift** | pnlLift | Current weight |
|---|--:|--:|--:|--:|--:|--:|--:|
| **S/R room** | 698 | 899 | 33% | 27% | **+5.9** | +₹80 | **0** |
| **ADX trend strength** | 972 | 132 | 33% | 27% | **+5.2** | +₹67 | 12 |
| MACD on 1m | 641 | 956 | 31% | 28% | +2.9 | +₹214 | 22 |
| **Sector aligned** | 614 | 983 | 31% | 29% | +2.4 | +₹135 | **0** |
| MACD on 5m | 466 | 1131 | 30% | 30% | +0.3 | +₹124 | 18 |
| Index aligned | 1147 | 450 | 30% | 30% | +0.1 | +₹174 | 0 |
| Relative strength | 479 | 1118 | 29% | 30% | −0.3 | +₹138 | 0 |
| MACD on 1d | 597 | 1000 | 27% | 31% | −4.8 | −₹83 | 3 |
| SuperTrend match | 758 | 839 | 27% | 32% | −5.7 | −₹88 | 0 |
| RSI on 5m | 773 | 331 | 30% | 36% | −6.2 | −₹138 | 10 |
| Volume confirmation | 1025 | 572 | 27% | 35% | −8.6 | −₹127 | 7 |
| Price vs 20-EMA | 466 | 27 | 24% | 33% | −9.3 | −₹108 | (legacy) |
| EMA9 over EMA20 | 945 | 159 | 30% | 40% | −9.8 | −₹156 | 3 |
| ATR target feasibility | 986 | 118 | 31% | 42% | −10.8 | −₹150 | 5 |
| **VWAP relationship** | 696 | 408 | 28% | 39% | **−11.2** | −₹231 | **15** |
| **Multi-day breakout** | 565 | 539 | 25% | 39% | **−13.5** | −₹243 | **5** |

---

## 3. What this reveals

1. **The weighting is inverted from reality.** The two biggest "scored" momentum/extension factors — **VWAP (w=15, IC −11.2)** and **Multi-day breakout (w=5, IC −13.5)** — are the *most anti-predictive*. The most *predictive* factors — **S/R-room (+5.9)** and **Sector (+2.4)** — carry **zero weight** (they're "observability only").
2. **Extension factors are contrarian for this strategy.** Multi-day breakout, VWAP-above, ATR-feasibility, EMA9>20, RSI-momentum all reward "already run / extended." For an intraday mean-reverting book, *failing* them is the edge: breakout-fail wins **39%** vs breakout-pass **25%**; VWAP-fail **39%** vs pass **28%**. **Inverting** these factors turns them predictive — this is the "buy at support / not extended" edge from `[[2026-06-16 decision-gate]]`, recovered from data.
3. **Only two weighted checks earn their weight:** ADX (+5.2, w=12) and MACD-1m (+2.9 win / +₹214 pnl, w=22). Everything else weighted is noise or negative.
4. **MACD-5m (w=18) is noise** (IC +0.3) — 18% of the score does nothing.

---

## 4. Reweighting prescription (data-driven)

**Keep / up-weight (positive IC):**
- S/R room — give it real weight (currently 0). Top predictor.
- ADX trend strength — keep.
- MACD-1m — keep (best pnl-lift).
- Sector aligned — give it weight (currently 0).

**Invert (negative IC → flip the sense so "not extended" scores):**
- Multi-day breakout → "not at 20-day extreme."
- VWAP relationship → penalty when extended far above VWAP.
- ATR feasibility, RSI-5m (cap the hot end), EMA9>20.
Add an explicit **"too-extended" penalty** (RSI>75 / VWAP-extension% / intraday run%) that *subtracts*.

**Drop (noise):** MACD-5m (w=18), Index-aligned, Relative-strength (already 0), MACD-1d, SuperTrend.

**Re-band lot sizing** to the re-fitted score so size tracks real edge (today it sizes biggest on the worst bucket).

---

## 5. Caveats

- **Univariate** ICs — they ignore factor correlation (the 6 momentum checks are collinear). A multivariate logistic regression would refine the weights and may collapse the momentum cluster.
- **In-sample** — fit and measured on the same 1,597 trades. Must be validated out-of-sample (fit on earlier half, test on later) before shipping a reweight.
- **Data-starved dilution** — some "failed" counts for observability checks (S/R-room "no level book", Sector "no mapping") are no-data, not signal failures; this *understates* their true IC. S/R-room still leads at +5.9 despite the dilution → robust.
- **Win-rate vs payoff** — winLift uses hit-rate; pnlLift (payoff) mostly agrees (VWAP −₹231, breakout −₹243 confirm). A full re-fit should optimize expected-value, not just hit-rate.

---

## 6. Recommended next steps

1. **Multivariate logistic re-fit** on the per-check `passed` flags → coefficient-based weights (handles collinearity).
2. **Out-of-sample split** to confirm the reweight (and the inversion) holds forward.
3. **Implement the inversion + S/R-room/sector weighting** behind a flag, run it as a shadow score A/B vs the current score (mirror the ungated/Hull experiment pattern).
4. **Fix the null `maxFavorable`/`maxAdverse` capture** (see `[[2026-06-26 findings]]`) so future calibration is continuous, not a one-off.

---

## Artifacts

| File | Role |
|------|------|
| `tmp-score-accuracy.mjs` | Score-bucket vs outcome (§1) |
| `tmp-factor-ic.mjs` | Per-factor IC table (§2) |
| `tmp-breakdown-shape.mjs` | Confirmed `initialBreakdown.checks[]` shape |

## Source

| File | Role |
|------|------|
| `apps/api/src/modules/chartink/services/chartink-scoring.service.ts` | The 15-check score (weights inline per check) |
| `apps/api/src/modules/signal-generator/services/context-scoring/weights.ts` | The *other* (macro-factor) scoring engine — not the gating score |
