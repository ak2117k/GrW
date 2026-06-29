# Trade Policy & Charges Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add six trading-rule controls to the watch-monitor auto-trade flow — concurrent-duplicate guard, 30-minute re-entry cooldown, an 11:45–14:00 IST stricter score gate, score-tiered capital, a stop-loss of 0.4% of deployed capital, and a real SEBI per-order charge model on both legs.

**Architecture:** Two new pure modules — `trade-policy.ts` (admission + capital) and `trade-charges.ts` (per-order charges) — hold all new rule logic as fully unit-tested pure functions. Existing services (`ChartinkProcessService`, `WatchService`, `WatchMonitorService`, `PaperTradeService`, `TradeExecutionService`) are wired to call them. No DB migration — `WatchEntry.quantity` and `executedPrice` already exist.

**Tech Stack:** NestJS + TypeScript, Prisma (PostgreSQL), Jest (ts-jest). Spec: `docs/superpowers/specs/2026-05-19-trade-policy-rules-design.md`.

**Run tests from `apps/api/`:** `npx jest <path>`.

---

## File Structure

- **Create** `apps/api/src/modules/watch-monitor/services/trade-policy.ts` — pure: `evaluateTradePolicy`, `isStrictWindow` (R3 admission, R4 capital).
- **Create** `apps/api/src/modules/watch-monitor/services/trade-policy.spec.ts`.
- **Create** `apps/api/src/modules/trade-engine/services/trade-charges.ts` — pure: `computeOrderCharges` (R6).
- **Create** `apps/api/src/modules/trade-engine/services/trade-charges.spec.ts`.
- **Modify** `chartink/services/chartink-process.service.ts` — R3 admission gate, R2 cooldown-error catch.
- **Modify** `chartink/services/__tests__/chartink-process.service.spec.ts` — freeze time, R3 tests.
- **Modify** `chartink/workers/chartink-process.worker.ts` — R1 comment.
- **Modify** `watch-monitor/services/watch.service.ts` — R4 sizing, R5 SL helper, R2 cooldown.
- **Modify** `watch-monitor/services/watch.service.spec.ts` — freeze time, R2/R4/R5/R1 tests.
- **Modify** `watch-monitor/services/watch-monitor.service.ts` — R5 SL in the safety net.
- **Modify** `watch-monitor/repositories/watch.repository.ts` — R2 `wasTokenExecutedSince`.
- **Modify** `trade-engine/services/paper-trade.service.ts` — R6 entry charge, exit-charge signature, replay fix.
- **Modify** `trade-engine/services/paper-trade.service.spec.ts` — R6 spec rewrites.
- **Modify** `trade-engine/services/trade-execution.service.ts` — R6 wire charges into both legs.
- **Modify** `trade-engine/services/trade-execution.service.spec.ts` — R6 spec rewrites.

**Implementation order:** Tasks 1–2 (pure modules) first; 3–9 wire them; 10 verifies. Each task is independently committable.

---

### Task 1: `trade-policy.ts` — admission + capital (R3, R4)

**Files:**
- Create: `apps/api/src/modules/watch-monitor/services/trade-policy.ts`
- Test: `apps/api/src/modules/watch-monitor/services/trade-policy.spec.ts`

- [ ] **Step 1: Write the failing test**

`trade-policy.spec.ts`:

```typescript
import { evaluateTradePolicy, isStrictWindow } from './trade-policy';

// A Date whose IST time-of-day is hh:mm. IST = UTC+5:30.
function istAt(hh: number, mm: number): Date {
  const utcMinutes = hh * 60 + mm - (5 * 60 + 30);
  const d = new Date('2026-05-19T00:00:00Z');
  d.setUTCMinutes(d.getUTCMinutes() + utcMinutes);
  return d;
}

describe('isStrictWindow — 11:45-14:00 IST, half-open', () => {
  it('is false at 11:44, true at 11:45, true at 13:59, false at 14:00', () => {
    expect(isStrictWindow(istAt(11, 44))).toBe(false);
    expect(isStrictWindow(istAt(11, 45))).toBe(true);
    expect(isStrictWindow(istAt(13, 59))).toBe(true);
    expect(isStrictWindow(istAt(14, 0))).toBe(false);
  });
});

describe('evaluateTradePolicy — admission (R3)', () => {
  it('outside the window admits score >= 60', () => {
    expect(evaluateTradePolicy({ score: 60, at: istAt(10, 0) }).admitted).toBe(true);
    expect(evaluateTradePolicy({ score: 59, at: istAt(10, 0) }).admitted).toBe(false);
  });

  it('inside the window admits only score >= 75', () => {
    expect(evaluateTradePolicy({ score: 74, at: istAt(12, 0) }).admitted).toBe(false);
    expect(evaluateTradePolicy({ score: 75, at: istAt(12, 0) }).admitted).toBe(true);
    expect(evaluateTradePolicy({ score: 74, at: istAt(12, 0) }).reason)
      .toContain('11:45-14:00');
  });
});

describe('evaluateTradePolicy — capital (R4)', () => {
  it('outside the window: tiered by score, half-open boundaries', () => {
    expect(evaluateTradePolicy({ score: 60, at: istAt(10, 0) }).capital).toBe(100_000);
    expect(evaluateTradePolicy({ score: 64, at: istAt(10, 0) }).capital).toBe(100_000);
    expect(evaluateTradePolicy({ score: 65, at: istAt(10, 0) }).capital).toBe(150_000);
    expect(evaluateTradePolicy({ score: 74, at: istAt(10, 0) }).capital).toBe(150_000);
    expect(evaluateTradePolicy({ score: 75, at: istAt(10, 0) }).capital).toBe(200_000);
    expect(evaluateTradePolicy({ score: 90, at: istAt(10, 0) }).capital).toBe(200_000);
  });

  it('inside the window: flat 1,00,000 regardless of score', () => {
    expect(evaluateTradePolicy({ score: 90, at: istAt(12, 30) }).capital).toBe(100_000);
  });

  it('returns a valid capital even when not admitted (caller uses it unconditionally)', () => {
    const r = evaluateTradePolicy({ score: 50, at: istAt(10, 0) });
    expect(r.admitted).toBe(false);
    expect(r.capital).toBe(100_000);
  });
});
```

- [ ] **Step 2: Run the test, verify it fails**

Run: `npx jest src/modules/watch-monitor/services/trade-policy.spec.ts`
Expected: FAIL — `Cannot find module './trade-policy'`.

- [ ] **Step 3: Write `trade-policy.ts`**

```typescript
/**
 * Trade-admission and capital policy for watch-monitor auto-trades. Pure
 * module — given a score and a timestamp it decides whether a trade is
 * admitted (R3) and how much capital to deploy (R4). One source of truth.
 */

const MIN_SCORE_NORMAL = 60;
const MIN_SCORE_STRICT = 75;

const CAPITAL_TIER_1 = 100_000; // score [60,65)
const CAPITAL_TIER_2 = 150_000; // score [65,75)
const CAPITAL_TIER_3 = 200_000; // score [75,inf)
const STRICT_WINDOW_CAPITAL = 100_000;

export interface TradePolicyInput {
  score: number;
  at: Date;
}

export interface TradePolicyResult {
  admitted: boolean;
  minScore: number;
  /** Capital (INR) to deploy — always a valid tier value, even when not admitted. */
  capital: number;
  reason?: string;
}

/** True when `at`, in IST, is in the half-open window [11:45, 14:00). */
export function isStrictWindow(at: Date): boolean {
  const ist = new Date(at.getTime() + 5.5 * 60 * 60 * 1000);
  const minutesOfDay = ist.getUTCHours() * 60 + ist.getUTCMinutes();
  return minutesOfDay >= 11 * 60 + 45 && minutesOfDay < 14 * 60;
}

export function evaluateTradePolicy(input: TradePolicyInput): TradePolicyResult {
  const strict = isStrictWindow(input.at);
  const minScore = strict ? MIN_SCORE_STRICT : MIN_SCORE_NORMAL;
  const admitted = input.score >= minScore;

  let capital: number;
  if (strict) {
    capital = STRICT_WINDOW_CAPITAL;
  } else if (input.score < 65) {
    capital = CAPITAL_TIER_1;
  } else if (input.score < 75) {
    capital = CAPITAL_TIER_2;
  } else {
    capital = CAPITAL_TIER_3;
  }

  return {
    admitted,
    minScore,
    capital,
    reason: admitted
      ? undefined
      : strict
        ? `score ${input.score} below ${minScore} (11:45-14:00 IST window)`
        : `score ${input.score} below ${minScore}`,
  };
}
```

- [ ] **Step 4: Run the test, verify it passes**

Run: `npx jest src/modules/watch-monitor/services/trade-policy.spec.ts`
Expected: PASS (all describe blocks green).

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/modules/watch-monitor/services/trade-policy.ts apps/api/src/modules/watch-monitor/services/trade-policy.spec.ts
git commit -m "feat(watch-monitor): trade-policy module - time-gated admission + score-tiered capital"
```

---

### Task 2: `trade-charges.ts` — real SEBI per-order charges (R6)

**Files:**
- Create: `apps/api/src/modules/trade-engine/services/trade-charges.ts`
- Test: `apps/api/src/modules/trade-engine/services/trade-charges.spec.ts`

- [ ] **Step 1: Write the failing test**

`trade-charges.spec.ts`:

```typescript
import { computeOrderCharges } from './trade-charges';

describe('computeOrderCharges - Indian equity intraday', () => {
  it('a BUY order: stamp duty present, STT absent', () => {
    // turnover = 100 x 1000 = 100,000
    const c = computeOrderCharges({ side: 'BUY', price: 100, quantity: 1000, exchange: 'NSE' });
    expect(c.stt).toBe(0);
    expect(c.stampDuty).toBeCloseTo(3, 2);          // 0.003% of 100,000
    expect(c.brokerage).toBeCloseTo(20, 2);         // 0.03% = 30, capped at 20
    expect(c.exchangeTxn).toBeCloseTo(2.97, 2);     // 0.00297%
    expect(c.sebiFee).toBeCloseTo(0.1, 2);          // 10 per crore
    expect(c.gst).toBeCloseTo((20 + 2.97) * 0.18, 2);
    expect(c.total).toBeGreaterThan(0);
  });

  it('a SELL order: STT present, stamp duty absent', () => {
    const c = computeOrderCharges({ side: 'SELL', price: 100, quantity: 1000, exchange: 'NSE' });
    expect(c.stampDuty).toBe(0);
    expect(c.stt).toBeCloseTo(25, 2);               // 0.025% of 100,000
  });

  it('brokerage is 0.03% when below the 20-rupee cap', () => {
    // turnover 10,000 -> 0.03% = 3 < 20
    const c = computeOrderCharges({ side: 'BUY', price: 100, quantity: 100, exchange: 'NSE' });
    expect(c.brokerage).toBeCloseTo(3, 2);
  });

  it('BSE uses the higher exchange transaction rate', () => {
    const nse = computeOrderCharges({ side: 'BUY', price: 100, quantity: 1000, exchange: 'NSE' });
    const bse = computeOrderCharges({ side: 'BUY', price: 100, quantity: 1000, exchange: 'BSE' });
    expect(bse.exchangeTxn).toBeGreaterThan(nse.exchangeTxn);
  });

  it('total is the sum of all itemised charges', () => {
    const c = computeOrderCharges({ side: 'SELL', price: 250, quantity: 400, exchange: 'NSE' });
    expect(c.total).toBeCloseTo(
      c.brokerage + c.stt + c.exchangeTxn + c.sebiFee + c.stampDuty + c.gst, 2,
    );
  });
});
```

- [ ] **Step 2: Run the test, verify it fails**

Run: `npx jest src/modules/trade-engine/services/trade-charges.spec.ts`
Expected: FAIL — `Cannot find module './trade-charges'`.

- [ ] **Step 3: Write `trade-charges.ts`**

```typescript
/**
 * Indian equity-intraday charges for a single paper order. Pure module — one
 * source of truth for R6. No DP charges (delivery only), no delivery STT.
 * Exchanges other than NSE use the BSE transaction rate.
 */

const BROKERAGE_RATE = 0.0003;       // 0.03% of turnover
const BROKERAGE_CAP = 20;            // INR 20 per order
const STT_SELL_RATE = 0.00025;       // 0.025% on the sell leg
const EXCHANGE_TXN_NSE = 0.0000297;  // 0.00297%
const EXCHANGE_TXN_BSE = 0.0000375;  // 0.00375%
const SEBI_RATE = 0.000001;          // INR 10 per crore
const STAMP_DUTY_BUY_RATE = 0.00003; // 0.003% on the buy leg
const GST_RATE = 0.18;               // 18% on (brokerage + exchange txn)

export interface OrderChargeInput {
  side: 'BUY' | 'SELL';
  price: number;
  quantity: number;
  exchange: string;
}

export interface OrderCharges {
  brokerage: number;
  stt: number;
  exchangeTxn: number;
  sebiFee: number;
  stampDuty: number;
  gst: number;
  total: number;
}

const round2 = (n: number): number => Math.round(n * 100) / 100;

export function computeOrderCharges(input: OrderChargeInput): OrderCharges {
  const turnover = Math.max(0, input.price) * Math.max(0, input.quantity);
  const isBuy = input.side === 'BUY';
  const isNse = (input.exchange ?? 'NSE').toUpperCase() === 'NSE';

  const brokerage = Math.min(turnover * BROKERAGE_RATE, BROKERAGE_CAP);
  const stt = isBuy ? 0 : turnover * STT_SELL_RATE;
  const exchangeTxn = turnover * (isNse ? EXCHANGE_TXN_NSE : EXCHANGE_TXN_BSE);
  const sebiFee = turnover * SEBI_RATE;
  const stampDuty = isBuy ? turnover * STAMP_DUTY_BUY_RATE : 0;
  const gst = (brokerage + exchangeTxn) * GST_RATE;

  return {
    brokerage: round2(brokerage),
    stt: round2(stt),
    exchangeTxn: round2(exchangeTxn),
    sebiFee: round2(sebiFee),
    stampDuty: round2(stampDuty),
    gst: round2(gst),
    total: round2(brokerage + stt + exchangeTxn + sebiFee + stampDuty + gst),
  };
}
```

- [ ] **Step 4: Run the test, verify it passes**

Run: `npx jest src/modules/trade-engine/services/trade-charges.spec.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/modules/trade-engine/services/trade-charges.ts apps/api/src/modules/trade-engine/services/trade-charges.spec.ts
git commit -m "feat(trade-engine): trade-charges module - real SEBI per-order charge model"
```

---

### Task 3: R3 — time-gated admission in ChartinkProcessService

**Files:**
- Modify: `apps/api/src/modules/chartink/services/chartink-process.service.ts`
- Test: `apps/api/src/modules/chartink/services/__tests__/chartink-process.service.spec.ts`

`processOne` admits a setup with `if (scoringResult.score >= 60)` (line ~274). Replace the flat `60` with `evaluateTradePolicy(...).admitted`.

> **Why the spec is also modified:** the spec's default `scoring.score` mock returns score **70**, and ~20 tests expect `kind: 'setup'`. Once R3 reads `new Date()`, a suite run between 11:45–14:00 IST would set `minScore=75` and reject 70 — breaking those tests non-deterministically. Step 1 freezes the suite clock to 10:00 IST (outside the window) so every existing test is deterministic; the new R3 tests override the clock per-test.

- [ ] **Step 1: Freeze the suite clock (no behaviour change yet)**

In `chartink-process.service.spec.ts`, in the top-level `describe('ChartinkProcessService')` `beforeEach` (starts ~line 44), add as the FIRST line of the callback body:

```typescript
    // R3: freeze the clock to 10:00 IST — outside the 11:45-14:00 strict
    // window — so the default score-70 mock is admitted deterministically.
    jest.useFakeTimers({ now: new Date('2026-05-19T04:30:00Z') });
```

In the `afterEach` (currently `jest.restoreAllMocks();`, ~line 87-89), add a second line:

```typescript
  afterEach(() => {
    jest.restoreAllMocks();
    jest.useRealTimers();
  });
```

Run: `npx jest src/modules/chartink/services/__tests__/chartink-process.service.spec.ts`
Expected: PASS — no behaviour changed, just deterministic time. (If any test errors on a faked timer, add `doNotFake: ['setTimeout','setInterval','setImmediate','nextTick','queueMicrotask']` to the `useFakeTimers` options — it freezes only the clock.)

- [ ] **Step 2: Write the failing R3 tests**

Append to the `describe('Scoring and persistence')` block (it already mocks `mdRepo`/`angelOne` in its own `beforeEach`):

```typescript
    it('rejects a score-70 setup inside the 11:45-14:00 IST window (R3 needs >=75)', async () => {
      jest.setSystemTime(new Date('2026-05-19T06:30:00Z')); // 12:00 IST
      scoring.score.mockResolvedValue({ score: 70, lotCount: 2, checks: [] });

      await service.processOne('alert-1', { symbol: 'RELIANCE', hitPrice: 2885 });

      expect(watchSvc.createFromAlert).not.toHaveBeenCalled();
      expect(repo.createAlertSetup).toHaveBeenCalledWith(expect.objectContaining({
        kind: 'scored-low',
        rejectReason: expect.stringContaining('11:45-14:00'),
      }));
    });

    it('still admits a score-80 setup inside the 11:45-14:00 IST window', async () => {
      jest.setSystemTime(new Date('2026-05-19T06:30:00Z')); // 12:00 IST
      scoring.score.mockResolvedValue({ score: 80, lotCount: 3, checks: [] });

      await service.processOne('alert-1', { symbol: 'RELIANCE', hitPrice: 2885 });

      expect(repo.createAlertSetup).toHaveBeenCalledWith(expect.objectContaining({ kind: 'setup' }));
      expect(watchSvc.createFromAlert).toHaveBeenCalled();
    });
```

- [ ] **Step 3: Run the tests, verify they fail**

Run: `npx jest src/modules/chartink/services/__tests__/chartink-process.service.spec.ts -t "11:45-14:00"`
Expected: FAIL — the first test still produces `kind: 'setup'` (current code admits 70 ≥ 60).

- [ ] **Step 4: Implement the gate**

Add the import at the top of `chartink-process.service.ts`:

```typescript
import { evaluateTradePolicy } from '../../watch-monitor/services/trade-policy';
```

In `processOne`, replace the line `if (scoringResult.score >= 60) {` with:

```typescript
    // R3: admission is delegated to the trade policy — score >= 60 normally,
    // but score >= 75 inside the 11:45-14:00 IST window.
    const policy = evaluateTradePolicy({ score: scoringResult.score, at: new Date() });
    if (policy.admitted) {
```

In the matching `else` branch's `rejectSetup` call, replace the line
`rejectReason: \`score ${scoringResult.score} below 60\`,` with:

```typescript
          rejectReason: policy.reason ?? `score ${scoringResult.score} below ${policy.minScore}`,
```

- [ ] **Step 5: Run the tests, verify they pass**

Run: `npx jest src/modules/chartink/services/__tests__/chartink-process.service.spec.ts`
Expected: PASS — all tests, including the existing `score 40 below 60` / `score 55 below 60` rejections (now produced by the policy at the frozen 10:00 IST time) and the two new window tests.

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/modules/chartink/services/chartink-process.service.ts apps/api/src/modules/chartink/services/__tests__/chartink-process.service.spec.ts
git commit -m "feat(chartink): time-gated admission - score >=75 inside 11:45-14:00 IST (R3)"
```

---

### Task 4: R4 — score-tiered capital sizing in WatchService

**Files:**
- Modify: `apps/api/src/modules/watch-monitor/services/watch.service.ts`
- Test: `apps/api/src/modules/watch-monitor/services/watch.service.spec.ts`

`executeEntry` sizes equity orders as `floor(MAX_INVESTMENT_PER_TRADE / referencePrice)`. Replace the flat `MAX_INVESTMENT_PER_TRADE` with `evaluateTradePolicy(...).capital`. `checkPartialExitTrigger` reconstructs `initialQty` the same wrong way — fix it to use the persisted `entry.quantity`.

> **Why the spec is also modified:** `createFromAlert` and `executeEntry` now call `evaluateTradePolicy(new Date())`. The `createFromAlert` and `Bug A` describe blocks must freeze the clock outside the strict window for determinism. The `auto-executes the paper trade` test asserts an exact quantity sized off a score — its mock must carry an `initialScore`.

- [ ] **Step 1: Freeze the clock in the two executeEntry-exercising blocks**

In `watch.service.spec.ts`, `describe('WatchService.createFromAlert')` `beforeEach` (starts ~line 25), add as the FIRST line of the callback body:

```typescript
    jest.useFakeTimers({ now: new Date('2026-05-19T04:30:00Z') }); // 10:00 IST
```

Its `afterEach` (`jest.restoreAllMocks();`, ~line 60) becomes:

```typescript
  afterEach(() => {
    jest.restoreAllMocks();
    jest.useRealTimers();
  });
```

Do the identical change to `describe('WatchService.executeEntry - live-quote pricing (Bug A)')` — add the `jest.useFakeTimers(...)` line to its `beforeEach` (~line 773) and `jest.useRealTimers()` to its `afterEach` (~line 798).

Run: `npx jest src/modules/watch-monitor/services/watch.service.spec.ts`
Expected: PASS — no behaviour changed yet.

- [ ] **Step 2: Write the failing R4 test**

In `describe('WatchService.executeEntry - live-quote pricing (Bug A)')`, add:

```typescript
  it('sizes the order from the score-tiered capital, not a flat 2L (R4)', async () => {
    // initialScore 72 -> tier [65,75) -> capital 1,50,000; live quote 100.
    repo.findById.mockResolvedValue({ ...watchingEntry, initialScore: 72 });
    brokerAdapter.getLiveQuote.mockResolvedValue({ ltp: 100 });
    trade.executeTrade.mockResolvedValue({ id: 'pt1', entryPrice: 100, quantity: 1500 });

    await svc.executeEntry('w1', { mode: 'paper' });

    // qty = floor(150,000 / 100) = 1500
    expect(trade.executeTrade).toHaveBeenCalledWith(
      expect.objectContaining({ quantity: 1500 }),
    );
  });
```

- [ ] **Step 3: Run the test, verify it fails**

Run: `npx jest src/modules/watch-monitor/services/watch.service.spec.ts -t "score-tiered capital"`
Expected: FAIL — quantity is `floor(200000/100)=2000`, not 1500.

- [ ] **Step 4: Implement R4 in `watch.service.ts`**

Add the import near the top:

```typescript
import { evaluateTradePolicy } from './trade-policy';
```

In `executeEntry`, replace the `computedQty` assignment (currently
`const computedQty = optionsLotSize ? lotCount * optionsLotSize : Math.max(1, Math.floor(MAX_INVESTMENT_PER_TRADE / Math.max(referencePrice, 1)));`) with:

```typescript
    // R4: equity quantity is sized off the score-tiered capital, not a flat
    // 2L. evaluateTradePolicy always returns a valid capital; admission was
    // already decided upstream in ChartinkProcessService.processOne.
    const tradeCapital = evaluateTradePolicy({
      score: entry.initialScore,
      at: new Date(),
    }).capital;
    const computedQty = optionsLotSize
      ? lotCount * optionsLotSize
      : Math.max(1, Math.floor(tradeCapital / Math.max(referencePrice, 1)));
```

In `checkPartialExitTrigger`, replace the `initialQty` line (currently
`const initialQty = Math.max(1, Math.floor(MAX_INVESTMENT_PER_TRADE / Math.max(ref, 1)));`) with:

```typescript
    // Prefer the REAL filled quantity persisted by executeEntry; the
    // floor(MAX/ref) reconstruction is only a fallback for legacy entries.
    const initialQty =
      entry.quantity ??
      Math.max(1, Math.floor(MAX_INVESTMENT_PER_TRADE / Math.max(ref, 1)));
```

(`MAX_INVESTMENT_PER_TRADE` stays imported — it remains the fallback in
`computeOpenPnl` and `checkPartialExitTrigger`.)

- [ ] **Step 5: Update the existing auto-execute test**

In `describe('WatchService.createFromAlert')`, the test
`'auto-executes the paper trade after creating the entry'` seeds `repo.findById`
without `initialScore`. Add `initialScore: 72,` to that `findById` mock object,
and change its `executeTrade` expectation and comment:

```typescript
    expect(mockTrade.executeTrade).toHaveBeenCalledWith(
      expect.objectContaining({
        symbol: 'TCS-EQ',
        side: 'BUY',
        // initialScore 72 -> capital 1,50,000; floor(150,000 / 4000) = 37
        quantity: 37,
        orderType: 'MARKET',
        positionType: 'INTRADAY',
        price: 4000,
      }),
    );
```

- [ ] **Step 6: Run the tests, verify they pass**

Run: `npx jest src/modules/watch-monitor/services/watch.service.spec.ts`
Expected: PASS. The `sizes the auto-executed order within the per-trade risk cap` test still passes — its `findById` mock has no `initialScore`, so the policy sees an undefined score and returns the ₹2L tier; `floor(200000/2000)=100`, orderValue `200000 ≤ DEFAULT_MAX_CAPITAL_PER_TRADE`.

- [ ] **Step 7: Commit**

```bash
git add apps/api/src/modules/watch-monitor/services/watch.service.ts apps/api/src/modules/watch-monitor/services/watch.service.spec.ts
git commit -m "feat(watch-monitor): size orders from score-tiered capital (R4)"
```

---

### Task 5: R5 — stop-loss = 0.4% of deployed capital

**Files:**
- Modify: `apps/api/src/modules/watch-monitor/services/watch.service.ts`
- Modify: `apps/api/src/modules/watch-monitor/services/watch-monitor.service.ts`
- Test: `apps/api/src/modules/watch-monitor/services/watch.service.spec.ts`

The hard loss-cut threshold is the flat `HARD_LOSS_CUT_RUPEES` (₹1,000) at three call sites. Replace it with `0.004 × quantity × executedPrice` per entry; `HARD_LOSS_CUT_RUPEES` stays as the legacy fallback for entries with no `quantity`.

> **Why an existing test is replaced, not just retuned:** R5 makes the threshold scale *with* quantity, so the loss-cut *trigger price* becomes quantity-independent (`executedPrice × (1 ± 0.004)`). The existing test `'sizes the loss-cut off entry.quantity, not the floor(MAX/price) estimate'` tests a premise (a bigger qty crosses a fixed ₹ threshold sooner) that R5 voids. Step 1 replaces it.

- [ ] **Step 1: Replace the obsolete test, write the failing R5 tests**

In `watch.service.spec.ts`, `describe('WatchService.onTick - hard loss-cut')`, **delete** the test `'sizes the loss-cut off entry.quantity, not the floor(MAX/price) estimate'` and add in its place:

```typescript
  it('hard-cuts at 0.4% of deployed capital (quantity x executedPrice) (R5)', async () => {
    // quantity 100, executedPrice 2000 -> deployed 200,000 -> SL = 0.4% = 800.
    // BUY: at ltp 1992 the loss is (1992-2000)*100 = -800 -> at threshold -> cut.
    repo.findActiveByToken.mockResolvedValue([tradedEntry({ quantity: 100 })]);

    await svc.onTick('11536', 1992, new Date());

    expect(repo.update).toHaveBeenCalledWith('w1', expect.objectContaining({
      status: 'STOPPED', closedReason: 'loss-cut',
    }));
  });

  it('does NOT hard-cut at -700 when the 0.4%-of-capital threshold is 800 (R5)', async () => {
    // ltp 1993 -> loss (1993-2000)*100 = -700, inside the 800 threshold.
    repo.findActiveByToken.mockResolvedValue([tradedEntry({ quantity: 100 })]);

    await svc.onTick('11536', 1993, new Date());

    const cut = (repo.update.mock.calls as any[]).find(
      (c) => c[1]?.closedReason === 'loss-cut',
    );
    expect(cut).toBeUndefined();
  });
```

- [ ] **Step 2: Run the tests, verify they fail**

Run: `npx jest src/modules/watch-monitor/services/watch.service.spec.ts -t "0.4%"`
Expected: FAIL — under the flat ₹1,000 threshold a -₹800 loss does not cut, so the first test fails.

- [ ] **Step 3: Add the `hardLossCutRupees` helper**

In `watch.service.ts`, immediately AFTER the `HARD_LOSS_CUT_RUPEES` constant
declaration, add:

```typescript
/**
 * Hard price loss-cut threshold for a trade (R5): 0.4% of the deployed
 * capital (quantity x executedPrice). Replaces the flat HARD_LOSS_CUT_RUPEES,
 * which now only serves as the fallback for legacy entries with no `quantity`.
 */
export function hardLossCutRupees(entry: {
  quantity?: number | null;
  executedPrice?: number | null;
  initialPrice?: number | null;
}): number {
  const qty = entry.quantity ?? 0;
  const price = entry.executedPrice ?? entry.initialPrice ?? 0;
  const deployed = qty * price;
  return deployed > 0 ? 0.004 * deployed : HARD_LOSS_CUT_RUPEES;
}
```

- [ ] **Step 4: Use the helper at the three call sites**

In `watch.service.ts`:
- In `applyTick`, change `if (openPnl <= -HARD_LOSS_CUT_RUPEES) {` to
  `if (openPnl <= -hardLossCutRupees(entry)) {`.
- In `transitionLossCut`, change `if (confirmPnl > -HARD_LOSS_CUT_RUPEES) {` to
  `if (confirmPnl > -hardLossCutRupees(entry)) {`.
- In `transitionLossCut`'s warn log, change the fragment
  `` (≥ ₹${HARD_LOSS_CUT_RUPEES} threshold)`, `` to
  `` (≥ ₹${hardLossCutRupees(entry).toFixed(0)} threshold)`, ``.

In `watch-monitor.service.ts`:
- Change the import line `import { WatchService, HARD_LOSS_CUT_RUPEES } from './watch.service';`
  to `import { WatchService, HARD_LOSS_CUT_RUPEES, hardLossCutRupees } from './watch.service';`.
- In `checkOpenLoss`, change `if (openPnl <= -HARD_LOSS_CUT_RUPEES) {` to
  `if (openPnl <= -hardLossCutRupees(entry)) {`.
- In `checkOpenLoss`'s warn log, change `(≥ ₹${HARD_LOSS_CUT_RUPEES})` to
  `(≥ ₹${hardLossCutRupees(entry).toFixed(0)})`.

(`HARD_LOSS_CUT_RUPEES` stays exported and imported — it is the fallback inside `hardLossCutRupees`.)

- [ ] **Step 5: Run the tests, verify they pass**

Run: `npx jest src/modules/watch-monitor/services/watch.service.spec.ts src/modules/watch-monitor/services/watch-monitor.service.spec.ts`
Expected: PASS. The other hard-loss-cut tests use `tradedEntry()` with no `quantity`, so `hardLossCutRupees` falls back to ₹1,000 and they are unchanged. If a `watch-monitor.service.spec.ts` test fails because its entry mock carries a `quantity`, recompute its expected threshold as `0.004 × quantity × executedPrice` and adjust the tick price.

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/modules/watch-monitor/services/watch.service.ts apps/api/src/modules/watch-monitor/services/watch-monitor.service.ts apps/api/src/modules/watch-monitor/services/watch.service.spec.ts
git commit -m "feat(watch-monitor): stop-loss = 0.4% of deployed capital (R5)"
```

---

### Task 6: R2 — 30-minute re-entry cooldown

**Files:**
- Modify: `apps/api/src/modules/watch-monitor/repositories/watch.repository.ts`
- Modify: `apps/api/src/modules/watch-monitor/services/watch.service.ts`
- Modify: `apps/api/src/modules/chartink/services/chartink-process.service.ts`
- Test: `apps/api/src/modules/watch-monitor/services/watch.service.spec.ts`

`createFromAlert` must reject a symbol executed within the last 30 minutes.

- [ ] **Step 1: Add the default repo mock + write the failing test**

In `watch.service.spec.ts`, `describe('WatchService.createFromAlert')` `beforeEach`,
add one key to the `repo` mock object so the existing tests exercise the
no-cooldown path:

```typescript
      wasTokenExecutedSince: jest.fn().mockResolvedValue(false),
```

Add `TradeCooldownError` to the import on line 3:
`import { WatchService, WatchCapExceededError, TradeCooldownError } from './watch.service';`

Add the test to that block:

```typescript
  it('rejects a symbol traded within the last 30 minutes (R2 cooldown)', async () => {
    repo.findActiveBySetupId.mockResolvedValue(null);
    repo.findActiveByToken.mockResolvedValue([]);
    repo.wasTokenExecutedSince.mockResolvedValue(true);

    await expect(svc.createFromAlert(baseInput)).rejects.toBeInstanceOf(
      TradeCooldownError,
    );
    expect(repo.createEntry).not.toHaveBeenCalled();
  });
```

- [ ] **Step 2: Run the test, verify it fails**

Run: `npx jest src/modules/watch-monitor/services/watch.service.spec.ts -t "30 minutes"`
Expected: FAIL — `TradeCooldownError` is not exported / not thrown.

- [ ] **Step 3: Add the repo query**

In `watch.repository.ts`, add a method to the `WatchRepository` class:

```typescript
  /**
   * True if any watch entry for this token was EXECUTED at or after `since`.
   * Backs the 30-minute re-entry cooldown (R2).
   */
  async wasTokenExecutedSince(token: string, since: Date): Promise<boolean> {
    const count = await this.prisma.watchEntry.count({
      where: { token, executedAt: { gte: since } },
    });
    return count > 0;
  }
```

- [ ] **Step 4: Add the error class + cooldown check**

In `watch.service.ts`, immediately after the `WatchCapExceededError` class, add:

```typescript
/** Re-entry cooldown window (R2): no new trade for a symbol within this many
 *  ms of its last execution. */
export const TRADE_COOLDOWN_MS = 30 * 60_000;

export class TradeCooldownError extends Error {
  constructor(symbol: string) {
    super(`${symbol}: traded within the last 30 minutes - cooldown active`);
    this.name = 'TradeCooldownError';
  }
}
```

In `createFromAlert`, immediately AFTER the Tier-2 token-dedup block (the
`existingByToken` check that ends with `return reused;`) and BEFORE
`const active = await this.repo.countActive();`, add:

```typescript
    // R2: 30-minute re-entry cooldown. A symbol executed in the last 30 min
    // may not be re-traded even though its prior trade has already closed
    // (which is why the active-token dedup above did not catch it).
    const cooldownSince = new Date(Date.now() - TRADE_COOLDOWN_MS);
    if (await this.repo.wasTokenExecutedSince(input.token, cooldownSince)) {
      this.logger.warn(
        formatTradeRejection({
          symbol: input.symbol,
          side: input.side,
          stage: 'watch',
          reason: 'symbol traded within the last 30 min - cooldown active',
        }),
      );
      throw new TradeCooldownError(input.symbol);
    }
```

- [ ] **Step 5: Handle the new error in the Chartink caller**

In `chartink-process.service.ts`, change the import of watch-service symbols to
include `TradeCooldownError` (the file already imports `WatchCapExceededError`
from `../../watch-monitor/services/watch.service`):

```typescript
import { WatchService, WatchCapExceededError, TradeCooldownError } from '../../watch-monitor/services/watch.service';
```

In `processOne`, in the `catch (err)` around `this.watch.createFromAlert(...)`,
change the `if/else` to:

```typescript
        if (err instanceof WatchCapExceededError) {
          this.logger.warn(`watch cap exceeded - skipping ${hit.symbol}`);
        } else if (err instanceof TradeCooldownError) {
          this.logger.log(`cooldown active - skipping ${hit.symbol}`);
        } else {
          this.logger.warn(
            `watch.createFromAlert failed for ${hit.symbol}: ${err instanceof Error ? err.message : err}`,
          );
        }
```

- [ ] **Step 6: Run the tests, verify they pass**

Run: `npx jest src/modules/watch-monitor/services/watch.service.spec.ts src/modules/chartink/services/__tests__/chartink-process.service.spec.ts`
Expected: PASS. The chartink spec's `watchSvc.createFromAlert` is a mock that resolves, so the cooldown path is not exercised there — no chartink spec change is needed.

- [ ] **Step 7: Commit**

```bash
git add apps/api/src/modules/watch-monitor/repositories/watch.repository.ts apps/api/src/modules/watch-monitor/services/watch.service.ts apps/api/src/modules/watch-monitor/services/watch.service.spec.ts apps/api/src/modules/chartink/services/chartink-process.service.ts
git commit -m "feat(watch-monitor): 30-minute re-entry cooldown per symbol (R2)"
```

---

### Task 7: R1 — lock the concurrent-duplicate guard

**Files:**
- Modify: `apps/api/src/modules/chartink/workers/chartink-process.worker.ts`
- Test: `apps/api/src/modules/watch-monitor/services/watch.service.spec.ts`

`ChartinkProcessWorker` uses `@Process('process')` with no concurrency option → Bull default concurrency 1 → Chartink alerts process strictly serially, and `processAlert` loops hits sequentially. The existing `findActiveByToken` reuse guard in `createFromAlert` therefore cannot race. This task locks that guarantee with a regression test and a code comment — no production logic changes.

- [ ] **Step 1: Write the regression test**

In `watch.service.spec.ts`, `describe('WatchService.createFromAlert')`, add:

```typescript
  it('R1: does not create a second entry while one is active for the symbol', async () => {
    repo.findActiveBySetupId.mockResolvedValue(null);
    repo.findActiveByToken.mockResolvedValue([
      { id: 'already-open', token: '11536', status: 'TRADED', symbol: 'TCS-EQ' },
    ]);

    const r = await svc.createFromAlert(baseInput);

    expect(r.id).toBe('already-open');
    expect(repo.createEntry).not.toHaveBeenCalled();
  });
```

- [ ] **Step 2: Run the test, verify it passes immediately**

Run: `npx jest src/modules/watch-monitor/services/watch.service.spec.ts -t "R1:"`
Expected: PASS — this locks existing correct behaviour (serial worker + reuse guard). If it FAILS, the guard has regressed and must be fixed before continuing.

- [ ] **Step 3: Add the worker comment**

In `chartink-process.worker.ts`, immediately above the `@Process('process')`
decorator, add:

```typescript
  // Bull default concurrency is 1 — Chartink alert jobs run strictly
  // serially, so the createFromAlert same-symbol reuse guard cannot race.
  // Do NOT raise concurrency without first making that guard atomic.
```

- [ ] **Step 4: Commit**

```bash
git add apps/api/src/modules/watch-monitor/services/watch.service.spec.ts apps/api/src/modules/chartink/workers/chartink-process.worker.ts
git commit -m "test(watch-monitor): lock the concurrent-duplicate guard (R1)"
```

---

### Task 8: R6 (part 1) — charges in PaperTradeService

**Files:**
- Modify: `apps/api/src/modules/trade-engine/services/paper-trade.service.ts`
- Test: `apps/api/src/modules/trade-engine/services/paper-trade.service.spec.ts`

Add `applyEntryCharge`, make `applyExitAccounting` take the charge as a parameter (replacing the flat `BROKER_CHARGE_PER_EXIT`), and fix the startup replay so an open trade's recorded entry charge is not lost on restart.

> **Why the spec is rewritten:** `paper-trade.service.spec.ts` imports `BROKER_CHARGE_PER_EXIT` and the `applyExitAccounting - broker charge + deferred profit` block hard-codes the flat ₹100. R6 removes that constant, so the import and that block must be rewritten.

- [ ] **Step 1: Rewrite the spec for the new signatures (failing)**

In `paper-trade.service.spec.ts`:

a) Change line 2 — remove `BROKER_CHARGE_PER_EXIT` from the import:
`import { PaperTradeService } from './paper-trade.service';`

b) Replace the entire `describe('PaperTradeService.applyExitAccounting - broker charge + deferred profit', ...)` block with:

```typescript
describe('PaperTradeService - entry & exit charges (R6)', () => {
  let service: PaperTradeService;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        PaperTradeService,
        { provide: TradeRepository, useValue: mockTradeRepository },
        { provide: MarketFeedService, useValue: mockMarketFeed },
      ],
    }).compile();
    service = module.get(PaperTradeService);
    service.resetVirtualPortfolio(2_000_000);
  });

  it('applyEntryCharge debits the supplied charge from the virtual balance', () => {
    service.applyEntryCharge(57.34);
    expect(service.getVirtualBalance()).toBeCloseTo(2_000_000 - 57.34, 2);
  });

  it('a losing exit deducts the supplied exit charge and defers nothing', async () => {
    const charge = service.applyExitAccounting(-5000, 42.5);
    expect(charge).toBe(42.5);
    expect(service.getVirtualBalance()).toBeCloseTo(2_000_000 - 42.5, 2);
    expect((await service.getAccount()).pendingProfit).toBe(0);
  });

  it('a winning exit withholds the profit and deducts the exit charge', async () => {
    const charge = service.applyExitAccounting(8000, 55);
    expect(charge).toBe(55);
    expect(service.getVirtualBalance()).toBeCloseTo(2_000_000 - 8000 - 55, 2);
    expect((await service.getAccount()).pendingProfit).toBe(8000);
  });
});
```

c) In `describe('PaperTradeService.settlePendingProfit ...')`, the first test calls
`service.applyExitAccounting(8000);` — change it to `service.applyExitAccounting(8000, 100);`
(its comment/expectation `2_000_000 - 100` stay correct). The third test also calls
`service.applyExitAccounting(8000);` — change it to `service.applyExitAccounting(8000, 100);`.

d) Add a startup-replay test to `describe('PaperTradeService.onModuleInit - balance + position rehydration', ...)`:

```typescript
  it('subtracts an OPEN trade recorded entry-charge fees from the replayed balance', async () => {
    const openTrades = [
      {
        status: 'OPEN', side: 'BUY', quantity: 10, entryPrice: 1000, pnl: null, fees: 37,
        instrument: { symbol: 'TCS-EQ', exchange: 'NSE' },
      },
    ];
    const repo = {
      findPaperTradesSince: jest.fn().mockResolvedValue(openTrades),
      getOpenTrades: jest.fn().mockResolvedValue(openTrades),
    };
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        PaperTradeService,
        { provide: TradeRepository, useValue: repo },
        { provide: MarketFeedService, useValue: mockMarketFeed },
      ],
    }).compile();
    const service = module.get<PaperTradeService>(PaperTradeService);
    await service.onModuleInit();

    // balance = 20L - 10,000 (open BUY cost) - 37 (recorded entry charge)
    expect(service.getVirtualBalance()).toBe(2_000_000 - 10_000 - 37);
  });
```

- [ ] **Step 2: Run the spec, verify it fails**

Run: `npx jest src/modules/trade-engine/services/paper-trade.service.spec.ts`
Expected: FAIL — `applyEntryCharge` is undefined; `applyExitAccounting` ignores the 2nd arg; the OPEN-fees replay does not subtract `fees`.

- [ ] **Step 3: Implement in `paper-trade.service.ts`**

a) Delete the `export const BROKER_CHARGE_PER_EXIT = 100;` declaration and its
doc comment.

b) Replace the whole `applyExitAccounting(realizedPnl: number): number { ... }`
method with:

```typescript
  /**
   * Apply paper-account accounting for ONE position exit (close event).
   *
   * `exitCharge` is the real per-order charge (see trade-charges.ts), passed
   * in by the caller. The SELL fill in fillAtPrice() already credited the
   * full exit value to cash, so here:
   *   - LOSS  : just remove the exit charge.
   *   - PROFIT: claw the realized gain back out of cash into `pendingProfit`
   *             (released at the 18:00 settlement), and remove the charge.
   *
   * Returns the charge so the caller can record it on the trade's `fees`.
   */
  applyExitAccounting(realizedPnl: number, exitCharge: number): number {
    this.virtualBalance -= exitCharge;
    if (realizedPnl > 0) {
      this.virtualBalance -= realizedPnl;
      this.pendingProfit += realizedPnl;
      this.logger.log(
        `[Paper] Exit accounting: -₹${exitCharge.toFixed(2)} charges, ` +
          `₹${realizedPnl.toFixed(0)} profit deferred to 18:00 settlement ` +
          `(pending=₹${this.pendingProfit.toFixed(0)})`,
      );
    } else {
      this.logger.log(
        `[Paper] Exit accounting: -₹${exitCharge.toFixed(2)} charges ` +
          `(loss of ₹${Math.abs(realizedPnl).toFixed(0)} booked)`,
      );
    }
    return exitCharge;
  }

  /** Debit a paper ENTRY order's charges from the virtual balance (R6). */
  applyEntryCharge(charge: number): void {
    this.virtualBalance -= charge;
    this.logger.log(`[Paper] Entry charges: -₹${charge.toFixed(2)}`);
  }
```

c) In `onModuleInit`, in the OPEN/PARTIALLY_FILLED branch, immediately after the
`if (t.side === 'BUY') { bal -= remainingValue; } else { bal += remainingValue; }`
block, add:

```typescript
        // An OPEN trade's entry charge was debited live by applyEntryCharge
        // and recorded on `fees`; subtract it so a restart is exact. (A
        // PARTIALLY_FILLED trade's fees are already netted by the pnl-fees
        // line below, so only do this for pure-OPEN.)
        if (t.status === 'OPEN') {
          bal -= t.fees ?? 0;
        }
```

- [ ] **Step 4: Run the spec, verify it passes**

Run: `npx jest src/modules/trade-engine/services/paper-trade.service.spec.ts`
Expected: PASS — all blocks, including the unchanged netting / rehydration / terminal-status / REST-fallback blocks.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/modules/trade-engine/services/paper-trade.service.ts apps/api/src/modules/trade-engine/services/paper-trade.service.spec.ts
git commit -m "feat(trade-engine): per-order charges in PaperTradeService - entry charge + parameterised exit charge (R6)"
```

---

### Task 9: R6 (part 2) — wire charges into TradeExecutionService

**Files:**
- Modify: `apps/api/src/modules/trade-engine/services/trade-execution.service.ts`
- Test: `apps/api/src/modules/trade-engine/services/trade-execution.service.spec.ts`

Charge the BUY entry order at fill, and pass the real SELL exit charge into `applyExitAccounting`.

> **Why the spec is rewritten:** the `closeTrade - broker charge` block hard-codes the flat ₹100 (`applyExitAccounting` called with one arg, `fees` asserted as 100/200). The `executeTrade - paper-trade entry price` block's `paperService` mock has no `applyEntryCharge`. Both must be updated.

- [ ] **Step 1: Update the spec for the new wiring (failing)**

In `trade-execution.service.spec.ts`:

a) In `describe('TradeExecutionService.executeTrade - paper-trade entry price')`,
widen the `paperService` type declaration — change
`let paperService: { simulateOrder: jest.Mock; simulateTick: jest.Mock };` to
`let paperService: { simulateOrder: jest.Mock; simulateTick: jest.Mock; applyEntryCharge: jest.Mock };`.
Add `applyEntryCharge: jest.fn(),` to the `paperService` object built in that
block's `beforeEach`. Then add a test:

```typescript
  it('charges the entry order and records it on the trade fees (R6)', async () => {
    const trade = await service.executeTrade({
      symbol: 'NIFTY24MAY22500CE', token: '99926000', exchange: 'NFO',
      side: 'BUY' as any, orderType: 'MARKET' as any, quantity: 50,
      positionType: 'INTRADAY' as any,
    } as any);

    expect(paperService.applyEntryCharge).toHaveBeenCalledTimes(1);
    expect(repo.updateTrade).toHaveBeenCalledWith(
      trade.id, expect.objectContaining({ fees: expect.any(Number) }),
    );
    const fees = (repo.updateTrade as jest.Mock).mock.calls[0][1].fees;
    expect(fees).toBeGreaterThan(0);
  });
```

b) Replace the FIVE tests inside `describe('TradeExecutionService.closeTrade - broker charge')`
with these (the seed/`beforeEach` of that block is unchanged):

```typescript
  it('routes a paper exit through applyExitAccounting with the slice P&L and a charge', async () => {
    await service.closeTrade('trade_1', { exitReasonTag: ExitReasonTag.HIT_TARGET });

    // slice P&L = (130.5 - 100) * 50 = 1525
    expect(paperService.applyExitAccounting).toHaveBeenCalledTimes(1);
    expect(paperService.applyExitAccounting).toHaveBeenCalledWith(1525, expect.any(Number));
  });

  it('records the real exit charge on the trade fees field (full close)', async () => {
    const trade = await service.closeTrade('trade_1');
    // Real SEBI charges on a ~6,525 turnover are a few rupees, not a flat 100.
    expect(trade.fees).toBeGreaterThan(0);
    expect(trade.fees).toBeLessThan(100);
  });

  it('charges a partial close too - slice P&L and fees both reflect the slice', async () => {
    const trade = await service.closeTrade('trade_1', { quantity: 20 });

    // slice P&L = (130.5 - 100) * 20 = 610
    expect(paperService.applyExitAccounting).toHaveBeenCalledWith(610, expect.any(Number));
    expect(trade.status).toBe('PARTIALLY_FILLED');
    expect(trade.fees).toBeGreaterThan(0);
  });

  it('accumulates fees across exits - a second close adds another charge', async () => {
    repo._trades['trade_1'].fees = 50; // an earlier leg already charged 50
    const trade = await service.closeTrade('trade_1');
    expect(trade.fees).toBeGreaterThan(50);
  });

  it('does NOT charge brokerage when closing a live (non-paper) trade', async () => {
    repo._trades['trade_1'].isPaperTrade = false;
    await service.closeTrade('trade_1');
    expect(paperService.applyExitAccounting).not.toHaveBeenCalled();
  });
```

(The block's `paperService.applyExitAccounting` mock is `jest.fn(() => 100)` —
leave it; the tests above assert call arguments and the persisted `fees`, both
of which work with that return value.)

- [ ] **Step 2: Run the spec, verify it fails**

Run: `npx jest src/modules/trade-engine/services/trade-execution.service.spec.ts`
Expected: FAIL — `applyEntryCharge` is never called; `applyExitAccounting` is called with one arg; `fees` is the flat 100.

- [ ] **Step 3: Implement in `trade-execution.service.ts`**

a) Add the import near the top:

```typescript
import { computeOrderCharges } from './trade-charges';
```

b) In `executeTrade`, immediately AFTER the
`if (isPaperTrade && initialStatus === 'OPEN' && entryPrice) { this.positionManagerService.addPosition(...) }`
block, add:

```typescript
    // R6: charge the paper ENTRY order and record it on the trade row so the
    // startup balance replay can reconstruct it.
    if (isPaperTrade && initialStatus === 'OPEN' && entryPrice) {
      const entryCharges = computeOrderCharges({
        side: request.side as 'BUY' | 'SELL',
        price: entryPrice,
        quantity: request.quantity,
        exchange: request.exchange,
      });
      this.paperTradeService.applyEntryCharge(entryCharges.total);
      await this.tradeRepository.updateTrade(trade.id, { fees: entryCharges.total });
    }
```

c) In `closeTrade`, replace the `brokerCharge` assignment (currently
`const brokerCharge = trade.isPaperTrade ? this.paperTradeService.applyExitAccounting(slicePnl) : 0;`)
with:

```typescript
    // R6: real per-order charges on the SELL exit leg, applied to the paper
    // account and accumulated onto the trade's `fees`.
    const exitCharges = computeOrderCharges({
      side: exitSide as 'BUY' | 'SELL',
      price: exitPrice,
      quantity: closeQty,
      exchange: instrument?.exchange ?? 'NSE',
    });
    const brokerCharge = trade.isPaperTrade
      ? this.paperTradeService.applyExitAccounting(slicePnl, exitCharges.total)
      : 0;
```

(`exitSide` and `instrument` are already declared earlier in `closeTrade`;
`const totalFees = (trade.fees ?? 0) + brokerCharge;` is unchanged.)

- [ ] **Step 4: Run the spec, verify it passes**

Run: `npx jest src/modules/trade-engine/services/trade-execution.service.spec.ts`
Expected: PASS — all blocks. The `closeTrade - exit-reason persistence` and
`closeTrade - paper-trade exit price` blocks use `applyExitAccounting: jest.fn(() => 100)`
and assert `pnl`/`exitPrice` (not `fees`), so they are unaffected.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/modules/trade-engine/services/trade-execution.service.ts apps/api/src/modules/trade-engine/services/trade-execution.service.spec.ts
git commit -m "feat(trade-engine): charge real SEBI fees on both entry and exit orders (R6)"
```

---

### Task 10: Full verification

- [ ] **Step 1: Run every affected suite**

Run: `npx jest src/modules/watch-monitor src/modules/trade-engine src/modules/chartink`
Expected: all suites PASS.

- [ ] **Step 2: Type-check**

Run (from `apps/api/`): `npx tsc --noEmit -p tsconfig.json`
Expected: no NEW errors in the touched files. The pre-existing standalone
`@td/shared/types` "Cannot find module" errors are a known moduleResolution
artifact (ts-jest resolves fine) — ignore those, do not chase them.

- [ ] **Step 3: Restart the dev server and smoke-check**

Stop the running API, then `npm run dev`. Confirm the API boots with no Nest
DI errors and `GET http://127.0.0.1:4001/api/trades/paper-account` responds.

- [ ] **Step 4: Commit any verification adjustments**

```bash
git status
# commit any test-expectation tweaks made during verification, if any
```

---

## Notes for the implementer

- `evaluateTradePolicy` always returns a valid `capital` even when `admitted`
  is false — `executeEntry` (Task 4) uses `.capital` unconditionally; the
  admission gate (Task 3) uses `.admitted`. They run ~1s apart, both with
  `new Date()`.
- `MAX_INVESTMENT_PER_TRADE` / `DEFAULT_MAX_CAPITAL_PER_TRADE` is NOT removed —
  it stays the legacy fallback in `computeOpenPnl` and `checkPartialExitTrigger`
  for entries persisted before `quantity` existed.
- "Capital used" for the R5 stop is the actual `quantity × executedPrice`, not
  the decided tier capital (they differ by the `floor()` remainder).
- The two pure modules (Tasks 1–2) have zero dependency on the wiring tasks and
  can be built and verified first in isolation.
- Several existing tests assert exact quantities / fees built on the old flat
  ₹2L / ₹1,000 / ₹100. Where this plan updates them, that is a deliberate
  behaviour change, not a regression. Only treat a failure as a real break if
  the *status* or *direction* of an outcome changed (e.g. a trade that should
  cut no longer cuts).
