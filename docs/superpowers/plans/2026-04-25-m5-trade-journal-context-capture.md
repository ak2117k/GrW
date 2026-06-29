# M5 — Trade Journal with Full Context Capture — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Every trade entry snapshots market context (spot, VIX with regime label, PCR, max pain, A/D ratio, trader's reason + tag chips, planned stop/target). Every trade exit captures a structured exit-reason tag. Journal page surfaces these fields and supports filtering by them.

**Architecture:**
- **Backend (Stream A):** Add Prisma columns to `Trade`. New `MarketContextService` in `market-data` module that aggregates VIX (Yahoo `^INDIAVIX`), PCR, max pain (existing in `options-chain`), A/D ratio (existing in `market-feed`), and a rule-based regime label. Wired into trade creation + close endpoints.
- **Frontend (Stream B):** `ExecuteTradeModal` extended with reason + tag chips. New `ExitTradeModal` (or extension of `TradeDetailModal` close flow) with exit-reason enum picker. `JournalPage` gains context columns + regime / exit-reason filters. `TradeDetailModal` displays the entry-context block.
- **Verification (Stream C):** End-to-end paper trade exercising the full lifecycle, type-check, tests.

**Tech Stack:** Prisma + PostgreSQL (TimescaleDB), NestJS 10, React 18 + Vite + Zustand, class-validator DTOs, axios via `@/services/api`, lucide-react icons.

**Out of scope (separate plans):** M2 dashboard wire-up, M6 risk view, full cost model (STT/brokerage/GST), live-vs-paper divergence, IV rank, opening-range overlays.

---

## File Structure (locked decisions)

| File | Action | Responsibility |
|---|---|---|
| `prisma/schema.prisma` | Modify (Trade model ~line 119) | Add 10 context columns + 2 exit columns |
| `apps/api/src/modules/market-data/services/yahoo-finance.service.ts` | Modify | Add `getIndiaVix()` |
| `apps/api/src/modules/market-data/services/market-context.service.ts` | **Create** | Aggregator: returns `{ spot, vix, vixRegime, pcr, maxPain, adRatio, capturedAt }` |
| `apps/api/src/modules/market-data/services/index.ts` | Modify | Export new service |
| `apps/api/src/modules/market-data/market-data.module.ts` | Modify | Provide + export new service |
| `apps/api/src/modules/trade-engine/dto/trade.dto.ts` | Modify | Add fields to `ExecuteTradeDto` + `CloseTradeDto`, add `ExitReasonTag` enum |
| `apps/api/src/modules/trade-engine/services/trade-execution.service.ts` | Modify | Call `MarketContextService.snapshot()` on createTrade; persist context |
| `apps/api/src/modules/trade-engine/services/trade-execution.service.ts` | Modify | Persist exitReasonTag + exitNotes on closeTrade |
| `apps/api/src/modules/trade-engine/trade-engine.module.ts` | Modify | Import market-data module to access `MarketContextService` |
| `apps/api/test/market-context.service.spec.ts` | **Create** | Unit tests for aggregator + regime classifier |
| `packages/shared/src/types/trade.ts` (or wherever Trade type lives) | Modify | Add fields to shared Trade type |
| `apps/web/src/types/index.ts` | Modify | Mirror new Trade fields |
| `apps/web/src/components/trading/ExecuteTradeModal.tsx` | Modify | Reason textarea + tag chip selector |
| `apps/web/src/components/trading/ExitTradeModal.tsx` | **Create** | Exit-reason tag picker modal |
| `apps/web/src/components/trading/TradeDetailModal.tsx` | Modify | Render entry context block; replace inline close button with `ExitTradeModal` |
| `apps/web/src/components/trading/TradeFilters.tsx` | Modify | Add regime + exitReason filter dropdowns |
| `apps/web/src/stores/trade-store.ts` | Modify | Pass entryReason/entryTags through executeTrade; pass exitReasonTag/exitNotes through closeTrade |
| `apps/web/src/pages/journal/JournalPage.tsx` | Modify | Add VIX, Regime, Tags, Exit-Reason columns |

---

## Task 1: Schema migration — add Trade context columns

**Files:**
- Modify: `prisma/schema.prisma:119-151` (Trade model)

- [ ] **Step 1.1: Add columns to Trade model**

In `prisma/schema.prisma`, replace the existing Trade model body with:

```prisma
model Trade {
  id              String   @id @default(cuid())
  instrumentId    String
  instrument      Instrument @relation(fields: [instrumentId], references: [id])
  signalId        String?
  signal          Signal?  @relation(fields: [signalId], references: [id])
  orderId         String?
  side            String
  orderType       String
  positionType    String
  quantity        Int
  entryPrice      Float?
  exitPrice       Float?
  stoploss        Float?
  target          Float?
  pnl             Float?
  pnlPercent      Float?
  fees            Float    @default(0)
  status          String   @default("PENDING")
  strategy        String?
  isPaperTrade    Boolean  @default(true)
  entryTime       DateTime?
  exitTime        DateTime?
  notes           String?

  // ---- M5: Entry context capture ----
  entryReason     String?     // free-text "why this trade"
  entryTags       String[]    @default([])  // chip selections (e.g. ["OI_BUILDUP","VWAP_RECLAIM"])
  spotAtEntry     Float?      // underlying spot at time of entry
  vixAtEntry      Float?      // India VIX at time of entry
  vixRegimeAtEntry String?    // LOW | NORMAL | ELEVATED | HIGH
  pcrAtEntry      Float?      // put-call ratio at time of entry
  maxPainAtEntry  Float?      // max pain strike at time of entry
  adRatioAtEntry  Float?      // advance/decline ratio at time of entry
  contextSnapshot Json?       // full structured snapshot for forward compatibility

  // ---- M5: Exit reason capture ----
  exitReasonTag   String?     // HIT_TARGET | STOPPED_OUT | MOVED_STOP | PANIC_EXIT | TIME_EXIT | REVERSAL_SEEN | OTHER
  exitNotes       String?     // free-text exit notes

  createdAt       DateTime @default(now())
  updatedAt       DateTime @updatedAt

  @@index([status])
  @@index([createdAt])
  @@index([strategy])
  @@index([isPaperTrade])
  @@index([vixRegimeAtEntry])
  @@index([exitReasonTag])
  @@map("trades")
}
```

- [ ] **Step 1.2: Generate migration**

Run from repo root:

```bash
npx prisma migrate dev --name m5_trade_context_capture
```

Expected: migration file created under `prisma/migrations/`, Prisma client regenerated, `trades` table altered.

- [ ] **Step 1.3: Verify migration in DB**

```bash
npx prisma studio
```

Expected: open `trades` table, see new columns `entryReason`, `entryTags`, `spotAtEntry`, `vixAtEntry`, `vixRegimeAtEntry`, `pcrAtEntry`, `maxPainAtEntry`, `adRatioAtEntry`, `contextSnapshot`, `exitReasonTag`, `exitNotes`.

- [ ] **Step 1.4: Commit**

```bash
git add prisma/schema.prisma prisma/migrations
git commit -m "feat(prisma): add M5 trade context capture columns"
```

---

## Task 2: Yahoo VIX fetcher

**Files:**
- Modify: `apps/api/src/modules/market-data/services/yahoo-finance.service.ts`

- [ ] **Step 2.1: Read existing yahoo service**

Open `apps/api/src/modules/market-data/services/yahoo-finance.service.ts` and identify:
- The existing fetch method (likely uses `axios` or `yahoo-finance2` package)
- The pattern for symbol → quote conversion
- How errors are handled / logged

- [ ] **Step 2.2: Add `getIndiaVix()` method**

Add a public method that fetches `^INDIAVIX` from Yahoo and returns the latest spot value. Skeleton — adapt naming to match the existing methods in this file:

```typescript
/**
 * Fetch India VIX spot price from Yahoo Finance.
 * Yahoo ticker: ^INDIAVIX. Returns null on failure.
 */
async getIndiaVix(): Promise<number | null> {
  try {
    // Use whichever fetch primitive the rest of this service uses
    // (yahoo-finance2.quote, axios.get to query1.finance.yahoo.com, etc.)
    const quote = await this.fetchQuote('^INDIAVIX');
    if (!quote || typeof quote.regularMarketPrice !== 'number') {
      return null;
    }
    return quote.regularMarketPrice;
  } catch (err) {
    this.logger.warn(`Failed to fetch India VIX: ${(err as Error).message}`);
    return null;
  }
}
```

If the existing service does not have a generic `fetchQuote` helper, replicate the pattern the existing methods use (e.g. directly call `yahoo-finance2.quote('^INDIAVIX')`).

- [ ] **Step 2.3: Add a unit test**

Create `apps/api/test/yahoo-finance.spec.ts` (or add to existing spec) with a test that mocks the fetch primitive and asserts `getIndiaVix()` returns the mocked price.

```typescript
it('returns India VIX spot when fetch succeeds', async () => {
  const fakeQuote = { regularMarketPrice: 14.32 };
  jest.spyOn(service as any, 'fetchQuote').mockResolvedValue(fakeQuote);
  const vix = await service.getIndiaVix();
  expect(vix).toBe(14.32);
});

it('returns null when fetch fails', async () => {
  jest.spyOn(service as any, 'fetchQuote').mockRejectedValue(new Error('network'));
  const vix = await service.getIndiaVix();
  expect(vix).toBeNull();
});
```

- [ ] **Step 2.4: Run the test**

```bash
cd apps/api && npm test -- yahoo-finance.spec
```

Expected: PASS for both new cases.

- [ ] **Step 2.5: Commit**

```bash
git add apps/api/src/modules/market-data/services/yahoo-finance.service.ts apps/api/test/yahoo-finance.spec.ts
git commit -m "feat(market-data): add India VIX fetcher via Yahoo"
```

---

## Task 3: MarketContextService

**Files:**
- Create: `apps/api/src/modules/market-data/services/market-context.service.ts`
- Modify: `apps/api/src/modules/market-data/services/index.ts` (add export)
- Modify: `apps/api/src/modules/market-data/market-data.module.ts` (provide + export)
- Create: `apps/api/test/market-context.service.spec.ts`

- [ ] **Step 3.1: Write the failing test**

Create `apps/api/test/market-context.service.spec.ts`:

```typescript
import { Test } from '@nestjs/testing';
import { MarketContextService } from '../src/modules/market-data/services/market-context.service';
import { YahooFinanceService } from '../src/modules/market-data/services/yahoo-finance.service';
import { MarketFeedService } from '../src/modules/market-data/services/market-feed.service';
import { OptionsChainService } from '../src/modules/options-chain/services/options-chain.service';

describe('MarketContextService', () => {
  let service: MarketContextService;
  let yahoo: jest.Mocked<YahooFinanceService>;
  let feed: jest.Mocked<MarketFeedService>;
  let chain: jest.Mocked<OptionsChainService>;

  beforeEach(async () => {
    const moduleRef = await Test.createTestingModule({
      providers: [
        MarketContextService,
        { provide: YahooFinanceService, useValue: { getIndiaVix: jest.fn() } },
        { provide: MarketFeedService, useValue: { calculateBreadth: jest.fn(), getLtp: jest.fn() } },
        { provide: OptionsChainService, useValue: { getPCR: jest.fn(), getMaxPain: jest.fn() } },
      ],
    }).compile();
    service = moduleRef.get(MarketContextService);
    yahoo = moduleRef.get(YahooFinanceService);
    feed = moduleRef.get(MarketFeedService);
    chain = moduleRef.get(OptionsChainService);
  });

  describe('classifyVixRegime', () => {
    it('classifies <12 as LOW', () => {
      expect(service.classifyVixRegime(11.9)).toBe('LOW');
    });
    it('classifies 12-18 as NORMAL', () => {
      expect(service.classifyVixRegime(12)).toBe('NORMAL');
      expect(service.classifyVixRegime(17.99)).toBe('NORMAL');
    });
    it('classifies 18-25 as ELEVATED', () => {
      expect(service.classifyVixRegime(18)).toBe('ELEVATED');
      expect(service.classifyVixRegime(24.99)).toBe('ELEVATED');
    });
    it('classifies >=25 as HIGH', () => {
      expect(service.classifyVixRegime(25)).toBe('HIGH');
      expect(service.classifyVixRegime(40)).toBe('HIGH');
    });
    it('classifies null/undefined as UNKNOWN', () => {
      expect(service.classifyVixRegime(null)).toBe('UNKNOWN');
    });
  });

  describe('snapshot', () => {
    it('aggregates all context sources', async () => {
      yahoo.getIndiaVix.mockResolvedValue(14.5);
      feed.calculateBreadth.mockResolvedValue({ advances: 30, declines: 20, adRatio: 1.5 } as any);
      feed.getLtp.mockResolvedValue(22500);
      chain.getPCR.mockResolvedValue(1.12 as any);
      chain.getMaxPain.mockResolvedValue(22400 as any);

      const ctx = await service.snapshot('NIFTY');

      expect(ctx).toMatchObject({
        spot: 22500,
        vix: 14.5,
        vixRegime: 'NORMAL',
        pcr: 1.12,
        maxPain: 22400,
        adRatio: 1.5,
      });
      expect(ctx.capturedAt).toBeInstanceOf(Date);
    });

    it('tolerates partial failures (returns nulls for failed fetches)', async () => {
      yahoo.getIndiaVix.mockResolvedValue(null);
      feed.calculateBreadth.mockRejectedValue(new Error('ws not connected'));
      feed.getLtp.mockResolvedValue(22500);
      chain.getPCR.mockResolvedValue(null as any);
      chain.getMaxPain.mockResolvedValue(null as any);

      const ctx = await service.snapshot('NIFTY');

      expect(ctx.spot).toBe(22500);
      expect(ctx.vix).toBeNull();
      expect(ctx.vixRegime).toBe('UNKNOWN');
      expect(ctx.adRatio).toBeNull();
      expect(ctx.pcr).toBeNull();
      expect(ctx.maxPain).toBeNull();
    });
  });
});
```

- [ ] **Step 3.2: Run the test (expect FAIL)**

```bash
cd apps/api && npm test -- market-context.service.spec
```

Expected: FAIL — file not found / cannot resolve `MarketContextService`.

- [ ] **Step 3.3: Implement MarketContextService**

Create `apps/api/src/modules/market-data/services/market-context.service.ts`:

```typescript
import { Injectable, Logger } from '@nestjs/common';
import { YahooFinanceService } from './yahoo-finance.service';
import { MarketFeedService } from './market-feed.service';
import { OptionsChainService } from '../../options-chain/services/options-chain.service';

export type VixRegime = 'LOW' | 'NORMAL' | 'ELEVATED' | 'HIGH' | 'UNKNOWN';

export interface MarketContextSnapshot {
  spot: number | null;
  vix: number | null;
  vixRegime: VixRegime;
  pcr: number | null;
  maxPain: number | null;
  adRatio: number | null;
  capturedAt: Date;
  underlying: string;
}

/**
 * Aggregates real-time market context for trade journaling.
 *
 * WHY: M5 requires that every trade entry be stamped with the market state
 * at decision time, so post-hoc journal analysis can correlate outcomes
 * with regime, sentiment, and breadth — not just the trade's own price.
 */
@Injectable()
export class MarketContextService {
  private readonly logger = new Logger(MarketContextService.name);

  constructor(
    private readonly yahoo: YahooFinanceService,
    private readonly feed: MarketFeedService,
    private readonly chain: OptionsChainService,
  ) {}

  classifyVixRegime(vix: number | null | undefined): VixRegime {
    if (vix == null || Number.isNaN(vix)) return 'UNKNOWN';
    if (vix < 12) return 'LOW';
    if (vix < 18) return 'NORMAL';
    if (vix < 25) return 'ELEVATED';
    return 'HIGH';
  }

  /**
   * Capture a market-context snapshot for the given underlying.
   * Each upstream call is wrapped in a tolerant promise so a single
   * failing source does NOT block the snapshot — missing fields come
   * back as null and the trade still records what was available.
   */
  async snapshot(underlying: string): Promise<MarketContextSnapshot> {
    const [spot, vix, breadth, pcr, maxPain] = await Promise.all([
      this.tolerant(() => this.feed.getLtp(underlying), 'spot'),
      this.tolerant(() => this.yahoo.getIndiaVix(), 'vix'),
      this.tolerant(() => this.feed.calculateBreadth(), 'breadth'),
      this.tolerant(() => this.chain.getPCR(underlying), 'pcr'),
      this.tolerant(() => this.chain.getMaxPain(underlying), 'maxPain'),
    ]);

    return {
      underlying,
      spot: spot ?? null,
      vix: vix ?? null,
      vixRegime: this.classifyVixRegime(vix),
      pcr: pcr ?? null,
      maxPain: maxPain ?? null,
      adRatio: breadth?.adRatio ?? null,
      capturedAt: new Date(),
    };
  }

  private async tolerant<T>(fn: () => Promise<T>, label: string): Promise<T | null> {
    try {
      return await fn();
    } catch (err) {
      this.logger.warn(`MarketContext: failed to capture ${label}: ${(err as Error).message}`);
      return null;
    }
  }
}
```

**Note for the implementer:** Inspect `MarketFeedService` and `OptionsChainService` signatures before assuming method names. If the actual names are e.g. `getQuote(symbol).ltp`, `breadth()`, `computePCR(underlying)`, or `computeMaxPain(underlying)`, adjust the calls in `snapshot()` to match. The service contract (what `snapshot()` returns) does NOT change.

- [ ] **Step 3.4: Wire into module + index**

In `apps/api/src/modules/market-data/services/index.ts`, add:
```typescript
export * from './market-context.service';
```

In `apps/api/src/modules/market-data/market-data.module.ts`:
- Add `MarketContextService` to `providers` and to `exports`
- Ensure `OptionsChainModule` is imported (or the service-export pattern your repo uses) so `OptionsChainService` is injectable here. If circular-import risk, use `forwardRef`.

- [ ] **Step 3.5: Run the test (expect PASS)**

```bash
cd apps/api && npm test -- market-context.service.spec
```

Expected: all 7 tests PASS.

- [ ] **Step 3.6: Commit**

```bash
git add apps/api/src/modules/market-data/
git add apps/api/test/market-context.service.spec.ts
git commit -m "feat(market-data): MarketContextService aggregates VIX/PCR/maxPain/AD for journaling"
```

---

## Task 4: DTO updates (entry + exit)

**Files:**
- Modify: `apps/api/src/modules/trade-engine/dto/trade.dto.ts`

- [ ] **Step 4.1: Add ExitReasonTag enum + extend DTOs**

Edit `trade.dto.ts`. Add the enum near the top (after the existing enums) and extend the DTOs:

```typescript
export enum ExitReasonTag {
  HIT_TARGET = 'HIT_TARGET',
  STOPPED_OUT = 'STOPPED_OUT',
  MOVED_STOP = 'MOVED_STOP',
  PANIC_EXIT = 'PANIC_EXIT',
  TIME_EXIT = 'TIME_EXIT',
  REVERSAL_SEEN = 'REVERSAL_SEEN',
  OTHER = 'OTHER',
}
```

Inside `ExecuteTradeDto`, add the new optional fields (after `target?` and before `signalId?`):

```typescript
  @IsOptional()
  @IsString()
  entryReason?: string;

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  entryTags?: string[];
```

(Add `IsArray` to the `class-validator` import line.)

Inside `CloseTradeDto`, replace the body with:

```typescript
export class CloseTradeDto {
  @IsOptional()
  @IsEnum(ExitReasonTag)
  exitReasonTag?: ExitReasonTag;

  @IsOptional()
  @IsString()
  exitNotes?: string;

  /** @deprecated Prefer exitReasonTag + exitNotes. Kept for backwards compatibility. */
  @IsOptional()
  @IsString()
  reason?: string;
}
```

- [ ] **Step 4.2: Type-check**

```bash
cd apps/api && npx tsc --noEmit
```

Expected: no new type errors.

- [ ] **Step 4.3: Commit**

```bash
git add apps/api/src/modules/trade-engine/dto/trade.dto.ts
git commit -m "feat(trade-engine): add ExitReasonTag + entry context fields to DTOs"
```

---

## Task 5: Persist entry context on createTrade

**Files:**
- Modify: `apps/api/src/modules/trade-engine/services/trade-execution.service.ts`
- Modify: `apps/api/src/modules/trade-engine/trade-engine.module.ts`

- [ ] **Step 5.1: Inject MarketContextService into trade-execution**

Open `trade-engine.module.ts` and import `MarketDataModule` (so its exported `MarketContextService` is available). Then in `trade-execution.service.ts`, inject `MarketContextService` via the constructor.

```typescript
import { MarketContextService } from '../../market-data/services/market-context.service';

constructor(
  // ...existing deps
  private readonly marketContext: MarketContextService,
) {}
```

- [ ] **Step 5.2: Capture context inside the createTrade flow**

Locate the method that creates the Trade row (likely `executeTrade` or `createTrade`). Before persisting the trade, call:

```typescript
// Determine the underlying symbol — for an options trade, this is the
// underlying index (NIFTY/BANKNIFTY/FINNIFTY); for an index/equity trade,
// it's the symbol itself. Use the existing helper if one exists.
const underlying = this.deriveUnderlying(dto.symbol);

const ctx = await this.marketContext.snapshot(underlying);

// Build the Prisma create payload
const tradeData = {
  // ...existing fields,
  entryReason: dto.entryReason ?? null,
  entryTags: dto.entryTags ?? [],
  spotAtEntry: ctx.spot,
  vixAtEntry: ctx.vix,
  vixRegimeAtEntry: ctx.vixRegime,
  pcrAtEntry: ctx.pcr,
  maxPainAtEntry: ctx.maxPain,
  adRatioAtEntry: ctx.adRatio,
  contextSnapshot: ctx as unknown as Prisma.InputJsonValue,
};
```

If `deriveUnderlying` doesn't exist, add a small helper:
```typescript
private deriveUnderlying(symbol: string): string {
  // Options symbols look like "NIFTY24APR22500CE" — strip suffix
  const match = symbol.match(/^(NIFTY|BANKNIFTY|FINNIFTY|MIDCPNIFTY)/);
  return match ? match[1] : symbol;
}
```

- [ ] **Step 5.3: Verify the existing trade-creation tests still pass**

```bash
cd apps/api && npm test -- trade-execution
```

Expected: existing tests PASS. Failing tests indicate either a missed contract or a test that needs `MarketContextService` mocked — add the mock provider, do not change service signatures.

- [ ] **Step 5.4: Commit**

```bash
git add apps/api/src/modules/trade-engine/
git commit -m "feat(trade-engine): snapshot market context on trade entry"
```

---

## Task 6: Persist exit-reason on closeTrade

**Files:**
- Modify: `apps/api/src/modules/trade-engine/services/trade-execution.service.ts`
- Modify: `apps/api/src/modules/trade-engine/controllers/trade-engine.controller.ts` (verify body is wired)

- [ ] **Step 6.1: Update closeTrade signature**

Find the `closeTrade(tradeId, ...)` method. Update it to accept the new fields:

```typescript
async closeTrade(
  tradeId: string,
  opts: { exitReasonTag?: ExitReasonTag; exitNotes?: string; reason?: string } = {},
): Promise<Trade> {
  // ...existing exit-price + pnl computation...

  return this.tradeRepository.update(tradeId, {
    // ...existing fields,
    exitReasonTag: opts.exitReasonTag ?? null,
    exitNotes: opts.exitNotes ?? opts.reason ?? null,
    status: 'CLOSED',
    exitTime: new Date(),
  });
}
```

- [ ] **Step 6.2: Wire controller**

In `trade-engine.controller.ts`, the `POST /trades/:id/close` endpoint should accept `CloseTradeDto` from the body:

```typescript
@Post(':id/close')
async close(
  @Param('id') id: string,
  @Body() dto: CloseTradeDto,
) {
  return this.tradeExecution.closeTrade(id, {
    exitReasonTag: dto.exitReasonTag,
    exitNotes: dto.exitNotes,
    reason: dto.reason,
  });
}
```

- [ ] **Step 6.3: Add a test**

In the existing trade-execution spec, add:

```typescript
it('persists exitReasonTag and exitNotes on close', async () => {
  // arrange: create an OPEN trade in the test DB / mocked repo
  const trade = await service.executeTrade(/* ... */);
  // act
  await service.closeTrade(trade.id, {
    exitReasonTag: ExitReasonTag.HIT_TARGET,
    exitNotes: 'Target reached at VWAP+1',
  });
  // assert
  const persisted = await repo.findById(trade.id);
  expect(persisted.exitReasonTag).toBe('HIT_TARGET');
  expect(persisted.exitNotes).toBe('Target reached at VWAP+1');
  expect(persisted.status).toBe('CLOSED');
});
```

- [ ] **Step 6.4: Run tests**

```bash
cd apps/api && npm test -- trade-execution
```

Expected: PASS.

- [ ] **Step 6.5: Commit**

```bash
git add apps/api/src/modules/trade-engine/
git commit -m "feat(trade-engine): persist structured exit reason on closeTrade"
```

---

## Task 7: Frontend Trade type

**Files:**
- Modify: `apps/web/src/types/index.ts` (or wherever `Trade` is exported from)

- [ ] **Step 7.1: Find existing Trade type**

```bash
grep -rn "export interface Trade" apps/web/src/types
grep -rn "export type Trade" apps/web/src/types
```

- [ ] **Step 7.2: Extend the type**

Add the new fields:

```typescript
export interface Trade {
  // ...existing fields
  entryReason?: string | null;
  entryTags?: string[];
  spotAtEntry?: number | null;
  vixAtEntry?: number | null;
  vixRegimeAtEntry?: 'LOW' | 'NORMAL' | 'ELEVATED' | 'HIGH' | 'UNKNOWN' | null;
  pcrAtEntry?: number | null;
  maxPainAtEntry?: number | null;
  adRatioAtEntry?: number | null;
  contextSnapshot?: Record<string, unknown> | null;
  exitReasonTag?:
    | 'HIT_TARGET'
    | 'STOPPED_OUT'
    | 'MOVED_STOP'
    | 'PANIC_EXIT'
    | 'TIME_EXIT'
    | 'REVERSAL_SEEN'
    | 'OTHER'
    | null;
  exitNotes?: string | null;
}

export const ENTRY_TAG_OPTIONS = [
  { value: 'OI_BUILDUP', label: 'OI buildup at S/R' },
  { value: 'VWAP_RECLAIM', label: 'VWAP reclaim' },
  { value: 'TREND_CONT', label: 'Trend continuation' },
  { value: 'REVERSAL', label: 'Reversal setup' },
  { value: 'RANGE_BREAK', label: 'Range break' },
  { value: 'EXPIRY_PIN', label: 'Expiry pin play' },
  { value: 'VOL_CRUSH', label: 'Volatility crush' },
  { value: 'NEWS_DRIVEN', label: 'News-driven' },
  { value: 'CUSTOM', label: 'Custom' },
] as const;

export const EXIT_REASON_OPTIONS = [
  { value: 'HIT_TARGET', label: 'Hit Target' },
  { value: 'STOPPED_OUT', label: 'Stopped Out' },
  { value: 'MOVED_STOP', label: 'Moved Stop (manual)' },
  { value: 'PANIC_EXIT', label: 'Panic / discretionary exit' },
  { value: 'TIME_EXIT', label: 'Time-based exit (e.g. close near EOD)' },
  { value: 'REVERSAL_SEEN', label: 'Saw reversal — exited early' },
  { value: 'OTHER', label: 'Other' },
] as const;
```

- [ ] **Step 7.3: Type-check**

```bash
cd apps/web && npx tsc --noEmit
```

Expected: type errors only at consumers that read these fields (those will be fixed in Tasks 8–13).

- [ ] **Step 7.4: Commit**

```bash
git add apps/web/src/types
git commit -m "feat(web): extend Trade type with M5 context + exit-reason fields"
```

---

## Task 8: ExecuteTradeModal — capture entry reason + tags

**Files:**
- Modify: `apps/web/src/components/trading/ExecuteTradeModal.tsx`

- [ ] **Step 8.1: Add reason + tags state**

After the existing `useState` hooks (around line 39), add:

```typescript
const [entryReason, setEntryReason] = useState('');
const [entryTags, setEntryTags] = useState<string[]>([]);
```

In the `useEffect` reset block (around line 97), reset them too:
```typescript
setEntryReason('');
setEntryTags([]);
```

- [ ] **Step 8.2: Pass through on submit**

In `handleSubmit` (around line 114), extend the executeTrade call:

```typescript
await executeTrade({
  // ...existing fields,
  entryReason: entryReason.trim() || undefined,
  entryTags: entryTags.length > 0 ? entryTags : undefined,
});
```

- [ ] **Step 8.3: Render the reason textarea + tag chips**

Insert this block AFTER the SL/Target grid (around line 324, before the "Estimated value" block):

```tsx
import { ENTRY_TAG_OPTIONS } from '@/types';
// ...

{/* Why this trade */}
<div>
  <label className="block text-xs font-medium text-gray-400 mb-1">
    Why this trade?
  </label>
  <textarea
    value={entryReason}
    onChange={(e) => setEntryReason(e.target.value)}
    placeholder="What's your edge here? (free text)"
    rows={2}
    className="w-full rounded-md border border-gray-700 bg-gray-800 py-2 px-3 text-sm text-gray-100 placeholder-gray-500 outline-none focus:border-blue-500 resize-none"
  />
  <div className="mt-2 flex flex-wrap gap-1.5">
    {ENTRY_TAG_OPTIONS.map((tag) => {
      const active = entryTags.includes(tag.value);
      return (
        <button
          key={tag.value}
          type="button"
          onClick={() =>
            setEntryTags((prev) =>
              prev.includes(tag.value)
                ? prev.filter((t) => t !== tag.value)
                : [...prev, tag.value],
            )
          }
          className={cn(
            'rounded-full border px-2.5 py-0.5 text-[11px] transition-colors',
            active
              ? 'border-blue-500 bg-blue-500/15 text-blue-300'
              : 'border-gray-700 bg-gray-800 text-gray-400 hover:border-gray-600',
          )}
        >
          {tag.label}
        </button>
      );
    })}
  </div>
</div>
```

- [ ] **Step 8.4: Verify the modal renders**

Run dev server and open the trade modal. Confirm:
- Reason textarea appears
- All 9 tag chips render
- Clicking a chip toggles its highlighted state
- Multiple chips can be selected

```bash
cd apps/web && npm run dev
```

- [ ] **Step 8.5: Commit**

```bash
git add apps/web/src/components/trading/ExecuteTradeModal.tsx
git commit -m "feat(web): capture entry reason + tags in ExecuteTradeModal"
```

---

## Task 9: ExitTradeModal — exit-reason picker

**Files:**
- Create: `apps/web/src/components/trading/ExitTradeModal.tsx`

- [ ] **Step 9.1: Write the component**

```tsx
import { useState, useEffect, useCallback } from 'react';
import { Modal } from '@/components/common';
import { cn } from '@/utils/cn';
import { EXIT_REASON_OPTIONS } from '@/types';
import api from '@/services/api';
import toast from 'react-hot-toast';
import { Loader2 } from 'lucide-react';

interface ExitTradeModalProps {
  tradeId: string | null;
  isOpen: boolean;
  onClose: () => void;
  onClosed?: () => void;
}

export default function ExitTradeModal({
  tradeId,
  isOpen,
  onClose,
  onClosed,
}: ExitTradeModalProps) {
  const [exitReasonTag, setExitReasonTag] = useState<string>('');
  const [exitNotes, setExitNotes] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);

  useEffect(() => {
    if (isOpen) {
      setExitReasonTag('');
      setExitNotes('');
      setIsSubmitting(false);
    }
  }, [isOpen]);

  const handleConfirm = useCallback(async () => {
    if (!tradeId || !exitReasonTag) return;
    setIsSubmitting(true);
    try {
      await api.post(`/trades/${tradeId}/close`, {
        exitReasonTag,
        exitNotes: exitNotes.trim() || undefined,
      });
      toast.success('Trade closed');
      onClosed?.();
      onClose();
    } catch {
      toast.error('Failed to close trade');
    } finally {
      setIsSubmitting(false);
    }
  }, [tradeId, exitReasonTag, exitNotes, onClose, onClosed]);

  return (
    <Modal isOpen={isOpen} onClose={onClose} title="Close Trade" size="md">
      <div className="space-y-4">
        <p className="text-xs text-gray-400">
          What actually happened? This is the most important field for journal analysis.
        </p>

        {/* Reason tag chips */}
        <div>
          <label className="block text-xs font-medium text-gray-400 mb-1.5">
            Exit reason
          </label>
          <div className="grid grid-cols-2 gap-1.5">
            {EXIT_REASON_OPTIONS.map((opt) => {
              const active = exitReasonTag === opt.value;
              return (
                <button
                  key={opt.value}
                  type="button"
                  onClick={() => setExitReasonTag(opt.value)}
                  className={cn(
                    'rounded-md border px-2.5 py-1.5 text-xs text-left transition-colors',
                    active
                      ? 'border-blue-500 bg-blue-500/15 text-blue-300'
                      : 'border-gray-700 bg-gray-800 text-gray-400 hover:border-gray-600',
                  )}
                >
                  {opt.label}
                </button>
              );
            })}
          </div>
        </div>

        {/* Optional notes */}
        <div>
          <label className="block text-xs font-medium text-gray-400 mb-1">
            Exit notes (optional)
          </label>
          <textarea
            value={exitNotes}
            onChange={(e) => setExitNotes(e.target.value)}
            placeholder="Anything you want to remember about how this exit played out?"
            rows={3}
            className="w-full rounded-md border border-gray-700 bg-gray-800 py-2 px-3 text-sm text-gray-100 placeholder-gray-500 outline-none focus:border-blue-500 resize-none"
          />
        </div>

        {/* Confirm button */}
        <button
          onClick={handleConfirm}
          disabled={!exitReasonTag || isSubmitting}
          className={cn(
            'w-full py-2.5 rounded-md text-sm font-semibold transition-colors flex items-center justify-center gap-2',
            'bg-red-600 hover:bg-red-500 text-white',
            (!exitReasonTag || isSubmitting) && 'opacity-50 cursor-not-allowed',
          )}
        >
          {isSubmitting ? <Loader2 size={16} className="animate-spin" /> : null}
          {isSubmitting ? 'Closing...' : 'Confirm Close'}
        </button>
      </div>
    </Modal>
  );
}
```

- [ ] **Step 9.2: Commit**

```bash
git add apps/web/src/components/trading/ExitTradeModal.tsx
git commit -m "feat(web): add ExitTradeModal with structured exit-reason picker"
```

---

## Task 10: Wire ExitTradeModal into TradeDetailModal

**Files:**
- Modify: `apps/web/src/components/trading/TradeDetailModal.tsx`

- [ ] **Step 10.1: Replace the inline close button with the new modal**

In `TradeDetailModal.tsx`, around line 102 the existing `handleCloseTrade` directly calls `POST /trades/:id/close` — that path no longer matches the new structured flow.

Replace:
```typescript
const [isClosing, setIsClosing] = useState(false);

const handleCloseTrade = useCallback(async () => {
  // ... existing impl
}, [trade, onClose, onTradeUpdated]);
```

With:
```typescript
const [exitModalOpen, setExitModalOpen] = useState(false);
```

And the actions block (around line 304):

```tsx
{isOpen_ && (
  <div className="flex justify-end pt-2 border-t border-gray-700/60">
    <button
      onClick={() => setExitModalOpen(true)}
      className="rounded-md bg-red-600 px-4 py-2 text-xs font-medium text-white hover:bg-red-500 transition-colors"
    >
      Close Trade
    </button>
  </div>
)}

<ExitTradeModal
  tradeId={trade.id}
  isOpen={exitModalOpen}
  onClose={() => setExitModalOpen(false)}
  onClosed={() => {
    onTradeUpdated?.();
    onClose();
  }}
/>
```

Add the import:
```typescript
import ExitTradeModal from './ExitTradeModal';
```

- [ ] **Step 10.2: Add the entry-context display block**

Insert this block AFTER the "Strategy & Risk" grid (around line 277):

```tsx
{/* Market context at entry */}
{(trade.vixAtEntry != null ||
  trade.pcrAtEntry != null ||
  trade.spotAtEntry != null) && (
  <div className="rounded-lg border border-gray-700/60 bg-gray-800/40 p-3">
    <h3 className="text-xs font-medium text-gray-400 uppercase tracking-wide mb-2">
      Market Context @ Entry
    </h3>
    <div className="grid grid-cols-2 md:grid-cols-3 gap-3 text-xs">
      <div>
        <span className="text-[10px] text-gray-500">Spot</span>
        <p className="text-gray-200">
          {trade.spotAtEntry != null ? trade.spotAtEntry.toFixed(2) : '--'}
        </p>
      </div>
      <div>
        <span className="text-[10px] text-gray-500">VIX</span>
        <p className="text-gray-200">
          {trade.vixAtEntry != null ? trade.vixAtEntry.toFixed(2) : '--'}{' '}
          <span className="text-[10px] text-gray-500">
            ({trade.vixRegimeAtEntry ?? 'UNKNOWN'})
          </span>
        </p>
      </div>
      <div>
        <span className="text-[10px] text-gray-500">PCR</span>
        <p className="text-gray-200">
          {trade.pcrAtEntry != null ? trade.pcrAtEntry.toFixed(2) : '--'}
        </p>
      </div>
      <div>
        <span className="text-[10px] text-gray-500">Max Pain</span>
        <p className="text-gray-200">
          {trade.maxPainAtEntry != null ? trade.maxPainAtEntry.toFixed(2) : '--'}
        </p>
      </div>
      <div>
        <span className="text-[10px] text-gray-500">A/D</span>
        <p className="text-gray-200">
          {trade.adRatioAtEntry != null ? trade.adRatioAtEntry.toFixed(2) : '--'}
        </p>
      </div>
    </div>
    {trade.entryReason && (
      <div className="mt-3 pt-3 border-t border-gray-700/40">
        <span className="text-[10px] text-gray-500 uppercase tracking-wide">
          Why this trade
        </span>
        <p className="text-xs text-gray-200 mt-1">{trade.entryReason}</p>
      </div>
    )}
    {trade.entryTags && trade.entryTags.length > 0 && (
      <div className="mt-2 flex flex-wrap gap-1">
        {trade.entryTags.map((t) => (
          <span
            key={t}
            className="rounded-full border border-blue-500/30 bg-blue-500/10 px-2 py-0.5 text-[10px] text-blue-300"
          >
            {t}
          </span>
        ))}
      </div>
    )}
  </div>
)}

{/* Exit reason (closed trades only) */}
{trade.exitReasonTag && (
  <div className="rounded-lg border border-gray-700/60 bg-gray-800/40 p-3">
    <h3 className="text-xs font-medium text-gray-400 uppercase tracking-wide mb-2">
      Exit Reason
    </h3>
    <p className="text-xs text-gray-200">{trade.exitReasonTag.replace(/_/g, ' ')}</p>
    {trade.exitNotes && (
      <p className="text-xs text-gray-400 mt-1">{trade.exitNotes}</p>
    )}
  </div>
)}
```

- [ ] **Step 10.3: Commit**

```bash
git add apps/web/src/components/trading/TradeDetailModal.tsx
git commit -m "feat(web): show market context at entry + exit reason in TradeDetailModal"
```

---

## Task 11: trade-store passthrough

**Files:**
- Modify: `apps/web/src/stores/trade-store.ts`

- [ ] **Step 11.1: Find executeTrade signature**

```bash
grep -n "executeTrade" apps/web/src/stores/trade-store.ts
```

- [ ] **Step 11.2: Extend the request payload type**

Add `entryReason?: string` and `entryTags?: string[]` to the parameter type. Forward them to the existing API POST body. No other logic changes.

If the store also exposes a `closeTrade(tradeId, ...)` action, extend it similarly with `exitReasonTag` and `exitNotes`. If the close call goes directly through `api.post` from `TradeDetailModal`/`ExitTradeModal`, no store change is needed for close.

- [ ] **Step 11.3: Type-check**

```bash
cd apps/web && npx tsc --noEmit
```

Expected: no errors.

- [ ] **Step 11.4: Commit**

```bash
git add apps/web/src/stores/trade-store.ts
git commit -m "feat(web): forward entryReason+entryTags through trade-store"
```

---

## Task 12: JournalPage — new columns

**Files:**
- Modify: `apps/web/src/pages/journal/JournalPage.tsx`

- [ ] **Step 12.1: Add VIX + Regime + Tags + Exit Reason columns**

Insert these column definitions inside the `columns` array (around line 295, after the Status column and before the duration column):

```tsx
{
  key: 'vixAtEntry',
  header: 'VIX',
  align: 'right' as const,
  width: '70px',
  render: (_val, row) => {
    const t = row as unknown as Trade;
    if (t.vixAtEntry == null) return <span className="text-xs text-gray-500">--</span>;
    return (
      <div className="text-xs">
        <span className="text-gray-200">{t.vixAtEntry.toFixed(1)}</span>
        {t.vixRegimeAtEntry && (
          <span className="ml-1 text-[10px] text-gray-500">
            {t.vixRegimeAtEntry.charAt(0)}
          </span>
        )}
      </div>
    );
  },
},
{
  key: 'entryTags',
  header: 'Tags',
  width: '180px',
  render: (_val, row) => {
    const t = row as unknown as Trade;
    if (!t.entryTags || t.entryTags.length === 0) {
      return <span className="text-xs text-gray-500">--</span>;
    }
    return (
      <div className="flex flex-wrap gap-1">
        {t.entryTags.slice(0, 3).map((tag) => (
          <span
            key={tag}
            className="rounded-full border border-blue-500/30 bg-blue-500/10 px-1.5 py-0 text-[10px] text-blue-300"
          >
            {tag.replace(/_/g, ' ').toLowerCase()}
          </span>
        ))}
        {t.entryTags.length > 3 && (
          <span className="text-[10px] text-gray-500">+{t.entryTags.length - 3}</span>
        )}
      </div>
    );
  },
},
{
  key: 'exitReasonTag',
  header: 'Exit',
  width: '110px',
  render: (_val, row) => {
    const t = row as unknown as Trade;
    if (!t.exitReasonTag) return <span className="text-xs text-gray-500">--</span>;
    return (
      <span className="text-xs text-gray-300">
        {t.exitReasonTag.replace(/_/g, ' ').toLowerCase()}
      </span>
    );
  },
},
```

- [ ] **Step 12.2: Update the CSV export to include new fields**

In `handleExportCSV` (line 93), extend headers + rows:

```typescript
const headers = [
  'Date', 'Symbol', 'Side', 'Entry', 'Exit', 'Qty', 'P&L', 'P&L%',
  'Strategy', 'Type', 'Status', 'Duration',
  'VIX', 'Regime', 'PCR', 'Tags', 'Why', 'ExitReason', 'ExitNotes',
];
const rows = trades.map((t) => [
  formatDate(t.createdAt),
  t.symbol,
  t.side,
  t.entryPrice,
  t.exitPrice ?? '',
  t.quantity,
  t.pnl,
  t.pnlPercent,
  t.strategy,
  t.isPaper ? 'Paper' : 'Live',
  t.status,
  computeDuration(t.createdAt, t.closedAt),
  t.vixAtEntry ?? '',
  t.vixRegimeAtEntry ?? '',
  t.pcrAtEntry ?? '',
  (t.entryTags ?? []).join('|'),
  (t.entryReason ?? '').replace(/[\n,]/g, ' '),
  t.exitReasonTag ?? '',
  (t.exitNotes ?? '').replace(/[\n,]/g, ' '),
]);
```

- [ ] **Step 12.3: Commit**

```bash
git add apps/web/src/pages/journal/JournalPage.tsx
git commit -m "feat(web): show VIX/regime/tags/exit-reason columns in journal"
```

---

## Task 13: TradeFilters — regime + exit-reason filters

**Files:**
- Modify: `apps/web/src/components/trading/TradeFilters.tsx`
- Modify: `apps/web/src/hooks/useTradeJournal.ts` (filter state shape)
- Modify: `apps/api/src/modules/trade-engine/dto/trade.dto.ts` (extend `TradeFilterDto`)
- Modify: `apps/api/src/modules/trade-engine/repositories/trade.repository.ts` (apply filters in query)

- [ ] **Step 13.1: Extend TradeFilterDto**

In `trade.dto.ts`, add to `TradeFilterDto`:
```typescript
@IsOptional()
@IsString()
vixRegime?: string;

@IsOptional()
@IsString()
exitReasonTag?: string;
```

- [ ] **Step 13.2: Apply filters in the repository**

In `trade.repository.ts`, find the list/query method and extend the where clause:

```typescript
const where: Prisma.TradeWhereInput = {
  // ...existing filters,
  ...(filters.vixRegime && { vixRegimeAtEntry: filters.vixRegime }),
  ...(filters.exitReasonTag && { exitReasonTag: filters.exitReasonTag }),
};
```

- [ ] **Step 13.3: Update the frontend filter state + UI**

In the `TradeFilters` component, add two `<select>` controls beside the existing strategy filter:

```tsx
<select
  value={filters.vixRegime ?? ''}
  onChange={(e) => onFilterChange({ ...filters, vixRegime: e.target.value || undefined })}
  className="rounded-md border border-gray-700 bg-gray-800 px-2 py-1.5 text-xs text-gray-200"
>
  <option value="">All regimes</option>
  <option value="LOW">Low VIX</option>
  <option value="NORMAL">Normal</option>
  <option value="ELEVATED">Elevated</option>
  <option value="HIGH">High VIX</option>
</select>

<select
  value={filters.exitReasonTag ?? ''}
  onChange={(e) => onFilterChange({ ...filters, exitReasonTag: e.target.value || undefined })}
  className="rounded-md border border-gray-700 bg-gray-800 px-2 py-1.5 text-xs text-gray-200"
>
  <option value="">All exits</option>
  <option value="HIT_TARGET">Hit target</option>
  <option value="STOPPED_OUT">Stopped out</option>
  <option value="MOVED_STOP">Moved stop</option>
  <option value="PANIC_EXIT">Panic exit</option>
  <option value="TIME_EXIT">Time exit</option>
  <option value="REVERSAL_SEEN">Reversal seen</option>
  <option value="OTHER">Other</option>
</select>
```

Also extend `TradeFilters` props type to include the two new optional fields.

- [ ] **Step 13.4: Update useTradeJournal hook**

Find the hook, extend the filter state shape with `vixRegime?: string; exitReasonTag?: string;` and forward them in the API query string.

- [ ] **Step 13.5: Type-check both apps**

```bash
cd apps/api && npx tsc --noEmit && cd ../web && npx tsc --noEmit
```

Expected: no errors.

- [ ] **Step 13.6: Commit**

```bash
git add apps/api/src/modules/trade-engine/ apps/web/src/components/trading/TradeFilters.tsx apps/web/src/hooks/useTradeJournal.ts
git commit -m "feat: filter journal by VIX regime + exit reason"
```

---

## Task 14 (Stream C): End-to-end verification

**Files:** None modified — this is a manual verification step.

- [ ] **Step 14.1: Boot stack**

```bash
npm run dev
```

Wait until api, web, and ai-engine are all up.

- [ ] **Step 14.2: Place a paper trade**

In the web UI, open the Execute Trade modal:
- Select NIFTY 24APR22500CE (or any liquid symbol)
- BUY, MARKET, qty 1
- Stoploss + Target — any sensible values
- **Type a reason** ("Testing M5 capture")
- **Select 2 tag chips** (e.g. OI buildup + VWAP reclaim)
- Submit

- [ ] **Step 14.3: Verify entry context persisted**

Open Prisma Studio:
```bash
npx prisma studio
```

Find the new trade row. Confirm these fields are populated:
- `entryReason` = "Testing M5 capture"
- `entryTags` = `["OI_BUILDUP","VWAP_RECLAIM"]`
- `spotAtEntry` ≠ null
- `vixAtEntry` ≠ null (if Yahoo fetch succeeded)
- `vixRegimeAtEntry` ∈ {LOW, NORMAL, ELEVATED, HIGH, UNKNOWN}
- `pcrAtEntry`, `maxPainAtEntry`, `adRatioAtEntry` — at least one ≠ null
- `contextSnapshot` JSON populated

If `vixAtEntry` is null, check api logs — Yahoo may have rate-limited; the snapshot is tolerant of partial failures so this is acceptable but should be noted.

- [ ] **Step 14.4: Close the trade with a reason**

Click the trade in the journal → click "Close Trade" → exit-reason picker opens → pick "Hit Target" → add a note → confirm.

- [ ] **Step 14.5: Verify exit reason persisted**

In Prisma Studio, confirm:
- `exitReasonTag` = `HIT_TARGET`
- `exitNotes` = whatever was typed
- `exitTime` set
- `status` = `CLOSED`

- [ ] **Step 14.6: Verify journal display**

Reload the journal page. Confirm:
- New columns visible: VIX, Tags, Exit
- Filter by "Hit target" — only the just-closed trade appears
- Filter by VIX regime matching the captured value — same trade appears
- Click row → TradeDetailModal shows the "Market Context @ Entry" block + "Exit Reason" block
- CSV export includes the new columns

- [ ] **Step 14.7: Run the full test suite**

```bash
npm test
```

Expected: all green.

- [ ] **Step 14.8: Final commit**

If any small fix-ups were needed during verification:
```bash
git add -A
git commit -m "chore(m5): verification fix-ups"
```

---

## Self-Review Checklist (run before declaring done)

- [ ] Every Trade row created after this lands has non-null `entryReason` *or* `entryTags` (UI requirement, not DB)
- [ ] Every closed Trade row created after this lands has non-null `exitReasonTag`
- [ ] VIX fetch tolerated partial failures in M5 unit tests (network outage doesn't block trade entry)
- [ ] Filters return correct rows: regime filter, exit-reason filter
- [ ] CSV export includes the new columns and quoting handles commas/newlines in reason text
- [ ] No new TypeScript errors in either app
- [ ] No raw method-name guessing — every call to `MarketFeedService` / `OptionsChainService` matches actual public API
- [ ] No mocked/fake fills written to `contextSnapshot` — only real captured values

---

## Execution Notes

This plan has **3 streams** that can run in parallel after Task 1 (schema) lands:

- **Stream A (Backend):** Tasks 1 → 2 → 3 → 4 → 5 → 6 — sequential within stream
- **Stream B (Frontend):** Tasks 7 → 8, 9, 10 (parallel-able) → 11 → 12 → 13 — depends on Stream A's DTO from Task 4 for the closing API contract; Trade type extension (Task 7) can start as soon as Task 1 schema is committed
- **Stream C (Verify):** Task 14 — strictly after A + B complete

If dispatching subagents:
- Agent A owns Tasks 1–6 in worktree `m5-backend`
- Agent B owns Tasks 7–13 in worktree `m5-frontend` (waits on Task 1's commit on main, then branches)
- Main session owns Task 14 after both branches merge to main
