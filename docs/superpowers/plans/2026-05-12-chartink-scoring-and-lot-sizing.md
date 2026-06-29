# Chartink Scoring & Lot Sizing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended). Steps use checkbox (`- [ ]`) syntax.

**Goal:** Add a 0-100 trade-quality scoring layer to the Chartink pipeline that runs after `analyze()` returns a setup. Score determines lot count (skip/1/2/3 lots). Persisted per-setup on a new `ChartinkAlertSetup` columns + rendered as a per-check breakdown table on `/chartink`.

**Architecture:** New `ChartinkScoringService` invoked between `analyze()` and DB persistence in `ChartinkProcessService.processOne`. 9 checks summing to 100 points. Each check is a private async method that returns `{ name, points, pointsPossible, passed, detail }`. Total score maps to lot count via bands (`<50 skip · 50-65 → 1 · 65-80 → 2 · 80+ → 3`).

**Tech Stack:** NestJS + TypeScript backend (Jest tests), Prisma migration, React frontend, existing `AngelOneAdapterService` for historical candles, existing `indicators.ts` for `ema`/`macd` math (need to add `atr` + `superTrend`).

Spec: `docs/superpowers/specs/2026-05-12-chartink-scoring-and-lot-sizing-design.md`

---

## Pre-flight

- [ ] **Step 0.1: Verify dev environment**

Run from repo root:
```bash
cd apps/api && npx jest --listTests src/modules/chartink 2>&1 | head -5
cd ../web && npx tsc --noEmit 2>&1 | head -3
```
Expected: both succeed without infra errors. Existing tests still discoverable.

- [ ] **Step 0.2: Check current API health (running on :4001)**

```bash
curl -s http://127.0.0.1:4001/api/market-data/status --max-time 5 | head -c 200
```
Expected: JSON with `feedActive:true`.

---

## Task 1: Add ATR + SuperTrend helpers to `indicators.ts`

**Files:**
- Modify: `apps/api/src/modules/signal-generator/strategies/indicators.ts`
- Modify: `apps/api/src/modules/signal-generator/strategies/__tests__/indicators.spec.ts` (or create)

The existing `indicators.ts` has `ema`, `rsi`, `macd`, `bollinger`, `roc`. We need to add `atr` and `supertrend`.

### Step 1.1: Add `atr` function

In `apps/api/src/modules/signal-generator/strategies/indicators.ts`, append (after existing exports):

```typescript
/**
 * Average True Range (ATR) using Wilder's smoothing.
 * Returns the latest ATR value, or null if `highs.length < period + 1`.
 * Standard period is 14.
 */
export function atr(
  highs: number[],
  lows: number[],
  closes: number[],
  period = 14,
): number | null {
  if (highs.length !== lows.length || lows.length !== closes.length) return null;
  if (highs.length < period + 1) return null;

  // True ranges
  const trs: number[] = [];
  for (let i = 1; i < highs.length; i++) {
    const hl = highs[i] - lows[i];
    const hc = Math.abs(highs[i] - closes[i - 1]);
    const lc = Math.abs(lows[i] - closes[i - 1]);
    trs.push(Math.max(hl, hc, lc));
  }

  // Wilder's smoothing: first ATR is simple avg of first `period` TRs.
  // Subsequent: ATR_t = ((period-1) * ATR_{t-1} + TR_t) / period.
  let avg = trs.slice(0, period).reduce((a, b) => a + b, 0) / period;
  for (let i = period; i < trs.length; i++) {
    avg = ((period - 1) * avg + trs[i]) / period;
  }
  return avg;
}
```

### Step 1.2: Add `supertrend` function

```typescript
/**
 * SuperTrend indicator (period=10, multiplier=3 standard).
 * Returns the latest SuperTrend state: { value, direction } where
 *   direction = 'UP' | 'DOWN'.
 * Returns null if insufficient candles (need at least period+1).
 *
 * Algorithm (matches the common TradingView formulation):
 *   basicUpper = (high + low) / 2 + multiplier * ATR
 *   basicLower = (high + low) / 2 - multiplier * ATR
 *   finalUpper / finalLower follow the standard "carry the prior band
 *   unless price breaks through" rule. Direction flips when close crosses
 *   the active band.
 */
export interface SuperTrendResult {
  value: number;
  direction: 'UP' | 'DOWN';
}

export function supertrend(
  highs: number[],
  lows: number[],
  closes: number[],
  period = 10,
  multiplier = 3,
): SuperTrendResult | null {
  if (highs.length !== lows.length || lows.length !== closes.length) return null;
  if (highs.length < period + 1) return null;

  // Compute rolling ATR series (one ATR per bar from index `period` onwards).
  // We'll compute the supertrend iteratively, tracking final upper/lower bands.
  const atrs: number[] = new Array(highs.length).fill(NaN);

  // True range series
  const trs: number[] = [0];
  for (let i = 1; i < highs.length; i++) {
    const hl = highs[i] - lows[i];
    const hc = Math.abs(highs[i] - closes[i - 1]);
    const lc = Math.abs(lows[i] - closes[i - 1]);
    trs.push(Math.max(hl, hc, lc));
  }

  // Seed: simple avg over first `period` TRs (starting at index 1)
  let atrAvg = 0;
  for (let i = 1; i <= period; i++) atrAvg += trs[i];
  atrAvg /= period;
  atrs[period] = atrAvg;
  for (let i = period + 1; i < highs.length; i++) {
    atrAvg = ((period - 1) * atrAvg + trs[i]) / period;
    atrs[i] = atrAvg;
  }

  // Compute supertrend state
  let prevFinalUpper = 0;
  let prevFinalLower = 0;
  let prevDirection: 'UP' | 'DOWN' = 'UP';
  let lastValue = 0;
  let lastDirection: 'UP' | 'DOWN' = 'UP';

  for (let i = period; i < highs.length; i++) {
    const hl2 = (highs[i] + lows[i]) / 2;
    const basicUpper = hl2 + multiplier * atrs[i];
    const basicLower = hl2 - multiplier * atrs[i];

    const finalUpper =
      i === period || basicUpper < prevFinalUpper || closes[i - 1] > prevFinalUpper
        ? basicUpper
        : prevFinalUpper;
    const finalLower =
      i === period || basicLower > prevFinalLower || closes[i - 1] < prevFinalLower
        ? basicLower
        : prevFinalLower;

    let direction: 'UP' | 'DOWN';
    let value: number;

    if (i === period) {
      // Seed direction: compare close to (upper+lower)/2 — standard convention
      direction = closes[i] > hl2 ? 'UP' : 'DOWN';
      value = direction === 'UP' ? finalLower : finalUpper;
    } else {
      if (prevDirection === 'UP' && closes[i] < finalLower) {
        direction = 'DOWN';
        value = finalUpper;
      } else if (prevDirection === 'DOWN' && closes[i] > finalUpper) {
        direction = 'UP';
        value = finalLower;
      } else {
        direction = prevDirection;
        value = direction === 'UP' ? finalLower : finalUpper;
      }
    }

    prevFinalUpper = finalUpper;
    prevFinalLower = finalLower;
    prevDirection = direction;
    lastValue = value;
    lastDirection = direction;
  }

  return { value: lastValue, direction: lastDirection };
}
```

### Step 1.3: Add unit tests

Append to (or create) `apps/api/src/modules/signal-generator/strategies/__tests__/indicators.spec.ts`:

```typescript
describe('atr', () => {
  it('returns null for insufficient candles', () => {
    expect(atr([1, 2], [0.5, 1], [0.8, 1.5], 14)).toBeNull();
  });

  it('computes ATR for a 14-bar rising series', () => {
    const n = 30;
    const h = Array.from({ length: n }, (_, i) => 100 + i);
    const l = Array.from({ length: n }, (_, i) => 99 + i);
    const c = Array.from({ length: n }, (_, i) => 99.5 + i);
    const v = atr(h, l, c, 14);
    expect(v).not.toBeNull();
    expect(v!).toBeGreaterThan(0);
    expect(v!).toBeLessThan(5); // small range, ATR should be modest
  });
});

describe('supertrend', () => {
  it('returns null for insufficient candles', () => {
    expect(supertrend([1, 2], [0.5, 1], [0.8, 1.5])).toBeNull();
  });

  it('reports UP direction for a strongly rising series', () => {
    const n = 30;
    const h = Array.from({ length: n }, (_, i) => 100 + i * 2);
    const l = Array.from({ length: n }, (_, i) => 99 + i * 2);
    const c = Array.from({ length: n }, (_, i) => 99.5 + i * 2);
    const r = supertrend(h, l, c, 10, 3);
    expect(r).not.toBeNull();
    expect(r!.direction).toBe('UP');
  });

  it('reports DOWN direction for a strongly falling series', () => {
    const n = 30;
    const h = Array.from({ length: n }, (_, i) => 200 - i * 2);
    const l = Array.from({ length: n }, (_, i) => 199 - i * 2);
    const c = Array.from({ length: n }, (_, i) => 199.5 - i * 2);
    const r = supertrend(h, l, c, 10, 3);
    expect(r).not.toBeNull();
    expect(r!.direction).toBe('DOWN');
  });
});
```

Add to the existing imports at the top of the test file:
```typescript
import { atr, supertrend } from '../indicators';
```

### Step 1.4: Run tests + commit

```bash
cd C:/Users/AryanKumar/Desktop/TD_Automation/apps/api && npx jest src/modules/signal-generator/strategies/__tests__/indicators.spec.ts 2>&1 | tail -15
```
Expected: all tests pass (existing + new).

```bash
cd C:/Users/AryanKumar/Desktop/TD_Automation
git add apps/api/src/modules/signal-generator/strategies/indicators.ts \
        apps/api/src/modules/signal-generator/strategies/__tests__/indicators.spec.ts
git -c commit.gpgsign=false commit -m "feat(indicators): add ATR + SuperTrend helpers"
```

---

## Task 2: Prisma migration — 3 new columns on `ChartinkAlertSetup`

**Files:**
- Modify: `prisma/schema.prisma`
- Create: `prisma/migrations/<timestamp>_add_chartink_scoring/migration.sql`

### Step 2.1: Update Prisma schema

In `prisma/schema.prisma`, find the `ChartinkAlertSetup` model. Add three optional fields:

```prisma
model ChartinkAlertSetup {
  // ... existing fields stay unchanged ...

  // Chartink scoring + lot sizing (added 2026-05-12)
  score          Int?
  lotCount       Int?
  scoreBreakdown Json?
}
```

Add these fields right before the `@@index` / `@@map` block.

### Step 2.2: Generate migration

```bash
cd C:/Users/AryanKumar/Desktop/TD_Automation && npx prisma migrate dev --name add_chartink_scoring --schema=prisma/schema.prisma
```

This creates `prisma/migrations/<timestamp>_add_chartink_scoring/migration.sql`. The SQL should look like:

```sql
ALTER TABLE "chartink_alert_setups" ADD COLUMN "score" INTEGER;
ALTER TABLE "chartink_alert_setups" ADD COLUMN "lotCount" INTEGER;
ALTER TABLE "chartink_alert_setups" ADD COLUMN "scoreBreakdown" JSONB;
```

If the migration fails because the dev DB doesn't have prior chartink migrations, manually run the SQL via psql or recreate. The columns are nullable so existing rows just get NULL.

### Step 2.3: Regenerate Prisma client

```bash
cd C:/Users/AryanKumar/Desktop/TD_Automation && npx prisma generate --schema=prisma/schema.prisma
```

### Step 2.4: Commit

```bash
git add prisma/schema.prisma prisma/migrations/*add_chartink_scoring*
git -c commit.gpgsign=false commit -m "feat(chartink): migration for scoring columns (score, lotCount, scoreBreakdown)"
```

---

## Task 3: `ChartinkScoringService` core + types + lot-banding logic

**Files:**
- Create: `apps/api/src/modules/chartink/services/chartink-scoring.service.ts`
- Create: `apps/api/src/modules/chartink/services/chartink-scoring.service.spec.ts`

### Step 3.1: Create the service file

```typescript
// apps/api/src/modules/chartink/services/chartink-scoring.service.ts
import { Injectable, Logger } from '@nestjs/common';
import { AngelOneAdapterService } from '../../market-data/services/angel-one-adapter.service';
import { ema, macd, atr, supertrend } from '../../signal-generator/strategies/indicators';
import { SECTOR_INDICES } from '@td/shared/constants';

export type SetupSide = 'BUY' | 'SELL';

export interface ScoreCheckResult {
  name: string;
  points: number;
  pointsPossible: number;
  passed: boolean;
  detail?: Record<string, unknown>;
}

export interface ScoringInput {
  token: string;
  symbol: string;
  exchange: string;
  side: SetupSide;
  entryPrice: number;
  setupContext?: { levelBookSnapshot?: { pdh: number; pdl: number; orh: number | null; orl: number | null; vwap: number } } | null;
}

export interface ScoringResult {
  score: number;
  lotCount: 0 | 1 | 2 | 3;
  checks: ScoreCheckResult[];
}

// Static stock → sector-index map. Seeded from SECTOR_INDICES. Sized for the
// liquid-stock universe we trade. Stocks not in this map fail check #1 with
// detail.reason = 'no sector mapping'.
const STOCK_TO_SECTOR_INDEX: Record<string, string> = {
  // Banks / FinServ
  HDFCBANK: '99926009', ICICIBANK: '99926009', SBIN: '99926009', AXISBANK: '99926009',
  KOTAKBANK: '99926009', INDUSINDBK: '99926009', BAJFINANCE: '99926011',
  // IT
  TCS: '99926013', INFY: '99926013', WIPRO: '99926013', HCLTECH: '99926013',
  TECHM: '99926013', LTIM: '99926013',
  // Auto
  MARUTI: '99926021', TATAMOTORS: '99926021', M_M: '99926021', BAJAJ_AUTO: '99926021',
  // Energy
  RELIANCE: '99926019', ONGC: '99926019', GAIL: '99926019', BPCL: '99926019', IOC: '99926019',
  HINDPETRO: '99926019', NTPC: '99926019', POWERGRID: '99926019',
  // Metals
  TATASTEEL: '99926023', HINDALCO: '99926023', JSWSTEEL: '99926023', VEDL: '99926023',
  HINDCOPPER: '99926023', HINDZINC: '99926023',
  // Pharma
  SUNPHARMA: '99926017', DIVISLAB: '99926017', DRREDDY: '99926017', CIPLA: '99926017',
  // FMCG
  HINDUNILVR: '99926015', ITC: '99926015', NESTLEIND: '99926015', BRITANNIA: '99926015',
};

const NIFTY_TOKEN = '99926000';
const NIFTY_EXCHANGE = 'NSE';

const LOT_BAND_THRESHOLDS = [50, 65, 80] as const;

@Injectable()
export class ChartinkScoringService {
  private readonly logger = new Logger(ChartinkScoringService.name);

  constructor(private readonly adapter: AngelOneAdapterService) {}

  /**
   * Score a Chartink setup against the 9-check table. Returns score 0-100
   * plus per-check breakdown. Never throws — failed checks return points=0
   * with detail.error.
   */
  async score(input: ScoringInput): Promise<ScoringResult> {
    const checks: ScoreCheckResult[] = [];

    // Run checks sequentially to respect the 350ms broker rate-limit pacer.
    // Total worst case: 9 * 350ms = ~3.15s per setup. Acceptable for now.
    checks.push(await this.checkSectorAligned(input));
    await this.sleep(350);
    checks.push(await this.checkIndexAligned(input));
    await this.sleep(350);
    checks.push(await this.checkMacdDaily(input));
    await this.sleep(350);
    checks.push(await this.checkMacdOneMin(input));
    await this.sleep(350);
    checks.push(await this.checkMacdFiveMin(input));
    await this.sleep(350);
    checks.push(await this.checkPriceVs20Ema(input));
    await this.sleep(350);
    checks.push(await this.checkSupertrend(input));
    await this.sleep(350);
    checks.push(await this.checkSrRoom(input));
    await this.sleep(350);
    checks.push(await this.checkVolume(input));

    const score = checks.reduce((sum, c) => sum + c.points, 0);
    const lotCount = this.scoreToLotCount(score);
    return { score, lotCount, checks };
  }

  scoreToLotCount(score: number): 0 | 1 | 2 | 3 {
    if (score < LOT_BAND_THRESHOLDS[0]) return 0;
    if (score < LOT_BAND_THRESHOLDS[1]) return 1;
    if (score < LOT_BAND_THRESHOLDS[2]) return 2;
    return 3;
  }

  // ─── Individual checks ──────────────────────────────────────────────────

  private async checkSectorAligned(input: ScoringInput): Promise<ScoreCheckResult> {
    const name = 'Sector aligned';
    const pointsPossible = 20;
    const sectorToken = STOCK_TO_SECTOR_INDEX[input.symbol.toUpperCase()];
    if (!sectorToken) {
      return { name, points: 0, pointsPossible, passed: false, detail: { reason: 'no sector mapping' } };
    }
    try {
      const candles = await this.fetch15mCandles(sectorToken, 'NSE', 25);
      if (candles.length < 21) {
        return { name, points: 0, pointsPossible, passed: false, detail: { reason: 'insufficient sector candles' } };
      }
      const closes = candles.map((c) => c.close);
      const ema20 = ema(closes, 20);
      const lastClose = closes[closes.length - 1];
      if (ema20 === null) {
        return { name, points: 0, pointsPossible, passed: false, detail: { reason: 'ema20 null' } };
      }
      const passed = input.side === 'BUY' ? lastClose > ema20 : lastClose < ema20;
      return {
        name, points: passed ? pointsPossible : 0, pointsPossible, passed,
        detail: { sectorToken, lastClose, ema20 },
      };
    } catch (err) {
      return { name, points: 0, pointsPossible, passed: false, detail: { error: errMsg(err) } };
    }
  }

  private async checkIndexAligned(input: ScoringInput): Promise<ScoreCheckResult> {
    const name = 'Index aligned';
    const pointsPossible = 20;
    if (input.token === NIFTY_TOKEN) {
      return { name, points: 0, pointsPossible, passed: false, detail: { reason: 'setup is on the index itself' } };
    }
    try {
      const candles = await this.fetch15mCandles(NIFTY_TOKEN, NIFTY_EXCHANGE, 25);
      if (candles.length < 21) {
        return { name, points: 0, pointsPossible, passed: false, detail: { reason: 'insufficient nifty candles' } };
      }
      const closes = candles.map((c) => c.close);
      const ema20 = ema(closes, 20);
      const lastClose = closes[closes.length - 1];
      if (ema20 === null) {
        return { name, points: 0, pointsPossible, passed: false, detail: { reason: 'ema20 null' } };
      }
      const passed = input.side === 'BUY' ? lastClose > ema20 : lastClose < ema20;
      return {
        name, points: passed ? pointsPossible : 0, pointsPossible, passed,
        detail: { lastClose, ema20 },
      };
    } catch (err) {
      return { name, points: 0, pointsPossible, passed: false, detail: { error: errMsg(err) } };
    }
  }

  private async checkMacdAtTf(
    input: ScoringInput, tf: '1d' | '1m' | '5m', pointsPossible: number, lookback: number,
  ): Promise<ScoreCheckResult> {
    const name = `MACD on ${tf}`;
    try {
      const candles = await this.fetchCandles(input.token, input.exchange, tf, lookback);
      if (candles.length < 35) {
        return { name, points: 0, pointsPossible, passed: false, detail: { reason: 'insufficient candles' } };
      }
      const closes = candles.map((c) => c.close);
      const m = macd(closes);
      if (!m || m.macd === null || m.signal === null) {
        return { name, points: 0, pointsPossible, passed: false, detail: { reason: 'macd null' } };
      }
      const passed = input.side === 'BUY' ? m.macd > m.signal : m.macd < m.signal;
      return {
        name, points: passed ? pointsPossible : 0, pointsPossible, passed,
        detail: { macd: m.macd, signal: m.signal },
      };
    } catch (err) {
      return { name, points: 0, pointsPossible, passed: false, detail: { error: errMsg(err) } };
    }
  }

  private checkMacdDaily(input: ScoringInput) { return this.checkMacdAtTf(input, '1d', 10, 50); }
  private checkMacdOneMin(input: ScoringInput) { return this.checkMacdAtTf(input, '1m', 7, 60); }
  private checkMacdFiveMin(input: ScoringInput) { return this.checkMacdAtTf(input, '5m', 8, 60); }

  private async checkPriceVs20Ema(input: ScoringInput): Promise<ScoreCheckResult> {
    const name = 'Price vs 20-EMA';
    const pointsPossible = 10;
    try {
      const candles = await this.fetch15mCandles(input.token, input.exchange, 30);
      if (candles.length < 21) {
        return { name, points: 0, pointsPossible, passed: false, detail: { reason: 'insufficient candles' } };
      }
      const closes = candles.map((c) => c.close);
      const ema20 = ema(closes, 20);
      const lastClose = closes[closes.length - 1];
      if (ema20 === null) {
        return { name, points: 0, pointsPossible, passed: false, detail: { reason: 'ema20 null' } };
      }
      const passed = input.side === 'BUY' ? lastClose > ema20 : lastClose < ema20;
      return { name, points: passed ? pointsPossible : 0, pointsPossible, passed, detail: { lastClose, ema20 } };
    } catch (err) {
      return { name, points: 0, pointsPossible, passed: false, detail: { error: errMsg(err) } };
    }
  }

  private async checkSupertrend(input: ScoringInput): Promise<ScoreCheckResult> {
    const name = 'SuperTrend match';
    const pointsPossible = 10;
    try {
      const candles = await this.fetch15mCandles(input.token, input.exchange, 30);
      if (candles.length < 11) {
        return { name, points: 0, pointsPossible, passed: false, detail: { reason: 'insufficient candles' } };
      }
      const highs = candles.map((c) => c.high);
      const lows = candles.map((c) => c.low);
      const closes = candles.map((c) => c.close);
      const st = supertrend(highs, lows, closes, 10, 3);
      if (!st) {
        return { name, points: 0, pointsPossible, passed: false, detail: { reason: 'supertrend null' } };
      }
      const passed = input.side === 'BUY' ? st.direction === 'UP' : st.direction === 'DOWN';
      return { name, points: passed ? pointsPossible : 0, pointsPossible, passed, detail: st };
    } catch (err) {
      return { name, points: 0, pointsPossible, passed: false, detail: { error: errMsg(err) } };
    }
  }

  private async checkSrRoom(input: ScoringInput): Promise<ScoreCheckResult> {
    const name = 'S/R room';
    const pointsPossible = 10;
    const lb = input.setupContext?.levelBookSnapshot;
    if (!lb) {
      return { name, points: 0, pointsPossible, passed: false, detail: { reason: 'no level book' } };
    }
    try {
      const candles = await this.fetch15mCandles(input.token, input.exchange, 50);
      if (candles.length < 21) {
        return { name, points: 0, pointsPossible, passed: false, detail: { reason: 'insufficient candles for ATR' } };
      }
      const highs = candles.map((c) => c.high);
      const lows = candles.map((c) => c.low);
      const closes = candles.map((c) => c.close);
      const atr20 = atr(highs, lows, closes, 20);
      if (atr20 === null || atr20 <= 0) {
        return { name, points: 0, pointsPossible, passed: false, detail: { reason: 'atr null/zero' } };
      }
      // Find nearest opposing S/R
      let nextBlocker: number | null = null;
      if (input.side === 'BUY') {
        const candidates = [lb.pdh, lb.orh].filter((x): x is number => typeof x === 'number' && x > input.entryPrice);
        nextBlocker = candidates.length > 0 ? Math.min(...candidates) : null;
      } else {
        const candidates = [lb.pdl, lb.orl].filter((x): x is number => typeof x === 'number' && x < input.entryPrice);
        nextBlocker = candidates.length > 0 ? Math.max(...candidates) : null;
      }
      if (nextBlocker === null) {
        return { name, points: pointsPossible, pointsPossible, passed: true, detail: { reason: 'no opposing S/R within snapshot — full room' } };
      }
      const room = Math.abs(nextBlocker - input.entryPrice);
      const ratio = room / atr20;
      const passed = ratio >= 0.4;
      return { name, points: passed ? pointsPossible : 0, pointsPossible, passed, detail: { entryPrice: input.entryPrice, nextBlocker, atr20, ratio } };
    } catch (err) {
      return { name, points: 0, pointsPossible, passed: false, detail: { error: errMsg(err) } };
    }
  }

  private async checkVolume(input: ScoringInput): Promise<ScoreCheckResult> {
    const name = 'Volume confirmation';
    const pointsPossible = 5;
    try {
      const todayCandles = await this.fetchCandles(input.token, input.exchange, '5m', 100);
      const dailyCandles = await this.fetchCandles(input.token, input.exchange, '1d', 25);
      if (dailyCandles.length < 20) {
        return { name, points: 0, pointsPossible, passed: false, detail: { reason: 'insufficient daily candles' } };
      }
      const todayVol = todayCandles.reduce((sum, c) => sum + (c.volume || 0), 0);
      const avgDaily = dailyCandles.slice(-20).reduce((s, c) => s + (c.volume || 0), 0) / 20;
      if (avgDaily === 0) {
        return { name, points: 0, pointsPossible, passed: false, detail: { reason: 'avg daily volume zero' } };
      }
      const ratio = todayVol / avgDaily;
      const passed = ratio > 1.2;
      return { name, points: passed ? pointsPossible : 0, pointsPossible, passed, detail: { todayVol, avgDaily, ratio } };
    } catch (err) {
      return { name, points: 0, pointsPossible, passed: false, detail: { error: errMsg(err) } };
    }
  }

  // ─── Helpers ─────────────────────────────────────────────────────────

  private async fetchCandles(token: string, exchange: string, tf: string, lookback: number): Promise<Array<{ timestamp: Date; open: number; high: number; low: number; close: number; volume: number }>> {
    const lookbackMs = this.lookbackMsForTf(tf, lookback);
    const to = new Date();
    const from = new Date(to.getTime() - lookbackMs);
    const candles = (await this.adapter.getHistoricalData(token, exchange, tf, from, to)) as any[];
    return candles.map((c) => ({
      timestamp: c.timestamp instanceof Date ? c.timestamp : new Date(c.timestamp),
      open: Number(c.open),
      high: Number(c.high),
      low: Number(c.low),
      close: Number(c.close),
      volume: Number(c.volume) || 0,
    }));
  }

  private fetch15mCandles(token: string, exchange: string, n: number) {
    return this.fetchCandles(token, exchange, '15m', n);
  }

  private lookbackMsForTf(tf: string, count: number): number {
    const perBar: Record<string, number> = {
      '1m': 60_000,
      '5m': 5 * 60_000,
      '15m': 15 * 60_000,
      '1h': 60 * 60_000,
      '1d': 24 * 60 * 60_000,
    };
    // Wide buffer (3x) since holidays and gaps eat into the window
    return (perBar[tf] ?? 15 * 60_000) * count * 3;
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
```

### Step 3.2: Create the spec file

```typescript
// apps/api/src/modules/chartink/services/chartink-scoring.service.spec.ts
import { Test, type TestingModule } from '@nestjs/testing';
import { ChartinkScoringService, type ScoringInput } from './chartink-scoring.service';
import { AngelOneAdapterService } from '../../market-data/services/angel-one-adapter.service';

describe('ChartinkScoringService', () => {
  let service: ChartinkScoringService;
  let mockAdapter: { getHistoricalData: jest.Mock };

  beforeEach(async () => {
    mockAdapter = { getHistoricalData: jest.fn() };
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ChartinkScoringService,
        { provide: AngelOneAdapterService, useValue: mockAdapter },
      ],
    }).compile();
    module.useLogger(false);
    service = module.get(ChartinkScoringService);
    (service as unknown as { sleep: (ms: number) => Promise<void> }).sleep = () => Promise.resolve();
  });

  describe('scoreToLotCount', () => {
    it.each([
      [0, 0], [49, 0], [50, 1], [64, 1], [65, 2], [79, 2], [80, 3], [100, 3],
    ])('score=%d → %d lots', (score, expected) => {
      expect(service.scoreToLotCount(score)).toBe(expected);
    });
  });

  describe('score()', () => {
    const baseInput: ScoringInput = {
      token: '2885', symbol: 'RELIANCE', exchange: 'NSE', side: 'BUY',
      entryPrice: 2880, setupContext: null,
    };

    function rising(n: number, start: number, step: number) {
      return Array.from({ length: n }, (_, i) => ({
        timestamp: new Date(Date.UTC(2026, 4, 12, 0, i * 5)),
        open: start + i * step, high: start + i * step + 0.5, low: start + i * step - 0.5,
        close: start + i * step + 0.25, volume: 1000 + i * 50,
      }));
    }
    function falling(n: number, start: number, step: number) {
      return Array.from({ length: n }, (_, i) => ({
        timestamp: new Date(Date.UTC(2026, 4, 12, 0, i * 5)),
        open: start - i * step, high: start - i * step + 0.5, low: start - i * step - 0.5,
        close: start - i * step - 0.25, volume: 1000 + i * 50,
      }));
    }

    it('all checks rising → score around 73 (RELIANCE has sector mapping)', async () => {
      mockAdapter.getHistoricalData.mockResolvedValue(rising(60, 100, 0.5));
      const result = await service.score(baseInput);
      expect(result.score).toBeGreaterThanOrEqual(60);
      expect(result.lotCount).toBeGreaterThanOrEqual(1);
      expect(result.checks.length).toBe(9);
    });

    it('all checks falling on BUY setup → low score', async () => {
      mockAdapter.getHistoricalData.mockResolvedValue(falling(60, 100, 0.5));
      const result = await service.score(baseInput);
      expect(result.score).toBeLessThan(50);
      expect(result.lotCount).toBe(0);
    });

    it('symbol with no sector mapping → sector check fails with reason', async () => {
      mockAdapter.getHistoricalData.mockResolvedValue(rising(60, 100, 0.5));
      const input: ScoringInput = { ...baseInput, symbol: 'UNKNOWNSTOCK' };
      const result = await service.score(input);
      const sectorCheck = result.checks.find((c) => c.name === 'Sector aligned');
      expect(sectorCheck?.passed).toBe(false);
      expect(sectorCheck?.detail?.reason).toBe('no sector mapping');
    });

    it('broker throws for one check → that check fails but others continue', async () => {
      // First call throws (sector), rest succeed
      mockAdapter.getHistoricalData
        .mockRejectedValueOnce(new Error('Angel timeout'))
        .mockResolvedValue(rising(60, 100, 0.5));
      const result = await service.score(baseInput);
      expect(result.checks.length).toBe(9);
      const sector = result.checks.find((c) => c.name === 'Sector aligned');
      expect(sector?.detail?.error).toBe('Angel timeout');
    });
  });
});
```

### Step 3.3: Run tests + commit

```bash
cd C:/Users/AryanKumar/Desktop/TD_Automation/apps/api && npx jest src/modules/chartink/services/chartink-scoring.service.spec.ts 2>&1 | tail -20
```
Expected: all tests pass.

```bash
git add apps/api/src/modules/chartink/services/chartink-scoring.service.ts \
        apps/api/src/modules/chartink/services/chartink-scoring.service.spec.ts
git -c commit.gpgsign=false commit -m "feat(chartink): ChartinkScoringService — 9-check trade-quality scoring"
```

---

## Task 4: Wire scoring into ChartinkProcessService + Repository

**Files:**
- Modify: `apps/api/src/modules/chartink/services/chartink-process.service.ts`
- Modify: `apps/api/src/modules/chartink/repositories/chartink.repository.ts`
- Modify: `apps/api/src/modules/chartink/chartink.module.ts`

### Step 4.1: Register service in module

In `apps/api/src/modules/chartink/chartink.module.ts`, add `ChartinkScoringService` to `providers`. Add the import at top.

### Step 4.2: Update repository signature

In `apps/api/src/modules/chartink/repositories/chartink.repository.ts`, find the `createAlertSetup` method (or wherever it persists). The input type should accept three new optional fields:

```typescript
export interface CreateAlertSetupInput {
  alertId: string;
  symbol: string;
  token: string | null;
  hitPrice: number;
  kind: string;
  setupId: string | null;
  rejectReason: string | null;
  // NEW
  score?: number | null;
  lotCount?: number | null;
  scoreBreakdown?: unknown;  // JSON-serialized check results
}
```

Pass them through to `prisma.chartinkAlertSetup.create`:

```typescript
data: {
  ...existingFields,
  score: input.score ?? null,
  lotCount: input.lotCount ?? null,
  scoreBreakdown: input.scoreBreakdown ?? null,
}
```

### Step 4.3: Wire scoring into ChartinkProcessService

In `apps/api/src/modules/chartink/services/chartink-process.service.ts`:

1. Import the new service:
   ```typescript
   import { ChartinkScoringService, type SetupSide } from './chartink-scoring.service';
   ```

2. Add it to the constructor:
   ```typescript
   constructor(
     private readonly repo: ChartinkRepository,
     private readonly mdRepo: MarketDataRepository,
     private readonly signalSvc: SignalGeneratorService,
     private readonly tracker: SetupTrackerService,
     private readonly mtf: MtfAlignmentService,
     private readonly scoring: ChartinkScoringService,  // NEW
   ) {}
   ```

3. After the existing `result = await this.signalSvc.analyze(...)` call AND the existing `if (result.kind === 'setup')` branch, replace the setup-success persistence with:

```typescript
    if (result.kind === 'setup') {
      const locked = this.tracker.getActive(instrument.token);
      // NEW: run scoring on the locked setup
      let scoring = null as Awaited<ReturnType<typeof this.scoring.score>> | null;
      if (locked) {
        try {
          scoring = await this.scoring.score({
            token: instrument.token,
            symbol: hit.symbol,
            exchange: 'NSE',
            side: (locked.entry > locked.stoploss ? 'BUY' : 'SELL') as SetupSide,
            entryPrice: locked.entry,
            setupContext: locked,
          });
        } catch (err) {
          this.logger.warn(`scoring failed for ${hit.symbol}: ${err instanceof Error ? err.message : err}`);
        }
      }
      await this.repo.createAlertSetup({
        alertId,
        symbol: hit.symbol,
        token: instrument.token,
        hitPrice: hit.hitPrice,
        kind: 'setup',
        setupId: locked?.id ?? null,
        rejectReason: null,
        score: scoring?.score ?? null,
        lotCount: scoring?.lotCount ?? null,
        scoreBreakdown: scoring?.checks ?? null,
      });
    } else {
      // existing no-setup branch — unchanged
      await this.repo.createAlertSetup({
        alertId, symbol: hit.symbol, token: instrument.token, hitPrice: hit.hitPrice,
        kind: 'no-setup', setupId: null,
        rejectReason: result.reason ?? null,
      });
    }
```

### Step 4.4: Update test mock

In `apps/api/src/modules/chartink/services/__tests__/chartink-process.service.spec.ts`, find the `Test.createTestingModule` block. Add a mock for `ChartinkScoringService`:

```typescript
let mockScoring: { score: jest.Mock; scoreToLotCount: jest.Mock };
// in beforeEach:
mockScoring = {
  score: jest.fn().mockResolvedValue({ score: 70, lotCount: 2, checks: [] }),
  scoreToLotCount: jest.fn(),
};
// in providers:
{ provide: ChartinkScoringService, useValue: mockScoring },
```

Plus import: `import { ChartinkScoringService } from '../chartink-scoring.service';`

Existing tests should still pass (the scoring service is invoked only in the setup branch; tests that produce no-setup or mtf-misaligned don't touch it).

### Step 4.5: Verify + commit

```bash
cd C:/Users/AryanKumar/Desktop/TD_Automation/apps/api && npx jest src/modules/chartink 2>&1 | tail -20
```

```bash
git add apps/api/src/modules/chartink/services/chartink-process.service.ts \
        apps/api/src/modules/chartink/services/__tests__/chartink-process.service.spec.ts \
        apps/api/src/modules/chartink/repositories/chartink.repository.ts \
        apps/api/src/modules/chartink/chartink.module.ts
git -c commit.gpgsign=false commit -m "feat(chartink): persist scoring + lot count on alert setups"
```

---

## Task 5: Frontend types + score-breakdown table component

**Files:**
- Modify: `apps/web/src/types/index.ts` (or wherever ChartinkAlertSetup type lives)
- Create: `apps/web/src/components/chartink/ChartinkScoreTable.tsx`

### Step 5.1: Add score fields to the type

In `apps/web/src/types/index.ts`, find the `ChartinkAlertSetup` type (or `ChartinkAlert['setups']` element). Add three optional fields:

```typescript
interface ChartinkAlertSetup {
  // ... existing fields ...
  score?: number | null;
  lotCount?: 0 | 1 | 2 | 3 | null;
  scoreBreakdown?: Array<{
    name: string;
    points: number;
    pointsPossible: number;
    passed: boolean;
    detail?: Record<string, unknown>;
  }> | null;
}
```

### Step 5.2: Create the score table component

Create `apps/web/src/components/chartink/ChartinkScoreTable.tsx`:

```typescript
interface ScoreCheck {
  name: string;
  points: number;
  pointsPossible: number;
  passed: boolean;
  detail?: Record<string, unknown>;
}

interface ChartinkScoreTableProps {
  score: number;
  lotCount: 0 | 1 | 2 | 3;
  checks: ScoreCheck[];
}

function scoreColor(score: number): string {
  if (score >= 80) return 'text-emerald-400 bg-emerald-500/15';
  if (score >= 65) return 'text-blue-400 bg-blue-500/15';
  if (score >= 50) return 'text-amber-400 bg-amber-500/15';
  return 'text-gray-400 bg-gray-500/10';
}

function formatDetail(detail: Record<string, unknown> | undefined): string {
  if (!detail) return '';
  if (detail.reason) return String(detail.reason);
  if (detail.error) return `error: ${detail.error}`;
  const parts: string[] = [];
  for (const [k, v] of Object.entries(detail)) {
    if (typeof v === 'number') parts.push(`${k}=${v.toFixed(2)}`);
    else if (typeof v === 'string') parts.push(`${k}=${v}`);
  }
  return parts.join(' · ');
}

export default function ChartinkScoreTable({ score, lotCount, checks }: ChartinkScoreTableProps) {
  return (
    <div className="mt-2 text-xs">
      <div className="flex items-center gap-3 mb-2">
        <span className={`px-2 py-0.5 rounded text-sm font-medium ${scoreColor(score)}`}>
          {score}/100
        </span>
        <span className="text-[var(--color-text-secondary)]">
          → {lotCount === 0 ? 'SKIP' : `${lotCount} lot${lotCount > 1 ? 's' : ''}`}
        </span>
      </div>
      <table className="w-full">
        <tbody>
          {checks.map((c, i) => (
            <tr key={i} className="border-b border-[var(--color-border-subtle)]">
              <td className="py-1 px-2 w-6">{c.passed ? '✓' : '✗'}</td>
              <td className="py-1 px-2 text-[var(--color-text-primary)]">{c.name}</td>
              <td className="py-1 px-2 w-14 tabular-nums text-right">
                {c.points}/{c.pointsPossible}
              </td>
              <td className="py-1 px-2 text-[var(--color-text-muted)]">{formatDetail(c.detail)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
```

### Step 5.3: Verify + commit

```bash
cd C:/Users/AryanKumar/Desktop/TD_Automation/apps/web && npx tsc --noEmit 2>&1 | grep -E "ChartinkScoreTable|types/index" | head -5
```
Expected: no errors.

```bash
git add apps/web/src/types/index.ts apps/web/src/components/chartink/ChartinkScoreTable.tsx
git -c commit.gpgsign=false commit -m "feat(chartink): ChartinkScoreTable component + score type fields"
```

---

## Task 6: Wire score table + column into `/chartink` page

**Files:**
- Modify: `apps/web/src/pages/chartink/ChartinkPage.tsx`

### Step 6.1: Add column + breakdown rendering

Open `apps/web/src/pages/chartink/ChartinkPage.tsx`. Make these changes:

1. Add import at top:
   ```typescript
   import ChartinkScoreTable from '@/components/chartink/ChartinkScoreTable';
   ```

2. In the "Recent Alerts" table where alerts are listed, find the row template. Add a new column showing the highest score across that alert's setups (or "—" if no scored setup):

```typescript
function fmtAlertScore(setups: ChartinkAlert['setups']): string {
  const scored = (setups ?? []).filter((s) => typeof s.score === 'number');
  if (scored.length === 0) return '—';
  const max = Math.max(...scored.map((s) => s.score as number));
  const maxSetup = scored.find((s) => s.score === max);
  const lots = maxSetup?.lotCount ?? 0;
  return `${max}/100 (${lots} lot${lots !== 1 ? 's' : ''})`;
}
```

Then in the row template:
```typescript
<td>{fmtAlertScore(alert.setups)}</td>
```

Add header `<th>Score</th>` to the table head.

3. In the "Selected Alert Detail" section where each setup is rendered, conditionally render `<ChartinkScoreTable />` when `scoreBreakdown` is non-null:

```typescript
{setup.scoreBreakdown && typeof setup.score === 'number' && typeof setup.lotCount === 'number' && (
  <ChartinkScoreTable
    score={setup.score}
    lotCount={setup.lotCount as 0 | 1 | 2 | 3}
    checks={setup.scoreBreakdown}
  />
)}
```

### Step 6.2: Verify + commit

```bash
cd apps/web && npx tsc --noEmit 2>&1 | grep -E "ChartinkPage" | head -5
```
Expected: no errors.

```bash
git add apps/web/src/pages/chartink/ChartinkPage.tsx
git -c commit.gpgsign=false commit -m "feat(chartink): show score column + per-check breakdown on /chartink"
```

---

## Task 7: Smoke test end-to-end

- [ ] **Step 7.1: Confirm tests are all green**

```bash
cd apps/api && npx jest src/modules/chartink src/modules/signal-generator/strategies 2>&1 | tail -15
```
Expected: all green.

- [ ] **Step 7.2: Touch main.ts to trigger nest --watch reload + wait for restart**

```bash
cd C:/Users/AryanKumar/Desktop/TD_Automation && touch -c apps/api/src/main.ts
until curl -s http://127.0.0.1:4001/api/market-data/status --max-time 3 | grep -q feedActive; do sleep 2; done
echo "API up"
```

- [ ] **Step 7.3: Trigger a synthetic Chartink webhook with a stock that has sector mapping**

```bash
SECRET=$(grep '^CHARTINK_WEBHOOK_SECRET=' .env | cut -d= -f2-)
curl -sS -X POST "http://127.0.0.1:4001/webhooks/chartink/$SECRET" -H "Content-Type: application/json" --data-binary '{"stocks":"RELIANCE,TCS","trigger_prices":"2880,3900","triggered_at":"3:25 pm","scan_name":"scoring-smoke","scan_url":"scoring-smoke","alert_name":"x","webhook_url":""}'
```

- [ ] **Step 7.4: Wait for processing + inspect outcomes**

```bash
sleep 25
ALERT_ID=$(curl -s "http://127.0.0.1:4001/api/chartink/alerts" | grep -oE '"id":"cmp[^"]+"' | head -1 | cut -d\" -f4)
curl -s "http://127.0.0.1:4001/api/chartink/alerts/$ALERT_ID" | head -c 2000
```
Expected: at least one of `RELIANCE` or `TCS` has `score` and `lotCount` populated (non-null). For setups that didn't reach analyze() (mtf-misaligned, no-setup, unresolved), score remains null.

- [ ] **Step 7.5: Manual check: load /chartink page in browser and verify the Score column + per-check breakdown render correctly**

Open http://localhost:4000/chartink, click the new alert row to expand. Should show the per-check table for any setups that have scoreBreakdown.

---

## Done criteria

- All 9 checks have unit-test coverage for at least pass + fail cases.
- Lot-band mapping unit-tested at boundary values (0, 49, 50, 64, 65, 79, 80, 100).
- A real (or synthetic) Chartink fire produces a DB row with non-null `score`, `lotCount`, `scoreBreakdown`.
- `/chartink` page renders the score column on each alert row and the breakdown table when row is expanded.
- `tsc --noEmit` is clean for all modified files.
- No regression: existing chartink-process tests still pass (`mtf-misaligned`, `no-setup`, `unresolved`, `error` paths).

## Out of scope (reminder)

- Tuning the 9 weights based on real-data — v1 ships with the user's prescribed values.
- Per-scanner band overrides.
- Universal scoring across cron-fired setups — Chartink-only for v1.
- Auto-execution on high-score signals.
