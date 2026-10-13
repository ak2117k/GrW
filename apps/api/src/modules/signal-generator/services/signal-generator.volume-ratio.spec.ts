import { SignalGeneratorService } from './signal-generator.service';
import {
  LevelsContextStrategy,
  closedBarVolumeRatio,
} from '../strategies/levels-context.strategy';

/**
 * `volumeRatio` on the /analyze result used to exist only on a setup — and on
 * every setup it read 0, because `lockedToResult` hard-coded it. The sentinel's
 * `flow.volumeRatio` therefore got either nothing (no setup, most of the time)
 * or a FALSE "0x" (every setup). These pin the honest version:
 *   - a no-setup result carries the closed-bar VMA20 ratio from the candles
 *     analyze() already loaded (no extra fetch);
 *   - a re-served lock that loaded no candles says null, never 0;
 *   - a lock with no level book carries `levels: null`, never zero-filled PDH/PDL.
 */

type Bar = { timestamp: Date; open: number; high: number; low: number; close: number; volume: number };

function bars(n: number, volume: (i: number) => number): Bar[] {
  return Array.from({ length: n }, (_, i) => ({
    timestamp: new Date(Date.UTC(2026, 9, 12, 4, 0) + i * 15 * 60_000),
    open: 100, high: 101, low: 99, close: 100, volume: volume(i),
  }));
}

describe('closedBarVolumeRatio', () => {
  it('is the last CLOSED bar (length-2) over the median of the 20 bars before it', () => {
    // 30 bars: everything 100 except the closed bar (index 28) at 250 and the
    // in-progress bar (index 29) at 5, which must be ignored.
    const c = bars(30, (i) => (i === 28 ? 250 : i === 29 ? 5 : 100));
    expect(closedBarVolumeRatio(c)).toBeCloseTo(2.5, 6);
  });

  it('is null — no reading — when the instrument reports no volume (index tokens)', () => {
    expect(closedBarVolumeRatio(bars(30, () => 0))).toBeNull();
  });

  it('is null when there are not 20 bars behind the closed bar', () => {
    expect(closedBarVolumeRatio(bars(21, () => 100))).toBeNull();
  });
});

describe('SignalGeneratorService.analyze — volumeRatio and levels honesty', () => {
  const TOKEN = '3045';
  const BOOK = {
    token: TOKEN, symbol: 'SBIN', exchange: 'NSE',
    pdh: 110, pdl: 90, orh: 105, orl: 95, prevOrh: null, prevOrl: null,
    vwap: 100, todayHigh: 106, todayLow: 94, atr14: 10, spot: 100,
    lastTickAt: new Date(),
  };

  function build(opts: { active?: unknown; book?: unknown; candles?: Bar[] }) {
    const levelBookService = {
      refreshFromBroker: jest.fn().mockResolvedValue(null),
      lazyLoad: jest.fn().mockResolvedValue(opts.book ?? null),
    } as any;
    const setupTracker = {
      getActive: jest.fn().mockReturnValue(opts.active ?? null),
      updateFromTick: jest.fn(),
    } as any;
    const marketDataRepository = {
      getInstrumentByToken: jest.fn().mockResolvedValue({ id: 'i1' }),
      getCandles: jest.fn().mockResolvedValue(opts.candles ?? []),
    } as any;
    const zoneRepository = { findActiveByToken: jest.fn().mockResolvedValue([]) } as any;
    const service = new SignalGeneratorService(
      {} as any, {} as any, {} as any, {} as any,
      marketDataRepository,
      {} as any, {} as any, {} as any,
      levelBookService,
      setupTracker,
      zoneRepository,
    );
    jest.spyOn(service as any, 'computeHigherTimeframeTrend').mockResolvedValue(null);
    return service;
  }

  afterEach(() => jest.restoreAllMocks());

  it('a no-setup result (strategy rejected) carries the closed-bar volume ratio', async () => {
    jest.spyOn(LevelsContextStrategy.prototype, 'analyze').mockReturnValue(null);
    const service = build({
      book: BOOK,
      candles: bars(30, (i) => (i === 28 ? 300 : 100)),
    });
    const r = await service.analyze(TOKEN, 'NSE', 'SBIN', '15m');
    expect(r.kind).toBe('no-setup');
    expect((r as { volumeRatio?: number | null }).volumeRatio).toBeCloseTo(3, 6);
  });

  it('a no-setup result with no level book says volumeRatio null, not absent-as-zero', async () => {
    const service = build({ book: null });
    const r = await service.analyze(TOKEN, 'NSE', 'SBIN', '15m');
    expect(r.kind).toBe('no-setup');
    expect((r as { volumeRatio?: number | null }).volumeRatio).toBeNull();
  });

  const LOCKED = {
    id: 's1', symbol: 'SBIN', side: 'BUY', entry: 100, stoploss: 95, target: 110,
    partialTakeAt: 105, trailingSl: null, levelType: 'PDH', setupType: 'BREAKOUT',
    grade: 'B', atr14: 10, reason: 'x', indicators: undefined,
    higherTimeframeTrend: null, regime: null, intradayRangeRatio: 0,
    status: 'ACTIVE', triggeredAt: null, partialBookedAt: null,
  };

  it('a re-served lock reports volumeRatio null — never the fabricated 0', async () => {
    const service = build({ active: LOCKED, book: BOOK });
    const r = await service.analyze(TOKEN, 'NSE', 'SBIN', '15m');
    expect(r.kind).toBe('setup');
    expect(r.kind === 'setup' && r.volumeRatio).toBeNull();
  });

  it('a lock with no level book carries levels null — never zero-filled PDH/PDL/VWAP', async () => {
    const service = build({ active: LOCKED, book: null });
    const r = await service.analyze(TOKEN, 'NSE', 'SBIN', '15m');
    expect(r.kind).toBe('setup');
    expect(r.levels).toBeNull();
  });
});
