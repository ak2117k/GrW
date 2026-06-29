# TP1 at Obstacle Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `LevelsContextStrategy.computeSlAndTarget` obstacle-aware so TP1 books partial at the first STRONG/MEDIUM zone (touchCount ≥ 3) in the trade path, instead of a fixed `1×R`. Runner + trailing logic unchanged.

**Architecture:** A two-field addition to the `SetupContext` type (`tp1Source`, `tp1Obstacle`), an algorithm change inside `computeSlAndTarget`, plumbing of `zones: StrongZone[]` from `SignalGeneratorService.analyze` into the strategy via `AnalyzeInput`, and a TP1-row subtitle in the AnalysisPanel.

**Tech Stack:** TypeScript, NestJS, Jest (backend), React + TailwindCSS (frontend), Prisma (`setupContext` is `Json?` — no migration).

**Spec:** `docs/superpowers/specs/2026-05-05-tp1-at-obstacle-design.md`

---

## File Structure

| File | Responsibility | Modify or Create |
|---|---|---|
| `apps/api/src/modules/signal-generator/types/setup-context.types.ts` | Define `tp1Source` + `tp1Obstacle` on `SetupContext` | Modify |
| `apps/api/src/modules/signal-generator/strategies/levels-context.strategy.ts` | Accept `zones` in `AnalyzeInput`, implement obstacle-aware `computeSlAndTarget`, populate new fields on `SetupContext` | Modify |
| `apps/api/src/modules/signal-generator/strategies/levels-context.strategy.spec.ts` | Unit-test the 9 obstacle scenarios | Modify |
| `apps/api/src/modules/signal-generator/services/signal-generator.service.ts` | Fetch active zones via `ZoneRepository.findActiveByToken` and pass into `strategy.analyze({...})` | Modify |
| `apps/api/src/modules/signal-generator/services/setup-tracker.service.spec.ts` | Confirm new fields round-trip through lock → persist → re-load | Modify |
| `apps/web/src/types/index.ts` | Mirror new optional fields on the frontend `SetupContext` | Modify |
| `apps/web/src/components/charts/AnalysisPanel.tsx` | Mirror fields on `SetupAnalysis`; render subtitle on TP1 row when `tp1Source === 'obstacle'` | Modify |

---

## Task 1 — Add type fields to `SetupContext` (backend)

**Files:**
- Modify: `apps/api/src/modules/signal-generator/types/setup-context.types.ts`

- [ ] **Step 1: Add the two optional fields to the `SetupContext` interface**

Open the file and append the new fields just before the closing brace of `SetupContext` (after `expiryDayWarning?: boolean;` on line ~93):

```typescript
  /**
   * How TP1 (`partialTakeAt`) was placed:
   *   'fixed'    → entry ± 1×R (the historical default)
   *   'obstacle' → near edge of a STRONG/MEDIUM zone (touchCount ≥ 3) in
   *                the trade path, with a 0.1×ATR buffer.
   *
   * Optional so persisted setups from before this field existed still
   * rehydrate cleanly (Prisma column is `Json?`).
   */
  tp1Source?: 'obstacle' | 'fixed';

  /**
   * Metadata about the obstacle that drove TP1 placement, populated only
   * when `tp1Source === 'obstacle'`. Surfaces in the AnalysisPanel TP1 row
   * so the trader can see WHY TP1 sits where it does.
   */
  tp1Obstacle?: {
    classification: 'STRONG' | 'MEDIUM';
    touchCount: number;
    /** The band edge price hits FIRST in the trade direction (upper for SELL, lower for BUY). */
    nearEdge: number;
  } | null;
```

- [ ] **Step 2: Verify the file compiles**

Run: `cd apps/api && npx tsc --noEmit -p tsconfig.json 2>&1 | grep -i setup-context.types || echo "OK"`
Expected: `OK` (no errors mentioning setup-context.types).

- [ ] **Step 3: Commit**

```bash
git add apps/api/src/modules/signal-generator/types/setup-context.types.ts
git commit -m "feat(signals): add tp1Source + tp1Obstacle fields to SetupContext

Optional fields populated by the upcoming obstacle-aware TP1 placement
in computeSlAndTarget. Optional so persisted setups without these
fields rehydrate unchanged."
```

---

## Task 2 — Strategy unit tests (TDD: write first, run-fail)

**Files:**
- Modify: `apps/api/src/modules/signal-generator/strategies/levels-context.strategy.spec.ts`

- [ ] **Step 1: Read the existing spec file to learn its fixture conventions**

Run: `head -120 apps/api/src/modules/signal-generator/strategies/levels-context.strategy.spec.ts`
Identify: how `computeSlAndTarget` is invoked (via the public `analyze()` or directly), how `LevelBook` and `CandleData[]` fixtures are built, how zones (if any) are passed today.

- [ ] **Step 2: Add a `describe('computeSlAndTarget — obstacle-aware TP1', ...)` block at the bottom of the spec file**

Insert this block (uses `(strategy as any)` to call the private helper directly — same pattern Jest specs in this repo already use; if a public path becomes preferable, refactor in step 3 of Task 3):

```typescript
import type { StrongZone } from '../types/zone.types';

describe('computeSlAndTarget — obstacle-aware TP1', () => {
  const baseLevelBook = {
    token: '99926000', symbol: 'NIFTY', exchange: 'NSE',
    asOf: new Date(), pdh: 24100, pdl: 23900, prevClose: 24000,
    orh: null, orl: null, orLocked: false,
    spot: 24000, vwap: 0, todayHigh: 24000, todayLow: 24000,
    atr14: 100, lastTickAt: new Date(), roundNumbers: [],
  };
  const baseCandle = {
    timestamp: new Date(), open: 24000, high: 24010, low: 23990,
    close: 24000, volume: 1000,
  };

  function makeZone(overrides: Partial<StrongZone>): StrongZone {
    return {
      id: 'z1', token: '99926000', symbol: 'NIFTY', exchange: 'NSE',
      type: 'support', upper: 23970, lower: 23930, isLine: false,
      strength: 60, classification: 'MEDIUM', touchCount: 5,
      lastTouchTimestamp: Date.now(),
      scoreBreakdown: { touchCount: 100, volumeScore: 0, wickDensity: 50,
        recencyScore: 80, reversalScore: 40, confluenceBonus: 30 },
      computedAt: Date.now(), expiresAt: Date.now() + 60_000,
      ...overrides,
    };
  }

  function computeSlAndTarget(args: {
    isLong: boolean; level: number; zones?: StrongZone[];
    setupType?: 'BREAKOUT' | 'REVERSAL';
  }) {
    const strategy = new LevelsContextStrategy();
    return (strategy as any).computeSlAndTarget({
      setupType: args.setupType ?? 'REVERSAL',
      isLong: args.isLong,
      level: args.level,
      atr: 100,
      levelBook: baseLevelBook,
      candidates: [],
      triggerCandle: { ...baseCandle, close: args.level },
      zones: args.zones ?? [],
    });
  }

  it('1. SELL with no zones falls back to fixed 1×R TP1', () => {
    const r = computeSlAndTarget({ isLong: false, level: 24000 });
    // entry == triggerCandle.close == 24000; SL = 24000 + 0.5*100 = 24050;
    // slDist = 50; default TP1 = 24000 - 50 = 23950
    expect(r.partialTakeAt).toBeCloseTo(23950, 1);
    expect(r.tp1Source).toBe('fixed');
    expect(r.tp1Obstacle ?? null).toBeNull();
  });

  it('2. SELL with STRONG zone in path → TP1 at zone.upper + buffer', () => {
    const zone = makeZone({ classification: 'STRONG', strength: 75,
      touchCount: 5, type: 'support', upper: 23970, lower: 23930 });
    const r = computeSlAndTarget({ isLong: false, level: 24000, zones: [zone] });
    // upper=23970 + 0.1*100 = 23980
    expect(r.partialTakeAt).toBeCloseTo(23980, 1);
    expect(r.tp1Source).toBe('obstacle');
    expect(r.tp1Obstacle).toEqual({
      classification: 'STRONG', touchCount: 5, nearEdge: 23970,
    });
  });

  it('3. SELL with MEDIUM zone touchCount=2 → ignored (touchCount filter)', () => {
    const zone = makeZone({ classification: 'MEDIUM', touchCount: 2 });
    const r = computeSlAndTarget({ isLong: false, level: 24000, zones: [zone] });
    expect(r.partialTakeAt).toBeCloseTo(23950, 1);
    expect(r.tp1Source).toBe('fixed');
  });

  it('4. SELL with WEAK zone in path → ignored (classification filter)', () => {
    const zone = makeZone({ classification: 'WEAK', touchCount: 5 });
    const r = computeSlAndTarget({ isLong: false, level: 24000, zones: [zone] });
    expect(r.partialTakeAt).toBeCloseTo(23950, 1);
    expect(r.tp1Source).toBe('fixed');
  });

  it('5. SELL with MEDIUM zone too close (obstacleR < 0.4) → fallback to fixed', () => {
    // obstacleTp1 would be 23990 + 10 = 24000 (exactly entry); fail floor
    const zone = makeZone({ classification: 'MEDIUM', touchCount: 5,
      upper: 23990, lower: 23970 });
    const r = computeSlAndTarget({ isLong: false, level: 24000, zones: [zone] });
    expect(r.partialTakeAt).toBeCloseTo(23950, 1);
    expect(r.tp1Source).toBe('fixed');
  });

  it('6. BUY with resistance zone in path → TP1 at zone.lower − buffer', () => {
    // BREAKOUT BUY: entry = 24000 + 0.2*100 = 24020; SL = 24000 - 0.5*100 = 23950;
    // slDist = 70; default TP1 = 24020 + 70 = 24090; target = 24020 + 2*70 = 24160
    const zone = makeZone({ classification: 'MEDIUM', touchCount: 4,
      type: 'resistance', upper: 24080, lower: 24050 });
    const r = computeSlAndTarget({ isLong: true, level: 24000, zones: [zone],
      setupType: 'BREAKOUT' });
    // lower=24050 − 0.1*100 = 24040
    expect(r.partialTakeAt).toBeCloseTo(24040, 1);
    expect(r.tp1Source).toBe('obstacle');
    expect(r.tp1Obstacle?.nearEdge).toBeCloseTo(24050, 1);
  });

  it('7. BUY with two resistance zones → only the closest one used', () => {
    const closer = makeZone({ id: 'z-close', classification: 'MEDIUM',
      touchCount: 4, type: 'resistance', upper: 24080, lower: 24050 });
    const farther = makeZone({ id: 'z-far', classification: 'MEDIUM',
      touchCount: 4, type: 'resistance', upper: 24150, lower: 24120 });
    const r = computeSlAndTarget({ isLong: true, level: 24000,
      zones: [farther, closer], setupType: 'BREAKOUT' });
    expect(r.tp1Obstacle?.nearEdge).toBeCloseTo(24050, 1);
  });

  it('8. BUY with zone beyond target → ignored', () => {
    // BREAKOUT BUY target = 24020 + 140 = 24160
    const zone = makeZone({ classification: 'MEDIUM', touchCount: 4,
      type: 'resistance', upper: 24240, lower: 24220 });
    const r = computeSlAndTarget({ isLong: true, level: 24000, zones: [zone],
      setupType: 'BREAKOUT' });
    expect(r.partialTakeAt).toBeCloseTo(24090, 1);
    expect(r.tp1Source).toBe('fixed');
  });

  it('9. SELL with valid obstacle clamps to NOT exceed target', () => {
    // Defensive clamp; build a synthetic case where the buffer math would
    // push TP1 past target. With nearEdge=23805 and buffer=10 obstacleTp1=23815,
    // target = 23900 (default 2×R from entry 24000). 23815 < 23900 (i.e. past
    // target for SELL). The implementation must not let TP1 cross target.
    const zone = makeZone({ classification: 'STRONG', strength: 75,
      touchCount: 5, type: 'support', upper: 23805, lower: 23770 });
    const r = computeSlAndTarget({ isLong: false, level: 24000, zones: [zone] });
    // target is 23900; TP1 must stay strictly between entry (24000) and target
    expect(r.partialTakeAt).toBeGreaterThan(r.target);
    expect(r.partialTakeAt).toBeLessThan(24000);
  });
});
```

- [ ] **Step 3: Run tests to confirm they all FAIL**

Run: `cd apps/api && npx jest --testPathPattern=levels-context.strategy.spec --no-coverage 2>&1 | tail -40`
Expected: 9 new tests fail. Most likely error: `tp1Source` is undefined / `tp1Obstacle` is undefined / `zones` arg ignored.

- [ ] **Step 4: Commit the failing tests**

```bash
git add apps/api/src/modules/signal-generator/strategies/levels-context.strategy.spec.ts
git commit -m "test(strategy): obstacle-aware TP1 spec — failing tests first

9 unit tests covering the algorithm in
docs/superpowers/specs/2026-05-05-tp1-at-obstacle-design.md §Algorithm.
Implementation follows in next commit."
```

---

## Task 3 — Strategy implementation

**Files:**
- Modify: `apps/api/src/modules/signal-generator/strategies/levels-context.strategy.ts`

- [ ] **Step 1: Add `zones` to `AnalyzeInput`**

Find the `AnalyzeInput` interface (around line 83-122). Add this property after `regime?: Regime;` (and before the closing `}`):

```typescript
  /**
   * Active strong/medium zones for this token. Pre-fetched by
   * SignalGeneratorService from ZoneRepository.findActiveByToken so the
   * strategy stays pure (no DB / detector calls here). Empty array when
   * no zones are loaded — TP1 falls back to the fixed 1×R default.
   */
  zones?: StrongZone[];
```

Add the import at the top of the file (alongside other type imports):

```typescript
import { StrongZone } from '../types/zone.types';
```

- [ ] **Step 2: Forward `zones` from `analyze` into `computeSlAndTarget`**

In the `analyze` method body (around line 150-220), change the `computeSlAndTarget` call site (around line 216-219) from:

```typescript
const slTarget = this.computeSlAndTarget({
  setupType, isLong, level: lvl.value, atr: levelBook.atr14,
  levelBook, candidates, triggerCandle: last,
});
```

to:

```typescript
const slTarget = this.computeSlAndTarget({
  setupType, isLong, level: lvl.value, atr: levelBook.atr14,
  levelBook, candidates, triggerCandle: last,
  zones: input.zones ?? [],
});
```

Also update the `unwrap` method (around line 360-375) to forward `zones` from a `MarketSnapshot.metadata` payload:

```typescript
return {
  candles: meta.candles,
  levelBook: meta.levelBook,
  nowIst: meta.nowIst,
  higherTimeframeTrend: meta.higherTimeframeTrend ?? null,
  regime: meta.regime,
  zones: meta.zones ?? [],
};
```

(If `unwrap` already returns more fields, just add the `zones` line — don't accidentally drop existing ones.)

- [ ] **Step 3: Update `computeSlAndTarget` signature and body**

Open `computeSlAndTarget` (starts around line 459). Replace the entire method with:

```typescript
private computeSlAndTarget(args: {
  setupType: SetupType;
  isLong: boolean;
  level: number;
  atr: number;
  levelBook: LevelBook;
  candidates: CandidateLevel[];
  triggerCandle: CandleData;
  zones?: StrongZone[];
}): {
  entry: number;
  stoploss: number;
  target: number;
  partialTakeAt: number;
  tp1Source: 'obstacle' | 'fixed';
  tp1Obstacle: { classification: 'STRONG' | 'MEDIUM'; touchCount: number; nearEdge: number } | null;
} | null {
  const { setupType, isLong, level, atr, candidates, triggerCandle, zones = [] } = args;
  const buffer = SL_BUFFER_ATR * atr;

  // Anchor entry to the level (breakout) or rejection close (reversal).
  let entry: number;
  if (setupType === 'BREAKOUT') {
    const trigger = BREAKOUT_BODY_ATR * atr;
    entry = isLong ? level + trigger : level - trigger;
  } else {
    entry = triggerCandle.close;
  }

  const stoploss = isLong ? level - buffer : level + buffer;
  const slDist = Math.abs(entry - stoploss);
  if (slDist <= 0) return null;
  const minTargetDist = 2 * slDist;

  // Pick target = nearest opposing candidate level >= 2×R, else default 2×R.
  const opposing = candidates
    .filter((c) => (isLong ? c.value > entry : c.value < entry))
    .sort((a, b) => Math.abs(a.value - entry) - Math.abs(b.value - entry));
  const target =
    opposing.length > 0 && Math.abs(opposing[0].value - entry) >= minTargetDist
      ? opposing[0].value
      : (isLong ? entry + minTargetDist : entry - minTargetDist);

  // Default TP1 = entry ± 1×R (the historical fixed placement).
  const defaultTp1 = isLong ? entry + slDist : entry - slDist;

  // Obstacle-aware TP1. See docs/superpowers/specs/2026-05-05-tp1-at-obstacle-design.md §Algorithm.
  const TP1_OBSTACLE_BUFFER_ATR = 0.1;
  const MIN_TP1_R = 0.4;
  const obstacleBuffer = TP1_OBSTACLE_BUFFER_ATR * atr;

  const obstacleCandidates = zones
    .filter((z) =>
      (z.classification === 'STRONG' || z.classification === 'MEDIUM') &&
      z.touchCount >= 3,
    )
    .map((z) => ({
      classification: z.classification as 'STRONG' | 'MEDIUM',
      touchCount: z.touchCount,
      nearEdge: isLong ? z.lower : z.upper,
    }))
    // Strictly inside the trade path: between entry and target, exclusive.
    .filter((z) =>
      isLong
        ? z.nearEdge > entry && z.nearEdge < target
        : z.nearEdge < entry && z.nearEdge > target,
    );

  const closest = isLong
    ? obstacleCandidates.reduce<typeof obstacleCandidates[number] | null>(
        (best, z) => (best === null || z.nearEdge < best.nearEdge ? z : best),
        null,
      )
    : obstacleCandidates.reduce<typeof obstacleCandidates[number] | null>(
        (best, z) => (best === null || z.nearEdge > best.nearEdge ? z : best),
        null,
      );

  let partialTakeAt = defaultTp1;
  let tp1Source: 'obstacle' | 'fixed' = 'fixed';
  let tp1Obstacle:
    | { classification: 'STRONG' | 'MEDIUM'; touchCount: number; nearEdge: number }
    | null = null;

  if (closest) {
    const rawObstacleTp1 = isLong
      ? closest.nearEdge - obstacleBuffer
      : closest.nearEdge + obstacleBuffer;
    // Defensive clamp — keep TP1 strictly between entry and target. With
    // step-4's filter this should already hold, but the buffer math could in
    // principle nudge it across in pathological inputs.
    const clampedTp1 = isLong
      ? Math.min(rawObstacleTp1, target - 1e-6)
      : Math.max(rawObstacleTp1, target + 1e-6);
    const obstacleR = Math.abs(clampedTp1 - entry) / slDist;
    if (obstacleR >= MIN_TP1_R) {
      partialTakeAt = clampedTp1;
      tp1Source = 'obstacle';
      tp1Obstacle = {
        classification: closest.classification,
        touchCount: closest.touchCount,
        nearEdge: closest.nearEdge,
      };
    }
  }

  return { entry, stoploss, target, partialTakeAt, tp1Source, tp1Obstacle };
}
```

- [ ] **Step 4: Populate the new fields on the emitted `SetupContext`**

Find the `setupContext: SetupContext = { ... }` literal in `analyze()` (around line 279-305). Add the two new fields after `intradayRangeRatio,`:

```typescript
        intradayRangeRatio,
        tp1Source: slTarget.tp1Source,
        tp1Obstacle: slTarget.tp1Obstacle,
      };
```

- [ ] **Step 5: Run the spec to verify all 9 obstacle tests now pass**

Run: `cd apps/api && npx jest --testPathPattern=levels-context.strategy.spec --no-coverage 2>&1 | tail -40`
Expected: All tests pass (including the pre-existing ones — none should regress).

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/modules/signal-generator/strategies/levels-context.strategy.ts
git commit -m "feat(strategy): obstacle-aware TP1 placement

computeSlAndTarget now scans for STRONG/MEDIUM zones (touchCount >= 3)
between entry and target. When found, TP1 is placed at the near edge of
the first one in the trade path (with a 0.1*ATR buffer), so partial
profit books at the bounce point instead of the fixed 1xR. Falls back
to fixed 1xR when no useful obstacle exists or when the obstacle would
yield a partial < 0.4xR.

Spec: docs/superpowers/specs/2026-05-05-tp1-at-obstacle-design.md"
```

---

## Task 4 — Wire zones into the strategy from `SignalGeneratorService.analyze`

**Files:**
- Modify: `apps/api/src/modules/signal-generator/services/signal-generator.service.ts`

- [ ] **Step 1: Inject `ZoneRepository`**

Find the constructor of `SignalGeneratorService`. Add `ZoneRepository` to the parameter list (preserve all existing parameters):

```typescript
import { ZoneRepository } from '../repositories/zone.repository';

constructor(
  // ... existing injections unchanged ...
  private readonly zoneRepository: ZoneRepository,
) {}
```

If the file doesn't already import `ZoneRepository`, add the import alongside the other repo imports.

- [ ] **Step 2: Confirm `ZoneRepository` is provided by the module**

Run: `grep -nE "ZoneRepository|providers:" apps/api/src/modules/signal-generator/signal-generator.module.ts | head -10`
Expected: `ZoneRepository` already appears in `providers` (it does — we saw it earlier). No module change needed.

- [ ] **Step 3: Fetch zones in `analyze()` and pass to the strategy**

In `analyze()` (around line 234-380), just before the `const output = strategy.analyze({...})` call (line ~368), add:

```typescript
const zones = await this.zoneRepository.findActiveByToken(token);
```

Then update the `strategy.analyze({...})` call to forward `zones`:

```typescript
const output = strategy.analyze({
  candles,
  levelBook: book,
  nowIst,
  nowMs: nowMsForStrategy,
  higherTimeframeTrend,
  regime,
  zones,
  debug,
});
```

- [ ] **Step 4: Verify TypeScript compiles**

Run: `cd apps/api && npx tsc --noEmit -p tsconfig.json 2>&1 | grep -E "signal-generator\.service|strategies/levels-context" || echo "OK"`
Expected: `OK`.

- [ ] **Step 5: Smoke-test against the live API**

Run: `curl -s "http://localhost:4001/api/signals/analyze?token=99926000&exchange=NSE&symbol=NIFTY&timeframe=15m" | python -c "import sys, json; d = json.load(sys.stdin); print('tp1Source=', d.get('tp1Source'), 'tp1Obstacle=', d.get('tp1Obstacle'))" 2>/dev/null || echo "no setup or non-JSON; that's fine if no setup is firing right now"`
Expected: either prints the new fields, or "no setup" — the field plumbing should at least not throw.

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/modules/signal-generator/services/signal-generator.service.ts
git commit -m "feat(signals): plumb active zones into LevelsContextStrategy

analyze() pulls active zones via ZoneRepository.findActiveByToken and
threads them through AnalyzeInput.zones so computeSlAndTarget can place
TP1 at intermediate bounce-prone bands."
```

---

## Task 5 — Setup-tracker persistence test

**Files:**
- Modify: `apps/api/src/modules/signal-generator/services/setup-tracker.service.spec.ts`

- [ ] **Step 1: Locate an existing test that builds a `SetupContext` fixture**

Run: `grep -n "SetupContext\|setupContext\|partialTakeAt" apps/api/src/modules/signal-generator/services/setup-tracker.service.spec.ts | head -10`
Use the first hit to find the fixture pattern in the file.

- [ ] **Step 2: Add a test confirming `tp1Source` + `tp1Obstacle` round-trip**

Add this `it(...)` block inside the existing top-level `describe('SetupTrackerService', ...)`:

```typescript
it('persists tp1Source and tp1Obstacle across lock and re-load', async () => {
  // Build a minimal SetupContext with the new fields populated.
  const ctx: SetupContext = {
    levelType: 'ORH',
    setupType: 'REVERSAL',
    levelValue: 24000,
    grade: 'A',
    entry: 24000,
    stoploss: 24050,
    target: 23900,
    partialTakeAt: 23980, // sits at obstacle, NOT 1×R
    triggerCandle: { time: 1700000000, ohlc: [24000, 24010, 23990, 24000] },
    levelBookSnapshot: {
      pdh: 24100, pdl: 23900, orh: 24050, orl: 23950,
      vwap: 0, todayHigh: 24010, todayLow: 23990,
    },
    atr14: 100,
    volumeRatio: 1.2,
    timeOfDayWindow: 'morning-trend',
    indicators: {
      ema9: null, ema21: null, rsi14: null, macdHistogram: null,
      bollingerPosition: null, roc10: null,
      alignment: { ema: 0, rsi: 0, macd: 0, bollinger: 0, momentum: 0 },
      agreement: 0,
    },
    higherTimeframeTrend: null,
    regime: null,
    intradayRangeRatio: 0.5,
    tp1Source: 'obstacle',
    tp1Obstacle: { classification: 'MEDIUM', touchCount: 5, nearEdge: 23970 },
  };

  // Lock the setup, then re-load via the public getter.
  // (Adapt the API calls below to whatever the existing tests use —
  // tracker.lockSetup / tracker.getActive / equivalent.)
  const tracker = makeTracker(); // existing helper in this spec file
  await tracker.lockSetup('99926000', 'SELL', ctx);
  const reloaded = tracker.getActive('99926000');

  expect(reloaded?.context.tp1Source).toBe('obstacle');
  expect(reloaded?.context.tp1Obstacle).toEqual({
    classification: 'MEDIUM', touchCount: 5, nearEdge: 23970,
  });
  expect(reloaded?.context.partialTakeAt).toBe(23980);
});
```

If the spec file's existing tests use different helper names (e.g. `tracker.lock(...)` instead of `tracker.lockSetup(...)` or a different method name for fetching the active setup), copy those names — the goal is to mirror the spec's existing pattern rather than invent new APIs.

- [ ] **Step 3: Run the spec**

Run: `cd apps/api && npx jest --testPathPattern=setup-tracker.service.spec --no-coverage 2>&1 | tail -25`
Expected: new test passes.

- [ ] **Step 4: Commit**

```bash
git add apps/api/src/modules/signal-generator/services/setup-tracker.service.spec.ts
git commit -m "test(signals): tp1Source + tp1Obstacle round-trip in setup tracker"
```

---

## Task 6 — Frontend type mirror

**Files:**
- Modify: `apps/web/src/types/index.ts`
- Modify: `apps/web/src/components/charts/AnalysisPanel.tsx`

- [ ] **Step 1: Find the frontend `SetupContext` type**

Run: `grep -nE "interface SetupContext|partialTakeAt" apps/web/src/types/index.ts | head -5`
Identify the exact location of `SetupContext` (or its equivalent) in the frontend types.

- [ ] **Step 2: Add the two optional fields to the frontend `SetupContext`**

Add inside the `SetupContext` interface, after `partialTakeAt` (or wherever the type closes — the order doesn't matter since they're optional):

```typescript
  tp1Source?: 'obstacle' | 'fixed';
  tp1Obstacle?: {
    classification: 'STRONG' | 'MEDIUM';
    touchCount: number;
    nearEdge: number;
  } | null;
```

- [ ] **Step 3: Mirror on `SetupAnalysis` in `AnalysisPanel.tsx`**

Open `apps/web/src/components/charts/AnalysisPanel.tsx`. Find the `SetupAnalysis` interface (around line 66-119) and add the two fields before the closing brace:

```typescript
  /** How TP1 was placed — 'obstacle' surfaces a subtitle on the TP1 row. */
  tp1Source?: 'obstacle' | 'fixed';
  tp1Obstacle?: {
    classification: 'STRONG' | 'MEDIUM';
    touchCount: number;
    nearEdge: number;
  } | null;
```

- [ ] **Step 4: Verify `web` still builds**

Run: `cd apps/web && npx tsc --noEmit -p tsconfig.json 2>&1 | grep -E "AnalysisPanel|types/index" || echo "OK"`
Expected: `OK`.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/types/index.ts apps/web/src/components/charts/AnalysisPanel.tsx
git commit -m "feat(web): mirror tp1Source + tp1Obstacle on frontend SetupContext"
```

---

## Task 7 — AnalysisPanel TP1 obstacle subtitle

**Files:**
- Modify: `apps/web/src/components/charts/AnalysisPanel.tsx`

- [ ] **Step 1: Find the TP1 row in the active-setup render branch**

Run: `grep -n "TP1\|partialTakeAt" apps/web/src/components/charts/AnalysisPanel.tsx | head -10`
The TP1 row is the `<span>TP1</span>` cell + its sibling `<span>{fmt(analysis.partialTakeAt)}</span>` inside the `analysis.partialTakeAt !== undefined && ...` block (around line 346-367).

- [ ] **Step 2: Add the subtitle below the TP1 value when it came from an obstacle**

Replace the existing TP1 row pair:

```jsx
<span className="text-[10px] uppercase tracking-wider text-gray-500">TP1</span>
<span className="text-right font-mono text-[11px] tabular-nums text-white">
  {fmt(analysis.partialTakeAt)}
</span>
```

with:

```jsx
<span className="text-[10px] uppercase tracking-wider text-gray-500">TP1</span>
<span className="text-right">
  <span className="font-mono text-[11px] tabular-nums text-white">
    {fmt(analysis.partialTakeAt)}
  </span>
  {analysis.tp1Source === 'obstacle' && analysis.tp1Obstacle && (
    <span
      className="ml-1.5 text-[9px] uppercase tracking-wider text-gray-500"
      title={`TP1 sits just before a ${analysis.tp1Obstacle.classification} zone with ${analysis.tp1Obstacle.touchCount} historical touches at ${analysis.tp1Obstacle.nearEdge.toFixed(2)}`}
    >
      at {analysis.tp1Obstacle.classification.toLowerCase()} zone · {analysis.tp1Obstacle.touchCount}t
    </span>
  )}
</span>
```

(The `title` attribute powers a hover-tooltip with the full numeric context; the inline label stays tight to fit the 72-px panel width.)

- [ ] **Step 3: Visual smoke test**

Open the chart in the browser at http://localhost:4000 (the dev server is already running and Vite will hot-reload). Pick a symbol that's currently producing an active setup — NIFTY 15m has been firing today. Confirm:
1. When `tp1Source === 'obstacle'`, the TP1 row shows e.g. `23,950.40   at medium zone · 19t` (subtitle in dim grey).
2. When `tp1Source === 'fixed'` or undefined, the TP1 row renders unchanged.
3. Hovering the subtitle shows the full tooltip text.

- [ ] **Step 4: Commit**

```bash
git add apps/web/src/components/charts/AnalysisPanel.tsx
git commit -m "feat(web): label TP1 row with obstacle classification + touch count

When the backend reports tp1Source === 'obstacle', the AnalysisPanel
TP1 row now shows a small subtitle naming the bounce-prone zone the
partial books at — e.g. 'at medium zone · 19t'. Hover tooltip carries
the full numeric near-edge for verification."
```

---

## Self-review

**Spec coverage** — every section of `2026-05-05-tp1-at-obstacle-design.md` maps to a task:

| Spec section | Task(s) |
|---|---|
| Architecture (component table) | 1, 3, 4, 5, 6, 7 |
| Algorithm (steps 1-9) | 3 (and tested in 2) |
| Data shape changes | 1 (backend), 6 (frontend), 7 (UI render) |
| Edge cases — locked-setup re-evaluation | 5 |
| Edge cases — no zones / filtered out | 2 (tests 1, 3, 4) |
| Edge cases — multiple obstacles / past target / floor | 2 (tests 5, 7, 8, 9) |
| Test plan rows 1-9 | 2 |
| Test plan integration touch | 5 |

**Placeholder scan** — no TBD/TODO; every code step contains complete code; all file paths are absolute (within the repo).

**Type consistency** — `tp1Source: 'obstacle' \| 'fixed'`, `tp1Obstacle.classification: 'STRONG' \| 'MEDIUM'`, `tp1Obstacle.touchCount: number`, `tp1Obstacle.nearEdge: number` — same shape in Tasks 1, 2, 3, 5, 6, 7.

**Parallelism note** — Tasks 2, 3, 4 are a sequential chain (TDD: tests → impl → wiring). Tasks 5, 6 (and 7) only depend on the type fields landing in Task 1. After Task 1 commits, an executor can dispatch Tasks 2-3-4 (backend chain), Task 5 (setup-tracker), and Tasks 6-7 (frontend chain) **in parallel**.
