# Trade Journal R&D — 2026-06-01

**Date:** 2026-06-01
**Area:** Gated watch / ungated shadow track — entry quality, exit mechanics, re-entry logic
**Status:** Findings documented — implementation options ranked by priority

---

## Session Stats

| Metric | Value |
|--------|-------|
| Total closed trades | 23 |
| Winning trades | 6 |
| Losing trades | 17 |
| Win rate | 26.1% |
| Average winner | +₹2,074 |
| Average loser | −₹467 |
| Win/loss ratio | 4.44× |
| Net P&L | +₹3,003 |

Despite a 26% win rate the session was profitable because winners are ~4.4× larger than losers. Every improvement to win rate or average loss size compounds directly into P&L.

---

## Finding 1 — Entries at the top of the spike (1–2 min SL hits)

**Stocks:** SUPRIYA (1 min hold), NSLNISP (1 min), MOREPENLAB (2 min), RUBICON (1 min)

Chartink fires on the *close* of a 15m candle. By the time the webhook arrives and the trade executes, the impulse move is already spent — we are entering right at the local peak. These trades had zero follow-through and hit the hard SL within minutes.

**Root cause:** By the time the webhook arrives and we execute, price has already moved beyond the risk/reward inflection point — remaining upside to target < SL risk.

**Decision:** 1-candle wait was rejected (misses fast-moving winners). Replaced with **dynamic R:R gate** — implemented 2026-06-01.

**Implementation:** At execute time, compute `dynamicRR = (profitTarget - livePrice) / (livePrice × 0.4%)`. If `dynamicRR < 2.0`, the move is spent — reject entry. Ungated throws `UngatedStaleEntryError` before DB write; gated returns null from `executeEntry` (entry stays WATCHING). Rejection logged as `stale-entry` in `ungated_rejections`.

---

## Finding 2 — Re-entries compounding losses

**Stocks:** RUBICON (−₹698 then −₹444), SAREGAMA (−₹648 then −₹440), SUPRIYA (−₹809 then −₹399)

Both entries on these stocks lost. The underlying was structurally weak; re-entering after a SL hit compounded the damage rather than recovering it.

**Status:** The **green-only re-entry gate** implemented 2026-06-01 prevents re-entry after a loss on the same token. Needs API restart to take effect in production. Once deployed these double-loss patterns should disappear.

---

## Finding 3 — SL slippage beyond 0.4% hard cap

**Stocks:** SUDEEPPHRM (−0.69%), RUBICON (−0.45%, −0.47%), SAREGAMA (−0.43%, −0.44%)

The 30s REST polling gap allows price to overshoot the −0.4% SL threshold before a tick is processed. The **SL exit-price cap** fix was implemented 2026-06-01 and pins `exitPrice` to `ref × (1 − 0.004)` on overshoot. Needs API restart.

---

## Finding 4 — AD ratio as a breadth gate for BUY entries

`adRatioAtEntry` is already captured on every trade. When the advance/decline ratio is below 0.5 (more stocks falling than rising), breakout scanner alerts are likely noise rather than trend continuation — the broader market is net-declining.

**Idea:** Block BUY entries when `adRatio < 0.5` at the time of the alert. Cheap to implement — the value is already present in the context snapshot pipeline.

**Risk:** May filter out valid individual-stock breakouts during sector rotation. Should be back-tested on a 5-day window before hardening.

---

## Finding 5 — Score stagnation: score-decay SL fires too late on some trades

Score-decay exits today were very clean (−0.02% to −0.04% losses). But SUDEEPPHRM, KERNEX, and RUBICON ran straight to the hard SL without triggering a score-decay exit first — meaning the score either held or the 10-minute grace window expired before it decayed.

**Idea:** Add a "score stagnation" exit: if score has not changed AND price has not moved favorably for N minutes after entry, exit early. Complements the existing score-decay SL.

**Alternative:** Tighten `stopLossScore` from 45 → 47 to match the entry floor and remove the grace window for low-score entries (47–55 range).

---

## Finding 6 — All winners exited via trailing-stop or target-hit

100% of winning trades today exited via `trailing-stop` (SPORTKING ×2, ICIL, KPRMILL) or `target-hit` (SAIPARENT). The partial-exit + trail mechanism is generating all the alpha.

Several trades likely moved +0.7–0.9% intraday but never triggered the +1% partial-exit threshold, meaning they got chopped out before reaching the trail phase.

**Idea:** Lower the partial-exit trigger from +1.0% to +0.7% so more trades enter the trail phase. Increases the number of trades that can compound into large winners.

**Risk:** Locking in partial profit at +0.7% reduces upside on stocks that run straight to +2%. Should be evaluated against the full distribution of intraday moves on winning trades.

---

## Top 3 Winners

| Symbol | Entry | Exit | P&L | Exit Reason |
|--------|-------|------|-----|-------------|
| SAIPARENT-EQ | ₹515.23 | ₹525.75 | +₹2,612 | target-hit |
| SPORTKING-EQ (2nd) | ₹191.10 | ₹192.97 | +₹2,476 | trailing-stop |
| ICIL-EQ (2nd) | ₹347.84 | ₹351.00 | +₹1,975 | trailing-stop |

## Top 3 Losers

| Symbol | Entry | Exit | P&L | Note |
|--------|-------|------|-----|------|
| KERNEX-EQ | ₹1,837.54 | ₹1,830.19 | −₹794 | sl-loss-cut |
| SUDEEPPHRM-EQ | ₹808.54 | ₹802.95 | −₹688 | SL slippage −0.69% |
| RUBICON-EQ (1st) | ₹1,138.63 | ₹1,133.30 | −₹699 | sl-loss-cut + re-entry |

---

## Improvement Priority

| Priority | Change | Expected Impact |
|----------|--------|-----------------|
| 1 | **Deploy today's fixes** (API restart) | Stops slippage + re-entry doubles immediately |
| 2 | **AD ratio gate** — block BUY when `adRatio < 0.5` | Filters breadth-weak entries |
| 3 | **Lower partial-exit trigger** to +0.7% | More trades enter trail phase → larger winners |
| 4 | ~~1-candle confirmation~~ → **Dynamic R:R gate** ✅ | Eliminates stale "bought the top" entries without missing fast movers |
| 5 | **Score stagnation exit** (score unchanged + price flat for N min) | Cleaner early exits on no-momentum trades |

---

## Files Involved (for implementation)

| File | Area |
|------|------|
| `apps/api/src/modules/ungated-track/services/ungated-watch.service.ts` | Partial-exit trigger threshold |
| `apps/api/src/modules/watch-monitor/services/watch.service.ts` | Same — gated path |
| `apps/api/src/modules/chartink/services/chartink-process.service.ts` | AD ratio gate at alert ingestion |
| `apps/api/src/modules/watch-monitor/services/trade-policy.ts` | Score thresholds |
