# Timeframe-Aware Support/Resistance (Chart-Only) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the Charts page compute native Support/Resistance per selected intraday timeframe (1m, 3m, 5m, 15m, 30m, 1h), while the 15m trading path (scanner/strategies/paper) stays byte-for-byte unchanged.

**Architecture:** Approach A — thread an `interval` arg through the chart S/R path, defaulting to `'15m'` at every seam so trading callers run identical code. Fetch candles at the selected interval (per-TF lookback) and compute a per-TF ATR as the tolerance unit. Bar-count windows stay as-is (already TF-relative). Chart path is in-memory cached (interval-keyed) and never reads/writes the shared zone DB for non-15m.

**Tech Stack:** NestJS (apps/api), React+Vite+TS (apps/web), Jest/ts-jest, Angel One adapter for candles.

**Spec:** `docs/superpowers/specs/2026-06-11-timeframe-aware-sr-design.md`

---

## File Structure

**New (backend, `apps/api/src/modules/signal-generator/services/`):**
- `timeframe-lookback.ts` — `lookbackDaysFor(interval)` + `INTRADAY_INTERVALS` set + `isIntradayInterval()`.
- `per-tf-atr.ts` — `computeAtrFromCandles(candles, period=14)`.
- `swing-pivots.ts` — `detectSwingPivots(candles)` → `{ price, kind }[]` for evidence HISTORY candidates on non-15m.

**Modified (backend):**
- `services/sr-evidence.service.ts` — `levelsFor(..., interval = '15m')`; per-TF fetch + ATR + pivots; interval cache key.
- `services/strong-zone-detector.service.ts` — optional `interval` on `DetectZonesInput`; cache key `token:interval`; `invalidateCache` clears all token keys.
- `controllers/signal-generator.controller.ts` — `interval` query on `/zones` and `/sr-evidence`; non-15m skips DB read/persist; per-TF candle fetch.

**Modified (frontend):**
- `hooks/useZones.ts`, `hooks/useSrEvidence.ts` — accept `timeframe`, send `?interval=`, include in deps.
- `pages/charts/ChartsPage.tsx` — pass `timeframe`; widen render gates to the intraday set.

---

## Parallelization (team of agents)

Two disjoint directories → safe to run concurrently in this worktree:

- **Stream BE** (one agent, `apps/api` only): Tasks 1→5 in order (Task 5 imports Tasks 1–3 utils, so sequential within the stream).
- **Stream FE** (one agent, `apps/web` only): Tasks 6–7. Codes against the agreed contract `GET /signals/{zones,sr-evidence}?token&exchange&symbol&interval=<tf>` — no need to wait for BE.
- **Stream REVIEW** (one agent, after BE+FE land): Task 8 — typecheck/tests + regression-guard verification.

**Contract (frozen, both streams rely on it):** the chart sends `interval` = one of `1m|3m|5m|15m|30m|1h`. Omitted/invalid ⇒ server treats as `15m`. Response shapes are unchanged.

---

## Stream BE

### Task 1: Per-TF lookback helper

**Files:**
- Create: `apps/api/src/modules/signal-generator/services/timeframe-lookback.ts`
- Test: `apps/api/src/modules/signal-generator/services/timeframe-lookback.spec.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { lookbackDaysFor, isIntradayInterval, INTRADAY_INTERVALS } from './timeframe-lookback';

describe('timeframe-lookback', () => {
  it('maps each intraday interval to a lookback window giving ~200-400 bars', () => {
    expect(lookbackDaysFor('1m')).toBe(1);
    expect(lookbackDaysFor('3m')).toBe(2);
    expect(lookbackDaysFor('5m')).toBe(5);
    expect(lookbackDaysFor('15m')).toBe(10);
    expect(lookbackDaysFor('30m')).toBe(20);
    expect(lookbackDaysFor('1h')).toBe(45);
  });
  it('defaults unknown intervals to the 15m window (10 days)', () => {
    expect(lookbackDaysFor('1d')).toBe(10);
    expect(lookbackDaysFor('bogus')).toBe(10);
  });
  it('recognises the intraday set', () => {
    expect(isIntradayInterval('5m')).toBe(true);
    expect(isIntradayInterval('1d')).toBe(false);
    expect([...INTRADAY_INTERVALS].sort()).toEqual(['15m','1h','1m','30m','3m','5m']);
  });
});
```

- [ ] **Step 2: Run test, verify it fails** — `npx jest timeframe-lookback -c apps/api/jest.config.* ` (or the repo's api test runner). Expected: module not found.

- [ ] **Step 3: Implement**

```ts
/** Intraday intervals that get native per-timeframe S/R. */
export const INTRADAY_INTERVALS = new Set(['1m', '3m', '5m', '15m', '30m', '1h']);

/** Days of history to fetch per interval — tuned for ~200-400 bars (NSE ~6.25h/day). */
const LOOKBACK_DAYS: Record<string, number> = {
  '1m': 1, '3m': 2, '5m': 5, '15m': 10, '30m': 20, '1h': 45,
};

export function isIntradayInterval(interval: string): boolean {
  return INTRADAY_INTERVALS.has(interval);
}

/** Lookback window in days; unknown intervals fall back to the proven 15m window. */
export function lookbackDaysFor(interval: string): number {
  return LOOKBACK_DAYS[interval] ?? LOOKBACK_DAYS['15m'];
}
```

- [ ] **Step 4: Run test, verify PASS.**
- [ ] **Step 5: Commit** — `feat(sr): per-timeframe lookback window helper`

---

### Task 2: Per-TF ATR helper

**Files:**
- Create: `apps/api/src/modules/signal-generator/services/per-tf-atr.ts`
- Test: `apps/api/src/modules/signal-generator/services/per-tf-atr.spec.ts`

ATR(14) via Wilder/SMA of True Range over the candle array. `interface AtrCandle { high: number; low: number; close: number }`.

- [ ] **Step 1: Failing test**

```ts
import { computeAtrFromCandles } from './per-tf-atr';

const mk = (h: number, l: number, c: number) => ({ high: h, low: l, close: c });

describe('computeAtrFromCandles', () => {
  it('returns 0 when fewer than period+1 candles', () => {
    expect(computeAtrFromCandles([mk(10, 9, 9.5)], 14)).toBe(0);
  });
  it('computes a positive ATR for a real series and tracks range size', () => {
    const tight = Array.from({ length: 30 }, (_, i) => mk(100 + i * 0.1, 99.9 + i * 0.1, 100 + i * 0.1));
    const wide = Array.from({ length: 30 }, (_, i) => mk(100 + i, 98 + i, 99 + i));
    const atrTight = computeAtrFromCandles(tight, 14);
    const atrWide = computeAtrFromCandles(wide, 14);
    expect(atrTight).toBeGreaterThan(0);
    expect(atrWide).toBeGreaterThan(atrTight); // wider ranges → larger ATR
  });
});
```

- [ ] **Step 2: Run, verify fail.**
- [ ] **Step 3: Implement** — standard True Range = max(h-l, |h-prevClose|, |l-prevClose|); ATR = average of last `period` TRs (Wilder smoothing acceptable). Return 0 if `candles.length <= period`.
- [ ] **Step 4: Run, verify PASS.**
- [ ] **Step 5: Commit** — `feat(sr): per-timeframe ATR from candle array`

---

### Task 3: Swing-pivot helper (evidence HISTORY for non-15m)

**Files:**
- Create: `apps/api/src/modules/signal-generator/services/swing-pivots.ts`
- Test: `apps/api/src/modules/signal-generator/services/swing-pivots.spec.ts`

3-bar fractal (mirrors the detector's proven rule): index `i` is a swing high if `high[i] > high[i±1..i±3]`, swing low if `low[i] < low[i±1..i±3]`. Skip first/last 3 bars. Returns `{ price, kind: 'high'|'low' }[]`.

- [ ] **Step 1: Failing test** with a hand-built series containing one obvious swing high and one swing low; assert both are detected with correct `kind` and `price`.
- [ ] **Step 2: Run, verify fail.**
- [ ] **Step 3: Implement** the 3-bar fractal scan.
- [ ] **Step 4: Run, verify PASS.**
- [ ] **Step 5: Commit** — `feat(sr): standalone 3-bar swing pivot helper`

---

### Task 4: Detector accepts interval (cache key only)

**Files:**
- Modify: `apps/api/src/modules/signal-generator/services/strong-zone-detector.service.ts`
- Test: `apps/api/src/modules/signal-generator/services/strong-zone-detector.service.spec.ts` (extend existing)

Changes:
- Add optional `interval?: string` to `DetectZonesInput` (default treated as `'15m'`). Note `candles15m` now may hold per-TF candles; its bar-count windows are TF-relative so no math change.
- Cache key: `` `${input.token}:${input.interval ?? '15m'}` `` everywhere the map is used (`detectZones` get/set).
- `invalidateCache(token)`: delete **all** keys starting with `` `${token}:` `` (so the scanner's 15m invalidation still works).

- [ ] **Step 1: Failing tests**
  - Two `detectZones` calls with same token but different `interval` do **not** share a cache entry (spy on `compute` via a candle change, or assert both recompute).
  - `invalidateCache(token)` clears the `token:15m` entry (recompute on next call).
  - Calling with **no** `interval` behaves exactly as before (regression guard).
- [ ] **Step 2: Run, verify fail.**
- [ ] **Step 3: Implement** the cache-key + invalidate change.
- [ ] **Step 4: Run, verify PASS** (and the full existing detector spec stays green).
- [ ] **Step 5: Commit** — `feat(sr): interval-aware detector cache key`

---

### Task 5: Evidence + controller interval wiring

**Files:**
- Modify: `apps/api/src/modules/signal-generator/services/sr-evidence.service.ts`
- Modify: `apps/api/src/modules/signal-generator/controllers/signal-generator.controller.ts`
- Test: extend `sr-evidence.service.spec.ts` and the controller spec.

**5a — `SrEvidenceService.levelsFor`** (`sr-evidence.service.ts:34`):

> **CRITICAL — preserve 15m exactly.** The user's requirement is "15m chart → today's structural levels (unchanged)." Today the 15m evidence overlay is built from **5m** candles + `book.atr14` (daily) + DB pivots. The `'15m'` branch MUST keep doing exactly that. Only **non-15m** intervals get the new native logic. The `interval` param selects the branch; it does **not** change what 15m fetches.

- Signature → `levelsFor(token, exchange, symbol, interval: string = '15m')`.
- Cache key → `` `${token}:${exchange}:${interval}` ``.
- **`interval === '15m'` (default) branch — UNCHANGED:** keep `fetch5mCandles` (5m candles), `book.atr14`, and `zoneRepository.findActiveByToken` pivots exactly as today.
- **`interval !== '15m'` branch — NEW native path:**
  - Fetch candles at `interval` via `fetchCandles(token, exchange, interval)` using `lookbackDaysFor(interval)` for the `from` window → `getHistoricalData(token, exchange, interval, from, now)`, DB fallback `getCandles(inst.id, interval, ...)`.
  - `atr14 = computeAtrFromCandles(candles, 14)` (fall back to `book.atr14` if 0).
  - HISTORY candidates from `detectSwingPivots(candles)` (price = pivot price, score = fixed 25) instead of the DB pivots.
  - Volume nodes / round numbers / OI walls computed exactly as today but over the per-TF candles + per-TF ATR.

**5b — Controller** (`signal-generator.controller.ts`):
- `getSrEvidence`: add `@Query('interval') interval?: string`; `const tf = isIntradayInterval(interval ?? '') ? interval! : '15m';` pass `tf` to `levelsFor(...)`.
- `getZones`: add `@Query('interval') interval?: string`; `const tf = isIntradayInterval(interval ?? '') ? interval! : '15m';`
  - **If `tf === '15m'`** → unchanged code path (DB read via `findActiveByToken`, compute-on-miss, `upsertMany`).
  - **If `tf !== '15m'`** → **skip** `findActiveByToken` and **skip** `upsertMany`. Fetch candles at `tf` (generalise `fetchLiveCandles15m` to `fetchLiveCandles(token, exchange, tf, from, to)` with `lookbackDaysFor(tf)` window; DB fallback `getCandles(inst.id, tf, ...)`). Compute `atr14 = computeAtrFromCandles(candles,14) || book.atr14`. Call `detectZones({ ..., candles15m: candles, atr14, interval: tf })`. Return the zones directly (no persist).

- [ ] **Step 1: Failing tests**
  - **Regression guard:** `levelsFor(token, ex, sym)` with no interval (and `levelsFor(..., '15m')`) ⇒ fetches `'5m'` candles, uses `book.atr14`, uses `zoneRepository.findActiveByToken` pivots — i.e. byte-for-byte today's behaviour. The 15m overlay must not move.
  - `levelsFor(token, ex, sym, '5m')` ⇒ fetches `'5m'` candles via the native branch, uses `computeAtrFromCandles`, HISTORY from `detectSwingPivots` (not the DB pivots).
  - `levelsFor(token, ex, sym, '1m')` ⇒ fetches `'1m'` candles with the 1-day lookback window.
  - Cache isolation across intervals (different keys).
  - Controller `getZones` with `interval='5m'`: **never calls** `zoneRepository.findActiveByToken` nor `upsertMany`; calls `detectZones` with `interval:'5m'`. (Mock zoneRepository, assert not called.)
  - Controller `getZones` with no interval (or `15m`): identical calls as today (DB read + persist) — regression guard.
  - Invalid `interval=foo` ⇒ treated as `15m`.
- [ ] **Step 2: Run, verify fail.**
- [ ] **Step 3: Implement 5a then 5b.**
- [ ] **Step 4: Run, verify PASS** + full signal-generator suite green.
- [ ] **Step 5: Commit** — `feat(sr): interval-aware evidence + zones endpoints (non-15m skips zone DB)`

---

## Stream FE

### Task 6: Hooks send `interval`

**Files:**
- Modify: `apps/web/src/hooks/useZones.ts`, `apps/web/src/hooks/useSrEvidence.ts`

Changes (both hooks, mirror each other):
- Add a third arg `timeframe: string | null`.
- In the request: `params: { token, exchange, interval: timeframe ?? '15m' }`.
- Add `timeframe` to the `useCallback` deps and the `useEffect` deps so a timeframe switch refetches.

- [ ] **Step 1:** If a hook test file exists, extend it to assert the request carries `interval`. If none exists, add a minimal one mocking `api.get` and asserting `params.interval`.
- [ ] **Step 2:** Run, verify fail.
- [ ] **Step 3:** Implement in both hooks.
- [ ] **Step 4:** Run, verify PASS. Also `npx tsc --noEmit` in `apps/web` (ignore known spurious `@td/shared` errors per project memory).
- [ ] **Step 5: Commit** — `feat(charts): send selected interval to S/R hooks`

---

### Task 7: Widen render gates to intraday set

**Files:**
- Modify: `apps/web/src/pages/charts/ChartsPage.tsx` (gates at ~442, ~449, ~479; hook calls at ~219–223)

Changes:
- Add near the top of the component: `const SR_INTRADAY = new Set(['1m','3m','5m','15m','30m','1h']); const showSR = SR_INTRADAY.has(timeframe);`
- Pass `timeframe` into both hooks: `useZones(token, exchange, timeframe)`, `useSrEvidence(token, exchange, timeframe)`.
- Replace the three `timeframe === '15m'` gate conditions with `showSR`.

- [ ] **Step 1:** Manual/visual verification is the test here (no RTL harness for this page). Implement the change.
- [ ] **Step 2:** `npx tsc --noEmit` in `apps/web` — no new errors.
- [ ] **Step 3: Commit** — `feat(charts): render S/R overlays on all intraday timeframes`

---

## Stream REVIEW

### Task 8: Integration verification

- [ ] Run the api test suite: `pnpm --filter @td/api test` (or repo equivalent). All green; the pre-existing hard-loss-cut failures noted in project memory are the only allowed reds — confirm no *new* failures.
- [ ] `npx tsc --noEmit` in `apps/api` and `apps/web` (ignore known spurious `@td/shared` errors).
- [ ] Regression guard manual check: grep that every new seam defaults to `'15m'` and that `getZones`/`levelsFor` with no `interval` exercise the original code path.
- [ ] Spot-check: with the app running, load a symbol on 1m / 5m / 15m and confirm overlays render and differ per timeframe (handoff to the `verify` skill / Playwright in the main session — NOT inside the worktree dev server).
- [ ] Commit any fixups.

---

## Self-Review Notes

- **Spec coverage:** §3 approach → Tasks 4,5; §5 backend table → Tasks 1–5; §5 frontend table → Tasks 6–7; §6 lookback → Task 1; §4 isolation (default 15m + no shared writes) → Tasks 4,5 (non-15m skip) + regression tests; §9 testing → each task's tests + Task 8.
- **15m is frozen:** both endpoints' `interval === '15m'` branch (and the no-interval default) reproduce today's exact behaviour — evidence from 5m candles + `book.atr14` + DB pivots; zones from the DB-cache/compute/persist path. Only non-15m intervals run new code. This is enforced by regression-guard tests in Tasks 4 and 5.
- **Type consistency:** `lookbackDaysFor`, `isIntradayInterval`, `INTRADAY_INTERVALS`, `computeAtrFromCandles`, `detectSwingPivots` names are used consistently across tasks.
