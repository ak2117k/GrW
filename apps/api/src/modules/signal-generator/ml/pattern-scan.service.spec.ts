import { PatternScanService } from './pattern-scan.service';
import type { OhlcvCandle } from './pattern-observation.types';

// --- Fixtures ---------------------------------------------------------------
// The scan runs the REAL detectors (buildPatternMarkers) over the candles it
// fetches — markers cannot be injected — so every fixture is hand-built so the
// detector emits patterns at KNOWN bars. `time = index * 1000` throughout, which
// makes "which bar is the live edge" a plain arithmetic check in the assertions.

/** Adapter (`getHistoricalData`) returns raw candles with a Date `timestamp`. */
function asHistorical(candles: OhlcvCandle[]) {
  return candles.map((c) => ({
    timestamp: new Date(c.time),
    open: c.open,
    high: c.high,
    low: c.low,
    close: c.close,
    volume: c.volume,
  }));
}

/**
 * 30 clean bullish bars (open 99.5 / close 100, range 99–100) with a HAMMER at
 * bar 20 AND at the LAST bar (29). A hammer is a CANDLESTICK pattern (detection
 * lag 0), so bar 29's decision bar IS bar 29 → live edge (kept); bar 20's is bar
 * 20 → historical (dropped). The equal 99 lows never form a strict swing, so no
 * chart pattern sneaks in; the plain bars are neither doji, hammer, nor engulfing.
 */
function hammerFixture(): OhlcvCandle[] {
  const base = (i: number): OhlcvCandle => ({
    time: i * 1000, open: 99.5, high: 100, low: 99, close: 100, volume: 1000,
  });
  const hammer = (i: number): OhlcvCandle => ({
    time: i * 1000, open: 100.2, high: 100.5, low: 99.0, close: 100.4, volume: 1000,
  });
  return Array.from({ length: 30 }, (_, i) => (i === 20 || i === 29 ? hammer(i) : base(i)));
}

/**
 * 30 bars forming ONE double bottom: troughs (low 95) at bars 12 and 26, a
 * neckline peak (high 102) at bar 19. The SECOND trough — the pattern's anchor —
 * sits at bar 26, the latest bar that can still be a swing low (it needs 3 bars
 * on its right: 27, 28, 29). A double bottom is a CHART pattern, so its decision
 * bar is 26 + CHART_DETECTION_LAG_BARS(3) = 29 = the last bar → live edge. No
 * candlestick pattern lands anywhere, so the chart row is the only observation.
 */
function doubleBottomFixture(): OhlcvCandle[] {
  const base = (i: number): OhlcvCandle => ({
    time: i * 1000, open: 99.5, high: 100, low: 99, close: 100, volume: 1000,
  });
  const trough = (i: number): OhlcvCandle => ({
    time: i * 1000, open: 96, high: 99, low: 95, close: 99, volume: 1000,
  });
  const peak = (i: number): OhlcvCandle => ({
    time: i * 1000, open: 100.5, high: 102, low: 100, close: 101.5, volume: 1000,
  });
  return Array.from({ length: 30 }, (_, i) => {
    if (i === 12 || i === 26) return trough(i);
    if (i === 19) return peak(i);
    return base(i);
  });
}

const CTX = { v: 1 as const, mtf: null, sr: null, sector: null };

/** DetectionContextService is built in parallel — mock it by its INTERFACE only. */
function ctxService(ret: unknown = CTX) {
  return { compute: jest.fn().mockResolvedValue(ret) };
}

const target = { token: '2885', exchange: 'NSE', symbol: 'RELIANCE' };

describe('PatternScanService', () => {
  it('keeps, enriches, and saves ONLY the live-edge observation', async () => {
    const context = ctxService();
    const adapter = {
      getHistoricalData: jest.fn().mockResolvedValue(asHistorical(hammerFixture())),
    } as any;
    const repo = { saveMany: jest.fn().mockResolvedValue(1) } as any;
    const svc = new PatternScanService(adapter, repo, context as any);

    const results = await svc.scan([target]);

    expect(results).toEqual([{ target: 'RELIANCE', timeframe: '15m', observations: 1 }]);

    // 'bulk' lane, NOT 'background': the adapter cache key ignores [from,to], so a
    // background read/write would be handed / would poison a live scan's window.
    expect(adapter.getHistoricalData).toHaveBeenCalledWith(
      '2885', 'NSE', '15m', expect.any(Date), expect.any(Date), 'bulk',
    );

    // The hammer at bar 20 is historical (decision bar 20 ≠ 29) and must be
    // dropped; only the last-bar hammer survives, and it carries the enrichment.
    expect(repo.saveMany).toHaveBeenCalledTimes(1);
    const saved = repo.saveMany.mock.calls[0][0];
    expect(saved).toHaveLength(1);
    expect(saved[0].barTime).toEqual(new Date(29 * 1000));
    expect(saved[0].detectionContext).toBe(CTX);
  });

  it('computes context with the pattern bias, last close as spot, and the row ATR', async () => {
    const context = ctxService();
    const adapter = {
      getHistoricalData: jest.fn().mockResolvedValue(asHistorical(hammerFixture())),
    } as any;
    const repo = { saveMany: jest.fn().mockResolvedValue(1) } as any;
    const svc = new PatternScanService(adapter, repo, context as any);

    await svc.scan([target]);

    expect(context.compute).toHaveBeenCalledTimes(1);
    const saved = repo.saveMany.mock.calls[0][0];
    // spot is the LAST candle's close (the live edge), atr is the observation's own
    // stored atrAtDetection — the same yardstick its label was measured against.
    expect(context.compute).toHaveBeenCalledWith({
      token: '2885',
      exchange: 'NSE',
      symbol: 'RELIANCE',
      bias: 'BULLISH',
      spot: 100.4,
      atr: saved[0].atrAtDetection,
    });
  });

  it('is fail-open per target — a rejecting target never aborts the next', async () => {
    const context = ctxService();
    const adapter = {
      getHistoricalData: jest
        .fn()
        .mockRejectedValueOnce(new Error('throttled'))
        .mockResolvedValue(asHistorical(hammerFixture())),
    } as any;
    const repo = { saveMany: jest.fn().mockResolvedValue(1) } as any;
    const svc = new PatternScanService(adapter, repo, context as any);

    const results = await svc.scan([
      { token: 'BAD', exchange: 'NSE', symbol: 'FAILS' },
      target,
    ]);

    expect(results).toHaveLength(2);
    expect(results[0]).toEqual({ target: 'FAILS', timeframe: '15m', observations: 0 });
    expect(results[1]).toEqual({ target: 'RELIANCE', timeframe: '15m', observations: 1 });
    expect(repo.saveMany).toHaveBeenCalledTimes(1); // only the surviving target saved
  });

  it('skips a target with fewer than 25 candles without touching the repo', async () => {
    const context = ctxService();
    const adapter = {
      getHistoricalData: jest.fn().mockResolvedValue(asHistorical(hammerFixture().slice(0, 10))),
    } as any;
    const repo = { saveMany: jest.fn().mockResolvedValue(0) } as any;
    const svc = new PatternScanService(adapter, repo, context as any);

    const results = await svc.scan([target]);

    expect(results[0].observations).toBe(0);
    // The <25-bar guard must short-circuit BEFORE any enrichment or persistence.
    expect(repo.saveMany).not.toHaveBeenCalled();
    expect(context.compute).not.toHaveBeenCalled();
  });

  it('applies the +CHART_DETECTION_LAG_BARS shift when deciding the live edge', async () => {
    const context = ctxService();
    const adapter = {
      getHistoricalData: jest.fn().mockResolvedValue(asHistorical(doubleBottomFixture())),
    } as any;
    const repo = { saveMany: jest.fn().mockResolvedValue(1) } as any;
    const svc = new PatternScanService(adapter, repo, context as any);

    await svc.scan([target]);

    expect(repo.saveMany).toHaveBeenCalledTimes(1);
    const saved = repo.saveMany.mock.calls[0][0];
    expect(saved).toHaveLength(1);
    // Anchor bar 26; decision bar 26 + lag(3) = 29 = last ⇒ live edge, kept. Without
    // the CHART shift the anchor (26) ≠ last bar (29) and the row would be dropped.
    expect(saved[0].category).toBe('CHART');
    expect(saved[0].barTime).toEqual(new Date(26 * 1000));
    expect(saved[0].detectionContext).toBe(CTX);
  });
});
