# Levels + Context Strategy Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build an intraday level-based scanner that detects high-probability breakout/reversal setups across NSE indices + MCX commodities + NSE F&O stocks (~190 instruments) and emits structured signals with entry/SL/target/grade for the trader to take or skip.

**Architecture:** One pure-function strategy class (`LevelsContextStrategy`) plus one in-memory service (`LevelBookService`). Strategy plugs into the existing `universe-scanner.worker` and emits via the existing `SignalGateway`. Frontend chart overlay + extended SignalCard render the results. No new DB tables — one JSON column added to the existing `Signal` model.

**Tech Stack:** NestJS 11, Prisma + PostgreSQL, lightweight-charts (frontend), Bull/Redis (existing scheduler), socket.io (existing WS), Vitest/Jest (tests).

**Spec:** `docs/superpowers/specs/2026-04-27-levels-context-strategy-design.md`

---

## File Structure (locked decisions)

| File | Action | Responsibility |
|---|---|---|
| `prisma/schema.prisma` | Modify (`Signal` model line 90-117) | Add `setupContext: Json?` |
| `apps/api/src/modules/signal-generator/types/level-book.types.ts` | **Create** | `LevelBook` + helper types |
| `apps/api/src/modules/signal-generator/types/setup-context.types.ts` | **Create** | `SetupContext` payload shape |
| `apps/api/src/modules/signal-generator/services/level-book.service.ts` | **Create** | `LevelBookService` — seed/lock/update/get |
| `apps/api/src/modules/signal-generator/services/level-book.service.spec.ts` | **Create** | Unit tests for the service |
| `apps/api/src/modules/signal-generator/strategies/levels-context.strategy.ts` | **Create** | `LevelsContextStrategy implements TradingStrategy` |
| `apps/api/src/modules/signal-generator/strategies/levels-context.strategy.spec.ts` | **Create** | Table-driven gate tests |
| `apps/api/src/modules/signal-generator/strategies/index.ts` | Modify | Re-export new strategy |
| `apps/api/src/modules/signal-generator/services/strategy-registry.service.ts` | Modify | Register `LevelsContextStrategy` |
| `apps/api/src/modules/signal-generator/signal-generator.module.ts` | Modify | Provide `LevelBookService` |
| `apps/api/src/modules/signal-generator/workers/universe-scanner.worker.ts` | Modify | Extend universe to F&O list, use new strategy |
| `apps/api/src/modules/market-data/services/market-feed.service.ts` | Modify (one method) | Push tick to `LevelBookService.updateFromTick()` |
| `apps/api/src/modules/signal-generator/services/level-book.cron.ts` | **Create** | Cron jobs for `seedSession` (09:15 IST) + `lockOpeningRange` (09:30 IST) |
| `apps/api/src/modules/signal-generator/repositories/signal.repository.ts` | Modify (existing file) | Persist `setupContext` JSON when creating signal |
| `apps/web/src/types/index.ts` | Modify | Add `SetupContext` + extend `TradeSignal` |
| `apps/web/src/components/trading/SignalCard.tsx` | Modify | Render new `setupContext` fields |
| `apps/web/src/components/charts/LevelOverlay.tsx` | **Create** | Draw level lines on chart |
| `apps/web/src/components/charts/SetupMarker.tsx` | **Create** | Mark setup candle with arrow |
| `apps/web/src/pages/charts/ChartsPage.tsx` | Modify | Wire `?signal=…` URL param to load + draw overlay |
| `scripts/backtest-levels-context.mjs` | **Create** | Backtest harness (Phase 3) |

---

## Phase 1 — Backend strategy + scanner

After Phase 1, `curl /api/signals/active?strategy=levels-context` returns live signals during market hours. No frontend changes yet.

### Task 1: Add `setupContext` column to Signal model

**Files:**
- Modify: `prisma/schema.prisma:90-117`

- [ ] **Step 1.1: Add the column**

In `prisma/schema.prisma`, replace the Signal block at lines 90-117 with:

```prisma
model Signal {
  id              String   @id @default(cuid())
  instrumentId    String
  instrument      Instrument @relation(fields: [instrumentId], references: [id])
  side            String   // BUY, SELL
  entryPrice      Float
  targetPrice     Float
  stoplossPrice   Float
  expectedProfit  Float
  expectedLoss    Float
  riskRewardRatio Float
  confidence      String   // LOW, MEDIUM, HIGH, VERY_HIGH
  confidenceScore Int      // 0-100
  strategy        String
  timeframe       String
  reason          String
  marketStatus    String   @default("LIVE")
  isActive        Boolean  @default(true)
  setupContext    Json?    // levels-context strategy payload (level type, setup type, grade, level book snapshot, etc.) — see SetupContext type
  createdAt       DateTime @default(now())
  expiresAt       DateTime?

  trades Trade[]

  @@index([isActive, confidenceScore])
  @@index([strategy])
  @@index([createdAt])
  @@map("signals")
}
```

- [ ] **Step 1.2: Apply via direct SQL (avoids the broken-migration drift trap we hit with M5)**

```bash
docker exec -i td-postgres psql -U postgres -d td_automation -c \
  'ALTER TABLE signals ADD COLUMN IF NOT EXISTS "setupContext" JSONB;'
```

Expected output: `ALTER TABLE`

- [ ] **Step 1.3: Regenerate Prisma client**

```bash
npx prisma generate
```

Expected output: `✔ Generated Prisma Client`

- [ ] **Step 1.4: Commit**

```bash
git add prisma/schema.prisma
git commit -m "feat(prisma): add setupContext JSON column to Signal model"
```

---

### Task 2: Type definitions

**Files:**
- Create: `apps/api/src/modules/signal-generator/types/level-book.types.ts`
- Create: `apps/api/src/modules/signal-generator/types/setup-context.types.ts`

- [ ] **Step 2.1: Write `level-book.types.ts`**

```ts
/**
 * Per-instrument level book maintained by LevelBookService.
 * See docs/superpowers/specs/2026-04-27-levels-context-strategy-design.md
 * §3.1 for design rationale.
 */
export interface LevelBook {
  token: string;
  symbol: string;
  exchange: string;
  asOf: Date;

  // Static — locked once per session
  pdh: number;
  pdl: number;
  prevClose: number;
  orh: number | null;
  orl: number | null;
  orLocked: boolean;

  // Dynamic — rolling on every tick
  spot: number;
  vwap: number;
  todayHigh: number;
  todayLow: number;
  /** 14-period DAILY ATR. Drives all distance gates and SL buffers. */
  atr14: number;
  /** Last tick timestamp; if older than 60s, level book is stale. */
  lastTickAt: Date;

  // Computed on demand
  roundNumbers: number[];
  topVolStrikes?: number[];
}

export interface SeedSessionInput {
  token: string;
  symbol: string;
  exchange: string;
  /** Sorted ascending by timestamp; service uses last 14 daily candles + previous day's H/L. */
  recentDailyCandles: Array<{
    timestamp: Date;
    open: number;
    high: number;
    low: number;
    close: number;
    volume: number;
  }>;
}

export interface TickInput {
  token: string;
  ltp: number;
  volume: number;
  timestamp: Date;
}
```

- [ ] **Step 2.2: Write `setup-context.types.ts`**

```ts
export type LevelType =
  | 'PDH' | 'PDL'
  | 'ORH' | 'ORL'
  | 'VWAP'
  | 'ROUND'
  | 'VOL_STRIKE';

export type SetupType = 'BREAKOUT' | 'REVERSAL';

export type SetupGrade = 'A' | 'B' | 'C';

export type TimeOfDayWindow = 'morning-trend' | 'afternoon-trend';

export interface SetupContext {
  levelType: LevelType;
  setupType: SetupType;
  levelValue: number;
  grade: SetupGrade;

  entry: number;
  stoploss: number;
  target: number;

  triggerCandle: {
    time: number; // unix seconds
    ohlc: [number, number, number, number]; // open, high, low, close
  };

  levelBookSnapshot: {
    pdh: number;
    pdl: number;
    orh: number | null;
    orl: number | null;
    vwap: number;
    todayHigh: number;
    todayLow: number;
  };

  atr14: number;
  volumeRatio: number; // 5m volume / VMA20
  timeOfDayWindow: TimeOfDayWindow;
  expiryDayWarning?: boolean;
}
```

- [ ] **Step 2.3: Run type-check**

```bash
cd apps/api && npx tsc --noEmit
```

Expected: no NEW errors related to either file.

- [ ] **Step 2.4: Commit**

```bash
git add apps/api/src/modules/signal-generator/types/level-book.types.ts apps/api/src/modules/signal-generator/types/setup-context.types.ts
git commit -m "feat(signal-generator): add LevelBook + SetupContext type definitions"
```

---

### Task 3: LevelBookService — TDD

**Files:**
- Create: `apps/api/src/modules/signal-generator/services/level-book.service.spec.ts`
- Create: `apps/api/src/modules/signal-generator/services/level-book.service.ts`

- [ ] **Step 3.1: Write the failing test file**

```ts
// level-book.service.spec.ts
import { LevelBookService } from './level-book.service';

describe('LevelBookService', () => {
  let service: LevelBookService;

  beforeEach(() => {
    service = new LevelBookService();
  });

  // Helper: build a single daily candle
  const candle = (ts: string, o: number, h: number, l: number, c: number) => ({
    timestamp: new Date(ts),
    open: o, high: h, low: l, close: c, volume: 1000,
  });

  describe('seedSession', () => {
    it('seeds PDH/PDL/prevClose from the most recent candle', () => {
      service.seedSession({
        token: '99926000',
        symbol: 'NIFTY',
        exchange: 'NSE',
        recentDailyCandles: [
          candle('2026-04-25', 23900, 24050, 23800, 24020),
          candle('2026-04-26', 24020, 24180, 24000, 24100),
        ],
      });
      const lb = service.getLevels('99926000')!;
      expect(lb.pdh).toBe(24180);
      expect(lb.pdl).toBe(24000);
      expect(lb.prevClose).toBe(24100);
    });

    it('computes atr14 from the trailing 14 daily candles (Wilder)', () => {
      const candles = Array.from({ length: 14 }, (_, i) =>
        candle(`2026-04-${String(i + 1).padStart(2, '0')}`, 24000, 24100, 23900, 24050),
      );
      service.seedSession({
        token: '99926000', symbol: 'NIFTY', exchange: 'NSE',
        recentDailyCandles: candles,
      });
      const lb = service.getLevels('99926000')!;
      // All bars have range=200; SMA-of-TR = 200
      expect(lb.atr14).toBeCloseTo(200, 0);
    });

    it('initialises VWAP/today H/L to 0 and ORLocked=false', () => {
      service.seedSession({
        token: '99926000', symbol: 'NIFTY', exchange: 'NSE',
        recentDailyCandles: [candle('2026-04-26', 24020, 24180, 24000, 24100)],
      });
      const lb = service.getLevels('99926000')!;
      expect(lb.vwap).toBe(0);
      expect(lb.todayHigh).toBe(0);
      expect(lb.todayLow).toBe(0);
      expect(lb.orh).toBeNull();
      expect(lb.orl).toBeNull();
      expect(lb.orLocked).toBe(false);
    });
  });

  describe('updateFromTick', () => {
    beforeEach(() => {
      service.seedSession({
        token: '99926000', symbol: 'NIFTY', exchange: 'NSE',
        recentDailyCandles: [candle('2026-04-26', 24020, 24180, 24000, 24100)],
      });
    });

    it('rolls VWAP across multiple ticks (volume-weighted)', () => {
      service.updateFromTick({ token: '99926000', ltp: 24100, volume: 100, timestamp: new Date() });
      service.updateFromTick({ token: '99926000', ltp: 24150, volume: 100, timestamp: new Date() });
      const lb = service.getLevels('99926000')!;
      // (24100*100 + 24150*100) / 200 = 24125
      expect(lb.vwap).toBeCloseTo(24125, 1);
    });

    it('updates spot, todayHigh, todayLow', () => {
      service.updateFromTick({ token: '99926000', ltp: 24050, volume: 50, timestamp: new Date() });
      service.updateFromTick({ token: '99926000', ltp: 24200, volume: 50, timestamp: new Date() });
      service.updateFromTick({ token: '99926000', ltp: 23990, volume: 50, timestamp: new Date() });
      const lb = service.getLevels('99926000')!;
      expect(lb.spot).toBe(23990);
      expect(lb.todayHigh).toBe(24200);
      expect(lb.todayLow).toBe(23990);
    });

    it('ignores ticks for tokens not yet seeded', () => {
      // No throw, no side effects
      expect(() =>
        service.updateFromTick({ token: 'unknown', ltp: 100, volume: 1, timestamp: new Date() }),
      ).not.toThrow();
      expect(service.getLevels('unknown')).toBeNull();
    });
  });

  describe('lockOpeningRange', () => {
    beforeEach(() => {
      service.seedSession({
        token: '99926000', symbol: 'NIFTY', exchange: 'NSE',
        recentDailyCandles: [candle('2026-04-26', 24020, 24180, 24000, 24100)],
      });
    });

    it('locks ORH/ORL from the supplied 15-min candle', () => {
      service.lockOpeningRange('99926000', { high: 24165, low: 24115 });
      const lb = service.getLevels('99926000')!;
      expect(lb.orh).toBe(24165);
      expect(lb.orl).toBe(24115);
      expect(lb.orLocked).toBe(true);
    });

    it('is idempotent — second call does not overwrite', () => {
      service.lockOpeningRange('99926000', { high: 24165, low: 24115 });
      service.lockOpeningRange('99926000', { high: 24999, low: 23999 });
      const lb = service.getLevels('99926000')!;
      expect(lb.orh).toBe(24165);
      expect(lb.orl).toBe(24115);
    });
  });

  describe('staleness', () => {
    it('marks level book stale when last tick > 60s old', () => {
      service.seedSession({
        token: '99926000', symbol: 'NIFTY', exchange: 'NSE',
        recentDailyCandles: [candle('2026-04-26', 24020, 24180, 24000, 24100)],
      });
      const oldTickTime = new Date(Date.now() - 90_000);
      service.updateFromTick({ token: '99926000', ltp: 24100, volume: 100, timestamp: oldTickTime });
      expect(service.isStale('99926000')).toBe(true);
    });

    it('marks fresh after a recent tick', () => {
      service.seedSession({
        token: '99926000', symbol: 'NIFTY', exchange: 'NSE',
        recentDailyCandles: [candle('2026-04-26', 24020, 24180, 24000, 24100)],
      });
      service.updateFromTick({ token: '99926000', ltp: 24100, volume: 100, timestamp: new Date() });
      expect(service.isStale('99926000')).toBe(false);
    });
  });

  describe('roundNumbers', () => {
    it('returns nearest 50-step round numbers around spot for NIFTY', () => {
      service.seedSession({
        token: '99926000', symbol: 'NIFTY', exchange: 'NSE',
        recentDailyCandles: [candle('2026-04-26', 24020, 24180, 24000, 24100)],
      });
      service.updateFromTick({ token: '99926000', ltp: 24100, volume: 1, timestamp: new Date() });
      const lb = service.getLevels('99926000')!;
      // Default round-step for NIFTY is 50; expect 24050, 24100, 24150 within ±100 of spot
      expect(lb.roundNumbers).toEqual(expect.arrayContaining([24050, 24100, 24150]));
    });
  });
});
```

- [ ] **Step 3.2: Run test — expect FAIL**

```bash
cd apps/api && npm test -- level-book.service.spec
```

Expected: `Cannot find module './level-book.service'`.

- [ ] **Step 3.3: Implement `level-book.service.ts`**

```ts
import { Injectable, Logger } from '@nestjs/common';
import { LevelBook, SeedSessionInput, TickInput } from '../types/level-book.types';

const STALE_THRESHOLD_MS = 60_000;
const ATR_PERIOD = 14;
const DEFAULT_ROUND_STEP: Record<string, number> = {
  NIFTY: 50, BANKNIFTY: 100, FINNIFTY: 50, MIDCPNIFTY: 25,
};
const DEFAULT_FALLBACK_STEP = 50;

interface BookState extends LevelBook {
  /** Internal accumulators for VWAP. */
  cumPV: number;
  cumV: number;
}

@Injectable()
export class LevelBookService {
  private readonly logger = new Logger(LevelBookService.name);
  private readonly books = new Map<string, BookState>();

  seedSession(input: SeedSessionInput): void {
    const candles = [...input.recentDailyCandles].sort(
      (a, b) => a.timestamp.getTime() - b.timestamp.getTime(),
    );
    if (candles.length === 0) {
      this.logger.warn(`seedSession: no candles for ${input.symbol}, skipping`);
      return;
    }
    const last = candles[candles.length - 1];
    const atr14 = this.computeAtr(candles);

    const book: BookState = {
      token: input.token,
      symbol: input.symbol,
      exchange: input.exchange,
      asOf: new Date(),
      pdh: last.high,
      pdl: last.low,
      prevClose: last.close,
      orh: null,
      orl: null,
      orLocked: false,
      spot: 0,
      vwap: 0,
      todayHigh: 0,
      todayLow: 0,
      atr14,
      lastTickAt: new Date(0),
      roundNumbers: [],
      cumPV: 0,
      cumV: 0,
    };
    this.books.set(input.token, book);
  }

  updateFromTick(tick: TickInput): void {
    const book = this.books.get(tick.token);
    if (!book) return; // not seeded; ignore silently

    book.spot = tick.ltp;
    if (book.todayHigh === 0 || tick.ltp > book.todayHigh) book.todayHigh = tick.ltp;
    if (book.todayLow === 0 || tick.ltp < book.todayLow) book.todayLow = tick.ltp;

    if (tick.volume > 0) {
      book.cumPV += tick.ltp * tick.volume;
      book.cumV += tick.volume;
      book.vwap = book.cumPV / book.cumV;
    }

    book.lastTickAt = tick.timestamp;
    book.roundNumbers = this.computeRoundNumbers(book.symbol, tick.ltp);
  }

  lockOpeningRange(token: string, or: { high: number; low: number }): void {
    const book = this.books.get(token);
    if (!book) return;
    if (book.orLocked) return; // idempotent
    book.orh = or.high;
    book.orl = or.low;
    book.orLocked = true;
  }

  getLevels(token: string): LevelBook | null {
    const book = this.books.get(token);
    if (!book) return null;
    // Strip internal accumulators from the public view
    const { cumPV: _pv, cumV: _v, ...publicBook } = book;
    void _pv; void _v;
    return publicBook;
  }

  isStale(token: string): boolean {
    const book = this.books.get(token);
    if (!book) return true;
    return Date.now() - book.lastTickAt.getTime() > STALE_THRESHOLD_MS;
  }

  setTopVolStrikes(token: string, strikes: number[]): void {
    const book = this.books.get(token);
    if (!book) return;
    book.topVolStrikes = strikes;
  }

  /** Wilder-smoothed ATR over the last ATR_PERIOD candles. */
  private computeAtr(
    candles: SeedSessionInput['recentDailyCandles'],
  ): number {
    if (candles.length < 2) return 0;
    const window = candles.slice(-ATR_PERIOD - 1);
    const trs: number[] = [];
    for (let i = 1; i < window.length; i++) {
      const cur = window[i];
      const prev = window[i - 1];
      const tr = Math.max(
        cur.high - cur.low,
        Math.abs(cur.high - prev.close),
        Math.abs(cur.low - prev.close),
      );
      trs.push(tr);
    }
    if (trs.length === 0) return 0;
    // Simple SMA of TR over up to ATR_PERIOD bars (good enough; Wilder
    // smoothing converges to SMA over a stable series).
    const sum = trs.slice(-ATR_PERIOD).reduce((a, b) => a + b, 0);
    return sum / Math.min(ATR_PERIOD, trs.length);
  }

  private computeRoundNumbers(symbol: string, spot: number): number[] {
    const step = DEFAULT_ROUND_STEP[symbol.toUpperCase()] ?? DEFAULT_FALLBACK_STEP;
    const center = Math.round(spot / step) * step;
    return [center - 2 * step, center - step, center, center + step, center + 2 * step];
  }
}
```

- [ ] **Step 3.4: Run tests — expect PASS**

```bash
cd apps/api && npm test -- level-book.service.spec
```

Expected: all tests in the file PASS.

- [ ] **Step 3.5: Commit**

```bash
git add apps/api/src/modules/signal-generator/services/level-book.service.ts apps/api/src/modules/signal-generator/services/level-book.service.spec.ts
git commit -m "feat(signal-generator): LevelBookService — seed/lock/update/get with tests"
```

---

### Task 4: LevelsContextStrategy — TDD with all gates

**Files:**
- Create: `apps/api/src/modules/signal-generator/strategies/levels-context.strategy.spec.ts`
- Create: `apps/api/src/modules/signal-generator/strategies/levels-context.strategy.ts`

This is the largest task. Tests are table-driven across all gate combinations.

- [ ] **Step 4.1: Write the test file**

```ts
// levels-context.strategy.spec.ts
import { LevelsContextStrategy } from './levels-context.strategy';
import { LevelBook } from '../types/level-book.types';
import { CandleData } from '../../../common/interfaces/trading-strategy.interface';

describe('LevelsContextStrategy.analyze', () => {
  let strategy: LevelsContextStrategy;
  beforeEach(() => {
    strategy = new LevelsContextStrategy();
  });

  // Build N 5-min candles ending at a target close. ATR/volume are configurable.
  const buildCandles = (count: number, opts: {
    closes?: number[]; volumes?: number[];
    open?: number; high?: number; low?: number;
  }): CandleData[] => {
    const candles: CandleData[] = [];
    for (let i = 0; i < count; i++) {
      const close = opts.closes?.[i] ?? 24100;
      const volume = opts.volumes?.[i] ?? 100_000;
      candles.push({
        timestamp: new Date(`2026-04-27T10:${String(i).padStart(2, '0')}:00+05:30`),
        open: opts.open ?? close - 5,
        high: opts.high ?? close + 10,
        low: opts.low ?? close - 10,
        close,
        volume,
      });
    }
    return candles;
  };

  const baseLevelBook = (overrides?: Partial<LevelBook>): LevelBook => ({
    token: '99926000',
    symbol: 'NIFTY',
    exchange: 'NSE',
    asOf: new Date(),
    pdh: 24180,
    pdl: 23950,
    prevClose: 24100,
    orh: 24160,
    orl: 24080,
    orLocked: true,
    spot: 24100,
    vwap: 24090,
    todayHigh: 24160,
    todayLow: 24050,
    atr14: 100,
    lastTickAt: new Date(),
    roundNumbers: [24000, 24050, 24100, 24150, 24200],
    ...overrides,
  });

  // ---- Distance gate ----
  it('returns null when spot is too far from every level', () => {
    const book = baseLevelBook({ spot: 24500 });
    const candles = buildCandles(25, { closes: Array(25).fill(24500) });
    expect(strategy.analyze({ candles, levelBook: book, nowIst: '10:00' })).toBeNull();
  });

  // ---- Time-of-day gate ----
  it('returns null when current time is in midday chop window', () => {
    const book = baseLevelBook();
    // Last close right at PDH 24180 with volume spike — would normally fire
    const candles = buildCandles(25, {
      closes: [...Array(24).fill(24100), 24185],
      volumes: [...Array(20).fill(100_000), ...Array(5).fill(200_000)],
    });
    expect(strategy.analyze({ candles, levelBook: book, nowIst: '12:30' })).toBeNull();
  });

  // ---- Stale level book ----
  it('returns null when level book is stale (lastTickAt > 60s old)', () => {
    const book = baseLevelBook({ lastTickAt: new Date(Date.now() - 90_000) });
    const candles = buildCandles(25, { closes: [...Array(24).fill(24100), 24185] });
    expect(strategy.analyze({ candles, levelBook: book, nowIst: '10:00' })).toBeNull();
  });

  // ---- Breakout pass ----
  it('emits BREAKOUT signal when 5m close > level + 0.1·ATR with volume confirm', () => {
    const book = baseLevelBook({ spot: 24190 });
    // 25 bars: first 20 average ~100k volume, last bars spike to 200k
    const candles = buildCandles(25, {
      closes: [...Array(24).fill(24100), 24195],
      volumes: [...Array(20).fill(100_000), ...Array(5).fill(200_000)],
    });
    const out = strategy.analyze({ candles, levelBook: book, nowIst: '10:30' });
    expect(out).not.toBeNull();
    expect(out!.metadata!.setupType).toBe('BREAKOUT');
    expect(out!.metadata!.levelType).toBe('PDH');
    expect(out!.side).toBe('BUY');
  });

  // ---- Reversal pass ----
  it('emits REVERSAL signal on pinbar rejection at PDH', () => {
    const book = baseLevelBook({ spot: 24165 });
    // Pinbar candle: long upper wick into PDH(24180), close near low
    const lastCandle: CandleData = {
      timestamp: new Date('2026-04-27T10:30:00+05:30'),
      open: 24160,
      high: 24182,    // wick into PDH
      low: 24150,
      close: 24158,   // body small + back below level
      volume: 130_000,
    };
    const earlier = buildCandles(24, { closes: Array(24).fill(24160), volumes: Array(24).fill(100_000) });
    const candles = [...earlier, lastCandle];
    const out = strategy.analyze({ candles, levelBook: book, nowIst: '10:30' });
    expect(out).not.toBeNull();
    expect(out!.metadata!.setupType).toBe('REVERSAL');
    expect(out!.side).toBe('SELL'); // rejection at resistance → short bias
  });

  // ---- R:R fail ----
  it('returns null when R:R math fails (target < 2× SL)', () => {
    // PDH=24180, spot=24179, no other levels nearby — target distance too small
    const book = baseLevelBook({
      spot: 24179, pdh: 24180,
      orh: 24210,   // very close — would make target < 2×SL
      orl: 23950, vwap: 24179, todayHigh: 24179, todayLow: 24050,
      atr14: 50,    // tiny ATR exaggerates the issue
      roundNumbers: [],
    });
    const candles = buildCandles(25, {
      closes: [...Array(24).fill(24178), 24185],
      volumes: [...Array(20).fill(100_000), ...Array(5).fill(200_000)],
    });
    expect(strategy.analyze({ candles, levelBook: book, nowIst: '10:00' })).toBeNull();
  });

  // ---- Volume gate fail ----
  it('returns null when breakout candle volume < 1.2× VMA20', () => {
    const book = baseLevelBook({ spot: 24190 });
    const candles = buildCandles(25, {
      closes: [...Array(24).fill(24100), 24195],
      // No volume spike on the trigger candle
      volumes: Array(25).fill(100_000),
    });
    expect(strategy.analyze({ candles, levelBook: book, nowIst: '10:00' })).toBeNull();
  });

  // ---- Grade A: confluence ----
  it('grades A when level is in confluence with another level (within 0.1·ATR)', () => {
    // PDH 24180 + round number 24150 within 0.3·ATR; spot interacts with PDH
    const book = baseLevelBook({
      spot: 24190,
      pdh: 24180,
      roundNumbers: [24150, 24180, 24200, 24250],
    });
    const candles = buildCandles(25, {
      closes: [...Array(24).fill(24100), 24195],
      volumes: [...Array(20).fill(100_000), ...Array(5).fill(160_000)],
    });
    const out = strategy.analyze({ candles, levelBook: book, nowIst: '10:00' });
    expect(out).not.toBeNull();
    expect(out!.metadata!.grade).toBe('A');
  });
});
```

- [ ] **Step 4.2: Run tests — expect FAIL**

```bash
cd apps/api && npm test -- levels-context.strategy.spec
```

Expected: `Cannot find module './levels-context.strategy'`.

- [ ] **Step 4.3: Implement `levels-context.strategy.ts`**

```ts
import {
  TradingStrategy,
  MarketSnapshot,
  SignalOutput,
  CandleData,
  BacktestInput,
  BacktestResult,
} from '../../../common/interfaces/trading-strategy.interface';
import { LevelBook } from '../types/level-book.types';
import {
  LevelType,
  SetupType,
  SetupGrade,
  SetupContext,
  TimeOfDayWindow,
} from '../types/setup-context.types';

const DISTANCE_GATE_ATR = 0.3;       // |spot - level| ≤ 0.3 × ATR14
const BREAKOUT_BODY_ATR = 0.1;       // close must be > level + 0.1 × ATR
const VOLUME_RATIO_MIN = 1.2;        // 5m volume / VMA20
const PINBAR_BODY_PCT = 0.3;         // body ≤ 30% of full candle range
const SL_BUFFER_ATR = 0.25;          // SL = level + 0.25 × ATR (asymmetric direction-aware)
const RR_FLOOR_STRICT = 2.0;
const STALE_TICK_MS = 60_000;
const MORNING_START = '09:45';
const MORNING_END = '11:00';
const AFTERNOON_START = '14:30';
const AFTERNOON_END = '15:30';
const CONFLUENCE_RADIUS_ATR = 0.1;
const VOLUME_RATIO_GRADE_A = 1.5;

export interface AnalyzeInput {
  candles: CandleData[];
  levelBook: LevelBook;
  /** "HH:MM" 24h IST clock for the current scan tick. */
  nowIst: string;
}

interface CandidateLevel {
  type: LevelType;
  value: number;
}

export class LevelsContextStrategy implements TradingStrategy {
  readonly name = 'levels-context';
  readonly description =
    'Intraday breakout/reversal scanner anchored on PDH/PDL/OR/VWAP/round-number levels with R:R + time-of-day + volume gates.';
  readonly supportedSegments = ['OPTIONS', 'EQUITY', 'FUTURES', 'COMMODITY'];
  readonly preferredTimeframes = ['5m'];

  private params: Record<string, unknown> = {
    rrFloor: RR_FLOOR_STRICT,
    distanceGateAtr: DISTANCE_GATE_ATR,
    volumeRatioMin: VOLUME_RATIO_MIN,
  };

  // The TradingStrategy interface forces `analyze(MarketSnapshot)`. The
  // scanner wraps a LevelBook lookup into MarketSnapshot.metadata so we
  // accept either shape.
  analyze(data: MarketSnapshot | AnalyzeInput): SignalOutput | null {
    const input: AnalyzeInput | null = this.unwrap(data);
    if (!input) return null;
    const { candles, levelBook, nowIst } = input;

    if (candles.length < 25) return null;
    if (this.isStale(levelBook)) return null;
    if (!this.inTradingWindow(nowIst)) return null;

    const last = candles[candles.length - 1];
    const vma20 = this.vma(candles.slice(-21, -1)); // 20 prior bars
    const volumeRatio = vma20 > 0 ? last.volume / vma20 : 0;

    const candidates = this.collectLevels(levelBook);
    for (const lvl of candidates) {
      const dist = Math.abs(levelBook.spot - lvl.value);
      if (dist > DISTANCE_GATE_ATR * levelBook.atr14) continue;

      const breakout = this.detectBreakout(last, lvl, levelBook.atr14, volumeRatio);
      const reversal = this.detectReversal(last, lvl, levelBook.atr14);
      if (!breakout && !reversal) continue;

      const setupType: SetupType = breakout ? 'BREAKOUT' : 'REVERSAL';
      const isLong = this.directionFromSetup(setupType, last, lvl.value);
      const slTarget = this.computeSlAndTarget({
        setupType, isLong, level: lvl.value, atr: levelBook.atr14,
        levelBook, candidates,
      });
      if (!slTarget) continue;

      const rr =
        Math.abs(slTarget.target - slTarget.entry) /
        Math.max(Math.abs(slTarget.entry - slTarget.stoploss), 1e-6);
      if (rr < (this.params.rrFloor as number)) continue;

      const grade = this.gradeSetup({
        candidates, level: lvl, atr: levelBook.atr14,
        volumeRatio, nowIst,
      });
      if (grade === 'C') continue; // C-grade filtered out at strict threshold

      const window: TimeOfDayWindow =
        this.between(nowIst, MORNING_START, MORNING_END)
          ? 'morning-trend' : 'afternoon-trend';

      const setupContext: SetupContext = {
        levelType: lvl.type,
        setupType,
        levelValue: lvl.value,
        grade,
        entry: slTarget.entry,
        stoploss: slTarget.stoploss,
        target: slTarget.target,
        triggerCandle: {
          time: Math.floor(last.timestamp.getTime() / 1000),
          ohlc: [last.open, last.high, last.low, last.close],
        },
        levelBookSnapshot: {
          pdh: levelBook.pdh, pdl: levelBook.pdl,
          orh: levelBook.orh, orl: levelBook.orl,
          vwap: levelBook.vwap,
          todayHigh: levelBook.todayHigh, todayLow: levelBook.todayLow,
        },
        atr14: levelBook.atr14,
        volumeRatio,
        timeOfDayWindow: window,
      };

      const reason = this.buildReason(setupContext, levelBook);

      return {
        symbol: levelBook.symbol,
        exchange: levelBook.exchange,
        side: isLong ? 'BUY' : 'SELL',
        entryPrice: slTarget.entry,
        targetPrice: slTarget.target,
        stoplossPrice: slTarget.stoploss,
        confidence: Math.round(rr * 25), // crude 0-100 from R:R
        reason,
        timeframe: '5m',
        metadata: setupContext,
      };
    }

    return null;
  }

  backtest(_input: BacktestInput): BacktestResult {
    // Backtesting is implemented in scripts/backtest-levels-context.mjs
    // which calls analyze() directly with replayed candle/level-book inputs.
    // The TradingStrategy interface requires this method — we throw to
    // signal callers to use the dedicated harness instead.
    throw new Error(
      'LevelsContextStrategy: use scripts/backtest-levels-context.mjs for backtesting.',
    );
  }

  getParameters(): Record<string, unknown> {
    return { ...this.params };
  }

  setParameters(params: Record<string, unknown>): void {
    this.params = { ...this.params, ...params };
  }

  // ─────────────────────────────────────────────
  // Internals
  // ─────────────────────────────────────────────

  private unwrap(data: MarketSnapshot | AnalyzeInput): AnalyzeInput | null {
    if ('levelBook' in data && 'nowIst' in data) {
      return data as AnalyzeInput;
    }
    const snapshot = data as MarketSnapshot;
    const meta = (snapshot as unknown as { metadata?: AnalyzeInput }).metadata;
    if (!meta || !meta.levelBook || !meta.nowIst) return null;
    return { candles: snapshot.candles, levelBook: meta.levelBook, nowIst: meta.nowIst };
  }

  private isStale(book: LevelBook): boolean {
    return Date.now() - book.lastTickAt.getTime() > STALE_TICK_MS;
  }

  private inTradingWindow(nowIst: string): boolean {
    return (
      this.between(nowIst, MORNING_START, MORNING_END) ||
      this.between(nowIst, AFTERNOON_START, AFTERNOON_END)
    );
  }

  private between(hhmm: string, lo: string, hi: string): boolean {
    return hhmm >= lo && hhmm <= hi;
  }

  private collectLevels(book: LevelBook): CandidateLevel[] {
    const out: CandidateLevel[] = [
      { type: 'PDH', value: book.pdh },
      { type: 'PDL', value: book.pdl },
      { type: 'VWAP', value: book.vwap },
    ];
    if (book.orh !== null) out.push({ type: 'ORH', value: book.orh });
    if (book.orl !== null) out.push({ type: 'ORL', value: book.orl });
    for (const r of book.roundNumbers) out.push({ type: 'ROUND', value: r });
    if (book.topVolStrikes) {
      for (const s of book.topVolStrikes) out.push({ type: 'VOL_STRIKE', value: s });
    }
    return out.filter((l) => Number.isFinite(l.value) && l.value > 0);
  }

  private detectBreakout(
    candle: CandleData,
    level: CandidateLevel,
    atr: number,
    volumeRatio: number,
  ): boolean {
    if (volumeRatio < VOLUME_RATIO_MIN) return false;
    const buffer = BREAKOUT_BODY_ATR * atr;
    const above = candle.close > level.value + buffer;
    const below = candle.close < level.value - buffer;
    return above || below;
  }

  private detectReversal(candle: CandleData, level: CandidateLevel, atr: number): boolean {
    const range = candle.high - candle.low;
    if (range <= 0) return false;
    const body = Math.abs(candle.close - candle.open);
    if (body / range > PINBAR_BODY_PCT) return false;

    // upper wick into a level above current (resistance rejection)
    const upperWick = candle.high - Math.max(candle.open, candle.close);
    const lowerWick = Math.min(candle.open, candle.close) - candle.low;
    const tagsLevelFromBelow = candle.high >= level.value && candle.close < level.value;
    const tagsLevelFromAbove = candle.low <= level.value && candle.close > level.value;
    if (tagsLevelFromBelow && upperWick / range > 0.5) return true;
    if (tagsLevelFromAbove && lowerWick / range > 0.5) return true;
    return false;
  }

  private directionFromSetup(
    setup: SetupType,
    last: CandleData,
    level: number,
  ): boolean {
    if (setup === 'BREAKOUT') return last.close > level;
    // REVERSAL: rejection at level → fade direction
    return last.close < level; // rejected from below → bearish (SELL)
  }

  private computeSlAndTarget(args: {
    setupType: SetupType;
    isLong: boolean;
    level: number;
    atr: number;
    levelBook: LevelBook;
    candidates: CandidateLevel[];
  }): { entry: number; stoploss: number; target: number } | null {
    const { setupType, isLong, level, atr, levelBook, candidates } = args;
    const buffer = SL_BUFFER_ATR * atr;
    const entry = levelBook.spot;
    let stoploss: number;

    if (setupType === 'BREAKOUT') {
      stoploss = isLong ? level - buffer : level + buffer;
    } else {
      stoploss = isLong ? level - buffer : level + buffer;
    }

    const slDist = Math.abs(entry - stoploss);
    if (slDist <= 0) return null;
    const minTargetDist = 2 * slDist;

    // Find the nearest opposing level in the trade direction
    const opposing = candidates
      .filter((c) => (isLong ? c.value > entry : c.value < entry))
      .sort((a, b) =>
        Math.abs(a.value - entry) - Math.abs(b.value - entry),
      );

    let target: number;
    if (opposing.length > 0 && Math.abs(opposing[0].value - entry) >= minTargetDist) {
      target = opposing[0].value;
    } else {
      target = isLong ? entry + minTargetDist : entry - minTargetDist;
    }
    return { entry, stoploss, target };
  }

  private gradeSetup(args: {
    candidates: CandidateLevel[];
    level: CandidateLevel;
    atr: number;
    volumeRatio: number;
    nowIst: string;
  }): SetupGrade {
    const { candidates, level, atr, volumeRatio, nowIst } = args;
    const confluence = candidates.filter(
      (c) =>
        c !== level && Math.abs(c.value - level.value) <= CONFLUENCE_RADIUS_ATR * atr,
    ).length;
    const primeWindow =
      this.between(nowIst, '09:45', '10:30') ||
      this.between(nowIst, '14:45', '15:15');
    if (confluence >= 1 && volumeRatio >= VOLUME_RATIO_GRADE_A && primeWindow) return 'A';
    if (volumeRatio >= VOLUME_RATIO_MIN) return 'B';
    return 'C';
  }

  private vma(candles: CandleData[]): number {
    if (candles.length === 0) return 0;
    const sum = candles.reduce((a, c) => a + c.volume, 0);
    return sum / candles.length;
  }

  private buildReason(ctx: SetupContext, book: LevelBook): string {
    const dir = ctx.setupType === 'BREAKOUT' ? 'broke' : 'rejected';
    return `${book.symbol} ${dir} ${ctx.levelType} (${ctx.levelValue}). Volume ${ctx.volumeRatio.toFixed(2)}× VMA20. SL ${ctx.stoploss.toFixed(2)}, target ${ctx.target.toFixed(2)}, R:R ${(Math.abs(ctx.target - ctx.entry) / Math.abs(ctx.entry - ctx.stoploss)).toFixed(2)}. Grade ${ctx.grade}.`;
  }
}
```

- [ ] **Step 4.4: Run tests — expect PASS**

```bash
cd apps/api && npm test -- levels-context.strategy.spec
```

Expected: all test cases PASS.

- [ ] **Step 4.5: Commit**

```bash
git add apps/api/src/modules/signal-generator/strategies/levels-context.strategy.ts apps/api/src/modules/signal-generator/strategies/levels-context.strategy.spec.ts
git commit -m "feat(signal-generator): LevelsContextStrategy — pure-function gates with table-driven tests"
```

---

### Task 5: Tick wiring — push ticks from MarketFeedService to LevelBookService

**Files:**
- Modify: `apps/api/src/modules/market-data/services/market-feed.service.ts` (one method)
- Modify: `apps/api/src/modules/signal-generator/signal-generator.module.ts` (provide LevelBookService)
- Modify: `apps/api/src/modules/market-data/market-data.module.ts` (export LevelBookService access)

- [ ] **Step 5.1: Provide LevelBookService in signal-generator module**

In `apps/api/src/modules/signal-generator/signal-generator.module.ts`, add `LevelBookService` to the providers array and exports array. Read the existing file first to find the providers/exports lists; insert these lines:

```ts
import { LevelBookService } from './services/level-book.service';

// inside @Module({ providers: [...] })
LevelBookService,

// inside @Module({ exports: [...] })
LevelBookService,
```

- [ ] **Step 5.2: Import the signal-generator module from market-data (or use a shared module pattern). The cleanest path:** add `imports: [forwardRef(() => SignalGeneratorModule)]` to `MarketDataModule` and inject `LevelBookService` into `MarketFeedService`. Mirror the existing `forwardRef(() => OptionsChainModule)` pattern in market-data.module.ts.

- [ ] **Step 5.3: In `MarketFeedService`, find the tick handler that already calls `this.candleAggregator.processTick(tick)` (around line 528 per audits earlier in the session). After that call, add:**

```ts
// Drive the per-instrument level book off the same tick stream.
// LevelBookService rolls VWAP / today H/L / spot and tracks staleness.
this.levelBookService.updateFromTick({
  token: tick.token,
  ltp: tick.ltp,
  volume: tick.volume,
  timestamp: tick.timestamp,
});
```

Inject `LevelBookService` via the constructor.

- [ ] **Step 5.4: Type-check**

```bash
cd apps/api && npx tsc --noEmit
```

Expected: no NEW errors. The pre-existing module-resolution errors in `@td/shared/types` are unrelated.

- [ ] **Step 5.5: Commit**

```bash
git add apps/api/src/modules/market-data/services/market-feed.service.ts apps/api/src/modules/signal-generator/signal-generator.module.ts apps/api/src/modules/market-data/market-data.module.ts
git commit -m "feat(market-feed): push ticks to LevelBookService for VWAP/today H-L tracking"
```

---

### Task 6 + 7: Cron jobs — pre-market seeder + opening range locker

**Files:**
- Create: `apps/api/src/modules/signal-generator/services/level-book.cron.ts`
- Modify: `apps/api/src/modules/signal-generator/signal-generator.module.ts` (provide cron)

- [ ] **Step 6.1: Write `level-book.cron.ts`**

```ts
import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { LevelBookService } from './level-book.service';
import { PrismaService } from '../../../common/prisma/prisma.service';
import { TIMEFRAMES } from '@td/shared/constants';

const UNIVERSE: Array<{ token: string; symbol: string; exchange: string }> = [
  // Indices
  { token: '99926000', symbol: 'NIFTY', exchange: 'NSE' },
  { token: '99926009', symbol: 'BANKNIFTY', exchange: 'NSE' },
  { token: '99926037', symbol: 'FINNIFTY', exchange: 'NSE' },
  // MCX commodities (top by liquidity)
  { token: '486502', symbol: 'CRUDEOIL', exchange: 'MCX' },
  { token: '488791', symbol: 'COPPER', exchange: 'MCX' },
  // Stocks: keep small in v1; expand once stocks-options decision lands
  // (Decision Log #9 in spec: cash market or stock-future, not stock options)
];

@Injectable()
export class LevelBookCron {
  private readonly logger = new Logger(LevelBookCron.name);

  constructor(
    private readonly levelBook: LevelBookService,
    private readonly prisma: PrismaService,
  ) {}

  /** 09:15 IST Mon-Fri — seed PDH/PDL/ATR for the day's universe. */
  @Cron('0 15 9 * * 1-5', { timeZone: 'Asia/Kolkata' })
  async seedSession(): Promise<void> {
    this.logger.log('Seeding level books for the session');
    for (const u of UNIVERSE) {
      try {
        const inst = await this.prisma.instrument.findFirst({
          where: { token: u.token, exchange: u.exchange },
          select: { id: true },
        });
        if (!inst) {
          this.logger.warn(`No instrument row for ${u.symbol}; skipping`);
          continue;
        }
        const recent = await this.prisma.candle.findMany({
          where: { instrumentId: inst.id, timeframe: TIMEFRAMES.ONE_DAY },
          orderBy: { timestamp: 'desc' },
          take: 16,
        });
        if (recent.length === 0) {
          this.logger.warn(`No daily candles for ${u.symbol}; skipping`);
          continue;
        }
        this.levelBook.seedSession({
          token: u.token, symbol: u.symbol, exchange: u.exchange,
          recentDailyCandles: recent
            .reverse()
            .map((c) => ({
              timestamp: c.timestamp,
              open: c.open, high: c.high, low: c.low, close: c.close,
              volume: Number(c.volume),
            })),
        });
      } catch (err) {
        this.logger.error(
          `seedSession ${u.symbol} failed: ${err instanceof Error ? err.message : err}`,
        );
      }
    }
    this.logger.log(`Seeded ${UNIVERSE.length} level books`);
  }

  /** 09:30 IST Mon-Fri — lock the opening range from the first 15-min candle. */
  @Cron('0 30 9 * * 1-5', { timeZone: 'Asia/Kolkata' })
  async lockOpeningRange(): Promise<void> {
    this.logger.log('Locking opening ranges');
    for (const u of UNIVERSE) {
      try {
        const inst = await this.prisma.instrument.findFirst({
          where: { token: u.token, exchange: u.exchange },
          select: { id: true },
        });
        if (!inst) continue;
        // The 09:15-09:30 IST candle is timestamp = 03:45 UTC of today
        const today = new Date();
        today.setUTCHours(3, 45, 0, 0);
        const tomorrow = new Date(today);
        tomorrow.setUTCMinutes(today.getUTCMinutes() + 15);
        const orCandle = await this.prisma.candle.findFirst({
          where: {
            instrumentId: inst.id,
            timeframe: TIMEFRAMES.FIFTEEN_MIN,
            timestamp: { gte: today, lt: tomorrow },
          },
        });
        if (!orCandle) {
          this.logger.warn(`No OR 15m candle for ${u.symbol} yet; skipping`);
          continue;
        }
        this.levelBook.lockOpeningRange(u.token, {
          high: orCandle.high, low: orCandle.low,
        });
      } catch (err) {
        this.logger.error(
          `lockOpeningRange ${u.symbol} failed: ${err instanceof Error ? err.message : err}`,
        );
      }
    }
  }
}
```

- [ ] **Step 6.2: Register in module** — add `LevelBookCron` to `signal-generator.module.ts` providers.

- [ ] **Step 6.3: Type-check**

```bash
cd apps/api && npx tsc --noEmit
```

Expected: no NEW errors.

- [ ] **Step 6.4: Commit**

```bash
git add apps/api/src/modules/signal-generator/services/level-book.cron.ts apps/api/src/modules/signal-generator/signal-generator.module.ts
git commit -m "feat(signal-generator): cron jobs for session seed (09:15) + OR lock (09:30) IST"
```

---

### Task 8: Wire strategy into universe scanner + register in registry

**Files:**
- Modify: `apps/api/src/modules/signal-generator/services/strategy-registry.service.ts`
- Modify: `apps/api/src/modules/signal-generator/workers/universe-scanner.worker.ts`
- Modify: `apps/api/src/modules/signal-generator/strategies/index.ts`

- [ ] **Step 8.1: Re-export the strategy from `strategies/index.ts`** — add:

```ts
export { LevelsContextStrategy } from './levels-context.strategy';
```

- [ ] **Step 8.2: Register in StrategyRegistryService** — in `strategy-registry.service.ts` `onModuleInit()`, add:

```ts
import { LevelsContextStrategy } from '../strategies/levels-context.strategy';

// in onModuleInit, after other strategy registrations:
this.register(new LevelsContextStrategy());
```

- [ ] **Step 8.3: In `universe-scanner.worker.ts`**, find the place where it iterates instruments + runs strategies. Add a path that calls the new strategy with a level-book-aware MarketSnapshot:

```ts
import { LevelBookService } from '../services/level-book.service';
import { LevelsContextStrategy } from '../strategies/levels-context.strategy';

// inject in constructor:
constructor(
  // … existing deps …
  private readonly levelBook: LevelBookService,
) {}

// In the per-instrument scan body, after fetching candles:
const levelBook = this.levelBook.getLevels(instrument.token);
if (levelBook && !this.levelBook.isStale(instrument.token)) {
  const nowIst = new Date().toLocaleTimeString('en-GB', {
    timeZone: 'Asia/Kolkata',
    hour: '2-digit', minute: '2-digit', hour12: false,
  });
  // The LevelsContextStrategy ignores the standard MarketSnapshot path
  // and reads from metadata instead. We dispatch directly.
  const strategy = this.strategyRegistry.getStrategy('levels-context') as
    LevelsContextStrategy | undefined;
  const out = strategy?.analyze({
    candles: candles.map(c => ({
      timestamp: c.timestamp, open: c.open, high: c.high,
      low: c.low, close: c.close, volume: Number(c.volume),
    })),
    levelBook,
    nowIst,
  });
  if (out) {
    await this.signalRepository.create({
      instrumentId: instrument.id,
      side: out.side,
      entryPrice: out.entryPrice,
      targetPrice: out.targetPrice,
      stoplossPrice: out.stoplossPrice,
      expectedProfit: Math.abs(out.targetPrice - out.entryPrice),
      expectedLoss:   Math.abs(out.entryPrice - out.stoplossPrice),
      riskRewardRatio: Math.abs(out.targetPrice - out.entryPrice) /
                       Math.abs(out.entryPrice - out.stoplossPrice),
      confidence: out.confidence > 75 ? 'VERY_HIGH'
                  : out.confidence > 60 ? 'HIGH'
                  : out.confidence > 40 ? 'MEDIUM' : 'LOW',
      confidenceScore: out.confidence,
      strategy: out.strategy ?? 'levels-context',
      timeframe: out.timeframe,
      reason: out.reason,
      setupContext: out.metadata as object,
    });
  }
}
```

The implementer should adapt to the actual signature of `signalRepository.create` (read the existing repository to confirm).

- [ ] **Step 8.4: Verify the api boots, the cron decorator registers, and the scanner picks up the new strategy:**

```bash
# (api dev server already running with --watch; just check logs)
sleep 5
tail -100 "C:/Users/.../bglizcgt6.output" 2>&1 | grep -E "Registered strategy: levels-context|LevelBookService|LevelBookCron" | head -5
```

Expected at least: `Registered strategy: levels-context (segments: OPTIONS, EQUITY, FUTURES, COMMODITY)`.

- [ ] **Step 8.5: Commit**

```bash
git add apps/api/src/modules/signal-generator/services/strategy-registry.service.ts apps/api/src/modules/signal-generator/workers/universe-scanner.worker.ts apps/api/src/modules/signal-generator/strategies/index.ts
git commit -m "feat(signal-generator): register levels-context in registry + scanner"
```

---

### Task 9: Backend smoke test — verify signals fire end-to-end

- [ ] **Step 9.1: Manually invoke the seeding cron via a one-off ts-node script** (or wait until next 09:15 IST) so the level book has data outside cron windows:

```bash
cd apps/api
node --loader ts-node/esm -e "
  import('./src/modules/signal-generator/services/level-book.cron.js').then(async m => {
    // (in dev mode with nest start --watch, the cron is registered automatically;
    //  this step is documentation for engineers running outside dev)
  });
"
```

If the api is running with `nest start --watch`, the cron is already armed — just wait for the next 09:15 / 09:30 IST tick, or temporarily patch the cron to fire on session-startup for a one-shot test.

- [ ] **Step 9.2: After seeding + a few minutes of ticks, hit the active-signals endpoint:**

```bash
curl -s "http://localhost:4001/api/signals/active?strategy=levels-context" | head -c 800
```

Expected during market hours: a JSON array with `setupContext` populated. During off-hours, expected: `[]` (no signals fire — correct silent behavior).

- [ ] **Step 9.3: Commit (only if any glue code was added in Task 9):**

```bash
git add . && git commit -m "test(signal-generator): smoke-test levels-context end-to-end" || echo "nothing to commit"
```

---

## Phase 2 — Frontend signal display + chart overlay

After Phase 2, `/signals` page shows the new setup context per signal, and clicking a signal opens the chart with levels drawn.

### Task 10: Frontend type updates

**Files:**
- Modify: `apps/web/src/types/index.ts` — add `SetupContext` + extend `TradeSignal`

- [ ] **Step 10.1: Add the type** — append to `apps/web/src/types/index.ts`:

```ts
// Levels-context strategy: structured signal payload.
// Mirrors apps/api/src/modules/signal-generator/types/setup-context.types.ts —
// keep them in lockstep.
export type LevelType =
  | 'PDH' | 'PDL' | 'ORH' | 'ORL'
  | 'VWAP' | 'ROUND' | 'VOL_STRIKE';
export type SetupType = 'BREAKOUT' | 'REVERSAL';
export type SetupGrade = 'A' | 'B' | 'C';
export type TimeOfDayWindow = 'morning-trend' | 'afternoon-trend';

export interface SetupContext {
  levelType: LevelType;
  setupType: SetupType;
  levelValue: number;
  grade: SetupGrade;
  entry: number;
  stoploss: number;
  target: number;
  triggerCandle: { time: number; ohlc: [number, number, number, number] };
  levelBookSnapshot: {
    pdh: number; pdl: number;
    orh: number | null; orl: number | null;
    vwap: number; todayHigh: number; todayLow: number;
  };
  atr14: number;
  volumeRatio: number;
  timeOfDayWindow: TimeOfDayWindow;
  expiryDayWarning?: boolean;
}
```

- [ ] **Step 10.2: Find the `TradeSignal` import or re-export** (likely from `@td/shared`) — extend it locally:

```ts
import type { TradeSignal as SharedTradeSignal } from '@td/shared';

export interface TradeSignal extends SharedTradeSignal {
  setupContext?: SetupContext | null;
}
```

- [ ] **Step 10.3: Type-check**

```bash
cd apps/web && npx tsc --noEmit
```

Expected: no NEW errors.

- [ ] **Step 10.4: Commit**

```bash
git add apps/web/src/types/index.ts
git commit -m "feat(web): add SetupContext type + extend TradeSignal"
```

---

### Task 11: Extend SignalCard with setupContext fields

**Files:**
- Modify: `apps/web/src/components/trading/SignalCard.tsx`

- [ ] **Step 11.1:** Read the current SignalCard to understand its layout. Add a new "Setup Context" section that renders ONLY when `signal.setupContext` is present:

```tsx
{signal.setupContext && (
  <div className="rounded-lg border border-gray-700/60 bg-gray-800/40 p-3 text-xs">
    <div className="flex items-center justify-between mb-2">
      <div className="flex items-center gap-2">
        <span className="font-semibold text-gray-200">
          {signal.setupContext.setupType === 'BREAKOUT' ? '↗ Breakout' : '↘ Reversal'}
        </span>
        <span className="rounded bg-gray-700/60 px-1.5 py-0.5 text-[10px] font-medium text-gray-300">
          {signal.setupContext.levelType}
        </span>
      </div>
      <span className={`rounded px-2 py-0.5 text-[10px] font-bold ${
        signal.setupContext.grade === 'A' ? 'bg-emerald-500/20 text-emerald-300'
        : signal.setupContext.grade === 'B' ? 'bg-blue-500/20 text-blue-300'
        : 'bg-gray-500/20 text-gray-300'
      }`}>
        Grade {signal.setupContext.grade}
      </span>
    </div>
    <div className="grid grid-cols-3 gap-2 text-[11px] text-gray-300">
      <div>
        <div className="text-[9px] uppercase text-gray-500">Level</div>
        <div className="font-mono">{signal.setupContext.levelValue.toFixed(2)}</div>
      </div>
      <div>
        <div className="text-[9px] uppercase text-gray-500">Vol vs MA</div>
        <div className="font-mono">{signal.setupContext.volumeRatio.toFixed(2)}×</div>
      </div>
      <div>
        <div className="text-[9px] uppercase text-gray-500">Window</div>
        <div className="font-mono">{signal.setupContext.timeOfDayWindow.replace('-trend', '')}</div>
      </div>
    </div>
    {signal.setupContext.expiryDayWarning && (
      <div className="mt-2 rounded bg-amber-500/10 border border-amber-500/30 px-2 py-1 text-[10px] text-amber-300">
        ⚠ Expiry day — theta acceleration risk
      </div>
    )}
  </div>
)}
```

- [ ] **Step 11.2: Add a "📈 View on chart" button** that links to `/charts?token=${tokenFromSignal}&signal=${signal.id}`. Existing card may already have this kind of action area.

- [ ] **Step 11.3: Type-check** — `cd apps/web && npx tsc --noEmit` — no NEW errors.

- [ ] **Step 11.4: Commit**

```bash
git add apps/web/src/components/trading/SignalCard.tsx
git commit -m "feat(web): SignalCard renders levels-context setupContext"
```

---

### Task 12: LevelOverlay component for chart

**Files:**
- Create: `apps/web/src/components/charts/LevelOverlay.tsx`

- [ ] **Step 12.1: Write the component**

```tsx
import { useEffect, useRef } from 'react';
import type { IChartApi, IPriceLine, ISeriesApi } from 'lightweight-charts';

interface Level {
  type: string;
  value: number;
  color: string;
  label: string;
}

interface LevelOverlayProps {
  series: ISeriesApi<'Candlestick'> | null;
  levels: Level[];
}

/**
 * Draws each level as a horizontal price line on the candle series.
 * Reconciles via the price-line API: lines are added on mount + when levels
 * change, and removed on unmount.
 */
export default function LevelOverlay({ series, levels }: LevelOverlayProps) {
  const linesRef = useRef<IPriceLine[]>([]);

  useEffect(() => {
    if (!series) return;

    // Clear previous lines
    for (const line of linesRef.current) {
      try { series.removePriceLine(line); } catch { /* chart may be disposed */ }
    }
    linesRef.current = [];

    // Add new lines
    for (const lvl of levels) {
      const line = series.createPriceLine({
        price: lvl.value,
        color: lvl.color,
        lineWidth: 1,
        lineStyle: 2, // dashed
        axisLabelVisible: true,
        title: lvl.label,
      });
      linesRef.current.push(line);
    }

    return () => {
      for (const line of linesRef.current) {
        try { series.removePriceLine(line); } catch { /* ignore */ }
      }
      linesRef.current = [];
    };
  }, [series, levels]);

  return null; // pure side-effect
}

export const LEVEL_COLORS: Record<string, string> = {
  PDH: '#ef4444', PDL: '#22c55e',
  ORH: '#a855f7', ORL: '#a855f7',
  VWAP: '#06b6d4',
  ROUND: '#94a3b8',
  VOL_STRIKE: '#f59e0b',
};
```

- [ ] **Step 12.2: Type-check + commit**

```bash
cd apps/web && npx tsc --noEmit
git add apps/web/src/components/charts/LevelOverlay.tsx
git commit -m "feat(web): LevelOverlay component for chart"
```

---

### Task 13: SetupMarker component for chart

**Files:**
- Create: `apps/web/src/components/charts/SetupMarker.tsx`

- [ ] **Step 13.1: Write the component**

```tsx
import { useEffect } from 'react';
import type { ISeriesApi, Time } from 'lightweight-charts';

interface SetupMarkerProps {
  series: ISeriesApi<'Candlestick'> | null;
  time: number; // unix seconds — triggerCandle.time
  side: 'BUY' | 'SELL';
  text: string;
}

export default function SetupMarker({ series, time, side, text }: SetupMarkerProps) {
  useEffect(() => {
    if (!series) return;
    const marker = {
      time: time as Time,
      position: side === 'BUY' ? 'belowBar' as const : 'aboveBar' as const,
      color: side === 'BUY' ? '#22c55e' : '#ef4444',
      shape: side === 'BUY' ? 'arrowUp' as const : 'arrowDown' as const,
      text,
    };
    series.setMarkers([marker]);
    return () => {
      try { series.setMarkers([]); } catch { /* ignore */ }
    };
  }, [series, time, side, text]);

  return null;
}
```

- [ ] **Step 13.2: Type-check + commit**

```bash
cd apps/web && npx tsc --noEmit
git add apps/web/src/components/charts/SetupMarker.tsx
git commit -m "feat(web): SetupMarker component for chart"
```

---

### Task 14: ChartsPage — signal mode (URL params + render levels + marker)

**Files:**
- Modify: `apps/web/src/pages/charts/ChartsPage.tsx`

- [ ] **Step 14.1: Read the URL `signal` param. If present, fetch the signal from `/api/signals/:id` and render LevelOverlay + SetupMarker:**

```tsx
import { useSearchParams } from 'react-router-dom';
import LevelOverlay, { LEVEL_COLORS } from '@/components/charts/LevelOverlay';
import SetupMarker from '@/components/charts/SetupMarker';
import api from '@/services/api';
import type { SetupContext } from '@/types';

// ... inside the component:
const [params] = useSearchParams();
const signalId = params.get('signal');
const [setupContext, setSetupContext] = useState<SetupContext | null>(null);

useEffect(() => {
  if (!signalId) { setSetupContext(null); return; }
  api.get(`/signals/${signalId}`)
    .then(r => setSetupContext(r.data?.setupContext ?? null))
    .catch(() => setSetupContext(null));
}, [signalId]);

const overlayLevels = useMemo(() => {
  if (!setupContext) return [];
  const lb = setupContext.levelBookSnapshot;
  return [
    { type: 'PDH', value: lb.pdh, color: LEVEL_COLORS.PDH, label: 'PDH' },
    { type: 'PDL', value: lb.pdl, color: LEVEL_COLORS.PDL, label: 'PDL' },
    ...(lb.orh !== null ? [{ type: 'ORH', value: lb.orh, color: LEVEL_COLORS.ORH, label: 'ORH' }] : []),
    ...(lb.orl !== null ? [{ type: 'ORL', value: lb.orl, color: LEVEL_COLORS.ORL, label: 'ORL' }] : []),
    { type: 'VWAP', value: lb.vwap, color: LEVEL_COLORS.VWAP, label: 'VWAP' },
  ];
}, [setupContext]);
```

Then pass to overlays:

```tsx
{candleSeries && setupContext && (
  <>
    <LevelOverlay series={candleSeries} levels={overlayLevels} />
    <SetupMarker
      series={candleSeries}
      time={setupContext.triggerCandle.time}
      side={setupContext.entry > setupContext.stoploss ? 'BUY' : 'SELL'}
      text={`${setupContext.setupType} · ${setupContext.grade}`}
    />
  </>
)}
```

(`candleSeries` is the existing ref to the candlestick `ISeriesApi`. If the existing chart code uses different ref naming, adapt.)

- [ ] **Step 14.2: Type-check + commit**

```bash
cd apps/web && npx tsc --noEmit
git add apps/web/src/pages/charts/ChartsPage.tsx
git commit -m "feat(web): chart signal mode — draws level overlay + setup marker"
```

---

## Phase 3 — Backtest harness

### Task 15: scripts/backtest-levels-context.mjs

**Files:**
- Create: `scripts/backtest-levels-context.mjs`

- [ ] **Step 15.1: Write the harness** (430+ lines — keeps the structure of `scripts/verify-m5.mjs` you already have for reference: env loading, Prisma client setup, ANSI helpers):

The script:
1. Loads daily candles from DB to seed the LevelBook for each test session
2. Loads 5-min candles intraday for each session
3. Iterates 5-min candles in order, replays through `LevelsContextStrategy.analyze()`
4. When a signal fires, simulates fill + exit (target/SL/EOD) with the cost model
5. Aggregates stats per regime (VIX bucket from a separate VIX series), per setup type, per grade
6. Prints a Markdown report

Full implementation (paste this into the file):

```javascript
// scripts/backtest-levels-context.mjs
// Backtest the levels-context strategy against 10y of historical candles.
// Run: node scripts/backtest-levels-context.mjs
// Env: DATABASE_URL (read from .env), YEARS_BACK=10 (default), SYMBOL=NIFTY (default)

import 'dotenv/config';
import { PrismaClient } from '@prisma/client';
import { LevelBookService } from '../apps/api/src/modules/signal-generator/services/level-book.service.js';
import { LevelsContextStrategy } from '../apps/api/src/modules/signal-generator/strategies/levels-context.strategy.js';

// ANSI helpers
const c = { reset: '\x1b[0m', bold: '\x1b[1m', dim: '\x1b[2m',
  red: '\x1b[31m', green: '\x1b[32m', yellow: '\x1b[33m',
  cyan: '\x1b[36m' };

// Cost model — Indian options
const COSTS = {
  slippageAtrFraction: 0.05, // per leg
  brokeragePerOrder: 20,
  brokeragePctMax: 0.0003,   // 0.03%
  stt: { optionsSell: 0.00025, equitySell: 0.001 },
  gst: 0.18,
  exchangeSebi: 0.000006,
  stampBuy: 0.00003,
};

const SYMBOL = process.env.SYMBOL ?? 'NIFTY';
const YEARS_BACK = Number(process.env.YEARS_BACK ?? 10);

const prisma = new PrismaClient();

async function main() {
  console.log(`${c.bold}LevelsContext Backtest — ${SYMBOL}, ${YEARS_BACK}y${c.reset}`);
  const inst = await prisma.instrument.findFirst({
    where: { symbol: SYMBOL, exchange: 'NSE' },
    select: { id: true, token: true, symbol: true, exchange: true },
  });
  if (!inst) throw new Error(`Instrument ${SYMBOL} not found in DB`);

  const fromDate = new Date(Date.now() - YEARS_BACK * 365 * 24 * 60 * 60 * 1000);
  const dailyCandles = await prisma.candle.findMany({
    where: { instrumentId: inst.id, timeframe: '1d', timestamp: { gte: fromDate } },
    orderBy: { timestamp: 'asc' },
  });
  console.log(`Daily candles loaded: ${dailyCandles.length}`);

  // Iterate session-by-session
  const trades = [];
  for (let i = 14; i < dailyCandles.length; i++) {
    const sessionStart = dailyCandles[i].timestamp;
    const sessionEnd = new Date(sessionStart);
    sessionEnd.setUTCHours(10, 0, 0, 0);  // 15:30 IST = 10:00 UTC

    const fiveMin = await prisma.candle.findMany({
      where: {
        instrumentId: inst.id, timeframe: '5m',
        timestamp: { gte: sessionStart, lt: sessionEnd },
      },
      orderBy: { timestamp: 'asc' },
    });
    if (fiveMin.length < 25) continue;

    const lbs = new LevelBookService();
    lbs.seedSession({
      token: inst.token, symbol: inst.symbol, exchange: inst.exchange,
      recentDailyCandles: dailyCandles.slice(i - 14, i).map((d) => ({
        timestamp: d.timestamp, open: d.open, high: d.high,
        low: d.low, close: d.close, volume: Number(d.volume),
      })),
    });
    // Lock OR from the first 15-min worth of 5m candles
    const orCandles = fiveMin.slice(0, 3);
    const orHigh = Math.max(...orCandles.map((c) => c.high));
    const orLow = Math.min(...orCandles.map((c) => c.low));
    lbs.lockOpeningRange(inst.token, { high: orHigh, low: orLow });

    const strategy = new LevelsContextStrategy();
    let openTrade = null;
    for (let j = 4; j < fiveMin.length; j++) {
      const cur = fiveMin[j];
      lbs.updateFromTick({
        token: inst.token, ltp: cur.close, volume: Number(cur.volume), timestamp: cur.timestamp,
      });
      // Convert IST clock for nowIst
      const nowIst = new Date(cur.timestamp.getTime() + 5.5 * 3600 * 1000)
        .toISOString().slice(11, 16);
      const lb = lbs.getLevels(inst.token);
      if (!lb) continue;
      const candles = fiveMin.slice(Math.max(0, j - 24), j + 1).map((c) => ({
        timestamp: c.timestamp, open: c.open, high: c.high, low: c.low,
        close: c.close, volume: Number(c.volume),
      }));

      // Fake "freshness" — set lastTickAt to the bar's timestamp so the
      // staleness gate doesn't reject backtest data.
      lb.lastTickAt = cur.timestamp;

      if (!openTrade) {
        const out = strategy.analyze({ candles, levelBook: lb, nowIst });
        if (out) {
          // Open with simulated slippage
          const slip = lb.atr14 * COSTS.slippageAtrFraction *
                       (out.side === 'BUY' ? 1 : -1);
          openTrade = {
            entryTime: cur.timestamp, entryPrice: out.entryPrice + slip,
            sl: out.stoplossPrice, target: out.targetPrice,
            side: out.side,
            ctx: out.metadata,
          };
        }
      } else {
        // Check exits
        const hit = (price) =>
          openTrade.side === 'BUY'
            ? (cur.high >= openTrade.target ? 'TARGET' :
               cur.low <= openTrade.sl ? 'SL' : null)
            : (cur.low <= openTrade.target ? 'TARGET' :
               cur.high >= openTrade.sl ? 'SL' : null);
        const exit = hit(cur);
        if (exit || j === fiveMin.length - 1) {
          const exitPrice = exit === 'TARGET' ? openTrade.target
                          : exit === 'SL' ? openTrade.sl
                          : cur.close;
          const slip = lb.atr14 * COSTS.slippageAtrFraction *
                       (openTrade.side === 'BUY' ? -1 : 1);
          const finalExit = exitPrice + slip;
          const grossPnl = openTrade.side === 'BUY'
            ? finalExit - openTrade.entryPrice
            : openTrade.entryPrice - finalExit;
          // Cost: brokerage (round trip) + GST + STT + stamp
          const orderValue = openTrade.entryPrice * 50; // assume 1 lot * 50 qty
          const brokerage = 2 * Math.min(COSTS.brokeragePerOrder,
                              orderValue * COSTS.brokeragePctMax);
          const gst = brokerage * COSTS.gst;
          const stt = orderValue * COSTS.stt.optionsSell;
          const stamp = orderValue * COSTS.stampBuy;
          const exch = orderValue * COSTS.exchangeSebi * 2;
          const totalCosts = brokerage + gst + stt + stamp + exch;
          trades.push({
            entryTime: openTrade.entryTime, exitTime: cur.timestamp,
            side: openTrade.side, entry: openTrade.entryPrice, exit: finalExit,
            grossPnl, totalCosts, netPnl: grossPnl - totalCosts,
            exit_reason: exit ?? 'EOD',
            ctx: openTrade.ctx,
          });
          openTrade = null;
        }
      }
    }
  }

  // Aggregate
  const wins = trades.filter((t) => t.netPnl > 0).length;
  const winRate = trades.length === 0 ? 0 : wins / trades.length;
  const avgWin = trades.filter(t => t.netPnl > 0)
    .reduce((s, t) => s + t.netPnl, 0) / Math.max(wins, 1);
  const avgLoss = trades.filter(t => t.netPnl <= 0)
    .reduce((s, t) => s + t.netPnl, 0) / Math.max(trades.length - wins, 1);

  console.log('\n' + c.bold + 'BACKTEST REPORT' + c.reset);
  console.log('================');
  console.log(`Total trades: ${trades.length}`);
  console.log(`Win rate: ${(winRate * 100).toFixed(1)}%`);
  console.log(`Avg win: ${avgWin.toFixed(2)}, avg loss: ${avgLoss.toFixed(2)}`);
  // Breakdown by setup type
  const bySetup = trades.reduce((acc, t) => {
    const k = t.ctx.setupType;
    acc[k] = acc[k] ?? { n: 0, wins: 0, pnl: 0 };
    acc[k].n++;
    if (t.netPnl > 0) acc[k].wins++;
    acc[k].pnl += t.netPnl;
    return acc;
  }, {});
  console.log('\nBy setup:');
  for (const [k, v] of Object.entries(bySetup)) {
    console.log(`  ${k}: ${v.n} trades, ${(v.wins/v.n*100).toFixed(1)}% win, net ${v.pnl.toFixed(0)}`);
  }
  // Breakdown by grade
  const byGrade = trades.reduce((acc, t) => {
    const k = t.ctx.grade;
    acc[k] = acc[k] ?? { n: 0, wins: 0, pnl: 0 };
    acc[k].n++;
    if (t.netPnl > 0) acc[k].wins++;
    acc[k].pnl += t.netPnl;
    return acc;
  }, {});
  console.log('\nBy grade:');
  for (const [k, v] of Object.entries(byGrade)) {
    console.log(`  ${k}: ${v.n} trades, ${(v.wins/v.n*100).toFixed(1)}% win, net ${v.pnl.toFixed(0)}`);
  }

  await prisma.$disconnect();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
```

- [ ] **Step 15.2: Add npm script + commit:**

In root `package.json` `scripts`:
```json
"backtest:levels": "node scripts/backtest-levels-context.mjs"
```

```bash
git add scripts/backtest-levels-context.mjs package.json
git commit -m "feat(scripts): backtest harness for levels-context strategy"
```

- [ ] **Step 15.3: Run the harness** to validate the strategy against 10y of NIFTY data:

```bash
npm run backtest:levels
```

Expected output (see spec §6 Layer 3): per-setup-type, per-grade win rate + net P&L. Sanity check: win rate > 45%, R:R-realized > 1.5.

If the report looks pathological (e.g., 100% win rate or 0 trades) — there's a bug in either the level book wiring or the gate logic. Re-read the strategy + level-book unit tests; the integration almost certainly violates an assumption the unit tests don't catch.

---

## Self-Review Checklist (run before declaring done)

- [ ] All tasks committed; `git log --oneline` shows ~15 commits since starting Phase 1
- [ ] `npm test` (api workspace) passes — both `level-book.service.spec` + `levels-context.strategy.spec` green
- [ ] `npx tsc --noEmit` clean for both apps/api and apps/web
- [ ] Boot logs show `Registered strategy: levels-context (segments: OPTIONS, EQUITY, FUTURES, COMMODITY)`
- [ ] During market hours: `curl /api/signals/active?strategy=levels-context` returns at least one signal with `setupContext` populated
- [ ] On the `/signals` page: signals from the new strategy render with grade badge + setup type
- [ ] On the chart page with `?signal=…`: PDH/PDL/ORH/ORL/VWAP are drawn as horizontal lines and the trigger candle has an arrow marker
- [ ] Backtest harness runs successfully and produces a structured report
- [ ] Spec §6 Layer 3 validation gate passed: backtest shows positive Sharpe + win rate > 45% + max DD documented

---

## Execution Notes

This plan has 15 tasks across 3 phases. Each phase produces working software at its end:

- **Phase 1 (Tasks 1-9):** Backend strategy fires real signals during market hours. Verifiable via `curl`.
- **Phase 2 (Tasks 10-14):** Frontend renders the signals + chart overlay.
- **Phase 3 (Task 15):** Backtest harness validates against 10y of historical data — required before trusting signals live, per the strategic review's gate.

If dispatching subagents:
- Phase 1 tasks 1-4 are sequential (each builds on the prior)
- Phase 1 tasks 5-8 can run in two parallel streams: (5+6+7 — wiring & cron) and (8 — scanner integration)
- Phase 2 tasks can run in parallel: 10 → (11, 12, 13) parallel → 14
- Phase 3 task 15 depends on Phase 1 only

Per the strategic review's validation gate, **Phase 3 is mandatory before any live deployment.** Even if the unit tests pass and the strategy looks beautiful in dev, the 10y backtest report is the data-driven check that catches over-fitted thresholds and regime-specific blind spots.
