// apps/api/src/modules/chartink/services/chartink-scoring.service.spec.ts
import { Test, type TestingModule } from '@nestjs/testing';
import { ChartinkScoringService, type ScoringInput, type ScoringCandleSource } from './chartink-scoring.service';
import { AngelOneAdapterService } from '../../market-data/services/angel-one-adapter.service';
import { NseSectorIndexService } from '../../market-data/services/nse-sector-index.service';
import { macd } from '../../signal-generator/strategies/indicators';

describe('ChartinkScoringService', () => {
  let service: ChartinkScoringService;
  let mockAdapter: { getHistoricalData: jest.Mock };
  let mockNseSectors: { getSectorIndexForSymbol: jest.Mock };

  beforeEach(async () => {
    mockAdapter = { getHistoricalData: jest.fn() };
    mockNseSectors = {
      getSectorIndexForSymbol: jest.fn((sym: string) => {
        const map: Record<string, string> = {
          RELIANCE: '99926019',
          TCS: '99926013',
          HDFCBANK: '99926009',
        };
        return Promise.resolve(map[sym.toUpperCase()] ?? null);
      }),
    };
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ChartinkScoringService,
        { provide: AngelOneAdapterService, useValue: mockAdapter },
        { provide: NseSectorIndexService, useValue: mockNseSectors },
      ],
    }).compile();
    module.useLogger(false);
    service = module.get(ChartinkScoringService);
    (service as unknown as { sleep: (ms: number) => Promise<void> }).sleep = () => Promise.resolve();
  });

  describe('scoreToLotCount', () => {
    it.each([
      [0, 0], [41, 0], [42, 1], [59, 1], [60, 2], [74, 2], [75, 3], [100, 3],
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
    function flat(n: number, price: number) {
      return Array.from({ length: n }, (_, i) => ({
        timestamp: new Date(Date.UTC(2026, 4, 12, 0, i * 5)),
        open: price, high: price + 0.1, low: price - 0.1,
        close: price, volume: 1000,
      }));
    }

    it('all checks rising → 15 checks emitted (10 scored + 5 observability)', async () => {
      // 400 bars: enough warm-up for the MACD checks (>=120) and the 5m
      // SuperTrend check (>=120) to converge on this fixture.
      mockAdapter.getHistoricalData.mockResolvedValue(rising(400, 100, 0.5));
      const result = await service.score(baseInput);
      // The new table has 15 checks. Under the new weighting the 5 historical
      // gates are observability-only (pointsPossible=0). On a constant-slope
      // ramp the MACD line equals the signal line exactly (flat histogram →
      // neither strictly green nor red), so all three MACD factors fail. The
      // 9/20 EMA-cross still passes (3 pts). RSI on a steep ramp pegs near
      // 100 — outside [45,70] → fails. ADX on a clean ramp gets the
      // direction right and trips above 22 → passes (12 pts). ATR/price on a
      // ramp that runs 100→300 with step 0.5: ATR ≈ 1 → atrPct ≈ 0.0005,
      // well below 0.004 → fails. Breakout: entry 2880 >> max-high 300 →
      // ratio >> 0.98 → passes (5 pts). VWAP / Volume use today's session
      // window (now - 9h); the fixture timestamps are from 2026-04-12 → no
      // session candles → both fail (data-starved). Net floor ≈ 3 + 12 + 5
      // = 20 pts. Make the assertion a meaningful lower bound.
      expect(result.checks.length).toBe(15);
      expect(result.score).toBeGreaterThanOrEqual(15);
    });

    it('all checks falling on BUY setup → low score', async () => {
      mockAdapter.getHistoricalData.mockResolvedValue(falling(60, 100, 0.5));
      const result = await service.score(baseInput);
      expect(result.checks.length).toBe(15);
      expect(result.score).toBeLessThan(42);
      expect(result.lotCount).toBe(0);
    });

    it('symbol with no sector mapping → sector + RS checks fail with reason', async () => {
      mockAdapter.getHistoricalData.mockResolvedValue(rising(60, 100, 0.5));
      const input: ScoringInput = { ...baseInput, symbol: 'UNKNOWNSTOCK' };
      const result = await service.score(input);
      const sectorCheck = result.checks.find((c) => c.name === 'Sector aligned');
      expect(sectorCheck?.passed).toBe(false);
      expect(sectorCheck?.detail?.reason).toBe('no sector mapping');
      const rsCheck = result.checks.find((c) => c.name === 'Relative strength');
      expect(rsCheck?.passed).toBe(false);
      expect(rsCheck?.detail?.reason).toBe('no sector mapping');
    });

    it('does NOT sleep unconditionally — relies on the adapter pacer (FIX 1)', async () => {
      // FIX 1: the ~14 hardcoded sleep(350) between checks are removed; the
      // adapter's global serializeHistoricalCall already enforces 3 req/sec.
      // Spy on the real sleep helper (NOT the no-op stub the suite installs)
      // and assert score() never calls it.
      const sleepSpy = jest.fn(() => Promise.resolve());
      (service as unknown as { sleep: (ms: number) => Promise<void> }).sleep = sleepSpy;
      mockAdapter.getHistoricalData.mockResolvedValue(rising(400, 100, 0.5));
      await service.score(baseInput);
      expect(sleepSpy).not.toHaveBeenCalled();
    });

    it('broker throws for first check → that check fails but others continue', async () => {
      // First call throws (sector check), rest succeed
      mockAdapter.getHistoricalData
        .mockRejectedValueOnce(new Error('Angel timeout'))
        .mockResolvedValue(rising(60, 100, 0.5));
      const result = await service.score(baseInput);
      expect(result.checks.length).toBe(15);
      const sector = result.checks.find((c) => c.name === 'Sector aligned');
      expect(sector?.detail?.error).toBe('Angel timeout');
    });
  });

  describe('checkRelativeStrength', () => {
    const buyInput: ScoringInput = {
      token: '2885', symbol: 'RELIANCE', exchange: 'NSE', side: 'BUY',
      entryPrice: 2880, setupContext: null,
    };
    const sellInput: ScoringInput = { ...buyInput, side: 'SELL' };

    function rising(n: number, start: number, step: number) {
      return Array.from({ length: n }, (_, i) => ({
        timestamp: new Date(Date.UTC(2026, 4, 12, 0, i * 5)),
        open: start + i * step, high: start + i * step + 0.5, low: start + i * step - 0.5,
        close: start + i * step + 0.25, volume: 1000 + i * 50,
      }));
    }

    it('BUY: stock outperforming sector → RS check passes (observability-only, 0 pts)', async () => {
      // Stock rises faster (step 1.0) than sector (step 0.2)
      // RELIANCE token = '2885', sector token = '99926019' (NIFTY ENERGY)
      const stockBars = rising(30, 100, 1.0);
      const sectorBars = rising(30, 100, 0.2);
      mockAdapter.getHistoricalData.mockImplementation(
        (token: string) => Promise.resolve(token === '2885' ? stockBars : sectorBars),
      );
      // Call checkRelativeStrength directly via the private path through score()
      // — but we only want to verify the RS check specifically.
      const result = await service.score(buyInput);
      const rs = result.checks.find((c) => c.name === 'Relative strength');
      expect(rs?.passed).toBe(true);
      // Observability-only: pointsPossible is 0 so a pass also awards 0.
      expect(rs?.points).toBe(0);
      expect(rs?.pointsPossible).toBe(0);
      expect((rs?.detail?.rs as number)).toBeGreaterThan(0);
    });

    it('BUY: stock underperforming sector → RS check fails', async () => {
      // Stock rises slower (step 0.1) than sector (step 1.0)
      const stockBars = rising(30, 100, 0.1);
      const sectorBars = rising(30, 100, 1.0);
      mockAdapter.getHistoricalData.mockImplementation(
        (token: string) => Promise.resolve(token === '2885' ? stockBars : sectorBars),
      );
      const result = await service.score(buyInput);
      const rs = result.checks.find((c) => c.name === 'Relative strength');
      expect(rs?.passed).toBe(false);
      expect(rs?.points).toBe(0);
      expect((rs?.detail?.rs as number)).toBeLessThan(0);
    });

    it('SELL: stock underperforming sector → RS check passes (observability-only, 0 pts)', async () => {
      // Stock rises slower than sector — stock is relatively weak → SELL passes
      const stockBars = rising(30, 100, 0.1);
      const sectorBars = rising(30, 100, 1.0);
      mockAdapter.getHistoricalData.mockImplementation(
        (token: string) => Promise.resolve(token === '2885' ? stockBars : sectorBars),
      );
      const result = await service.score(sellInput);
      const rs = result.checks.find((c) => c.name === 'Relative strength');
      expect(rs?.passed).toBe(true);
      // Observability-only.
      expect(rs?.points).toBe(0);
      expect(rs?.pointsPossible).toBe(0);
    });

    it('no sector mapping → RS check fails with reason: "no sector mapping"', async () => {
      mockAdapter.getHistoricalData.mockResolvedValue(rising(30, 100, 0.5));
      const input: ScoringInput = { ...buyInput, symbol: 'UNKNOWNSTOCK' };
      const result = await service.score(input);
      const rs = result.checks.find((c) => c.name === 'Relative strength');
      expect(rs?.passed).toBe(false);
      expect(rs?.detail?.reason).toBe('no sector mapping');
    });
  });

  describe('EMA9 over EMA20 check', () => {
    const buyInput: ScoringInput = {
      token: '2885', symbol: 'RELIANCE', exchange: 'NSE', side: 'BUY',
      entryPrice: 2880, setupContext: null,
    };
    const sellInput: ScoringInput = { ...buyInput, side: 'SELL' };

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

    it('rising closes → EMA9 > EMA20 → BUY passes (3 pts), SELL fails', async () => {
      // On a rising series the shorter 9-EMA lags less than the 20-EMA,
      // so EMA9 sits above EMA20 → BUY passes, SELL fails.
      mockAdapter.getHistoricalData.mockResolvedValue(rising(60, 100, 0.5));
      const buyResult = await service.score(buyInput);
      const buyCheck = buyResult.checks.find((c) => c.name === 'EMA9 over EMA20');
      expect(buyCheck?.passed).toBe(true);
      expect(buyCheck?.points).toBe(3);
      expect(buyCheck?.pointsPossible).toBe(3);
      expect(buyCheck?.detail?.ema9 as number).toBeGreaterThan(buyCheck?.detail?.ema20 as number);

      const sellResult = await service.score(sellInput);
      const sellCheck = sellResult.checks.find((c) => c.name === 'EMA9 over EMA20');
      expect(sellCheck?.passed).toBe(false);
      expect(sellCheck?.points).toBe(0);
    });

    it('falling closes → EMA9 < EMA20 → SELL passes (3 pts), BUY fails', async () => {
      // On a falling series the 9-EMA tracks the drop faster than the
      // 20-EMA, so EMA9 sits below EMA20 → SELL passes, BUY fails.
      mockAdapter.getHistoricalData.mockResolvedValue(falling(60, 100, 0.5));
      const sellResult = await service.score(sellInput);
      const sellCheck = sellResult.checks.find((c) => c.name === 'EMA9 over EMA20');
      expect(sellCheck?.passed).toBe(true);
      expect(sellCheck?.points).toBe(3);
      expect(sellCheck?.detail?.ema9 as number).toBeLessThan(sellCheck?.detail?.ema20 as number);

      const buyResult = await service.score(buyInput);
      const buyCheck = buyResult.checks.find((c) => c.name === 'EMA9 over EMA20');
      expect(buyCheck?.passed).toBe(false);
      expect(buyCheck?.points).toBe(0);
    });

    it('insufficient candles → fails with reason "insufficient candles"', async () => {
      // 15 candles → after the closed-only forming-bar drop only 14 closes
      // remain → ema(closes, 20) returns null → insufficient candles.
      mockAdapter.getHistoricalData.mockResolvedValue(rising(15, 100, 0.5));
      const result = await service.score(buyInput);
      const check = result.checks.find((c) => c.name === 'EMA9 over EMA20');
      expect(check?.passed).toBe(false);
      expect(check?.points).toBe(0);
      expect(check?.detail?.reason).toBe('insufficient candles');
    });

    it('uses the factor name "EMA9 over EMA20" with pointsPossible 3', async () => {
      mockAdapter.getHistoricalData.mockResolvedValue(rising(60, 100, 0.5));
      const result = await service.score(buyInput);
      const check = result.checks.find((c) => c.name === 'EMA9 over EMA20');
      expect(check).toBeDefined();
      expect(check?.pointsPossible).toBe(3);
    });
  });

  // ─── Task 3: MACD warmup ────────────────────────────────────────────────
  describe('MACD warmup (260-bar window converges, 60-bar tail diverges)', () => {
    // A long, realistic-ish price series with mild trend + noise. Built
    // deterministically so the assertions are stable.
    function longSeries(n: number): number[] {
      const out: number[] = [];
      let p = 100;
      for (let i = 0; i < n; i++) {
        // Gentle upward drift + a deterministic sinusoidal wobble.
        p += 0.08 + Math.sin(i / 7) * 0.9 + Math.cos(i / 23) * 0.4;
        out.push(p);
      }
      return out;
    }

    it('MACD on a 60-bar tail DIVERGES from MACD on the full series (EMA not warmed)', () => {
      const full = longSeries(400);
      const fullMacd = macd(full)!;
      const tail60 = full.slice(-60);
      const tail60Macd = macd(tail60)!;
      // The 26-EMA seeded only 34 bars before the read point is far from
      // converged — its residual is several percent of the MACD value.
      const diff = Math.abs(fullMacd.macd - tail60Macd.macd);
      const rel = diff / Math.max(1e-9, Math.abs(fullMacd.macd));
      expect(rel).toBeGreaterThan(0.02); // > 2% divergence
    });

    it('MACD on a 250-bar window MATCHES the full-series MACD within tiny tolerance', () => {
      const full = longSeries(600);
      const fullMacd = macd(full)!;
      const win250 = full.slice(-250);
      const win250Macd = macd(win250)!;
      const diff = Math.abs(fullMacd.macd - win250Macd.macd);
      const rel = diff / Math.max(1e-9, Math.abs(fullMacd.macd));
      // 250 bars warms the 26-EMA so thoroughly the seed residual is
      // (1 - k)^224 ≈ 10^-7 — effectively identical to the full series.
      expect(rel).toBeLessThan(1e-4);
    });
  });

  // ─── Task 3 + 4: MACD checks request 250 bars, condition = green AND zero ─
  describe('checkMacdAtTf — 250-bar request + insufficient floor + zero-line', () => {
    const buyInput: ScoringInput = {
      token: '2885', symbol: 'RELIANCE', exchange: 'NSE', side: 'BUY',
      entryPrice: 2880, setupContext: null,
    };
    const sellInput: ScoringInput = { ...buyInput, side: 'SELL' };

    // A synthetic candle series whose closes are fully controllable.
    function candlesFromCloses(closes: number[]) {
      return closes.map((c, i) => ({
        timestamp: new Date(Date.UTC(2026, 4, 12, 0, i)),
        open: c, high: c + 0.5, low: c - 0.5, close: c, volume: 1000,
      }));
    }
    // Strong, ACCELERATING uptrend → MACD line green (macd > signal) AND
    // above zero. NOTE: a constant-slope ramp (p += k) is the wrong fixture
    // here — on a straight line the fast and slow EMAs both converge to the
    // same lagged value, so macd === signal exactly (histogram 0), which is
    // neither green nor red. The check's pass condition uses STRICT macd >
    // signal, so a flat-histogram series fails. An accelerating trend keeps
    // the fast EMA genuinely ahead of the slow EMA → histogram stays > 0.
    function strongUp(n: number): number[] {
      const out: number[] = [];
      let p = 100;
      for (let i = 0; i < n; i++) { p += 1.0 + i * 0.03; out.push(p); }
      return out;
    }
    // Strong, ACCELERATING downtrend → MACD red (macd < signal) AND below
    // zero. Same reasoning as strongUp — a constant-slope drop gives a flat
    // (zero) histogram which is not red. Floor at 1 so prices stay positive.
    function strongDown(n: number): number[] {
      const out: number[] = [];
      let p = 4000;
      for (let i = 0; i < n; i++) { p -= 1.0 + i * 0.03; out.push(Math.max(p, 1)); }
      return out;
    }

    it('insufficient floor: 100 bars (< 120) → fails with reason "insufficient candles"', async () => {
      mockAdapter.getHistoricalData.mockResolvedValue(candlesFromCloses(strongUp(100)));
      const result = await service.score(buyInput);
      const macdDaily = result.checks.find((c) => c.name === 'MACD on 1d');
      expect(macdDaily?.passed).toBe(false);
      expect(macdDaily?.detail?.reason).toBe('insufficient candles');
    });

    it('BUY passes only when MACD green AND above zero', async () => {
      mockAdapter.getHistoricalData.mockResolvedValue(candlesFromCloses(strongUp(300)));
      const result = await service.score(buyInput);
      const macdDaily = result.checks.find((c) => c.name === 'MACD on 1d')!;
      expect(macdDaily.passed).toBe(true);
      expect(macdDaily.detail?.aboveZero).toBe(true);
      expect(macdDaily.points).toBe(3);
    });

    it('BUY fails when MACD green but BELOW zero (recovering downtrend)', async () => {
      // Long downtrend then a short up-tick: macd > signal (green) but the
      // MACD line is still negative. 251 bars so that after the closed-only
      // policy drops the forming candle the check still sees 250 closed bars.
      // The check computes on closes.slice(0, -1), so the sanity macd() must
      // use the SAME closed-only set.
      const downBars = strongDown(251 - 12);
      const last = downBars[downBars.length - 1];
      const upTail = Array.from({ length: 12 }, (_, i) => last + (i + 1) * 2);
      const closes = [...downBars, ...upTail];
      mockAdapter.getHistoricalData.mockResolvedValue(candlesFromCloses(closes));
      const result = await service.score(buyInput);
      const macdDaily = result.checks.find((c) => c.name === 'MACD on 1d')!;
      const m = macd(closes.slice(0, -1))!;
      // Sanity: this fixture really is green-but-below-zero (closed-only set).
      expect(m.macd).toBeGreaterThan(m.signal);
      expect(m.macd).toBeLessThan(0);
      expect(macdDaily.passed).toBe(false);
      expect(macdDaily.detail?.aboveZero).toBe(false);
    });

    it('SELL passes only when MACD red AND below zero', async () => {
      mockAdapter.getHistoricalData.mockResolvedValue(candlesFromCloses(strongDown(300)));
      const result = await service.score(sellInput);
      const macdDaily = result.checks.find((c) => c.name === 'MACD on 1d')!;
      expect(macdDaily.passed).toBe(true);
      expect(macdDaily.detail?.belowZero).toBe(true);
      expect(macdDaily.points).toBe(3);
    });

    it('SELL fails when MACD red but ABOVE zero (cooling uptrend)', async () => {
      // Long uptrend then a short down-tick: macd < signal (red) but the
      // MACD line is still positive. 251 bars so that after the closed-only
      // policy drops the forming candle the check still sees 250 closed bars.
      // The check computes on closes.slice(0, -1), so the sanity macd() must
      // use the SAME closed-only set.
      const upBars = strongUp(251 - 12);
      const last = upBars[upBars.length - 1];
      const downTail = Array.from({ length: 12 }, (_, i) => last - (i + 1) * 2);
      const closes = [...upBars, ...downTail];
      mockAdapter.getHistoricalData.mockResolvedValue(candlesFromCloses(closes));
      const result = await service.score(sellInput);
      const macdDaily = result.checks.find((c) => c.name === 'MACD on 1d')!;
      const m = macd(closes.slice(0, -1))!;
      expect(m.macd).toBeLessThan(m.signal);
      expect(m.macd).toBeGreaterThan(0);
      expect(macdDaily.passed).toBe(false);
      expect(macdDaily.detail?.belowZero).toBe(false);
    });

    it('MACD factor weights: 1d→3, 5m→18, 1m→22 pointsPossible', async () => {
      mockAdapter.getHistoricalData.mockResolvedValue(candlesFromCloses(strongUp(400)));
      const result = await service.score(buyInput);
      const macd1d = result.checks.find((c) => c.name === 'MACD on 1d');
      const macd5m = result.checks.find((c) => c.name === 'MACD on 5m');
      const macd1m = result.checks.find((c) => c.name === 'MACD on 1m');
      expect(macd1d?.pointsPossible).toBe(3);
      expect(macd5m?.pointsPossible).toBe(18);
      expect(macd1m?.pointsPossible).toBe(22);
    });

    it('all three MACD checks request the longer warmup window worth of history', async () => {
      // fetchCandles sizes the date window from lookbackMsForTf(tf, lookback).
      // With the longer MACD warmup (1d→300), the 1d window must span
      // >= 300*2+30 calendar days.
      mockAdapter.getHistoricalData.mockResolvedValue(candlesFromCloses(strongUp(400)));
      await service.score(buyInput);
      const dailyCall = mockAdapter.getHistoricalData.mock.calls.find(
        (c: unknown[]) => c[2] === '1d',
      );
      expect(dailyCall).toBeDefined();
      const from = dailyCall![3] as Date;
      const to = dailyCall![4] as Date;
      const spanDays = (to.getTime() - from.getTime()) / (24 * 60 * 60 * 1000);
      // 300*2+30 = 630 calendar days minimum for a 300-bar 1d request.
      expect(spanDays).toBeGreaterThanOrEqual(630);
    });
  });

  // ─── SuperTrend check — computed on the 5m timeframe with warm-up ───────
  describe('checkSupertrend — 5m series + 350-bar warm-up window', () => {
    const buyInput: ScoringInput = {
      token: '2885', symbol: 'RELIANCE', exchange: 'NSE', side: 'BUY',
      entryPrice: 2880, setupContext: null,
    };
    const sellInput: ScoringInput = { ...buyInput, side: 'SELL' };

    function candlesFromCloses(closes: number[]) {
      return closes.map((c, i) => ({
        timestamp: new Date(Date.UTC(2026, 4, 12, 0, i)),
        open: c, high: c + 0.5, low: c - 0.5, close: c, volume: 1000,
      }));
    }
    // Steady uptrend — SuperTrend direction resolves to UP.
    function upCloses(n: number): number[] {
      return Array.from({ length: n }, (_, i) => 100 + i * 0.5);
    }
    // Steady downtrend — SuperTrend direction resolves to DOWN.
    function downCloses(n: number): number[] {
      return Array.from({ length: n }, (_, i) => 4000 - i * 0.5);
    }

    it('fetches the 5m timeframe (not 15m) for the SuperTrend check', async () => {
      mockAdapter.getHistoricalData.mockResolvedValue(candlesFromCloses(upCloses(400)));
      await service.score(buyInput);
      // The 5m series must have been requested for the stock token.
      const fiveMinCall = mockAdapter.getHistoricalData.mock.calls.find(
        (c: unknown[]) => c[0] === '2885' && c[2] === '5m',
      );
      expect(fiveMinCall).toBeDefined();
    });

    it('requests a 350-bar warm-up window worth of 5m history', async () => {
      // fetchCandles sizes the date window from lookbackMsForTf('5m', 350).
      // calendarDays['5m'] = ceil(350/75)*2+1 = 5*2+1 = 11 calendar days.
      mockAdapter.getHistoricalData.mockResolvedValue(candlesFromCloses(upCloses(400)));
      await service.score(buyInput);
      const fiveMinCall = mockAdapter.getHistoricalData.mock.calls.find(
        (c: unknown[]) => c[0] === '2885' && c[2] === '5m',
      );
      expect(fiveMinCall).toBeDefined();
      const from = fiveMinCall![3] as Date;
      const to = fiveMinCall![4] as Date;
      const spanDays = (to.getTime() - from.getTime()) / (24 * 60 * 60 * 1000);
      expect(spanDays).toBeGreaterThanOrEqual(11);
    });

    it('BUY passes when 5m SuperTrend direction is UP (observability-only, 0 pts)', async () => {
      mockAdapter.getHistoricalData.mockResolvedValue(candlesFromCloses(upCloses(400)));
      const result = await service.score(buyInput);
      const st = result.checks.find((c) => c.name === 'SuperTrend match')!;
      expect(st.detail?.direction).toBe('UP');
      expect(st.passed).toBe(true);
      expect(st.points).toBe(0);
      expect(st.pointsPossible).toBe(0);
    });

    it('SELL passes when 5m SuperTrend direction is DOWN (observability-only, 0 pts)', async () => {
      mockAdapter.getHistoricalData.mockResolvedValue(candlesFromCloses(downCloses(400)));
      const result = await service.score(sellInput);
      const st = result.checks.find((c) => c.name === 'SuperTrend match')!;
      expect(st.detail?.direction).toBe('DOWN');
      expect(st.passed).toBe(true);
      expect(st.points).toBe(0);
      expect(st.pointsPossible).toBe(0);
    });

    it('SuperTrend reads the 5m series — uses 5m direction even when 15m disagrees', async () => {
      // Per-timeframe fixtures: the 15m series trends DOWN, the 5m series
      // trends UP. A correct (post-fix) SuperTrend check reads the 5m series
      // → direction UP → BUY passes. The old 15m-based check would read the
      // DOWN 15m series → BUY fails. This is the load-bearing assertion.
      mockAdapter.getHistoricalData.mockImplementation(
        (_token: string, _ex: string, tf: string) =>
          Promise.resolve(candlesFromCloses(tf === '5m' ? upCloses(400) : downCloses(400))),
      );
      const result = await service.score(buyInput);
      const st = result.checks.find((c) => c.name === 'SuperTrend match')!;
      expect(st.detail?.direction).toBe('UP');
      expect(st.passed).toBe(true);
      // Observability-only — pass still yields 0 pts.
      expect(st.points).toBe(0);
    });

    it('insufficient 5m candles → fails with reason "insufficient candles"', async () => {
      // 100 candles → after the closed-only forming-bar drop only 99 remain →
      // below the 120-bar warm-up floor → insufficient candles. The recursive
      // SuperTrend bands have not converged on a window this short.
      mockAdapter.getHistoricalData.mockResolvedValue(candlesFromCloses(upCloses(100)));
      const result = await service.score(buyInput);
      const st = result.checks.find((c) => c.name === 'SuperTrend match')!;
      expect(st.passed).toBe(false);
      expect(st.detail?.reason).toBe('insufficient candles');
    });
  });

  // ─── Closed-only candle policy ──────────────────────────────────────────
  describe('fetchCandles closed-only policy — drops the forming (last) candle', () => {
    const buyInput: ScoringInput = {
      token: '2885', symbol: 'RELIANCE', exchange: 'NSE', side: 'BUY',
      entryPrice: 2880, setupContext: null,
    };

    function candlesFromCloses(closes: number[]) {
      return closes.map((c, i) => ({
        timestamp: new Date(Date.UTC(2026, 4, 12, 0, i)),
        open: c, high: c + 0.5, low: c - 0.5, close: c, volume: 1000,
      }));
    }

    it('a huge spike on ONLY the last (forming) candle is excluded from the MACD check', async () => {
      // 300 perfectly flat closes → MACD line is exactly 0, histogram 0 →
      // neither green nor above zero → the BUY MACD check FAILS. The very
      // last candle carries a massive upward spike. If the forming candle
      // were included, that spike would drag the fast EMA up, turn the
      // histogram green AND push the MACD line above zero → the check would
      // PASS. Closed-only policy drops that bar, so the check still sees a
      // flat series and FAILS. This is the load-bearing assertion.
      const flatCloses = Array.from({ length: 300 }, () => 100);
      const spiked = [...flatCloses, 100000]; // forming candle: 1000x spike
      mockAdapter.getHistoricalData.mockResolvedValue(candlesFromCloses(spiked));

      const result = await service.score(buyInput);
      const macdDaily = result.checks.find((c) => c.name === 'MACD on 1d')!;

      // Spike excluded → flat series → MACD line at zero → NOT green, NOT
      // above zero → check fails. Would be green+aboveZero (passed) if the
      // forming candle leaked in.
      expect(macdDaily.passed).toBe(false);
      expect(macdDaily.detail?.aboveZero).toBe(false);
      // The check computed on the flat run only: macd line is ~0.
      expect(Math.abs(macdDaily.detail?.macd as number)).toBeLessThan(1e-6);
    });
  });

  // ─── Task 5: dataStarved flag ───────────────────────────────────────────
  describe('dataStarved flag on ScoringResult', () => {
    const buyInput: ScoringInput = {
      token: '2885', symbol: 'RELIANCE', exchange: 'NSE', side: 'BUY',
      entryPrice: 2880, setupContext: null,
    };

    function risingCandles(n: number) {
      return Array.from({ length: n }, (_, i) => ({
        timestamp: new Date(Date.UTC(2026, 4, 12, 0, i * 5)),
        open: 100 + i * 0.5, high: 100 + i * 0.5 + 0.5, low: 100 + i * 0.5 - 0.5,
        close: 100 + i * 0.5 + 0.25, volume: 1000 + i * 50,
      }));
    }

    it('exposes dataStarved: boolean on every result', async () => {
      mockAdapter.getHistoricalData.mockResolvedValue(risingCandles(300));
      const result = await service.score(buyInput);
      expect(typeof result.dataStarved).toBe('boolean');
    });

    it('dataStarved=true when 3+ checks fail due to missing/insufficient candles', async () => {
      // Empty candles everywhere → most checks fail with insufficient-data reasons.
      mockAdapter.getHistoricalData.mockResolvedValue([]);
      const result = await service.score(buyInput);
      expect(result.dataStarved).toBe(true);
    });

    it('dataStarved=true when checks fail because the broker throttled (typed error)', async () => {
      const throttle = new Error('Angel One historical throttled — data:null');
      (throttle as Error & { name: string }).name = 'AngelThrottleError';
      mockAdapter.getHistoricalData.mockRejectedValue(throttle);
      const result = await service.score(buyInput);
      expect(result.dataStarved).toBe(true);
    });

    it('dataStarved=false when checks fail on genuine signal (data present, trend wrong)', async () => {
      // Plenty of candles → no insufficient-data reasons. A falling series on
      // a BUY setup fails many checks, but for SIGNAL reasons, not data.
      mockAdapter.getHistoricalData.mockResolvedValue(
        Array.from({ length: 300 }, (_, i) => ({
          timestamp: new Date(Date.UTC(2026, 4, 12, 0, i * 5)),
          open: 1000 - i * 0.5, high: 1000 - i * 0.5 + 0.5, low: 1000 - i * 0.5 - 0.5,
          close: 1000 - i * 0.5 - 0.25, volume: 1000 + i * 50,
        })),
      );
      const result = await service.score(buyInput);
      expect(result.dataStarved).toBe(false);
    });
  });

  // ─── As-of-time scoring (backtest replay) ───────────────────────────────
  describe('asOf — historical candle fetches end at a past timestamp', () => {
    const buyInput: ScoringInput = {
      token: '2885', symbol: 'RELIANCE', exchange: 'NSE', side: 'BUY',
      entryPrice: 2880, setupContext: null,
    };

    function risingCandles(n: number) {
      return Array.from({ length: n }, (_, i) => ({
        timestamp: new Date(Date.UTC(2026, 4, 12, 0, i * 5)),
        open: 100 + i * 0.5, high: 100 + i * 0.5 + 0.5, low: 100 + i * 0.5 - 0.5,
        close: 100 + i * 0.5 + 0.25, volume: 1000 + i * 50,
      }));
    }

    it('passing asOf makes EVERY historical fetch use `to` === that past date', async () => {
      mockAdapter.getHistoricalData.mockResolvedValue(risingCandles(300));
      const asOf = new Date(Date.UTC(2026, 3, 1, 9, 30)); // 2026-04-01 09:30 UTC

      await service.score({ ...buyInput, asOf });

      expect(mockAdapter.getHistoricalData).toHaveBeenCalled();
      // Every call's `to` arg (index 4) must equal asOf exactly.
      for (const call of mockAdapter.getHistoricalData.mock.calls) {
        const to = call[4] as Date;
        expect(to.getTime()).toBe(asOf.getTime());
      }
    });

    it('asOf also shifts the `from` arg back from asOf (window ends at asOf, not now)', async () => {
      mockAdapter.getHistoricalData.mockResolvedValue(risingCandles(300));
      const asOf = new Date(Date.UTC(2026, 3, 1, 9, 30));

      await service.score({ ...buyInput, asOf });

      for (const call of mockAdapter.getHistoricalData.mock.calls) {
        const from = call[3] as Date;
        const to = call[4] as Date;
        // from is strictly before to, and the window ends exactly at asOf.
        expect(from.getTime()).toBeLessThan(to.getTime());
        expect(to.getTime()).toBe(asOf.getTime());
      }
    });

    it('omitting asOf → every fetch `to` is approximately now (unchanged behaviour)', async () => {
      mockAdapter.getHistoricalData.mockResolvedValue(risingCandles(300));
      const before = Date.now();

      await service.score(buyInput);

      const after = Date.now();
      expect(mockAdapter.getHistoricalData).toHaveBeenCalled();
      for (const call of mockAdapter.getHistoricalData.mock.calls) {
        const to = call[4] as Date;
        // `to` was new Date() at fetch time — within the test's wall-clock window.
        expect(to.getTime()).toBeGreaterThanOrEqual(before);
        expect(to.getTime()).toBeLessThanOrEqual(after + 1000);
      }
    });
  });

  // ─── Candle prefetch / ScoringCandleSource ──────────────────────────────
  describe('prefetch + candleSource — pre-fetched in-memory candle store', () => {
    const buyInput: ScoringInput = {
      token: '2885', symbol: 'RELIANCE', exchange: 'NSE', side: 'BUY',
      entryPrice: 2880, setupContext: null,
    };

    // Long deterministic minute-bar series with timestamps spaced 1 minute
    // apart, ascending. `count` bars ending at `end`.
    function seriesEndingAt(end: Date, count: number) {
      return Array.from({ length: count }, (_, i) => {
        const ts = new Date(end.getTime() - (count - 1 - i) * 60_000);
        return {
          timestamp: ts,
          open: 100 + i * 0.1, high: 100 + i * 0.1 + 0.5, low: 100 + i * 0.1 - 0.5,
          close: 100 + i * 0.1 + 0.25, volume: 1000 + i,
        };
      });
    }

    it('prefetch returns a ScoringCandleSource with a getCandles method', async () => {
      mockAdapter.getHistoricalData.mockResolvedValue(seriesEndingAt(new Date(Date.UTC(2026, 4, 1)), 800));
      const from = new Date(Date.UTC(2026, 3, 1));
      const to = new Date(Date.UTC(2026, 4, 1));
      const source = await service.prefetch('2885', 'RELIANCE', 'NSE', from, to);
      expect(source).toBeDefined();
      expect(typeof source.getCandles).toBe('function');
    });

    it('getCandles slices the series by asOf — candles after asOf are excluded', async () => {
      const end = new Date(Date.UTC(2026, 4, 1, 12, 0));
      const series = seriesEndingAt(end, 600);
      mockAdapter.getHistoricalData.mockResolvedValue(series);
      const from = new Date(Date.UTC(2026, 3, 1));
      const to = end;
      const source = await service.prefetch('2885', 'RELIANCE', 'NSE', from, to);

      // asOf in the MIDDLE of the series — pick the timestamp of bar index 200.
      const asOf = series[200].timestamp;
      // 15m is one of the prefetched series; query whatever tf the source holds.
      const got = source.getCandles('2885', 'NSE', '1m', asOf);
      // Every returned candle must be <= asOf.
      expect(got.length).toBeGreaterThan(0);
      for (const c of got) {
        expect(c.timestamp.getTime()).toBeLessThanOrEqual(asOf.getTime());
      }
      // The bar AFTER asOf must not be present.
      const lastTs = got[got.length - 1].timestamp.getTime();
      expect(lastTs).toBeLessThanOrEqual(asOf.getTime());
      expect(series[201].timestamp.getTime()).toBeGreaterThan(asOf.getTime());
    });

    it('getCandles returns chronological candles', async () => {
      const end = new Date(Date.UTC(2026, 4, 1, 12, 0));
      mockAdapter.getHistoricalData.mockResolvedValue(seriesEndingAt(end, 600));
      const source = await service.prefetch('2885', 'RELIANCE', 'NSE', new Date(Date.UTC(2026, 3, 1)), end);
      const got = source.getCandles('2885', 'NSE', '1m', end);
      for (let i = 1; i < got.length; i++) {
        expect(got[i].timestamp.getTime()).toBeGreaterThanOrEqual(got[i - 1].timestamp.getTime());
      }
    });

    it('getCandles returns [] for a series the source holds nothing for', async () => {
      mockAdapter.getHistoricalData.mockResolvedValue(seriesEndingAt(new Date(Date.UTC(2026, 4, 1)), 600));
      const source = await service.prefetch('2885', 'RELIANCE', 'NSE', new Date(Date.UTC(2026, 3, 1)), new Date(Date.UTC(2026, 4, 1)));
      // A token/exchange/tf combination that was never prefetched.
      expect(source.getCandles('UNKNOWN-TOKEN', 'NSE', '1m', new Date(Date.UTC(2026, 4, 1)))).toEqual([]);
      expect(source.getCandles('2885', 'BSE', '1m', new Date(Date.UTC(2026, 4, 1)))).toEqual([]);
    });

    it('score() with candleSource does NOT call the adapter getHistoricalData at all', async () => {
      const end = new Date(Date.UTC(2026, 4, 1, 12, 0));
      mockAdapter.getHistoricalData.mockResolvedValue(seriesEndingAt(end, 800));
      const source = await service.prefetch('2885', 'RELIANCE', 'NSE', new Date(Date.UTC(2026, 3, 1)), end);

      mockAdapter.getHistoricalData.mockClear();
      await service.score({ ...buyInput, asOf: end, candleSource: source });
      expect(mockAdapter.getHistoricalData).not.toHaveBeenCalled();
    });

    it('result-neutral: score() served from candleSource === score() fetched live (same series)', async () => {
      const end = new Date(Date.UTC(2026, 4, 1, 12, 0));
      // One big rising series used for BOTH the live fetch and the prefetch.
      const series = seriesEndingAt(end, 900);
      mockAdapter.getHistoricalData.mockResolvedValue(series);

      // Build the prefetched source (this consumes adapter calls).
      const source = await service.prefetch('2885', 'RELIANCE', 'NSE', new Date(Date.UTC(2026, 3, 1)), end);

      // Live score: adapter returns the SAME series for every fetch.
      const live = await service.score({ ...buyInput, asOf: end });
      // Sourced score: served from the in-memory store, adapter not touched.
      mockAdapter.getHistoricalData.mockClear();
      const sourced = await service.score({ ...buyInput, asOf: end, candleSource: source });

      expect(mockAdapter.getHistoricalData).not.toHaveBeenCalled();
      expect(sourced.score).toBe(live.score);
      expect(sourced.dataStarved).toBe(live.dataStarved);
      expect(sourced.checks.map((c) => [c.name, c.points, c.passed]))
        .toEqual(live.checks.map((c) => [c.name, c.points, c.passed]));
    });

    it('candleSource absent → behaviour unchanged (adapter still used)', async () => {
      mockAdapter.getHistoricalData.mockResolvedValue(seriesEndingAt(new Date(Date.UTC(2026, 4, 1)), 300));
      await service.score(buyInput);
      expect(mockAdapter.getHistoricalData).toHaveBeenCalled();
    });

    it('prefetch fetches the stock 1m/5m/15m/1d, NIFTY 15m, and sector 15m', async () => {
      const end = new Date(Date.UTC(2026, 4, 1, 12, 0));
      mockAdapter.getHistoricalData.mockResolvedValue(seriesEndingAt(end, 800));
      await service.prefetch('2885', 'RELIANCE', 'NSE', new Date(Date.UTC(2026, 3, 1)), end);
      const calls = mockAdapter.getHistoricalData.mock.calls;
      // (token, exchange, tf) tuples requested.
      const tuples = calls.map((c: unknown[]) => `${c[0]}:${c[1]}:${c[2]}`);
      expect(tuples).toContain('2885:NSE:1m');
      expect(tuples).toContain('2885:NSE:5m');
      expect(tuples).toContain('2885:NSE:15m');
      expect(tuples).toContain('2885:NSE:1d');
      expect(tuples).toContain('99926000:NSE:15m'); // NIFTY 15m
      expect(tuples).toContain('99926019:NSE:15m'); // RELIANCE sector index 15m
    });

    it('prefetch skips the sector series when the symbol has no sector mapping', async () => {
      const end = new Date(Date.UTC(2026, 4, 1, 12, 0));
      mockAdapter.getHistoricalData.mockResolvedValue(seriesEndingAt(end, 800));
      await service.prefetch('9999', 'UNKNOWNSTOCK', 'NSE', new Date(Date.UTC(2026, 3, 1)), end);
      const calls = mockAdapter.getHistoricalData.mock.calls;
      const tuples = calls.map((c: unknown[]) => `${c[0]}:${c[1]}:${c[2]}`);
      // No sector token — only the stock's 4 tfs + NIFTY 15m.
      expect(tuples).toContain('9999:NSE:1m');
      expect(tuples).toContain('99926000:NSE:15m');
      // No mapping was resolvable, so nothing other than NIFTY on a non-stock token.
      expect(tuples.filter((t: string) => t.startsWith('999260') && t !== '99926000:NSE:15m')).toEqual([]);
    });
  });

  // ─── New scored factor: VWAP relationship ───────────────────────────────
  describe('VWAP relationship check', () => {
    // Build a session of 5m bars ending at `end`. Each bar's typical price is
    // close ± a small high/low band; volume is uniform. With ascending
    // closes the mean typical price (≈ vwap on uniform volume) is at the
    // midpoint of the close range.
    function sessionBars(end: Date, count: number, startPrice: number, step: number) {
      return Array.from({ length: count }, (_, i) => {
        const close = startPrice + i * step;
        const ts = new Date(end.getTime() - (count - 1 - i) * 5 * 60_000);
        return {
          timestamp: ts,
          open: close, high: close + 0.5, low: close - 0.5, close, volume: 1000,
        };
      });
    }

    it('BUY passes when entry price is above today\'s VWAP', async () => {
      const asOf = new Date(Date.UTC(2026, 4, 22, 9, 30)); // mid-session
      // 50 5m bars ascending 100→124.5 → VWAP ~ midpoint of close range ~112
      const bars = sessionBars(asOf, 50, 100, 0.5);
      mockAdapter.getHistoricalData.mockResolvedValue(bars);
      const input: ScoringInput = {
        token: '2885', symbol: 'RELIANCE', exchange: 'NSE', side: 'BUY',
        entryPrice: 200, setupContext: null, asOf,
      };
      const result = await service.score(input);
      const vwap = result.checks.find((c) => c.name === 'VWAP relationship')!;
      expect(vwap.passed).toBe(true);
      expect(vwap.points).toBe(15);
      expect(vwap.pointsPossible).toBe(15);
      expect(vwap.detail?.vwap as number).toBeLessThan(input.entryPrice);
    });

    it('BUY fails when entry price is below VWAP', async () => {
      const asOf = new Date(Date.UTC(2026, 4, 22, 9, 30));
      const bars = sessionBars(asOf, 50, 100, 0.5);
      mockAdapter.getHistoricalData.mockResolvedValue(bars);
      const input: ScoringInput = {
        token: '2885', symbol: 'RELIANCE', exchange: 'NSE', side: 'BUY',
        entryPrice: 50, setupContext: null, asOf,
      };
      const result = await service.score(input);
      const vwap = result.checks.find((c) => c.name === 'VWAP relationship')!;
      expect(vwap.passed).toBe(false);
      expect(vwap.points).toBe(0);
    });

    it('returns reason "no session candles" when no bars fall inside the session window', async () => {
      // No asOf supplied → asOfEffective = new Date(). The fixture timestamps
      // are from 2026-04-12 — well before the session window (now - 9h).
      mockAdapter.getHistoricalData.mockResolvedValue(
        Array.from({ length: 50 }, (_, i) => ({
          timestamp: new Date(Date.UTC(2026, 3, 12, 0, i * 5)),
          open: 100, high: 100.5, low: 99.5, close: 100, volume: 1000,
        })),
      );
      const input: ScoringInput = {
        token: '2885', symbol: 'RELIANCE', exchange: 'NSE', side: 'BUY',
        entryPrice: 200, setupContext: null,
      };
      const result = await service.score(input);
      const vwap = result.checks.find((c) => c.name === 'VWAP relationship')!;
      expect(vwap.passed).toBe(false);
      expect(vwap.detail?.reason).toBe('no session candles');
    });
  });

  // ─── New scored factor: ADX trend strength ──────────────────────────────
  describe('ADX trend strength check', () => {
    function candlesFromCloses(closes: number[]) {
      return closes.map((c, i) => ({
        timestamp: new Date(Date.UTC(2026, 4, 12, 0, i)),
        open: c, high: c + 0.5, low: c - 0.5, close: c, volume: 1000,
      }));
    }

    it('passes on a strong trending series (adx > 22)', async () => {
      // A steeply rising series produces a high ADX — directional movement
      // dominates true range.
      const closes = Array.from({ length: 80 }, (_, i) => 100 + i * 2);
      mockAdapter.getHistoricalData.mockResolvedValue(candlesFromCloses(closes));
      const input: ScoringInput = {
        token: '2885', symbol: 'RELIANCE', exchange: 'NSE', side: 'BUY',
        entryPrice: 200, setupContext: null,
      };
      const result = await service.score(input);
      const a = result.checks.find((c) => c.name === 'ADX trend strength')!;
      expect(a.passed).toBe(true);
      expect(a.points).toBe(12);
      expect(a.pointsPossible).toBe(12);
      expect(a.detail?.adx as number).toBeGreaterThan(22);
    });

    it('fails on a flat series (adx ≈ 0)', async () => {
      // Constant closes → no directional movement → ADX 0.
      const closes = Array.from({ length: 80 }, () => 100);
      mockAdapter.getHistoricalData.mockResolvedValue(candlesFromCloses(closes));
      const input: ScoringInput = {
        token: '2885', symbol: 'RELIANCE', exchange: 'NSE', side: 'BUY',
        entryPrice: 200, setupContext: null,
      };
      const result = await service.score(input);
      const a = result.checks.find((c) => c.name === 'ADX trend strength')!;
      expect(a.passed).toBe(false);
      expect(a.points).toBe(0);
    });

    it('returns reason "insufficient candles for adx" when not enough bars', async () => {
      // Need >= 2*14+1 = 29 bars after the closed-only drop. 20 supplied → 19
      // closed → adx() returns null.
      const closes = Array.from({ length: 20 }, (_, i) => 100 + i);
      mockAdapter.getHistoricalData.mockResolvedValue(candlesFromCloses(closes));
      const input: ScoringInput = {
        token: '2885', symbol: 'RELIANCE', exchange: 'NSE', side: 'BUY',
        entryPrice: 200, setupContext: null,
      };
      const result = await service.score(input);
      const a = result.checks.find((c) => c.name === 'ADX trend strength')!;
      expect(a.passed).toBe(false);
      expect(a.detail?.reason).toBe('insufficient candles for adx');
    });
  });

  // ─── New scored factor: RSI on 5m in zone ───────────────────────────────
  describe('RSI on 5m check', () => {
    function candlesFromCloses(closes: number[]) {
      return closes.map((c, i) => ({
        timestamp: new Date(Date.UTC(2026, 4, 12, 0, i)),
        open: c, high: c + 0.5, low: c - 0.5, close: c, volume: 1000,
      }));
    }

    it('BUY passes when rsi is in the [45, 70] zone (moderately rising series)', async () => {
      // A mildly rising series with small wobbles keeps RSI in a balanced
      // mid-range. We use a sequence that ends with a recent mix of
      // up/down moves to keep RSI in the mid range.
      const closes: number[] = [];
      let p = 100;
      for (let i = 0; i < 80; i++) {
        // Net upward drift with periodic pullbacks → RSI stays in 45-70.
        p += i % 3 === 0 ? -0.5 : 0.6;
        closes.push(p);
      }
      mockAdapter.getHistoricalData.mockResolvedValue(candlesFromCloses(closes));
      const input: ScoringInput = {
        token: '2885', symbol: 'RELIANCE', exchange: 'NSE', side: 'BUY',
        entryPrice: 200, setupContext: null,
      };
      const result = await service.score(input);
      const r = result.checks.find((c) => c.name === 'RSI on 5m')!;
      const rsiVal = r.detail?.rsi as number;
      expect(rsiVal).toBeGreaterThanOrEqual(45);
      expect(rsiVal).toBeLessThanOrEqual(70);
      expect(r.passed).toBe(true);
      expect(r.points).toBe(10);
      expect(r.pointsPossible).toBe(10);
    });

    it('BUY fails when rsi is overbought (> 70) on a sharp accelerating uptrend', async () => {
      // Continuous strong up-only moves → no losses in the Wilder window → RSI → 100.
      const closes = Array.from({ length: 80 }, (_, i) => 100 + i * 3);
      mockAdapter.getHistoricalData.mockResolvedValue(candlesFromCloses(closes));
      const input: ScoringInput = {
        token: '2885', symbol: 'RELIANCE', exchange: 'NSE', side: 'BUY',
        entryPrice: 200, setupContext: null,
      };
      const result = await service.score(input);
      const r = result.checks.find((c) => c.name === 'RSI on 5m')!;
      expect(r.detail?.rsi as number).toBeGreaterThan(70);
      expect(r.passed).toBe(false);
      expect(r.points).toBe(0);
    });

    it('BUY fails when rsi is oversold (< 45) on a sharply falling series', async () => {
      const closes = Array.from({ length: 80 }, (_, i) => 1000 - i * 3);
      mockAdapter.getHistoricalData.mockResolvedValue(candlesFromCloses(closes));
      const input: ScoringInput = {
        token: '2885', symbol: 'RELIANCE', exchange: 'NSE', side: 'BUY',
        entryPrice: 200, setupContext: null,
      };
      const result = await service.score(input);
      const r = result.checks.find((c) => c.name === 'RSI on 5m')!;
      expect(r.detail?.rsi as number).toBeLessThan(45);
      expect(r.passed).toBe(false);
      expect(r.points).toBe(0);
    });
  });

  // ─── New scored factor: ATR target feasibility ──────────────────────────
  describe('ATR target feasibility check', () => {
    it('passes when atr/entryPrice >= 0.4%', async () => {
      // Volatile bars: each 15m bar swings about 2 around a ~100 close →
      // ATR around 2-3 → atrPct on entry 100 ≈ 0.02-0.03, well above 0.004.
      const candles = Array.from({ length: 60 }, (_, i) => ({
        timestamp: new Date(Date.UTC(2026, 4, 12, 0, i)),
        open: 100, high: 102, low: 98, close: 100 + (i % 2 === 0 ? 1 : -1), volume: 1000,
      }));
      mockAdapter.getHistoricalData.mockResolvedValue(candles);
      const input: ScoringInput = {
        token: '2885', symbol: 'RELIANCE', exchange: 'NSE', side: 'BUY',
        entryPrice: 100, setupContext: null,
      };
      const result = await service.score(input);
      const a = result.checks.find((c) => c.name === 'ATR target feasibility')!;
      expect(a.passed).toBe(true);
      expect(a.points).toBe(5);
      expect(a.pointsPossible).toBe(5);
      expect(a.detail?.atrPct as number).toBeGreaterThanOrEqual(0.004);
    });

    it('fails when atr/entryPrice < 0.4% (very low volatility, expensive stock)', async () => {
      // Tiny intraday range vs a high entry price → atrPct tiny.
      const candles = Array.from({ length: 60 }, (_, i) => ({
        timestamp: new Date(Date.UTC(2026, 4, 12, 0, i)),
        open: 10000, high: 10000.05, low: 9999.95, close: 10000, volume: 1000,
      }));
      mockAdapter.getHistoricalData.mockResolvedValue(candles);
      const input: ScoringInput = {
        token: '2885', symbol: 'RELIANCE', exchange: 'NSE', side: 'BUY',
        entryPrice: 10000, setupContext: null,
      };
      const result = await service.score(input);
      const a = result.checks.find((c) => c.name === 'ATR target feasibility')!;
      expect(a.passed).toBe(false);
      expect(a.points).toBe(0);
      expect(a.detail?.atrPct as number).toBeLessThan(0.004);
    });
  });

  // ─── New scored factor: multi-day breakout confirmation ─────────────────
  describe('Multi-day breakout confirmation check', () => {
    function candlesFromCloses(closes: number[]) {
      return closes.map((c, i) => ({
        timestamp: new Date(Date.UTC(2026, 4, 12, 0, i)),
        open: c, high: c + 0.5, low: c - 0.5, close: c, volume: 1000,
      }));
    }

    it('BUY passes when entry is within 2% of the 20d max-high', async () => {
      // Rising daily series with closes 100→125, highs slightly above. Entry
      // at the top → entry/highs20 ≈ 1.0 → >= 0.98.
      const closes = Array.from({ length: 30 }, (_, i) => 100 + i);
      mockAdapter.getHistoricalData.mockResolvedValue(candlesFromCloses(closes));
      const input: ScoringInput = {
        token: '2885', symbol: 'RELIANCE', exchange: 'NSE', side: 'BUY',
        // After closed-only + slice(-20) the highs20 max is ~128.5 (close+0.5).
        entryPrice: 128, setupContext: null,
      };
      const result = await service.score(input);
      const b = result.checks.find((c) => c.name === 'Multi-day breakout confirmation')!;
      expect(b.passed).toBe(true);
      expect(b.points).toBe(5);
      expect(b.pointsPossible).toBe(5);
      expect(b.detail?.ratio as number).toBeGreaterThanOrEqual(0.98);
    });

    it('BUY fails when entry sits well below the 20d max-high', async () => {
      const closes = Array.from({ length: 30 }, (_, i) => 100 + i);
      mockAdapter.getHistoricalData.mockResolvedValue(candlesFromCloses(closes));
      const input: ScoringInput = {
        token: '2885', symbol: 'RELIANCE', exchange: 'NSE', side: 'BUY',
        entryPrice: 80, setupContext: null,
      };
      const result = await service.score(input);
      const b = result.checks.find((c) => c.name === 'Multi-day breakout confirmation')!;
      expect(b.passed).toBe(false);
      expect(b.points).toBe(0);
      expect(b.detail?.ratio as number).toBeLessThan(0.98);
    });

    it('returns reason "insufficient daily candles" when fewer than 20 daily bars', async () => {
      // 15 bars → 14 closed → < 20 → reason emitted.
      const closes = Array.from({ length: 15 }, (_, i) => 100 + i);
      mockAdapter.getHistoricalData.mockResolvedValue(candlesFromCloses(closes));
      const input: ScoringInput = {
        token: '2885', symbol: 'RELIANCE', exchange: 'NSE', side: 'BUY',
        entryPrice: 120, setupContext: null,
      };
      const result = await service.score(input);
      const b = result.checks.find((c) => c.name === 'Multi-day breakout confirmation')!;
      expect(b.passed).toBe(false);
      expect(b.detail?.reason).toBe('insufficient daily candles');
    });
  });
});
