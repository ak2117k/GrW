# Timeframe-Aware Support/Resistance (Chart-Only) — Design Spec

> **Date:** 2026-06-11
> **Branch:** `worktree-feature+timeframe-aware-sr`
> **Status:** Design — approved for spec, pending written-spec review

---

## 1. Problem

Support/Resistance (S/R) levels render correctly only on the **15-minute** chart. On
5m, 1m, and other timeframes the overlays disappear or look wrong. Root-cause
investigation (2026-06-11) found this is **by design at two layers**, not a calculation bug:

1. **Render gate** — the strong-zone overlay, evidence-level overlay, and S/R status
   chip in `apps/web/src/pages/charts/ChartsPage.tsx` are each wrapped in
   `timeframe === '15m' && ...` (lines ~442, ~449, ~479). Comment at line 441:
   *"Detector basis is 15m, so only render there."*

2. **Fixed-interval computation** — the S/R engines never receive the selected
   timeframe:
   - `SrEvidenceService.levelsFor(token, exchange, symbol)` takes **no interval**
     and hardcodes `'5m'` candle fetches (`sr-evidence.service.ts:81`).
   - The zone detector's `DetectZonesInput` has **no interval field**; callers always
     pass 15m candles.
   - Frontend hooks `useZones` / `useSrEvidence` never send a timeframe.

3. **Daily-ATR tolerance unit** — every price tolerance / zone width multiplies a
   **daily** ATR (`level-book.service.ts`), which does not scale to intraday
   timeframes. (The bar-count windows — 3-bar fractal pivot, 50-bar recency, 20-bar
   volume MA — are already timeframe-relative and do *not* need rescaling.)

## 2. Goal & Scope

**Goal:** Native, per-timeframe S/R on the Charts page — a 5m chart computes S/R from
5m structure, 1m from 1m structure — for **all intraday timeframes**:
`1m, 3m, 5m, 15m, 30m, 1h`.

**Out of scope (explicit):**
- **Daily (`1d`) timeframe** — different regime, not now. Stays gated off.
- **Trading logic** — the scanner, strategies, and paper-trade tracks keep consuming
  S/R pinned to **15m**, untouched. This is a **chart-visualization-only** change.

## 3. Approach (chosen: A — Parameterize, default to 15m)

Thread an `interval` argument through the chart S/R path. **It defaults to `'15m'`** at
every new seam, so existing trading callers (which omit it) execute byte-for-byte the
same code they do today. Only the chart explicitly passes the selected timeframe.

Two real computation changes inside the engine:
1. Fetch candles at the selected `interval` (with a per-TF lookback window) instead of
   the hardcoded `'5m'` / `'15m'`.
2. Replace the daily ATR with a **per-timeframe ATR** computed from those same candles,
   so zone widths auto-scale to the timeframe.

Bar-count windows stay as-is — they are already timeframe-relative.

### Alternatives considered (rejected)
- **B — Wall-clock window model:** convert every bar-count window to a duration and
  derive bars per interval. Large tuning surface, high risk of regressing working 15m
  behavior, solves a problem we mostly don't have. Rejected.
- **C — Separate chart-only S/R service:** total physical isolation from trading, but
  duplicates the substantial evidence/clustering/scoring logic and creates two engines
  to keep visually consistent. Rejected in favor of A's default-param isolation.

## 4. Isolation Guarantees

1. **Default-param inertness:** with `interval` defaulting to `'15m'`, the diff is
   provably inert for any caller that does not pass it. The trading path runs identical
   code.
2. **No shared-state writes:** chart-triggered S/R computes on demand and caches
   **in-memory** keyed by `${token}:${exchange}:${interval}`. It **never** writes to the
   shared zone repository the scanner reads. The persisted 15m zones are untouched.

## 5. Components & Changes

### Backend — `apps/api/src/modules/signal-generator`
| File | Change |
|------|--------|
| `services/sr-evidence.service.ts` | `levelsFor(token, exchange, symbol, interval = '15m')`. Fetch candles at `interval` (replace hardcoded `'5m'`). Compute per-TF ATR from those candles. Derive pivot/HISTORY candidates from the same per-TF candles (via existing pivot detection) rather than the DB-stored 15m zones. Volume nodes from per-TF candles; round numbers & OI walls unchanged (price-based, TF-agnostic). Cache key includes `interval`. |
| `services/strong-zone-detector.service.ts` | `DetectZonesInput` gains optional `interval`; cache key includes it; `atr14` receives the per-TF ATR. Bar-count windows unchanged. |
| `controllers/signal-generator.controller.ts` | `/signals/zones` and `/signals/sr-evidence` accept optional `interval` query param (default `'15m'`), validated against the intraday set; fetch candles at that interval with per-TF lookback; pass `interval` down. |
| `services/` (new helpers) | A **per-TF lookback map** (lookback window per interval) and a **per-TF ATR** util (ATR(14) over an array of candles). |

### Frontend — `apps/web`
| File | Change |
|------|--------|
| `hooks/useZones.ts`, `hooks/useSrEvidence.ts` | Accept `timeframe`; send as `?interval=`; include it in the query key so caches don't collide across timeframes. |
| `pages/charts/ChartsPage.tsx` | Pass `timeframe` into both hooks. Change render gates (lines ~442, ~449, ~479) from `timeframe === '15m'` to membership in the intraday set `{1m,3m,5m,15m,30m,1h}`. `1d` stays gated off. |

## 6. Per-Timeframe Lookback

Target ~200–400 bars per interval so each timeframe has comparable structural depth
(windows need ~50+ bars; clustering wants a few hundred). Not a fixed 10 days.

| TF | ~bars/day (NSE ~6.25h) | lookback | ≈ bars |
|----|------------------------|----------|--------|
| 1m | ~375 | 1 day | ~375 |
| 3m | ~125 | 2 days | ~250 |
| 5m | ~75 | 5 days | ~375 |
| 15m | ~25 | 10 days *(unchanged)* | ~250 |
| 30m | ~13 | 20 days | ~260 |
| 1h | ~7 | 45 days | ~315 |

Angel One chunks sub-hour fetches at 1 day/call (`TIMEFRAME_MAX_RANGE_DAYS`,
`angel-one-adapter.service.ts`); 1m over 1 day = 1 chunk. The interval→enum mapping
(`TIMEFRAME_MAP`) already supports all six intervals.

## 7. Data Flow

```
UI timeframe
  → useZones / useSrEvidence (?interval=<tf>)
  → controller (interval default '15m', validated)
  → fetch candles @ interval (per-TF lookback)
  → per-TF ATR
  → detector / evidence (cache keyed by token:exchange:interval, in-memory only)
  → levels → overlays (rendered for intraday set)
```

Trading path is unchanged: scanner/strategies call the same services without `interval`,
get `'15m'`, read/write the persisted 15m zone store exactly as today.

## 8. Error Handling & Degradation

- Existing guards stay: `< 10 candles → []`.
- The S/R status chip already surfaces `"S/R: insufficient data"` / `"no levels"`, so a
  sparse intraday series degrades gracefully instead of looking broken (important for 1m
  early in a session or after an Angel session expiry).
- Invalid/unsupported `interval` query values fall back to `'15m'` (safe default).

## 9. Testing

- **Per-TF ATR util:** correct ATR(14) on known candle fixtures; differs appropriately
  across intervals.
- **Lookback map:** returns sane bar counts per TF.
- **Cache key:** includes `interval` — no cross-timeframe cache collision.
- **Engine output:** detector & evidence produce sensible, non-empty levels on 5m and
  1m fixtures.
- **Regression guard (critical):** calling with no `interval` ⇒ identical inputs/outputs
  to today — the frozen 15m trading path must not move.
- **No persistence:** chart-path computation does not write to the shared zone
  repository.

## 10. Risks

| Risk | Mitigation |
|------|------------|
| Accidentally altering the 15m trading path | Default-param `'15m'` + explicit regression test asserting unchanged behavior. |
| Chart path polluting persisted zones | In-memory cache only, interval-keyed; no writes to zone repo (tested). |
| Excessive Angel API calls for fine intervals | Bounded per-TF lookback (≤ a few chunks); existing per-TF TTL cache in the adapter. |
| 1m sparse data early in session | Existing `< 10 candles` guard + "insufficient data" chip. |
