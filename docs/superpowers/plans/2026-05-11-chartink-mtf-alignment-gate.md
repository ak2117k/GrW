# Chartink MTF Alignment Gate Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a 4-timeframe directional-agreement gate (1d, 1h, 15m, 5m) between Chartink alert symbol-resolution and `analyze()`. Hits with mixed TF directions get rejected with `kind='mtf-misaligned'` and never reach `analyze()`.

**Architecture:** New `MtfAlignmentService` in the signal-generator module — pure function that takes (token, exchange) and returns directional consensus across 4 timeframes. `ChartinkProcessService.processOne` calls it as a pre-filter; on misalignment, persists a row with the new `kind` and skips `analyze()`. One-line frontend update so the kind counts correctly on `/chartink`.

**Tech Stack:** NestJS + TypeScript, Vitest, existing `AngelOneAdapterService` for historical candles, Bull queue worker (no change).

Spec: `docs/superpowers/specs/2026-05-11-chartink-mtf-alignment-gate-design.md`

---

## Pre-flight

- [ ] **Step 0.1: Confirm dev infrastructure**

The dev server is running as background task (the long-lived turbo dev). API at :4001, web at :4000. Vitest available at `apps/api` and `apps/web`. The cloudflared quick tunnel may or may not still be alive — irrelevant for this plan (we don't need external webhooks; we use synthetic curl calls).

- [ ] **Step 0.2: Verify the existing chartink tests still pass**

Run from repo root:
```bash
cd apps/api && npx vitest run src/modules/chartink --reporter=verbose 2>&1 | tail -15
```
Expected: existing chartink-ingest, chartink-process, chartink-webhook tests all pass.

---

## Task 1: MtfAlignmentService — pure direction logic + tests

**Files:**
- Create: `apps/api/src/modules/signal-generator/services/mtf-alignment.service.ts`
- Create: `apps/api/src/modules/signal-generator/services/mtf-alignment.service.spec.ts`
- Modify: `apps/api/src/modules/signal-generator/signal-generator.module.ts` (export the new service)

### Step 1.1: Write the failing tests

Create `apps/api/src/modules/signal-generator/services/mtf-alignment.service.spec.ts`:

```typescript
import { Test, type TestingModule } from '@nestjs/testing';
import { Logger } from '@nestjs/common';
import { MtfAlignmentService, type MtfResult } from './mtf-alignment.service';
import { AngelOneAdapterService } from '../../market-data/services/angel-one-adapter.service';

interface MockCandle {
  timestamp: Date;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

function makeCandles(closes: number[]): MockCandle[] {
  // Synthesize candles with strictly-monotonic timestamps. The service only
  // uses .close and .timestamp; other fields are placeholders.
  return closes.map((c, i) => ({
    timestamp: new Date(Date.UTC(2026, 4, 11, 9, 15 + i * 5)),
    open: c,
    high: c,
    low: c,
    close: c,
    volume: 1000,
  }));
}

describe('MtfAlignmentService', () => {
  let service: MtfAlignmentService;
  let mockAdapter: { getHistoricalData: ReturnType<typeof vi.fn> };

  beforeEach(async () => {
    mockAdapter = { getHistoricalData: vi.fn() };
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        MtfAlignmentService,
        { provide: AngelOneAdapterService, useValue: mockAdapter },
      ],
    }).compile();
    module.useLogger(false);
    service = module.get(MtfAlignmentService);
    // Patch the sleep to a no-op so tests don't take seconds.
    (service as unknown as { sleep: (ms: number) => Promise<void> }).sleep = () => Promise.resolve();
  });

  it('reports aligned UP when all 4 TFs are up', async () => {
    mockAdapter.getHistoricalData.mockResolvedValue(makeCandles([100, 101]));
    const result = await service.check('99926000', 'NSE');
    expect(result.aligned).toBe(true);
    expect(result.agreedDirection).toBe('UP');
    expect(result.directions).toEqual({ '1d': 'UP', '1h': 'UP', '15m': 'UP', '5m': 'UP' });
  });

  it('reports aligned DOWN when all 4 TFs are down', async () => {
    mockAdapter.getHistoricalData.mockResolvedValue(makeCandles([100, 99]));
    const result = await service.check('99926000', 'NSE');
    expect(result.aligned).toBe(true);
    expect(result.agreedDirection).toBe('DOWN');
  });

  it('reports misaligned when even one TF disagrees', async () => {
    mockAdapter.getHistoricalData
      .mockResolvedValueOnce(makeCandles([100, 101])) // 1d UP
      .mockResolvedValueOnce(makeCandles([100, 101])) // 1h UP
      .mockResolvedValueOnce(makeCandles([100, 99]))  // 15m DOWN  ← disagreement
      .mockResolvedValueOnce(makeCandles([100, 101])); // 5m UP
    const result = await service.check('99926000', 'NSE');
    expect(result.aligned).toBe(false);
    expect(result.agreedDirection).toBeNull();
    expect(result.directions['15m']).toBe('DOWN');
  });

  it('counts equal closes as NEUTRAL and treats them as misaligned', async () => {
    mockAdapter.getHistoricalData
      .mockResolvedValueOnce(makeCandles([100, 100])) // 1d NEUTRAL
      .mockResolvedValueOnce(makeCandles([100, 101]))
      .mockResolvedValueOnce(makeCandles([100, 101]))
      .mockResolvedValueOnce(makeCandles([100, 101]));
    const result = await service.check('99926000', 'NSE');
    expect(result.aligned).toBe(false);
    expect(result.directions['1d']).toBe('NEUTRAL');
  });

  it('treats insufficient candles (<2) as NEUTRAL → misaligned', async () => {
    mockAdapter.getHistoricalData
      .mockResolvedValueOnce(makeCandles([100])) // only 1 bar
      .mockResolvedValueOnce(makeCandles([100, 101]))
      .mockResolvedValueOnce(makeCandles([100, 101]))
      .mockResolvedValueOnce(makeCandles([100, 101]));
    const result = await service.check('99926000', 'NSE');
    expect(result.aligned).toBe(false);
    expect(result.directions['1d']).toBe('NEUTRAL');
  });

  it('treats broker fetch failure on any TF as NEUTRAL → misaligned', async () => {
    mockAdapter.getHistoricalData
      .mockResolvedValueOnce(makeCandles([100, 101]))
      .mockRejectedValueOnce(new Error('Angel timeout'))  // 1h fails
      .mockResolvedValueOnce(makeCandles([100, 101]))
      .mockResolvedValueOnce(makeCandles([100, 101]));
    const result = await service.check('99926000', 'NSE');
    expect(result.aligned).toBe(false);
    expect(result.directions['1h']).toBe('NEUTRAL');
  });

  it('uses the prior bar when the most-recent bar is still forming', async () => {
    // 3 bars: prev-prev close 100, prev close 101, current still-forming close 95.
    // If we naively used [-1] vs [-2] → 95 < 101 → DOWN.
    // We want [-2] vs [-3] → 101 > 100 → UP.
    const candles = makeCandles([100, 101, 95]);
    // Mark the last candle as "still forming" by giving it a future timestamp.
    candles[candles.length - 1].timestamp = new Date(Date.now() + 60_000);
    mockAdapter.getHistoricalData.mockResolvedValue(candles);
    const result = await service.check('99926000', 'NSE');
    // All 4 TFs see the same shape (the same mocked candles), so they agree UP.
    expect(result.aligned).toBe(true);
    expect(result.agreedDirection).toBe('UP');
  });

  it('builds rejectReason summary when misaligned', async () => {
    mockAdapter.getHistoricalData
      .mockResolvedValueOnce(makeCandles([100, 101])) // 1d UP
      .mockResolvedValueOnce(makeCandles([100, 99]))  // 1h DOWN
      .mockResolvedValueOnce(makeCandles([100, 101])) // 15m UP
      .mockResolvedValueOnce(makeCandles([100, 99])); // 5m DOWN
    const result = await service.check('99926000', 'NSE');
    expect(result.aligned).toBe(false);
    expect(result.summary).toContain('1d=UP');
    expect(result.summary).toContain('1h=DOWN');
    expect(result.summary).toContain('15m=UP');
    expect(result.summary).toContain('5m=DOWN');
  });

  it('calls getHistoricalData with the 4 expected timeframes', async () => {
    mockAdapter.getHistoricalData.mockResolvedValue(makeCandles([100, 101]));
    await service.check('99926000', 'NSE');
    const calls = mockAdapter.getHistoricalData.mock.calls.map((c: unknown[]) => c[2]);
    expect(calls).toEqual(['1d', '1h', '15m', '5m']);
  });
});

declare const vi: { fn: () => ReturnType<typeof vi.fn> & { mock: { calls: unknown[][] } }; mockResolvedValue: never; mockRejectedValue: never };
```

### Step 1.2: Run the test to verify it fails

Run from repo root:
```bash
cd apps/api && npx vitest run src/modules/signal-generator/services/mtf-alignment.service.spec.ts 2>&1 | tail -10
```
Expected: FAIL with `Cannot find module './mtf-alignment.service'`.

### Step 1.3: Implement MtfAlignmentService

Create `apps/api/src/modules/signal-generator/services/mtf-alignment.service.ts`:

```typescript
import { Injectable, Logger } from '@nestjs/common';
import { AngelOneAdapterService } from '../../market-data/services/angel-one-adapter.service';

export type TfDirection = 'UP' | 'DOWN' | 'NEUTRAL';
export type Timeframe = '1d' | '1h' | '15m' | '5m';

export interface MtfResult {
  directions: Record<Timeframe, TfDirection>;
  aligned: boolean;
  agreedDirection: 'UP' | 'DOWN' | null;
  /** Human-readable summary, e.g. "1d=UP 1h=DOWN 15m=UP 5m=UP". */
  summary: string;
}

interface Candle {
  timestamp: Date;
  close: number;
}

const TIMEFRAMES: Timeframe[] = ['1d', '1h', '15m', '5m'];
const RATE_LIMIT_MS = 350; // matches Angel historical-API serial pacer (per memory)

// Lookback windows sized to guarantee ≥ 2 completed bars even on a fresh
// post-weekend morning. Wide margins because Angel historical-API doesn't
// charge per row, only per request.
const LOOKBACK_MS: Record<Timeframe, number> = {
  '1d': 7 * 24 * 60 * 60 * 1000,    // 7 days
  '1h': 24 * 60 * 60 * 1000,        // 24 hours
  '15m': 3 * 60 * 60 * 1000,        // 3 hours
  '5m': 1 * 60 * 60 * 1000,         // 1 hour
};

@Injectable()
export class MtfAlignmentService {
  private readonly logger = new Logger(MtfAlignmentService.name);

  constructor(private readonly adapter: AngelOneAdapterService) {}

  /**
   * Probe each of 4 timeframes for the stock's bar-over-bar direction.
   * Returns aligned=true only when all 4 agree on UP or DOWN. Any NEUTRAL
   * (equal closes, insufficient data, or broker fetch failure) causes
   * misalignment.
   *
   * Uses the LAST COMPLETED bar (skips bars whose timestamp is still in the
   * future or hasn't closed yet for that TF) so the same hit produces the
   * same decision within a single TF window.
   */
  async check(token: string, exchange: string): Promise<MtfResult> {
    const directions: Record<Timeframe, TfDirection> = {
      '1d': 'NEUTRAL', '1h': 'NEUTRAL', '15m': 'NEUTRAL', '5m': 'NEUTRAL',
    };

    const now = Date.now();
    for (let i = 0; i < TIMEFRAMES.length; i++) {
      const tf = TIMEFRAMES[i];
      directions[tf] = await this.directionForTimeframe(token, exchange, tf, now);
      // Serial pacing between TF fetches to stay under Angel's historical rate limit.
      if (i < TIMEFRAMES.length - 1) await this.sleep(RATE_LIMIT_MS);
    }

    const values = Object.values(directions);
    const allUp = values.every((d) => d === 'UP');
    const allDown = values.every((d) => d === 'DOWN');
    const aligned = allUp || allDown;
    const agreedDirection: 'UP' | 'DOWN' | null = allUp ? 'UP' : allDown ? 'DOWN' : null;

    const summary = TIMEFRAMES.map((tf) => `${tf}=${directions[tf]}`).join(' ');

    return { directions, aligned, agreedDirection, summary };
  }

  private async directionForTimeframe(
    token: string,
    exchange: string,
    tf: Timeframe,
    nowMs: number,
  ): Promise<TfDirection> {
    const from = new Date(nowMs - LOOKBACK_MS[tf]);
    const to = new Date(nowMs);

    let candles: Candle[];
    try {
      candles = (await this.adapter.getHistoricalData(token, exchange, tf, from, to)) as Candle[];
    } catch (err) {
      this.logger.warn(
        `MTF: ${tf} fetch failed for ${exchange}:${token} — ` +
        `${err instanceof Error ? err.message : String(err)}`,
      );
      return 'NEUTRAL';
    }

    if (!candles || candles.length < 2) return 'NEUTRAL';

    // Skip a still-forming most-recent bar. A bar is "still forming" when its
    // timestamp is in the future or equals the same TF-bucket as `now`.
    let endIdx = candles.length - 1;
    if (this.isBarStillForming(candles[endIdx], tf, nowMs)) {
      endIdx -= 1;
    }
    if (endIdx < 1) return 'NEUTRAL';

    const cur = candles[endIdx].close;
    const prev = candles[endIdx - 1].close;
    if (cur > prev) return 'UP';
    if (cur < prev) return 'DOWN';
    return 'NEUTRAL';
  }

  private isBarStillForming(bar: Candle, tf: Timeframe, nowMs: number): boolean {
    const ts = bar.timestamp.getTime();
    if (ts > nowMs) return true; // future timestamp → must be still forming (or bad data)
    const tfMs = LOOKBACK_MS_PER_BAR[tf];
    return nowMs - ts < tfMs; // less than one TF-length elapsed → bar hasn't closed yet
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}

const LOOKBACK_MS_PER_BAR: Record<Timeframe, number> = {
  '1d': 24 * 60 * 60 * 1000,
  '1h': 60 * 60 * 1000,
  '15m': 15 * 60 * 1000,
  '5m': 5 * 60 * 1000,
};
```

### Step 1.4: Run the test to verify it passes

Run from repo root:
```bash
cd apps/api && npx vitest run src/modules/signal-generator/services/mtf-alignment.service.spec.ts 2>&1 | tail -15
```
Expected: All 9 tests pass.

### Step 1.5: Register service in the signal-generator module

Open `apps/api/src/modules/signal-generator/signal-generator.module.ts` and find the `providers` array. Add `MtfAlignmentService` to it. Also add an import at the top and add `MtfAlignmentService` to the `exports` array (so the chartink module can inject it).

Concretely, find these snippets and edit:

If the providers array currently looks like:
```typescript
providers: [
  SignalGeneratorService,
  SetupTrackerService,
  // ... other providers
],
```

Change to:
```typescript
providers: [
  SignalGeneratorService,
  SetupTrackerService,
  MtfAlignmentService,
  // ... other providers
],
exports: [
  // ... existing exports
  MtfAlignmentService,
],
```

Add the import at the top:
```typescript
import { MtfAlignmentService } from './services/mtf-alignment.service';
```

### Step 1.6: Verify the module compiles

Run from repo root:
```bash
cd apps/api && npx tsc --noEmit 2>&1 | grep -E "mtf-alignment" | head -10
```
Expected: no output (no type errors).

### Step 1.7: Commit

```bash
cd C:/Users/AryanKumar/Desktop/TD_Automation
git add apps/api/src/modules/signal-generator/services/mtf-alignment.service.ts \
        apps/api/src/modules/signal-generator/services/mtf-alignment.service.spec.ts \
        apps/api/src/modules/signal-generator/signal-generator.module.ts
git -c commit.gpgsign=false commit -m "feat(signal-generator): MtfAlignmentService — 4-TF directional agreement"
```

---

## Task 2: Wire MTF gate into Chartink processing

**Files:**
- Modify: `apps/api/src/modules/chartink/services/chartink-process.service.ts`
- Modify: `apps/api/src/modules/chartink/services/__tests__/chartink-process.service.spec.ts`

### Step 2.1: Update process.service.ts to inject and call MtfAlignmentService

Open `apps/api/src/modules/chartink/services/chartink-process.service.ts` and replace its contents with:

```typescript
import { Injectable, Logger } from '@nestjs/common';
import { ChartinkRepository } from '../repositories/chartink.repository';
import { MarketDataRepository } from '../../market-data/repositories/market-data.repository';
import { SignalGeneratorService } from '../../signal-generator/services/signal-generator.service';
import { SetupTrackerService } from '../../signal-generator/services/setup-tracker.service';
import { MtfAlignmentService } from '../../signal-generator/services/mtf-alignment.service';

interface Hit {
  symbol: string;
  hitPrice: number;
}

const RATE_LIMIT_MS = 350; // matches Angel One historical-API serial pacer (per memory)

@Injectable()
export class ChartinkProcessService {
  private readonly logger = new Logger(ChartinkProcessService.name);

  constructor(
    private readonly repo: ChartinkRepository,
    private readonly mdRepo: MarketDataRepository,
    private readonly signalSvc: SignalGeneratorService,
    private readonly tracker: SetupTrackerService,
    private readonly mtf: MtfAlignmentService,
  ) {}

  async processAlert(alertId: string, hits: Hit[]): Promise<void> {
    this.logger.log(`Processing Chartink alert ${alertId} — ${hits.length} hits`);
    for (let i = 0; i < hits.length; i++) {
      try {
        await this.processOne(alertId, hits[i]);
      } catch (err) {
        this.logger.warn(
          `processOne unexpected throw for ${hits[i].symbol}: ${err instanceof Error ? err.message : err}`,
        );
      }
      if (i < hits.length - 1) await this.sleep(RATE_LIMIT_MS);
    }
  }

  async processOne(alertId: string, hit: Hit): Promise<void> {
    const instrument = await this.mdRepo.getInstrumentBySymbol(hit.symbol, 'NSE');
    if (!instrument) {
      await this.repo.createAlertSetup({
        alertId,
        symbol: hit.symbol,
        token: null,
        hitPrice: hit.hitPrice,
        kind: 'unresolved',
        setupId: null,
        rejectReason: 'symbol not in local DB',
      });
      return;
    }

    // MTF gate — 4-TF directional agreement check before any deeper analysis.
    // On misalignment we persist immediately and skip analyze() to save 1-3
    // additional broker calls per hit.
    const mtf = await this.mtf.check(instrument.token, 'NSE');
    if (!mtf.aligned) {
      await this.repo.createAlertSetup({
        alertId,
        symbol: hit.symbol,
        token: instrument.token,
        hitPrice: hit.hitPrice,
        kind: 'mtf-misaligned',
        setupId: null,
        rejectReason: `TF: ${mtf.summary}`,
      });
      return;
    }

    let result: { kind: string; reason?: string };
    try {
      result = (await this.signalSvc.analyze(
        instrument.token, 'NSE', hit.symbol, '15m',
      )) as { kind: string; reason?: string };
    } catch (err) {
      await this.repo.createAlertSetup({
        alertId,
        symbol: hit.symbol,
        token: instrument.token,
        hitPrice: hit.hitPrice,
        kind: 'error',
        setupId: null,
        rejectReason: err instanceof Error ? err.message : String(err),
      });
      return;
    }

    if (result.kind === 'setup') {
      const locked = this.tracker.getActive(instrument.token);
      await this.repo.createAlertSetup({
        alertId,
        symbol: hit.symbol,
        token: instrument.token,
        hitPrice: hit.hitPrice,
        kind: 'setup',
        setupId: locked?.id ?? null,
        rejectReason: null,
      });
    } else {
      await this.repo.createAlertSetup({
        alertId,
        symbol: hit.symbol,
        token: instrument.token,
        hitPrice: hit.hitPrice,
        kind: 'no-setup',
        setupId: null,
        rejectReason: result.reason ?? null,
      });
    }
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
```

### Step 2.2: Read the existing spec file to learn the test setup

Open `apps/api/src/modules/chartink/services/__tests__/chartink-process.service.spec.ts` and read the existing `beforeEach` block. The structure (how the service is instantiated, what dependencies are mocked) tells you exactly what shape to extend.

### Step 2.3: Update the chartink-process spec to mock MtfAlignmentService

The spec already mocks `MarketDataRepository`, `SignalGeneratorService`, `SetupTrackerService`, `ChartinkRepository`. Add `MtfAlignmentService` to the mock set.

In the existing spec's `beforeEach`, find the providers list and add:

```typescript
{
  provide: MtfAlignmentService,
  useValue: {
    // Default to aligned UP so existing tests (which expect analyze() to be called) keep passing.
    check: vi.fn().mockResolvedValue({
      aligned: true,
      agreedDirection: 'UP',
      directions: { '1d': 'UP', '1h': 'UP', '15m': 'UP', '5m': 'UP' },
      summary: '1d=UP 1h=UP 15m=UP 5m=UP',
    }),
  },
},
```

Add the import at the top of the spec file:
```typescript
import { MtfAlignmentService } from '../../../signal-generator/services/mtf-alignment.service';
```

### Step 2.4: Add two new test cases for the gate

In the existing `describe('ChartinkProcessService', ...)` block, after the existing tests, append:

```typescript
  describe('MTF gate', () => {
    it('persists mtf-misaligned and SKIPS analyze when TFs disagree', async () => {
      // Override the per-test mocks: instrument resolves, MTF reports misaligned.
      mockMdRepo.getInstrumentBySymbol.mockResolvedValue({ id: 'inst-1', token: '2885', symbol: 'RELIANCE' });
      mockMtf.check.mockResolvedValue({
        aligned: false,
        agreedDirection: null,
        directions: { '1d': 'UP', '1h': 'UP', '15m': 'DOWN', '5m': 'UP' },
        summary: '1d=UP 1h=UP 15m=DOWN 5m=UP',
      });
      mockSignalSvc.analyze.mockResolvedValue({ kind: 'setup' }); // must NOT be called

      await service.processOne('alert-1', { symbol: 'RELIANCE', hitPrice: 2885 });

      expect(mockSignalSvc.analyze).not.toHaveBeenCalled();
      expect(mockRepo.createAlertSetup).toHaveBeenCalledWith(expect.objectContaining({
        alertId: 'alert-1',
        symbol: 'RELIANCE',
        token: '2885',
        hitPrice: 2885,
        kind: 'mtf-misaligned',
        rejectReason: expect.stringContaining('1d=UP 1h=UP 15m=DOWN 5m=UP'),
      }));
    });

    it('proceeds to analyze when MTF reports aligned UP', async () => {
      mockMdRepo.getInstrumentBySymbol.mockResolvedValue({ id: 'inst-1', token: '2885', symbol: 'RELIANCE' });
      mockMtf.check.mockResolvedValue({
        aligned: true,
        agreedDirection: 'UP',
        directions: { '1d': 'UP', '1h': 'UP', '15m': 'UP', '5m': 'UP' },
        summary: '1d=UP 1h=UP 15m=UP 5m=UP',
      });
      mockSignalSvc.analyze.mockResolvedValue({ kind: 'no-setup', reason: 'reject:outside-window' });
      mockTracker.getActive.mockReturnValue(null);

      await service.processOne('alert-1', { symbol: 'RELIANCE', hitPrice: 2885 });

      expect(mockSignalSvc.analyze).toHaveBeenCalledOnce();
      expect(mockRepo.createAlertSetup).toHaveBeenCalledWith(expect.objectContaining({
        kind: 'no-setup',
      }));
    });

    it('proceeds to analyze when MTF reports aligned DOWN', async () => {
      mockMdRepo.getInstrumentBySymbol.mockResolvedValue({ id: 'inst-1', token: '2885', symbol: 'RELIANCE' });
      mockMtf.check.mockResolvedValue({
        aligned: true,
        agreedDirection: 'DOWN',
        directions: { '1d': 'DOWN', '1h': 'DOWN', '15m': 'DOWN', '5m': 'DOWN' },
        summary: '1d=DOWN 1h=DOWN 15m=DOWN 5m=DOWN',
      });
      mockSignalSvc.analyze.mockResolvedValue({ kind: 'setup' });
      mockTracker.getActive.mockReturnValue({ id: 'setup-99' });

      await service.processOne('alert-1', { symbol: 'RELIANCE', hitPrice: 2885 });

      expect(mockSignalSvc.analyze).toHaveBeenCalledOnce();
      expect(mockRepo.createAlertSetup).toHaveBeenCalledWith(expect.objectContaining({
        kind: 'setup',
        setupId: 'setup-99',
      }));
    });

    it('does NOT call MTF when symbol fails to resolve', async () => {
      mockMdRepo.getInstrumentBySymbol.mockResolvedValue(null);

      await service.processOne('alert-1', { symbol: 'UNKNOWN', hitPrice: 100 });

      expect(mockMtf.check).not.toHaveBeenCalled();
      expect(mockSignalSvc.analyze).not.toHaveBeenCalled();
      expect(mockRepo.createAlertSetup).toHaveBeenCalledWith(expect.objectContaining({
        kind: 'unresolved',
      }));
    });
  });
```

You'll need to make sure the test file declares `mockMtf` in its outer scope (same pattern as the existing mocks like `mockSignalSvc`). Inside the `beforeEach`:

```typescript
mockMtf = {
  check: vi.fn().mockResolvedValue({
    aligned: true,
    agreedDirection: 'UP',
    directions: { '1d': 'UP', '1h': 'UP', '15m': 'UP', '5m': 'UP' },
    summary: '1d=UP 1h=UP 15m=UP 5m=UP',
  }),
};
```

And in the `Test.createTestingModule({ providers: [...] })`:
```typescript
{ provide: MtfAlignmentService, useValue: mockMtf },
```

### Step 2.5: Run the chartink-process tests

Run from repo root:
```bash
cd apps/api && npx vitest run src/modules/chartink/services/__tests__/chartink-process.service.spec.ts 2>&1 | tail -20
```
Expected: All existing tests pass + 4 new "MTF gate" tests pass.

### Step 2.6: Commit

```bash
cd C:/Users/AryanKumar/Desktop/TD_Automation
git add apps/api/src/modules/chartink/services/chartink-process.service.ts \
        apps/api/src/modules/chartink/services/__tests__/chartink-process.service.spec.ts
git -c commit.gpgsign=false commit -m "feat(chartink): gate hits through 4-TF directional check before analyze"
```

---

## Task 3: Surface the new kind on the /chartink frontend

**Files:**
- Modify: `apps/web/src/pages/chartink/ChartinkPage.tsx` (line ~16-24 — `fmtKindCount` function)

### Step 3.1: Update the kind-count formatter

Open `apps/web/src/pages/chartink/ChartinkPage.tsx`. Find this function (it's near the top of the file):

```typescript
function fmtKindCount(setups: ChartinkAlert['setups']): string {
  const counts: Record<string, number> = { setup: 0, 'no-setup': 0, unresolved: 0, error: 0 };
  for (const s of setups ?? []) counts[s.kind] = (counts[s.kind] ?? 0) + 1;
  const parts: string[] = [];
  if (counts.setup) parts.push(`${counts.setup} setups`);
  if (counts['no-setup']) parts.push(`${counts['no-setup']} no-setup`);
  if (counts.unresolved) parts.push(`${counts.unresolved} unresolved`);
  if (counts.error) parts.push(`${counts.error} error`);
  return parts.length ? parts.join(' · ') : '—';
}
```

Replace it with:

```typescript
function fmtKindCount(setups: ChartinkAlert['setups']): string {
  const counts: Record<string, number> = {
    setup: 0, 'no-setup': 0, 'mtf-misaligned': 0, unresolved: 0, error: 0,
  };
  for (const s of setups ?? []) counts[s.kind] = (counts[s.kind] ?? 0) + 1;
  const parts: string[] = [];
  if (counts.setup) parts.push(`${counts.setup} setups`);
  if (counts['no-setup']) parts.push(`${counts['no-setup']} no-setup`);
  if (counts['mtf-misaligned']) parts.push(`${counts['mtf-misaligned']} mtf-misaligned`);
  if (counts.unresolved) parts.push(`${counts.unresolved} unresolved`);
  if (counts.error) parts.push(`${counts.error} error`);
  return parts.length ? parts.join(' · ') : '—';
}
```

### Step 3.2: Verify it compiles

Run from repo root:
```bash
cd apps/web && npx tsc --noEmit 2>&1 | grep -E "ChartinkPage" | head -5
```
Expected: no output.

### Step 3.3: Commit

```bash
cd C:/Users/AryanKumar/Desktop/TD_Automation
git add apps/web/src/pages/chartink/ChartinkPage.tsx
git -c commit.gpgsign=false commit -m "feat(chartink): show mtf-misaligned count on /chartink page"
```

---

## Task 4: Smoke test the gate end-to-end

- [ ] **Step 4.1: Verify tests all green**

```bash
cd C:/Users/AryanKumar/Desktop/TD_Automation/apps/api && npx vitest run src/modules/signal-generator/services/mtf-alignment.service.spec.ts src/modules/chartink 2>&1 | tail -20
```
Expected: all green.

- [ ] **Step 4.2: Trigger a synthetic webhook against the live API**

The API auto-reloads via `nest start --watch` when the source files change, so the new gate is already live. Touch main if needed:

```bash
cd C:/Users/AryanKumar/Desktop/TD_Automation && touch -c apps/api/src/main.ts
```

Wait ~5s for restart, then:

```bash
cd C:/Users/AryanKumar/Desktop/TD_Automation && SECRET=$(grep '^CHARTINK_WEBHOOK_SECRET=' .env | cut -d= -f2-) && \
curl -sS -X POST "http://127.0.0.1:4001/webhooks/chartink/$SECRET" \
  -H "Content-Type: application/json" \
  --data-binary '{"stocks":"RELIANCE,TCS","trigger_prices":"2885,3890","triggered_at":"3:00 pm","scan_name":"MTF gate smoke","scan_url":"mtf-gate-smoke","alert_name":"x","webhook_url":""}'
```

Expected: `{"received":true, "alertId":"...","hitCount":2}`

- [ ] **Step 4.3: Pull the alert detail and inspect outcomes**

Wait ~10s for the worker to process (~4 broker calls × 350ms × 2 stocks = ~3 s, plus analyze() if MTF aligns):

```bash
cd C:/Users/AryanKumar/Desktop/TD_Automation && ALERT_ID=$(curl -s "http://127.0.0.1:4001/api/chartink/alerts" | grep -oE '"id":"[^"]+"' | head -1 | cut -d\" -f4); \
sleep 10; \
curl -s "http://127.0.0.1:4001/api/chartink/alerts/$ALERT_ID" | head -c 1500
```

Expected: per-symbol setups visible. After-market-hours, you should see either `mtf-misaligned` (with a `TF:` reject reason listing the 4 directions) OR `no-setup` with `reject:outside-window` (if MTF happened to align). Either is correct.

If you see `kind:'setup'` outside market hours that's a bug — please surface the alert ID and the controller log line for triage.

- [ ] **Step 4.4: Visual confirmation on /chartink page**

Open http://localhost:4000/chartink in a browser (refresh if it was open). The new alert row should show the new mix in its "OUTCOMES" column, e.g.:
- "1 mtf-misaligned · 1 no-setup" (mixed result)
- "2 mtf-misaligned" (both rejected by the gate)
- "2 no-setup" (gate passed both, analyze rejected for other reasons)

---

## Done criteria

- `MtfAlignmentService.check()` covered by 9 unit tests; all green.
- `ChartinkProcessService` has the 4 new MTF tests + existing tests still green.
- Frontend `fmtKindCount` includes `mtf-misaligned`.
- Real curl against the live webhook produces a row with the new kind in DB (verified via /api/chartink/alerts/:id).
- `npx tsc --noEmit` clean for the modified files.

## Out of scope (reminder)

- No DB migration (kind stays as free-form string).
- No changes to `analyze()` itself.
- No per-scanner override.
- No EMA/slope/ADX-based direction definitions.
