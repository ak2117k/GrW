# Chartink Scoring — NSE Lookup + RS + Robust Trend (Extensions)

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Three extensions to the Chartink scoring system shipped in `e86aa7b`:

1. **NSE Sector Index Service** — pull sector-index constituent lists from NSE's `archives.nseindia.com` (which we just verified is publicly accessible, HTTP 200 with no auth). Replaces the hardcoded ~40-symbol static map with dynamic ~150+ stock coverage.

2. **Split Sector check into Alignment (10) + Relative Strength (10)** — current sector check (20 pts) becomes two sub-checks. Alignment retains the existing logic. RS measures whether the stock is outperforming its sector over the same lookback.

3. **Robust trend definition** — replace `close > EMA20` (fragile bar-to-bar flip on wicks) with `close > EMA20 AND EMA20 slope positive over last 5 bars`. Applied to Sector, Index, and Price-vs-20-EMA checks.

Updated scoring table sums to 100:

| Check | Old pts | New pts |
|---|---|---|
| Sector direction aligned | 20 | 10 |
| **Relative strength (stock vs sector)** | — | **10 (NEW)** |
| Index aligned | 20 | 20 |
| MACD 1d | 10 | 10 |
| MACD 1m | 7 | 7 |
| MACD 5m | 8 | 8 |
| Price vs 20-EMA | 10 | 10 |
| SuperTrend match | 10 | 10 |
| S/R room | 10 | 10 |
| Volume confirmation | 5 | 5 |
| **Total** | 100 | **100** |

Lot bands unchanged (sums stays at 100).

**Spec reference:** `docs/superpowers/specs/2026-05-12-chartink-scoring-and-lot-sizing-design.md` (the original scoring spec).

---

## Pre-flight

- [ ] **Step 0.1: Confirm pre-existing tests still pass**

```bash
cd C:/Users/AryanKumar/Desktop/TD_Automation/apps/api && npx jest src/modules/chartink/services/chartink-scoring.service.spec.ts 2>&1 | tail -5
```
Expected: 12 tests pass (the existing scoring spec, with old check semantics).

These tests will be UPDATED in this plan to match the new semantics. We don't break the old test file — we update the assertions where appropriate.

---

## Task A: `NseSectorIndexService` + daily refresh

**Files:**
- Create: `apps/api/src/modules/market-data/services/nse-sector-index.service.ts`
- Create: `apps/api/src/modules/market-data/services/nse-sector-index.service.spec.ts`
- Modify: `apps/api/src/modules/market-data/market-data.module.ts` (register service)

### Step A.1: Service skeleton

Create `apps/api/src/modules/market-data/services/nse-sector-index.service.ts`:

```typescript
import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { HttpService } from '@nestjs/axios';
import { Cron, CronExpression } from '@nestjs/schedule';
import { firstValueFrom } from 'rxjs';
import { SECTOR_INDICES } from '@td/shared/constants';

/**
 * Maps sector-index name (lower-case, no spaces) to NSE archives CSV slug.
 * URL pattern: https://archives.nseindia.com/content/indices/ind_<slug>.csv
 *
 * Verified accessible 2026-05-12: HTTP 200 for all 9 below.
 * Other indices we'd want (PSU BANK, PVT BANK, FIN SERVICE, HEALTHCARE,
 * CONSUMER) have less-stable URL slugs; if a fetch 404s we skip silently.
 */
const SECTOR_CSV_SLUGS: Record<string, string> = {
  '99926009': 'niftybanklist',
  '99926013': 'niftyitlist',
  '99926015': 'niftyfmcglist',
  '99926017': 'niftypharmalist',
  '99926019': 'niftyenergylist',
  '99926021': 'niftyautolist',
  '99926023': 'niftymetallist',
  '99926027': 'niftyrealtylist',
  '99926029': 'niftyinfralist',
  '99926031': 'niftymedialist',
  '99926033': 'niftypsubanklist',
  '99926035': 'niftyprivatebanklist',
  '99926011': 'niftyfinancelist',
  '99926041': 'niftyhealthcarelist',
  '99926039': 'niftyconsumerdurableslist',
};

/**
 * Hardcoded fallback used if NSE fetches all fail (boot before first
 * refresh, NSE down, network blocked). Copied from the previous static
 * map in chartink-scoring.service.ts so behavior degrades gracefully.
 */
const STATIC_FALLBACK: Record<string, string> = {
  HDFCBANK: '99926009', ICICIBANK: '99926009', SBIN: '99926009', AXISBANK: '99926009',
  KOTAKBANK: '99926009', INDUSINDBK: '99926009', BAJFINANCE: '99926011',
  TCS: '99926013', INFY: '99926013', WIPRO: '99926013', HCLTECH: '99926013',
  TECHM: '99926013', LTIM: '99926013',
  MARUTI: '99926021', TATAMOTORS: '99926021', M_M: '99926021', BAJAJ_AUTO: '99926021',
  RELIANCE: '99926019', ONGC: '99926019', GAIL: '99926019', BPCL: '99926019',
  IOC: '99926019', HINDPETRO: '99926019', NTPC: '99926019', POWERGRID: '99926019',
  TATASTEEL: '99926023', HINDALCO: '99926023', JSWSTEEL: '99926023',
  VEDL: '99926023', HINDCOPPER: '99926023', HINDZINC: '99926023',
  SUNPHARMA: '99926017', DIVISLAB: '99926017', DRREDDY: '99926017', CIPLA: '99926017',
  HINDUNILVR: '99926015', ITC: '99926015', NESTLEIND: '99926015', BRITANNIA: '99926015',
};

@Injectable()
export class NseSectorIndexService implements OnModuleInit {
  private readonly logger = new Logger(NseSectorIndexService.name);
  private symbolToSector: Map<string, string> = new Map();
  private lastRefreshAt: Date | null = null;

  constructor(private readonly http: HttpService) {}

  async onModuleInit() {
    // Don't block startup — fetch async, fall back to static if it takes time.
    this.refresh().catch((err) => {
      this.logger.warn(`Initial sector refresh failed: ${err instanceof Error ? err.message : err}`);
    });
  }

  /** Cron at 06:00 IST daily (00:30 UTC) — well before market open. */
  @Cron('30 0 * * 1-5')
  async dailyRefresh() {
    this.logger.log('Daily NSE sector-index refresh triggered');
    await this.refresh();
  }

  /**
   * Manually trigger a refresh. Returns count of symbols loaded.
   * Public for ops endpoints + tests.
   */
  async refresh(): Promise<number> {
    const fresh = new Map<string, string>();
    let okCount = 0;
    let failCount = 0;

    for (const [sectorToken, slug] of Object.entries(SECTOR_CSV_SLUGS)) {
      try {
        const symbols = await this.fetchSectorConstituents(slug);
        for (const sym of symbols) {
          fresh.set(sym.toUpperCase(), sectorToken);
        }
        okCount++;
      } catch (err) {
        failCount++;
        this.logger.warn(`NSE ${slug}: ${err instanceof Error ? err.message : err}`);
      }
    }

    if (fresh.size === 0) {
      this.logger.warn(`NSE refresh got 0 symbols — keeping previous map (${this.symbolToSector.size} entries)`);
      return 0;
    }

    this.symbolToSector = fresh;
    this.lastRefreshAt = new Date();
    this.logger.log(`NSE refresh: ${fresh.size} symbols across ${okCount} sectors (${failCount} sectors unreachable)`);
    return fresh.size;
  }

  /**
   * Look up sector index token for a stock symbol. Returns null if not found.
   * Bare-symbol lookup (case-insensitive). Strips series suffixes like -EQ/-BE
   * before matching, since Chartink sends bare names.
   */
  getSectorIndexForSymbol(symbol: string): string | null {
    if (!symbol) return null;
    const bare = symbol.toUpperCase().replace(/-(EQ|BE|BL|IV|RL)$/, '');
    // Try dynamic map first, then static fallback
    return this.symbolToSector.get(bare) ?? STATIC_FALLBACK[bare] ?? null;
  }

  /** For ops/admin endpoints. */
  getStats(): { count: number; lastRefreshAt: Date | null } {
    return { count: this.symbolToSector.size, lastRefreshAt: this.lastRefreshAt };
  }

  private async fetchSectorConstituents(slug: string): Promise<string[]> {
    const url = `https://archives.nseindia.com/content/indices/ind_${slug}.csv`;
    const response = await firstValueFrom(
      this.http.get<string>(url, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
          Accept: 'text/csv,*/*',
        },
        responseType: 'text',
        timeout: 15_000,
      }),
    );
    return this.parseConstituentsCsv(response.data);
  }

  /**
   * Parse NSE's constituent CSV. Format (verified 2026-05-12):
   *   Company Name,Industry,Symbol,Series,ISIN Code
   *   Infosys Ltd.,Information Technology,INFY,EQ,INE009A01021
   *   ...
   * Returns the list of `Symbol` values.
   */
  private parseConstituentsCsv(csv: string): string[] {
    const lines = csv.split('\n').map((l) => l.trim()).filter(Boolean);
    if (lines.length < 2) return [];
    const headerCols = lines[0].split(',').map((h) => h.trim().toLowerCase());
    const symbolIdx = headerCols.findIndex((c) => c === 'symbol');
    if (symbolIdx < 0) return [];
    const symbols: string[] = [];
    for (let i = 1; i < lines.length; i++) {
      const cols = this.parseCsvLine(lines[i]);
      if (cols.length > symbolIdx && cols[symbolIdx]) {
        symbols.push(cols[symbolIdx].trim());
      }
    }
    return symbols;
  }

  /** Minimal CSV line parser handling quoted fields (company names contain commas). */
  private parseCsvLine(line: string): string[] {
    const out: string[] = [];
    let cur = '';
    let inQuotes = false;
    for (const ch of line) {
      if (ch === '"') inQuotes = !inQuotes;
      else if (ch === ',' && !inQuotes) {
        out.push(cur);
        cur = '';
      } else cur += ch;
    }
    out.push(cur);
    return out;
  }
}
```

### Step A.2: Spec file

Create `apps/api/src/modules/market-data/services/nse-sector-index.service.spec.ts`:

```typescript
import { Test } from '@nestjs/testing';
import { HttpService } from '@nestjs/axios';
import { of, throwError } from 'rxjs';
import { NseSectorIndexService } from './nse-sector-index.service';

const NIFTY_IT_CSV = `Company Name,Industry,Symbol,Series,ISIN Code
Infosys Ltd.,Information Technology,INFY,EQ,INE009A01021
HCL Technologies Ltd.,Information Technology,HCLTECH,EQ,INE860A01027
Wipro Ltd.,Information Technology,WIPRO,EQ,INE075A01022`;

const NIFTY_BANK_CSV = `Company Name,Industry,Symbol,Series,ISIN Code
HDFC Bank Ltd.,Financial Services,HDFCBANK,EQ,INE040A01034
ICICI Bank Ltd.,Financial Services,ICICIBANK,EQ,INE090A01021`;

describe('NseSectorIndexService', () => {
  let service: NseSectorIndexService;
  let mockHttp: { get: jest.Mock };

  beforeEach(async () => {
    mockHttp = { get: jest.fn() };
    const module = await Test.createTestingModule({
      providers: [NseSectorIndexService, { provide: HttpService, useValue: mockHttp }],
    }).compile();
    module.useLogger(false);
    service = module.get(NseSectorIndexService);
  });

  it('parses NSE CSV correctly', async () => {
    mockHttp.get.mockReturnValue(of({ data: NIFTY_IT_CSV }));
    await service.refresh();
    expect(service.getSectorIndexForSymbol('INFY')).toBe('99926013');
    expect(service.getSectorIndexForSymbol('HCLTECH')).toBe('99926013');
    expect(service.getSectorIndexForSymbol('WIPRO')).toBe('99926013');
  });

  it('handles multiple sector CSVs (IT and BANK)', async () => {
    mockHttp.get.mockImplementation((url: string) => {
      if (url.includes('niftyitlist')) return of({ data: NIFTY_IT_CSV });
      if (url.includes('niftybanklist')) return of({ data: NIFTY_BANK_CSV });
      return throwError(() => new Error('404'));
    });
    await service.refresh();
    expect(service.getSectorIndexForSymbol('INFY')).toBe('99926013');
    expect(service.getSectorIndexForSymbol('HDFCBANK')).toBe('99926009');
  });

  it('returns null for unknown symbols (no static fallback match either)', async () => {
    mockHttp.get.mockReturnValue(of({ data: NIFTY_IT_CSV }));
    await service.refresh();
    expect(service.getSectorIndexForSymbol('UNKNOWNSTOCK')).toBeNull();
  });

  it('strips series suffixes from symbol lookup', async () => {
    mockHttp.get.mockReturnValue(of({ data: NIFTY_IT_CSV }));
    await service.refresh();
    expect(service.getSectorIndexForSymbol('INFY-EQ')).toBe('99926013');
    expect(service.getSectorIndexForSymbol('INFY-BE')).toBe('99926013');
  });

  it('falls back to static map when all NSE fetches fail', async () => {
    mockHttp.get.mockReturnValue(throwError(() => new Error('NSE timeout')));
    await service.refresh();
    // Dynamic map empty; static fallback should still cover RELIANCE
    expect(service.getSectorIndexForSymbol('RELIANCE')).toBe('99926019');
  });

  it('preserves previous map on a partial-failure refresh (0 symbols loaded)', async () => {
    mockHttp.get.mockReturnValueOnce(of({ data: NIFTY_IT_CSV }));
    await service.refresh(); // first refresh succeeds
    expect(service.getSectorIndexForSymbol('INFY')).toBe('99926013');

    // Subsequent refresh: all fetches throw
    mockHttp.get.mockReturnValue(throwError(() => new Error('NSE down')));
    await service.refresh();
    expect(service.getSectorIndexForSymbol('INFY')).toBe('99926013'); // still cached
  });

  it('reports stats including lastRefreshAt', async () => {
    mockHttp.get.mockReturnValue(of({ data: NIFTY_IT_CSV }));
    expect(service.getStats().count).toBe(0);
    expect(service.getStats().lastRefreshAt).toBeNull();
    await service.refresh();
    expect(service.getStats().count).toBeGreaterThan(0);
    expect(service.getStats().lastRefreshAt).toBeInstanceOf(Date);
  });
});
```

### Step A.3: Register in market-data module

Modify `apps/api/src/modules/market-data/market-data.module.ts`:
- Add `NseSectorIndexService` to providers array
- Add `NseSectorIndexService` to exports array (so chartink module can inject it)
- Add the import at top

If the module doesn't yet import `HttpModule` from `@nestjs/axios`, add it to the imports array. If it doesn't yet have `ScheduleModule.forRoot()` somewhere in the app, the `@Cron` decorator won't fire — but that's an app-level wiring issue (`apps/api/src/app.module.ts` likely already has it for other cron jobs).

### Step A.4: Run tests + commit

```bash
cd C:/Users/AryanKumar/Desktop/TD_Automation/apps/api && npx jest src/modules/market-data/services/nse-sector-index.service.spec.ts 2>&1 | tail -15
```
Expected: 7 tests pass.

```bash
git add apps/api/src/modules/market-data/services/nse-sector-index.service.ts \
        apps/api/src/modules/market-data/services/nse-sector-index.service.spec.ts \
        apps/api/src/modules/market-data/market-data.module.ts
git -c commit.gpgsign=false commit -m "feat(market-data): NseSectorIndexService — NSE constituent CSV ingestion"
```

---

## Task B: Update ChartinkScoringService — NSE lookup + sector split + RS + robust trend

**Files:**
- Modify: `apps/api/src/modules/chartink/services/chartink-scoring.service.ts`
- Modify: `apps/api/src/modules/chartink/services/chartink-scoring.service.spec.ts`
- Modify: `apps/api/src/modules/chartink/chartink.module.ts` (no change if already imports market-data — verify)

### Step B.1: Wire NseSectorIndexService into the constructor

Update the imports + constructor:

```typescript
import { NseSectorIndexService } from '../../market-data/services/nse-sector-index.service';

// in @Injectable() class:
constructor(
  private readonly adapter: AngelOneAdapterService,
  private readonly nseSectors: NseSectorIndexService,  // NEW
) {}
```

### Step B.2: Remove the hardcoded STOCK_TO_SECTOR_INDEX map

Delete the `STOCK_TO_SECTOR_INDEX` constant entirely. It's superseded by `NseSectorIndexService` (which has its own static fallback for offline cases).

### Step B.3: Add the robust trend helper

At the bottom of the file (or as a private method on the service), add a helper that combines the two trend conditions:

```typescript
/**
 * Robust trend check: returns 'UP' / 'DOWN' / 'INDETERMINATE'.
 *   - UP requires: close > EMA20 AND EMA20[now] > EMA20[5 bars ago]
 *   - DOWN requires: close < EMA20 AND EMA20[now] < EMA20[5 bars ago]
 *   - Anything else → INDETERMINATE (line wandering or price hovering at EMA)
 *
 * Returns the EMA values too for diagnostic display.
 */
private classifyTrend(closes: number[]): {
  direction: 'UP' | 'DOWN' | 'INDETERMINATE';
  closeLast: number;
  emaNow: number | null;
  emaThen: number | null;
} | null {
  if (closes.length < 26) return null; // need 20 for EMA + 5 lookback + buffer
  const emaNow = ema(closes, 20);
  const emaThen = ema(closes.slice(0, -5), 20);
  if (emaNow === null || emaThen === null) return null;
  const closeLast = closes[closes.length - 1];
  if (closeLast > emaNow && emaNow > emaThen) {
    return { direction: 'UP', closeLast, emaNow, emaThen };
  }
  if (closeLast < emaNow && emaNow < emaThen) {
    return { direction: 'DOWN', closeLast, emaNow, emaThen };
  }
  return { direction: 'INDETERMINATE', closeLast, emaNow, emaThen };
}
```

### Step B.4: Update `checkSectorAligned` — now worth 10 pts, uses NSE lookup, uses robust trend

```typescript
private async checkSectorAligned(input: ScoringInput): Promise<ScoreCheckResult> {
  const name = 'Sector aligned';
  const pointsPossible = 10;  // was 20
  const sectorToken = this.nseSectors.getSectorIndexForSymbol(input.symbol);
  if (!sectorToken) {
    return { name, points: 0, pointsPossible, passed: false, detail: { reason: 'no sector mapping' } };
  }
  try {
    const candles = await this.fetch15mCandles(sectorToken, 'NSE', 30);
    const closes = candles.map((c) => c.close);
    const trend = this.classifyTrend(closes);
    if (!trend) {
      return { name, points: 0, pointsPossible, passed: false, detail: { reason: 'insufficient sector candles' } };
    }
    const expected = input.side === 'BUY' ? 'UP' : 'DOWN';
    const passed = trend.direction === expected;
    return {
      name, points: passed ? pointsPossible : 0, pointsPossible, passed,
      detail: {
        sectorToken,
        sectorTrend: trend.direction,
        closeLast: trend.closeLast,
        emaNow: trend.emaNow,
        emaThen: trend.emaThen,
      },
    };
  } catch (err) {
    return { name, points: 0, pointsPossible, passed: false, detail: { error: errMsg(err) } };
  }
}
```

### Step B.5: Add new `checkRelativeStrength` — NEW 10 pts

```typescript
/**
 * Relative strength of stock vs its sector over 20 × 15m bars (~5 hours).
 *   stockReturn = (stock.close[now] - stock.close[then]) / stock.close[then]
 *   sectorReturn = same for sector
 *   RS = stockReturn - sectorReturn   (additive RS, in fractional units)
 *
 * BUY passes if RS > 0 (stock outperforming sector).
 * SELL passes if RS < 0 (stock underperforming sector).
 */
private async checkRelativeStrength(input: ScoringInput): Promise<ScoreCheckResult> {
  const name = 'Relative strength';
  const pointsPossible = 10;
  const sectorToken = this.nseSectors.getSectorIndexForSymbol(input.symbol);
  if (!sectorToken) {
    return { name, points: 0, pointsPossible, passed: false, detail: { reason: 'no sector mapping' } };
  }
  try {
    const lookback = 20;  // bars
    const stockCandles = await this.fetch15mCandles(input.token, input.exchange, lookback + 2);
    const sectorCandles = await this.fetch15mCandles(sectorToken, 'NSE', lookback + 2);
    if (stockCandles.length < lookback || sectorCandles.length < lookback) {
      return { name, points: 0, pointsPossible, passed: false, detail: { reason: 'insufficient candles' } };
    }
    const sNow = stockCandles[stockCandles.length - 1].close;
    const sThen = stockCandles[stockCandles.length - lookback].close;
    const iNow = sectorCandles[sectorCandles.length - 1].close;
    const iThen = sectorCandles[sectorCandles.length - lookback].close;
    if (sThen === 0 || iThen === 0) {
      return { name, points: 0, pointsPossible, passed: false, detail: { reason: 'zero baseline' } };
    }
    const stockReturn = (sNow - sThen) / sThen;
    const sectorReturn = (iNow - iThen) / iThen;
    const rs = stockReturn - sectorReturn;
    const passed = input.side === 'BUY' ? rs > 0 : rs < 0;
    return {
      name, points: passed ? pointsPossible : 0, pointsPossible, passed,
      detail: {
        stockReturn: +(stockReturn * 100).toFixed(2),
        sectorReturn: +(sectorReturn * 100).toFixed(2),
        rs: +(rs * 100).toFixed(2),
        lookbackBars: lookback,
      },
    };
  } catch (err) {
    return { name, points: 0, pointsPossible, passed: false, detail: { error: errMsg(err) } };
  }
}
```

### Step B.6: Update `checkIndexAligned` — uses robust trend (still 20 pts)

```typescript
private async checkIndexAligned(input: ScoringInput): Promise<ScoreCheckResult> {
  const name = 'Index aligned';
  const pointsPossible = 20;
  if (input.token === NIFTY_TOKEN) {
    return { name, points: 0, pointsPossible, passed: false, detail: { reason: 'setup is on the index itself' } };
  }
  try {
    const candles = await this.fetch15mCandles(NIFTY_TOKEN, NIFTY_EXCHANGE, 30);
    const closes = candles.map((c) => c.close);
    const trend = this.classifyTrend(closes);
    if (!trend) {
      return { name, points: 0, pointsPossible, passed: false, detail: { reason: 'insufficient nifty candles' } };
    }
    const expected = input.side === 'BUY' ? 'UP' : 'DOWN';
    const passed = trend.direction === expected;
    return {
      name, points: passed ? pointsPossible : 0, pointsPossible, passed,
      detail: {
        niftyTrend: trend.direction,
        closeLast: trend.closeLast,
        emaNow: trend.emaNow,
        emaThen: trend.emaThen,
      },
    };
  } catch (err) {
    return { name, points: 0, pointsPossible, passed: false, detail: { error: errMsg(err) } };
  }
}
```

### Step B.7: Update `checkPriceVs20Ema` — uses robust trend

```typescript
private async checkPriceVs20Ema(input: ScoringInput): Promise<ScoreCheckResult> {
  const name = 'Price vs 20-EMA';
  const pointsPossible = 10;
  try {
    const candles = await this.fetch15mCandles(input.token, input.exchange, 30);
    const closes = candles.map((c) => c.close);
    const trend = this.classifyTrend(closes);
    if (!trend) {
      return { name, points: 0, pointsPossible, passed: false, detail: { reason: 'insufficient candles' } };
    }
    const expected = input.side === 'BUY' ? 'UP' : 'DOWN';
    const passed = trend.direction === expected;
    return {
      name, points: passed ? pointsPossible : 0, pointsPossible, passed,
      detail: {
        trend: trend.direction,
        closeLast: trend.closeLast,
        emaNow: trend.emaNow,
        emaThen: trend.emaThen,
      },
    };
  } catch (err) {
    return { name, points: 0, pointsPossible, passed: false, detail: { error: errMsg(err) } };
  }
}
```

### Step B.8: Update the main `score()` method to call the new check

In the `score()` method's body, add `checkRelativeStrength` after `checkSectorAligned`:

```typescript
async score(input: ScoringInput): Promise<ScoringResult> {
  const checks: ScoreCheckResult[] = [];
  checks.push(await this.checkSectorAligned(input));
  await this.sleep(350);
  checks.push(await this.checkRelativeStrength(input));   // NEW
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
```

Total: now 10 checks (was 9). Total points still 100 (sector 10 + RS 10 + index 20 + 4 MACD = 35 + Price/EMA 10 + ST 10 + SR 10 + Vol 5 = 100). ✓

### Step B.9: Update tests

In `chartink-scoring.service.spec.ts`:

1. Inject the new dependency:
   ```typescript
   const mockNseSectors = {
     getSectorIndexForSymbol: jest.fn((sym: string) => {
       if (sym.toUpperCase() === 'RELIANCE') return '99926019';
       return null;
     }),
   };
   // in providers:
   { provide: NseSectorIndexService, useValue: mockNseSectors },
   ```

2. Update existing tests' EXPECTED CHECK COUNT from 9 to 10.

3. Update existing tests' expectations where they assert on sector points — the sector check is now worth 10 (was 20).

4. Add new tests specifically for `checkRelativeStrength`:
   - BUY with stock outperforming → passes
   - BUY with stock underperforming → fails
   - No sector mapping → fails with `reason: 'no sector mapping'`

5. Add tests for the robust trend logic:
   - `classifyTrend` returns UP when both conditions met
   - Returns INDETERMINATE when EMA20 flat (`emaNow ≈ emaThen`)
   - Returns INDETERMINATE when close on wrong side of EMA

### Step B.10: Run tests + commit

```bash
cd C:/Users/AryanKumar/Desktop/TD_Automation/apps/api && npx jest src/modules/chartink/services/chartink-scoring.service.spec.ts 2>&1 | tail -25
```

```bash
git add apps/api/src/modules/chartink/services/chartink-scoring.service.ts \
        apps/api/src/modules/chartink/services/chartink-scoring.service.spec.ts \
        apps/api/src/modules/chartink/chartink.module.ts
git -c commit.gpgsign=false commit -m "feat(chartink): NSE sector lookup + Relative Strength check + robust trend"
```

---

## Task C: Live verification + smoke test

- [ ] **Step C.1: Trigger nest --watch reload**

```bash
cd C:/Users/AryanKumar/Desktop/TD_Automation && touch -c apps/api/src/main.ts
until curl -s http://127.0.0.1:4001/api/market-data/status --max-time 3 | grep -q feedActive; do sleep 2; done
echo "API up"
```

- [ ] **Step C.2: Verify NseSectorIndexService is populated post-boot**

The service auto-refreshes on `onModuleInit`. Wait ~30 seconds for the 9 sector CSVs to fetch, then probe via the score-preview endpoint:

```bash
sleep 30
SECRET=$(grep '^CHARTINK_WEBHOOK_SECRET=' .env | cut -d= -f2-)
# Score a stock that was NOT in the static map (e.g., COFORGE — recently added IT)
curl -sS -X POST "http://127.0.0.1:4001/api/chartink/debug/score-preview" -H "Content-Type: application/json" --data-binary '{"token":"11543","symbol":"COFORGE","exchange":"NSE","side":"BUY","entryPrice":2000}' --max-time 90
```

Expected: sector check passes/fails with `sectorToken: '99926013'` (NIFTY IT), not `reason: 'no sector mapping'`. (Token 11543 is COFORGE on NSE per the master.)

- [ ] **Step C.3: Re-test HDFCBANK SELL with new sector + RS logic**

```bash
curl -sS -X POST "http://127.0.0.1:4001/api/chartink/debug/score-preview" -H "Content-Type: application/json" --data-binary '{"token":"1333","symbol":"HDFCBANK","exchange":"NSE","side":"SELL","entryPrice":1700}' --max-time 90
```

Expected breakdown contains BOTH `Sector aligned` (10 pts max) and `Relative strength` (10 pts max). Score should be in a similar range to before (~55-65) since sector still aligned + index still aligned for SELL.

- [ ] **Step C.4: Manual UI check**

Open http://localhost:4000/chartink — the score breakdown table on any setup with a score should now show 10 checks (was 9). No frontend changes needed because the table renders dynamic check arrays.

---

## Done criteria

- `NseSectorIndexService` loads at least 100+ symbols across 9 NIFTY sector indices on boot.
- `checkSectorAligned` (10 pts) uses the dynamic lookup; falls back gracefully if NSE is unreachable.
- `checkRelativeStrength` (10 pts NEW) compares stock's 20-bar return vs sector's 20-bar return.
- `classifyTrend` helper used by Sector / Index / Price-vs-20-EMA checks — eliminates fragile single-bar flips.
- Total points still 100; lot bands unchanged.
- All existing tests pass + new tests for NseSectorIndexService and the new check.
- Live score-preview shows real `sectorTrend: UP|DOWN|INDETERMINATE` and `rs: <number>` in the detail.

## Out of scope

- Frontend changes — none needed; breakdown table renders dynamic check lists.
- Updating the original scoring spec doc — leave as-is; this plan is the source of truth for the extensions.
- Industry-level granularity (banking-vs-NBFC etc.) — that's a v3 idea using the `Industry` column from NSE CSVs.
- Backfilling existing alerts with new scores — only new fires get scored under the new logic.
