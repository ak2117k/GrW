# Chartink MTF Alignment Gate — Design Spec

**Date:** 2026-05-11
**Status:** Approved (user picked the recommended option at every clarifying question)
**Author:** Brainstorm session with Claude (Opus 4.7)

---

## Goal

Add a multi-timeframe (MTF) **directional-agreement gate** between Chartink alert ingest and `signalGeneratorService.analyze()`. For each stock hit, the gate checks whether the **last completed candle's close is greater than the prior bar's close** on each of four timeframes (1d, 1h, 15m, 5m). If all four agree (all up or all down), the gate passes and the hit proceeds to full `analyze()`. If any disagree, the gate rejects with a new `kind: 'mtf-misaligned'`, `analyze()` is skipped entirely, and the per-TF directions are persisted for diagnostic review on the /chartink page.

The gate is **scanner-direction-agnostic** — it infers direction from the stock's own multi-TF behavior rather than from scanner metadata.

## Non-goals

- Changing the existing single-higher-TF check inside `analyze()`. This new gate sits *before* `analyze()`; both run.
- Tagging scanners with intended direction. The user explicitly rejected this; the gate uses pure 4-TF agreement.
- Smoothed trend metrics (EMA slope, ADX, etc.). The user wants the simplest definition: bar-over-bar close direction. Upgradeable later if too noisy.
- Auto-rejecting based on incomplete bars. We use the last *completed* bar on each TF, not the still-forming current bar, so the same hit produces the same decision within the bar.

## Architecture

```
ChartinkProcessService.processOne(hit)
  │
  ├── resolve symbol → token (existing)
  │
  ├── if not resolved → persist kind='unresolved' (existing, unchanged)
  │
  ├── NEW: mtfAlignment.check(token, exchange)
  │      │
  │      ├── For each tf in [1d, 1h, 15m, 5m]:
  │      │    fetch last 2 candles via AngelOneAdapter
  │      │    direction = close[1] > close[0] ? 'UP' : close[1] < close[0] ? 'DOWN' : 'NEUTRAL'
  │      │
  │      └── return { directions, aligned: bool, agreedDirection: 'UP'|'DOWN'|null }
  │
  ├── if !aligned → persist kind='mtf-misaligned' with rejectReason=summary, skip analyze
  │
  └── if aligned → existing analyze() path runs (no change)
```

## Component responsibilities

| Component | Responsibility |
|---|---|
| `MtfAlignmentService` (NEW) | Pure orchestrator. Takes (token, exchange), returns the alignment result. Knows nothing about Chartink — usable from other callers in future (e.g. cron-fired setups could opt-in). |
| `ChartinkProcessService` (MODIFIED) | Calls `mtfAlignmentService.check` between symbol-resolution and `analyze()`. Persists `mtf-misaligned` on rejection. |
| `ChartinkRepository` (UNCHANGED) | `createAlertSetup` already accepts arbitrary `kind` strings. |
| `chartinkController` GET listing endpoints (UNCHANGED) | Returns the new `kind` value as-is; frontend just needs to know how to count it. |
| Frontend `ChartinkPage` (SMALL EDIT) | Add `mtf-misaligned` to the count summary line. |

## Data model changes

None. `ChartinkAlertSetup.kind` is already a free-form `String`. We just introduce a new enum value `'mtf-misaligned'`. The `rejectReason` column carries the human-readable summary.

Adding a typed enum for `kind` is **out of scope** for this spec — would force a migration for all existing rows. The four current values are documented as strings in the controller spec and that pattern continues.

## Algorithm

`MtfAlignmentService.check(token, exchange)`:

```
const TFS = ['1d', '1h', '15m', '5m'] as const;
const directions: Record<string, 'UP'|'DOWN'|'NEUTRAL'> = {};

for (const tf of TFS) {
  // Fetch enough history to guarantee 2 completed bars even on a fresh
  // post-weekend morning. Use a generous lookback per TF:
  //   1d   → 7 days
  //   1h   → 24 hours
  //   15m  → 3 hours
  //   5m   → 1 hour
  const candles = await angelAdapter.getHistoricalData(
    token, exchange, tf, lookbackFor(tf), now
  );

  if (candles.length < 2) {
    directions[tf] = 'NEUTRAL'; // insufficient data treated as misaligned
    continue;
  }

  // The "last completed" bar is the most-recent bar whose closeTime is <= now.
  // angelAdapter returns chronologically sorted; the last element is most recent.
  // For intraday TFs during market hours, the very last bar may be still forming —
  // we step back one extra bar to be safe.
  const isMostRecentStillForming = isBarStillOpen(candles[candles.length - 1], tf, now);
  const lastCompletedIdx = isMostRecentStillForming
    ? candles.length - 2
    : candles.length - 1;
  if (lastCompletedIdx < 1) {
    directions[tf] = 'NEUTRAL';
    continue;
  }

  const cur = candles[lastCompletedIdx].close;
  const prev = candles[lastCompletedIdx - 1].close;
  if (cur > prev) directions[tf] = 'UP';
  else if (cur < prev) directions[tf] = 'DOWN';
  else directions[tf] = 'NEUTRAL';

  await sleep(350); // Angel historical-API serial pacer
}

// Determine alignment
const values = Object.values(directions);
const allUp = values.every(d => d === 'UP');
const allDown = values.every(d => d === 'DOWN');
const aligned = allUp || allDown;
const agreedDirection = allUp ? 'UP' : allDown ? 'DOWN' : null;

return { directions, aligned, agreedDirection };
```

**Lookback windows** (sized so we always get ≥ 2 completed bars):
- 1d → 7 days (covers weekends/holidays; expect 5 candles, use last 2)
- 1h → 24 hours (covers overnight; expect ~6 candles, use last 2)
- 15m → 3 hours (covers lunch-time gaps; expect 12 candles, use last 2)
- 5m → 1 hour (expect 12 candles, use last 2)

**`isBarStillOpen` semantics**:
- For 1d: a bar is "open" if its timestamp is today AND market hasn't closed yet (15:30 IST for NSE, 23:30 IST for MCX).
- For 1h: a bar is "open" if `now < timestamp + 1h` AND we're inside market hours.
- Same pattern for 15m and 5m.

If the market is closed (evening, weekend), the most-recent bar is always "completed" and we use it directly.

## Failure modes

| Case | Behavior |
|---|---|
| Angel API fails for any TF | Treat that TF as `'NEUTRAL'` → automatically fails alignment → `mtf-misaligned` with reason "broker fetch failed for {tf}". Log the underlying error at warn level. |
| Token not subscribed to live feed but historical works | Fine — we use historical only for this check. No dependency on the live tick stream. |
| `candles.length < 2` after lookback | Treat as `'NEUTRAL'` → misalignment. Most likely for newly-listed stocks. Acceptable rejection. |
| One TF has gap-fill / weekend hole | The lookback windows are generous (7d for 1d, 24h for 1h, etc.) so we'll still find 2 bars before the gap. Tested implicitly via the lookback sizing. |
| Equal closes (`cur === prev`) | `'NEUTRAL'` → fails the `every` check → misaligned. Very rare in practice (cents-precision prices). |
| Symbol is an index (e.g., NIFTY) | Index tokens have valid historical data; gate works identically. |

## /chartink page changes

The existing UI's `fmtKindCount` function hardcodes the 4 known kinds. Add `'mtf-misaligned'` to the count summary so a typical alert row reads:

```
1 setup · 2 no-setup · 4 mtf-misaligned · 0 unresolved
```

When a row is expanded, each `ChartinkAlertSetup` already shows `rejectReason` — for `mtf-misaligned` it'll show "TF: 1d=UP 1h=UP 15m=DOWN 5m=UP". No new component needed.

## Test plan

### Unit tests

| File | What's covered |
|---|---|
| `mtf-alignment.service.spec.ts` (NEW) | All four direction cases per TF (UP, DOWN, NEUTRAL), alignment computation (all UP → aligned UP, all DOWN → aligned DOWN, any disagreement → misaligned), insufficient-data handling, broker-fetch failure handling, bar-still-forming exclusion via mocked `isBarStillOpen`. |
| `chartink-process.service.spec.ts` (MODIFIED) | Add cases for: (a) MTF aligned → analyze() called as before, (b) MTF misaligned → analyze() NOT called, `mtf-misaligned` row persisted with the expected `rejectReason` summary. |

### Manual verification

After deploy:
1. Trigger a Chartink test fire (the synthetic "SYMBOL 1, SYMBOL 2, SYMBOL 3" payload).
2. Confirm those rows show `kind: 'unresolved'` (no change from today — symbol resolution fails before MTF runs).
3. On the next real scheduled fire with actual stocks, confirm `/chartink` shows the expected mix of `setup`, `no-setup`, and `mtf-misaligned` rows.
4. Spot-check 2-3 `mtf-misaligned` rows by manually opening the chart for the stock and verifying the four TFs really do disagree at the time of the alert.

## Performance

A typical Chartink alert carries 1-30 stocks. The gate adds **4 Angel historical calls per stock**, each paced 350ms apart, so:
- 1 stock → +1.4 s
- 10 stocks → +14 s
- 30 stocks → +42 s

This is added to the existing `analyze()` cost (which itself makes broker calls). Total time-to-completion for a 30-stock alert grows from ~30 s to ~70 s. Still well within the gap between scheduled scanner fires.

If this turns out to be too slow under heavy load, batch optimizations available later:
- Parallel TF fetches per stock (4 calls in parallel instead of serial → ~1.4 s → ~0.35 s)
- Or cache D candles globally (rarely change intraday)

## File layout

```
apps/api/src/modules/signal-generator/
└── services/
    └── mtf-alignment.service.ts            NEW
    └── mtf-alignment.service.spec.ts       NEW

apps/api/src/modules/chartink/
├── services/
│   └── chartink-process.service.ts         MODIFIED (~25 lines added between symbol-resolve and analyze)
│   └── __tests__/
│       └── chartink-process.service.spec.ts MODIFIED (+ 2 test cases)
└── chartink.module.ts                      MODIFIED (provide MtfAlignmentService — or it lives in signal-generator module)

apps/web/src/pages/chartink/
└── ChartinkPage.tsx                        MODIFIED (+ 1 line for mtf-misaligned count)
```

The service is placed in `signal-generator` module because:
1. It's a generic MTF check, not Chartink-specific.
2. It depends on `AngelOneAdapterService` which is already imported in signal-generator.
3. Future callers (cron-fired setups, manual chart-based "what's the MTF direction here?" UI) live closer to signal-generator than to Chartink.

## Roll-out

- No DB migration (we're only adding a new string value to a free-form column).
- No env var changes.
- Behaviour change is gated only by code: Chartink hits start being filtered through the MTF gate immediately upon deploy.
- Reversion: revert the two modified files; the MtfAlignmentService becomes dead code (harmless until next cleanup).

## Out of scope / deferred

- **Configurable gate sensitivity** — e.g., allowing `'NEUTRAL'` to count as a match for either side. Not in v1; can be added if NEUTRALs prove common.
- **Different bar-direction definition** — EMA slope, candle color, ADX-based, etc. The user explicitly chose "close vs prior close" for simplicity.
- **Per-scanner override** — letting some scanners bypass the MTF gate. If frequently needed, add a `bypassMtfGate: bool` column on `ChartinkScanner`.
- **MTF gate for cron-fired (non-Chartink) setups** — the service is reusable but plumbing it into the existing setup cron is a separate task.
- **Frontend: a chart overlay showing the 4-TF directions** at the moment of the alert. Useful for diagnostic but not blocking v1.
