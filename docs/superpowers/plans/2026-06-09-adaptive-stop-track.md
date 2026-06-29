# Adaptive-Stop Track Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax. Tasks marked **[parallel-safe]** touch disjoint files and may be dispatched concurrently; the **[spine]** tasks must run in order.

**Goal:** A 3rd paper track ("Adaptive-Stop") that runs a volatility-based, risk-first-sized stop on the SAME gated (score-passing) entries, so we can A/B whether the better stop closes greener.

**Architecture:** Clone the `ungated-track` module (the self-contained paper-experiment harness) into `adaptive-stop-track`, apply a rename map, and swap two things only: (1) position sizing → risk-first (`qty = RISK_PER_TRADE / stopDist`), (2) the stop → a per-entry volatility stop with a 2-minute grace. It is invoked from `chartink-process.service.ts` Stage 4's `policy.admitted` branch (same entries as the gated track), in its own try/catch.

**Tech Stack:** NestJS, Prisma (`db push`, never `migrate dev`), Jest. All in `apps/api`. Tests: `npx jest <path>` from `apps/api`.

**Spec:** `docs/superpowers/specs/2026-06-09-adaptive-stop-track-design.md`

**Rename map** (apply when cloning any `ungated-track` file):
- Identifiers: `Ungated` → `AdaptiveStop` (e.g. `UngatedWatchService` → `AdaptiveStopWatchService`).
- Paths: `ungated-track/` → `adaptive-stop-track/`, file prefixes `ungated-` → `adaptive-stop-`.
- DB models: `UngatedWatchEntry`/`UngatedTrade` → `AdaptiveStopWatchEntry`/`AdaptiveStopTrade`; tables `ungated_*` → `adaptive_stop_*`.
- Log tags: `[ungated]` → `[adaptive-stop]`.
- Relations/`@@map`/`@relation` names: `ungated*` → `adaptiveStop*`.

---

### Task 1 [spine]: Prisma models + db push

**Files:**
- Modify: `prisma/schema.prisma`

- [ ] **Step 1: Read the ungated models.** In `prisma/schema.prisma`, find `model UngatedWatchEntry`, `model UngatedTrade`, and any `UngatedWatchEvent`. These are the template.

- [ ] **Step 2: Clone them as AdaptiveStop models** with the rename map, and ADD these fields to `AdaptiveStopWatchEntry` (after the existing `quantity` field):
```prisma
  // Adaptive-Stop specific — the risk-first / vol-stop record
  riskAmount  Float?   // ₹ risked on this entry (RISK_PER_TRADE)
  atrAtEntry  Float?   // 5m ATR(14) used to size the stop
  stopPct     Float?   // resolved stop distance as % of entry
  stopPrice   Float?   // absolute stop level
  stopBasis   String?  // 'atr' | 'floor' | 'cap'
```
Keep ALL other fields identical to `UngatedWatchEntry` (including `slBreachCount`, `partialExitedAt`, `remainingQty`, `trailingStopPrice`, etc.). Map to tables `adaptive_stop_watch_entries`, `adaptive_stop_trades`, `adaptive_stop_watch_events`. Mirror every `@@index` and `@@map`.

- [ ] **Step 3: Apply schema.** Run: `cd apps/api && npx prisma db push && npx prisma generate`
Expected: "Your database is now in sync" + client regenerated. (Per repo convention never `migrate dev` — [[project_prisma_db_push_not_migrate]].)

- [ ] **Step 4: Commit.**
```bash
git add prisma/schema.prisma && git commit -m "feat(adaptive-stop): Prisma models for the adaptive-stop track"
```

---

### Task 2 [parallel-safe]: Vol-stop + sizing math (pure, TDD)

**Files:**
- Create: `apps/api/src/modules/adaptive-stop-track/adaptive-stop-math.ts`
- Create: `apps/api/src/modules/adaptive-stop-track/constants.ts`
- Test: `apps/api/src/modules/adaptive-stop-track/adaptive-stop-math.spec.ts`

- [ ] **Step 1: Write `constants.ts`.**
```ts
// Adaptive-Stop track settings (v1 — tunable constants; calibrate ATR_MULT/bounds
// against scripts/cf-real-candles.mjs). See the design spec.
export const STARTING_BALANCE = 80_00_000; // ₹80L paper account (same as ungated, for comparability)
export const MAX_CONCURRENT = 40;
export const TRADE_COOLDOWN_MS = 45 * 60_000;
export const PROFIT_TARGET_PCT = 0.02;     // 2% from fill (same as gated/ungated)

export const RISK_PER_TRADE = 800;         // ₹ risked per trade (≈ the 0.4%-of-₹2L the gated track implies)
export const ATR_MULT = 1.2;               // stop = ATR_MULT × intraday ATR(14, 5m)
export const MIN_STOP_PCT = 0.8;           // floor on stop distance (% of entry)
export const MAX_STOP_PCT = 2.5;           // cap on stop distance (% of entry)
export const GRACE_MS = 2 * 60_000;        // no stop honored in the first 2 minutes after entry
```

- [ ] **Step 2: Write the failing test** `adaptive-stop-math.spec.ts`:
```ts
import { resolveStop, sizeQuantity } from './adaptive-stop-math';

describe('resolveStop', () => {
  it('uses ATR_MULT × atr5m when within bounds', () => {
    // entry 1000, atr5m 10 → 1.2×10 = 12 (1.2%) — within [0.8%,2.5%]
    const r = resolveStop(1000, 10);
    expect(r.stopPrice).toBeCloseTo(988, 6);
    expect(r.stopPct).toBeCloseTo(1.2, 6);
    expect(r.basis).toBe('atr');
  });
  it('floors at MIN_STOP_PCT when ATR is tiny', () => {
    const r = resolveStop(1000, 1); // 1.2×1=1.2 → 0.12% < 0.8% floor
    expect(r.stopPct).toBeCloseTo(0.8, 6);
    expect(r.stopPrice).toBeCloseTo(992, 6);
    expect(r.basis).toBe('floor');
  });
  it('caps at MAX_STOP_PCT when ATR is huge', () => {
    const r = resolveStop(1000, 50); // 1.2×50=60 → 6% > 2.5% cap
    expect(r.stopPct).toBeCloseTo(2.5, 6);
    expect(r.stopPrice).toBeCloseTo(975, 6);
    expect(r.basis).toBe('cap');
  });
  it('falls back to floor when atr5m is missing/<=0', () => {
    expect(resolveStop(1000, 0).basis).toBe('floor');
    expect(resolveStop(1000, NaN).stopPct).toBeCloseTo(0.8, 6);
  });
});

describe('sizeQuantity', () => {
  it('risk-first: qty = floor(RISK_PER_TRADE / stopDist)', () => {
    // RISK_PER_TRADE 800, stopDist 12 → floor(66.6) = 66
    expect(sizeQuantity(12)).toBe(66);
  });
  it('returns 0 when one share exceeds the risk budget (stopDist > RISK)', () => {
    expect(sizeQuantity(900)).toBe(0); // floor(800/900)=0 → caller rejects
  });
});
```

- [ ] **Step 3: Run, verify FAIL.** `npx jest src/modules/adaptive-stop-track/adaptive-stop-math.spec.ts` → FAIL (module not found).

- [ ] **Step 4: Implement `adaptive-stop-math.ts`.**
```ts
import { ATR_MULT, MIN_STOP_PCT, MAX_STOP_PCT, RISK_PER_TRADE } from './constants';

export interface StopResolution { stopPrice: number; stopDist: number; stopPct: number; basis: 'atr' | 'floor' | 'cap'; }

/** Volatility stop: ATR_MULT×atr5m, floored at MIN_STOP_PCT and capped at MAX_STOP_PCT of entry. */
export function resolveStop(entry: number, atr5m: number): StopResolution {
  const minDist = (MIN_STOP_PCT / 100) * entry;
  const maxDist = (MAX_STOP_PCT / 100) * entry;
  const atrDist = Number.isFinite(atr5m) && atr5m > 0 ? ATR_MULT * atr5m : 0;
  let stopDist = atrDist;
  let basis: StopResolution['basis'] = 'atr';
  if (!(atrDist > 0) || atrDist < minDist) { stopDist = minDist; basis = 'floor'; }
  else if (atrDist > maxDist) { stopDist = maxDist; basis = 'cap'; }
  return { stopPrice: entry - stopDist, stopDist, stopPct: (stopDist / entry) * 100, basis };
}

/** Risk-first sizing: take only as many shares as keep the loss-at-stop = RISK_PER_TRADE. */
export function sizeQuantity(stopDist: number): number {
  if (!(stopDist > 0)) return 0;
  return Math.floor(RISK_PER_TRADE / stopDist);
}
```

- [ ] **Step 5: Run, verify PASS.** `npx jest src/modules/adaptive-stop-track/adaptive-stop-math.spec.ts` → all pass.

- [ ] **Step 6: Commit.**
```bash
git add apps/api/src/modules/adaptive-stop-track/constants.ts apps/api/src/modules/adaptive-stop-track/adaptive-stop-math.ts apps/api/src/modules/adaptive-stop-track/adaptive-stop-math.spec.ts
git commit -m "feat(adaptive-stop): vol-stop + risk-first sizing math (TDD)"
```

---

### Task 3 [parallel-safe, after Task 1]: Repositories + account + trade-execution + gateway (clone)

**Files (clone each from ungated with the rename map; NO behavioral change):**
- Create `repositories/adaptive-stop-watch.repository.ts` ← `ungated-watch.repository.ts`
- Create `repositories/adaptive-stop-trade.repository.ts` ← `ungated-trade.repository.ts`
- Create `services/adaptive-stop-account.service.ts` ← `ungated-paper-account.service.ts` (import `STARTING_BALANCE`/`MAX_CONCURRENT` from the new `constants.ts` instead of its local copies; keep the same exported error classes renamed)
- Create `services/adaptive-stop-trade-execution.service.ts` ← `ungated-trade-execution.service.ts`
- Create `gateways/adaptive-stop.gateway.ts` ← `ungated-watch.gateway.ts`

- [ ] **Step 1:** For each file above, read the ungated source, apply the rename map verbatim, and adjust imports so account constants come from `./constants`. The `AdaptiveStopCreateEntryInput` interface (in the watch repo) must include the new fields `riskAmount`, `atrAtEntry`, `stopPct`, `stopPrice`, `stopBasis` (all optional) in addition to the cloned ones.
- [ ] **Step 2: Typecheck via the dependent build later** — these compile with the watch service in Task 4. For now confirm no obvious unresolved imports by reading.
- [ ] **Step 3: Commit.**
```bash
git add apps/api/src/modules/adaptive-stop-track/repositories apps/api/src/modules/adaptive-stop-track/services/adaptive-stop-account.service.ts apps/api/src/modules/adaptive-stop-track/services/adaptive-stop-trade-execution.service.ts apps/api/src/modules/adaptive-stop-track/gateways
git commit -m "feat(adaptive-stop): clone repos/account/exec/gateway from ungated"
```

---

### Task 4 [spine, after Tasks 2+3]: Watch service (clone + stop/sizing deltas)

**Files:**
- Create: `apps/api/src/modules/adaptive-stop-track/services/adaptive-stop-watch.service.ts` ← clone `ungated-watch.service.ts` with rename map, then apply the deltas below.
- Test: `apps/api/src/modules/adaptive-stop-track/services/adaptive-stop-watch.service.spec.ts`

- [ ] **Step 1: Clone + rename** `ungated-watch.service.ts` → `adaptive-stop-watch.service.ts`. Keep the admission guards (BUY-only, dedup, cooldown, last-loss, no-quote, stale-entry, admit), the partial-exit, and trailing-stop logic UNCHANGED (just renamed).

- [ ] **Step 2: Delta A — imports + ATR fetch.** Add at top:
```ts
import { resolveStop, sizeQuantity } from '../adaptive-stop-math';
import { GRACE_MS, PROFIT_TARGET_PCT } from '../constants';
import { atr } from '../../signal-generator/services/indicators'; // existing ATR helper used by chartink-scoring
```
Add a private helper to fetch 5m ATR(14) at entry (mirror how `chartink-scoring.service.ts#fetch15mCandles`/`sr-evidence.service.ts#fetch5mCandles` pull candles via `this.adapter.getHistoricalData`):
```ts
private async atr5mFor(token: string, exchange: string): Promise<number> {
  try {
    const now = new Date();
    const from = new Date(now.getTime() - 3 * 24 * 3600 * 1000);
    const c = await this.adapter.getHistoricalData(token, exchange, '5m', from, now);
    if (!Array.isArray(c) || c.length < 21) return 0;
    const a = atr(c.map((x: any) => x.high), c.map((x: any) => x.low), c.map((x: any) => x.close), 14);
    return a ?? 0;
  } catch { return 0; }
}
```

- [ ] **Step 3: Delta B — sizing + stop at entry.** Replace the `qty = Math.max(1, Math.floor(TRADE_CAPITAL / ...))` block (step 9 in the cloned file) with risk-first sizing + vol-stop. After `const executedPrice = liveQuote;` compute:
```ts
const atr5m = await this.atr5mFor(input.token, input.exchange);
const stop = resolveStop(executedPrice, atr5m);
const qty = sizeQuantity(stop.stopDist);
if (qty < 1) {
  this.logger.warn(`[adaptive-stop] ${input.symbol}: stop ₹${stop.stopDist.toFixed(2)} > risk budget — rejected`);
  throw new AdaptiveStopNoQuoteError(input.symbol); // reuse a rejection class; or add AdaptiveStopRiskTooWideError
}
```
Then in the `createEntry` input add `riskAmount: RISK_PER_TRADE`, `atrAtEntry: atr5m`, `stopPct: stop.stopPct`, `stopPrice: stop.stopPrice`, `stopBasis: stop.basis`. Keep `profitTarget` = `executedPrice * (1 + PROFIT_TARGET_PCT)`. Use this `qty` in `openTrade` and the `update`.

- [ ] **Step 4: Delta C — onTick uses the per-entry stop + 2-min grace.** In `applyTick`, replace the fixed `HARD_STOP_PCT` threshold logic with the stored `stopPrice`, and skip the stop within `GRACE_MS`:
```ts
// after target-hit check, before the loss-cut block:
const sinceEntryMs = entry.executedAt ? Date.now() - new Date(entry.executedAt).getTime() : Infinity;
const inGrace = sinceEntryMs < GRACE_MS;
const stopPrice = entry.stopPrice ?? (entry.executedPrice ?? entry.initialPrice) * (1 - 0.008);
const breached = sideMul === 1 ? ltp <= stopPrice : ltp >= stopPrice;
if (!inGrace && breached) {
  const cur = entry.slBreachCount ?? 0;
  if (cur < 1) { await this.repo.update(entry.id, { slBreachCount: cur + 1 }); return; } // two-strike guard kept
  const openLoss = this.computeOpenPnl(entry, ltp);
  const cappedExit = sideMul === 1 ? Math.max(ltp, stopPrice) : Math.min(ltp, stopPrice);
  return this.transitionLossCut(entry, cappedExit, openLoss);
}
if (!breached && (entry.slBreachCount ?? 0) > 0) { await this.repo.update(entry.id, { slBreachCount: 0 }); }
```
Delete the old `HARD_STOP_PCT`-threshold computation. Keep `computeOpenPnl`, `transitionLossCut`, partial-exit, trailing-stop unchanged.

- [ ] **Step 5: Write the service test** `adaptive-stop-watch.service.spec.ts` — mirror `ungated-watch.service.spec.ts`'s mocking, plus assert: (a) entry persists `stopPrice`/`stopPct`/`riskAmount`/`atrAtEntry`/`stopBasis`; (b) `qty` equals `sizeQuantity(stopDist)`; (c) within `GRACE_MS` a breach does NOT loss-cut; (d) after grace, two consecutive breaches loss-cut. Use a fake clock by passing `ts`/stubbing `executedAt`.

- [ ] **Step 6: Run** `npx jest src/modules/adaptive-stop-track/services/adaptive-stop-watch.service.spec.ts` → PASS (iterate Deltas until green).

- [ ] **Step 7: Commit.**
```bash
git add apps/api/src/modules/adaptive-stop-track/services/adaptive-stop-watch.service.ts apps/api/src/modules/adaptive-stop-track/services/adaptive-stop-watch.service.spec.ts
git commit -m "feat(adaptive-stop): watch service — vol-stop, risk-first sizing, 2-min grace"
```

---

### Task 5 [parallel-safe, after Task 3]: Tick-poller + comparison + controller (clone)

**Files (clone from ungated, rename map, no behavior change):**
- Create `services/adaptive-stop-tick-poller.service.ts` ← `ungated-tick-poller.service.ts`
- Create `services/adaptive-stop-comparison.service.ts` ← `ungated-comparison.service.ts`
- Create `controllers/adaptive-stop.controller.ts` ← `ungated-track.controller.ts` (route base `adaptive-stop`)

- [ ] **Step 1:** Clone each with the rename map. The poller's cron + `onTick` dispatch stays identical (it calls `adaptiveStopWatch.onTick`). The comparison service keeps the same metric shape (win%, avg/trade, target-hit) reading the adaptive-stop repo.
- [ ] **Step 2: Commit.**
```bash
git add apps/api/src/modules/adaptive-stop-track/services/adaptive-stop-tick-poller.service.ts apps/api/src/modules/adaptive-stop-track/services/adaptive-stop-comparison.service.ts apps/api/src/modules/adaptive-stop-track/controllers
git commit -m "feat(adaptive-stop): clone tick-poller/comparison/controller from ungated"
```

---

### Task 6 [spine, after Tasks 4+5]: Module wiring + Stage-4 hook

**Files:**
- Create: `apps/api/src/modules/adaptive-stop-track/adaptive-stop-track.module.ts` ← clone `ungated-track.module.ts`, rename, register all the new providers/controllers/gateway.
- Modify: `apps/api/src/app.module.ts` — import `AdaptiveStopTrackModule` next to `UngatedTrackModule`.
- Modify: `apps/api/src/modules/chartink/services/chartink-process.service.ts` — inject `AdaptiveStopWatchService` and call it in the `policy.admitted` branch.

- [ ] **Step 1: Module + app registration.** Clone the module file, ensure it imports `MarketDataModule` (for `AngelOneAdapterService`) like ungated does, and exports `AdaptiveStopWatchService`. Add `AdaptiveStopTrackModule` to `app.module.ts` imports.

- [ ] **Step 2: Hook into Stage 4.** In `chartink-process.service.ts`: add constructor param `private readonly adaptiveStopWatch: AdaptiveStopWatchService`. Inside the `if (policy.admitted) { ... }` block, AFTER the existing `this.watch.createFromAlert(...)` try/catch, add a SEPARATE independent block:
```ts
// Adaptive-Stop shadow track — same admitted entry, new vol-stop/sizing.
// Independent try/catch: must never affect the gated or ungated paths.
try {
  await this.adaptiveStopWatch.createFromAlert({
    alertId, setupId: persistedSetup?.id ?? null, symbol: hit.symbol,
    token: instrument.token, exchange: 'NSE', side,
    initialPrice: hit.hitPrice, initialScore: scoringResult.score,
    initialBreakdown: { checks: scoringResult.checks, lotCount: scoringResult.lotCount } as any,
  });
} catch (err) {
  this.logger.warn(`[adaptive-stop] ${hit.symbol}: ${err instanceof Error ? err.message : err}`);
}
```
(Use the SAME inputs the gated `watch.createFromAlert` uses in that branch — match its arg names exactly when reading the file.)

- [ ] **Step 3: Build the API.** Run: `cd apps/api && npx tsc --noEmit -p tsconfig.json` — expect no NEW errors in adaptive-stop files (ignore pre-existing `@td/shared` spurious errors per [[tsc-shared-alias]]; rely on the next jest run too).

- [ ] **Step 4: Run the new module's tests + the chartink suite.**
Run: `npx jest src/modules/adaptive-stop-track src/modules/chartink/services/chartink-process` → PASS.

- [ ] **Step 5: Commit.**
```bash
git add apps/api/src/modules/adaptive-stop-track/adaptive-stop-track.module.ts apps/api/src/app.module.ts apps/api/src/modules/chartink/services/chartink-process.service.ts
git commit -m "feat(adaptive-stop): wire module + Stage-4 hook on admitted entries"
```

---

### Task 7 [spine, after Task 6]: Integration smoke

**Files:** none (manual verification).

- [ ] **Step 1: Confirm the dev API rebuilt** (nest --watch picks up the source changes). `curl -s -o NUL -w "%{http_code}\n" http://127.0.0.1:4001/api/market-data/indices` → `200`.
- [ ] **Step 2: Hit the comparison endpoint.** `curl -s "http://127.0.0.1:4001/api/adaptive-stop/comparison"` (use the actual route the cloned controller exposes) → returns JSON (likely empty pre-market or until new admitted alerts arrive). A 200 with valid shape is success.
- [ ] **Step 3: Confirm the table exists + will populate.** `docker exec td-postgres psql -U postgres -d td_automation -c "SELECT count(*) FROM adaptive_stop_watch_entries;"` → returns a count (0 is fine before the next admitted alert). Note: entries only appear when a NEW alert is admitted by the gated gate while the API is running.

---

## Self-Review

**Spec coverage:**
- Mirror ungated harness + gated entries → Tasks 3/5 (clone) + Task 6 (Stage-4 admitted hook). ✓
- Risk-first sizing + vol-stop + grace → Task 2 (math) + Task 4 (service deltas). ✓
- New Prisma fields (riskAmount/atrAtEntry/stopPct/stopPrice/stopBasis) → Task 1. ✓
- Constants for v1 → Task 2 `constants.ts`. ✓
- Comparison numbers → Task 5. ✓
- Paper-only, independent try/catch → Task 6 hook. ✓
- Backend-only (no UI) → Phase-1 scope respected; no web tasks. ✓
- Tests (sizing, stop resolution, grace) → Task 2 + Task 4 Step 5. ✓

**Placeholder scan:** novel code (constants, math, deltas, hook) is shown in full; boilerplate is "clone file X + rename map + listed deltas" (a concrete transform, not a vague TODO). ✓

**Type consistency:** `resolveStop`/`sizeQuantity` signatures match between Task 2 def and Task 4 use; `AdaptiveStopCreateEntryInput` new fields (Task 3) match what Task 4 writes and Task 1 stores. ✓
