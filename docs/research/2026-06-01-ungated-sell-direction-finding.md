# Ungated Track — SELL Direction Trades Explained

**Date:** 2026-06-01
**Area:** Ungated shadow track / Chartink processing
**Status:** Observed behaviour — not a bug, documented for future decision

---

## Observation

SELL-direction trades appear in the ungated watch even though the Chartink scanners that trigger them are bullish (breakout) scanners. These SELL trades consistently show profitable results.

---

## Root Cause — How It Happens

The direction (`BUY` / `SELL`) for every trade is **not taken from the scanner's intent**. It is computed fresh in `chartink-process.service.ts → processOne()` by classifying the 15-minute candle trend of the stock's sector index (falling back to the stock's own 15m trend when no sector mapping exists):

```
sectorTrend = classifyTrend(last 26 × 15m closes)
  UP   → side = 'BUY'
  DOWN → side = 'SELL'
```

This `side` value flows directly into `ungatedWatch.createFromAlert({ side, ... })` at line 347 — there is no BUY-only filter on the ungated path.

### Why SELL trades look "accurate"

The ungated paper account simulates short-selling. When `side = 'SELL'`:

- **Profit target** = `initialPrice × 0.98` — 2% *below* entry
- **Hard SL** = `initialPrice × 1.004` — 0.4% *above* entry
- **P&L** is positive when price falls

When a Chartink bullish-scanner fires on a stock whose sector is trending DOWN at that moment, the process service assigns `side = 'SELL'`. The stock continues lower (because the sector is genuinely weak), so the short paper trade profits. The P&L appears accurate because the direction logic is internally consistent with the 15m trend — it just happens to contradict the scanner's bullish framing.

### Gated track has identical behaviour

The gated `WatchService.createFromAlert` receives the same `side` value. In real intraday execution on NSE, a SELL-first trade is a valid short-sell. So both tracks can produce SELL entries from bullish-scanner alerts.

---

## Implication

The current design is: **scanner = signal that the stock is in play; trend = decides direction**. This is a valid approach if the goal is purely to follow momentum, but it can conflict with scanner intent when:

1. Scanner was designed for bullish breakouts only
2. Sector is in a short-term dip while the stock's longer-term structure is bullish
3. User only wants long (BUY) positions for simplicity or compliance reasons

---

## Options (not yet decided)

| Option | Description |
|--------|-------------|
| Keep as-is | Both directions allowed; trend drives side. Gives more signals. |
| **BUY-only gate on ungated** ✅ | `UngatedSellDirectionError` thrown first in `createFromAlert`; recorded as `sell-direction` rejection in `ungated_rejections`. **Implemented 2026-06-01.** |
| Scanner-level side override | Each Chartink scanner declares its own direction (`BUY`/`SELL`/`AUTO`). `AUTO` keeps current trend logic; explicit overrides bypass it. Most flexible. |
| Separate SELL scanners | Run dedicated short-sell scanners distinct from breakout scanners, routed to a separate ungated-short track. |

---

## Files Involved

| File | Role |
|------|------|
| `apps/api/src/modules/chartink/services/chartink-process.service.ts` | `processOne()` lines 177–248 — sector/stock trend → side assignment |
| `apps/api/src/modules/ungated-track/services/ungated-watch.service.ts` | `createFromAlert()` — receives and uses `side` as-is |
| `apps/api/src/modules/watch-monitor/services/watch.service.ts` | Same — gated path also uses the trend-derived side |
