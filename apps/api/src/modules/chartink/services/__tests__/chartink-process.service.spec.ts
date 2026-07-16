import { Test } from '@nestjs/testing';
import { Logger } from '@nestjs/common';
import { ChartinkProcessService } from '../chartink-process.service';
import { ChartinkRepository } from '../../repositories/chartink.repository';
import { MarketDataRepository } from '../../../market-data/repositories/market-data.repository';
import { MtfAlignmentService } from '../../../signal-generator/services/mtf-alignment.service';
import { ChartinkScoringService } from '../chartink-scoring.service';
import { AngelOneAdapterService } from '../../../market-data/services/angel-one-adapter.service';
import { NseSectorIndexService } from '../../../market-data/services/nse-sector-index.service';
import { WatchService, WatchCapExceededError } from '../../../watch-monitor/services/watch.service';
import * as marketHours from '../../../../common/utils/market-hours';
import { UngatedWatchService, UngatedSymbolDupError, UngatedCooldownError, UngatedScannerNotAllowedError } from '../../../ungated-track/services/ungated-watch.service';
import { UngatedRejectionRepository } from '../../../ungated-track/repositories/ungated-rejection.repository';
import {
  UngatedCapitalExhaustedError, UngatedPositionCapError, UngatedKillSwitchError,
} from '../../../ungated-track/services/ungated-paper-account.service';
import { AdaptiveStopWatchService } from '../../../adaptive-stop-track/services/adaptive-stop-watch.service';
import { AnandDualTrackService } from '../../../anand-dual-track/services/anand-dual-track.service';
import { BreakoutSwingService } from '../../../breakout-swing-track/services/breakout-swing.service';
import {
  SellFuturesService, SellFuturesNoFutureError, SellFuturesCooldownError,
} from '../../../sell-futures-track/services/sell-futures.service';
import { SellFuturesRejectionRepository } from '../../../sell-futures-track/repositories/sell-futures-rejection.repository';
import { LevelBookService } from '../../../signal-generator/services/level-book.service';

/** A 5-min-MACD score-check entry, for exercising the MACD entry gate. */
const macd5mCheck = (passed: boolean) => ({
  name: 'MACD on 5m', points: passed ? 8 : 0, pointsPossible: 8, passed,
});

/** A SuperTrend match score-check entry, for exercising the SuperTrend entry gate. */
const supertrendCheck = (passed: boolean) => ({
  name: 'SuperTrend match', points: passed ? 8 : 0, pointsPossible: 8, passed,
});

/** Generate a minimal 50-bar closes array trending UP (each bar slightly higher). */
function makeTrendingCloses(direction: 'UP' | 'DOWN' | 'FLAT', n = 50): number[] {
  const closes: number[] = [];
  const step = direction === 'UP' ? 1 : direction === 'DOWN' ? -1 : 0;
  for (let i = 0; i < n; i++) closes.push(100 + i * step);
  return closes;
}

describe('ChartinkProcessService', () => {
  let service: ChartinkProcessService;
  let repo: { createAlertSetup: jest.Mock };
  let mdRepo: { getInstrumentBySymbol: jest.Mock; getInstrumentByToken: jest.Mock };
  let mtf: { check: jest.Mock };
  let scoring: { score: jest.Mock; scoreToLotCount: jest.Mock };
  let angelOne: { getHistoricalData: jest.Mock; resolveSymbolToken: jest.Mock };
  let nseSector: { getSectorIndexForSymbol: jest.Mock };
  let watchSvc: { createFromAlert: jest.Mock };
  let ungatedWatch: { createFromAlert: jest.Mock };
  let adaptiveStopWatch: { createFromAlert: jest.Mock };
  let ungatedRejections: { record: jest.Mock };
  let anandDualTrack: { createEntries: jest.Mock };
  let breakoutSwing: { createFromAlert: jest.Mock };
  let sellFutures: { createFromAlert: jest.Mock };
  let sellFuturesRejections: { record: jest.Mock };
  let levelBook: { lazyLoad: jest.Mock };

  // Default happy-path candles — 50 bars trending UP, enough for classifyTrend
  const UP_CANDLES = makeTrendingCloses('UP', 50).map((close) => ({ close, timestamp: new Date(), open: close, high: close, low: close, volume: 1000 }));

  beforeEach(async () => {
    // R3: freeze the clock to 10:00 IST - outside the 11:45-14:00 strict
    // window - so the default score-70 mock is admitted deterministically.
    jest.useFakeTimers({ now: new Date('2026-05-19T04:30:00Z') });
    // Default: every test runs as if INSIDE the 09:15-15:00 IST entry window
    // so the pipeline is exercised. The dedicated cutoff describe-block below
    // overrides this with its own spy to test the closed-market path.
    jest.spyOn(marketHours, 'isWithinEntryWindow').mockReturnValue(true);
    repo = { createAlertSetup: jest.fn().mockResolvedValue({ id: 'setup-row-1' }) };
    mdRepo = {
      getInstrumentBySymbol: jest.fn(),
      getInstrumentByToken: jest.fn(),
    };
    mtf = {
      check: jest.fn().mockResolvedValue({
        aligned: true,
        agreedDirection: 'UP',
        directions: { '1d': 'UP', '1h': 'UP', '15m': 'UP', '5m': 'UP' },
        summary: '1d=UP 1h=UP 15m=UP 5m=UP',
      }),
    };
    scoring = {
      score: jest.fn().mockResolvedValue({ score: 70, lotCount: 2, checks: [macd5mCheck(true), supertrendCheck(true)] }),
      scoreToLotCount: jest.fn(),
    };
    // Default: 50 UP-trending candles so classifyTrend returns 'UP'.
    // resolveSymbolToken now sources the stock token straight from Angel's master
    // (token 2885 = RELIANCE) — the DB `instruments` table is no longer consulted
    // for the stock. getInstrumentByToken (below) still resolves the sector INDEX.
    angelOne = {
      getHistoricalData: jest.fn().mockResolvedValue(UP_CANDLES),
      resolveSymbolToken: jest.fn().mockResolvedValue({ token: '2885', tradingSymbol: 'RELIANCE-EQ' }),
    };
    nseSector = { getSectorIndexForSymbol: jest.fn().mockResolvedValue('99926019') };
    watchSvc = { createFromAlert: jest.fn().mockResolvedValue({ id: 'w1' }) };
    ungatedWatch = { createFromAlert: jest.fn().mockResolvedValue({ id: 'uw1' }) };
    adaptiveStopWatch = { createFromAlert: jest.fn().mockResolvedValue({ id: 'as1' }) };
    ungatedRejections = { record: jest.fn().mockResolvedValue(undefined) };
    anandDualTrack = { createEntries: jest.fn().mockResolvedValue(undefined) };
    breakoutSwing = { createFromAlert: jest.fn().mockResolvedValue({ id: 'bs1' }) };
    sellFutures = { createFromAlert: jest.fn().mockResolvedValue({ id: 'sf1' }) };
    sellFuturesRejections = { record: jest.fn().mockResolvedValue(undefined) };
    // Default: lazyLoad returns null so setupContext stays null in tests that
    // don't care about S/R room. Individual tests can override this.
    levelBook = { lazyLoad: jest.fn().mockResolvedValue(null) };

    const moduleRef = await Test.createTestingModule({
      providers: [
        ChartinkProcessService,
        { provide: ChartinkRepository, useValue: repo },
        { provide: MarketDataRepository, useValue: mdRepo },
        { provide: MtfAlignmentService, useValue: mtf },
        { provide: ChartinkScoringService, useValue: scoring },
        { provide: AngelOneAdapterService, useValue: angelOne },
        { provide: NseSectorIndexService, useValue: nseSector },
        { provide: WatchService, useValue: watchSvc },
        { provide: UngatedWatchService, useValue: ungatedWatch },
        { provide: AdaptiveStopWatchService, useValue: adaptiveStopWatch },
        { provide: UngatedRejectionRepository, useValue: ungatedRejections },
        { provide: AnandDualTrackService, useValue: anandDualTrack },
        { provide: BreakoutSwingService, useValue: breakoutSwing },
        { provide: SellFuturesService, useValue: sellFutures },
        { provide: SellFuturesRejectionRepository, useValue: sellFuturesRejections },
        { provide: LevelBookService, useValue: levelBook },
      ],
    }).compile();

    service = moduleRef.get(ChartinkProcessService);
  });

  afterEach(() => {
    jest.restoreAllMocks();
    jest.useRealTimers();
  });

  // ─── Step 1: Symbol resolution ─────────────────────────────────────────────

  it('persists kind=unresolved when the symbol is not in the Angel master', async () => {
    // Only a genuinely unlisted / mistyped symbol reaches here now — the master
    // holds the whole listed universe, so this is rare rather than the norm.
    angelOne.resolveSymbolToken.mockResolvedValue(null);

    await service.processOne('alert-1', { symbol: 'UNKNOWN', hitPrice: 100 });

    expect(repo.createAlertSetup).toHaveBeenCalledWith({
      alertId: 'alert-1',
      symbol: 'UNKNOWN',
      token: null,
      hitPrice: 100,
      kind: 'unresolved',
      setupId: null,
      rejectReason: 'symbol not found in Angel instrument master (NSE)',
    });
  });

  it('does NOT proceed to scoring when symbol fails to resolve', async () => {
    angelOne.resolveSymbolToken.mockResolvedValue(null);
    await service.processOne('alert-1', { symbol: 'UNKNOWN', hitPrice: 100 });
    expect(scoring.score).not.toHaveBeenCalled();
    expect(repo.createAlertSetup).toHaveBeenCalledWith(expect.objectContaining({ kind: 'unresolved' }));
  });

  it('resolves the stock token from the Angel master, not the local DB', async () => {
    // The core of the change: a symbol absent from the instruments table (NEOGEN)
    // now resolves via Angel and flows through to the swing track.
    angelOne.resolveSymbolToken.mockResolvedValue({ token: '15380', tradingSymbol: 'NEOGEN-EQ' });

    await service.processOne('alert-1', { symbol: 'NEOGEN', hitPrice: 100 });

    expect(angelOne.resolveSymbolToken).toHaveBeenCalledWith('NEOGEN', 'NSE');
    expect(mdRepo.getInstrumentBySymbol).not.toHaveBeenCalled();
    expect(repo.createAlertSetup).not.toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'unresolved' }),
    );
  });

  // ─── Step 2: MTF no longer gates ───────────────────────────────────────────
  // The pure score-based pipeline removed the MTF alignment pre-screen. MTF
  // misalignment must NOT cause an early reject — the stock proceeds straight
  // to direction-resolution and scoring. The mtf-misaligned kind is never
  // produced anywhere anymore.

  describe('MTF no longer gates the pipeline', () => {
    it('proceeds to scoring (and becomes a setup) even when MTF would be misaligned', async () => {
      mdRepo.getInstrumentBySymbol.mockResolvedValue({ id: 'inst-1', token: '2885', exchange: 'NSE' });
      mdRepo.getInstrumentByToken.mockResolvedValue({ id: 'sec-1', token: '99926019', exchange: 'NSE' });
      // Even if an MTF check were run, it would say "misaligned" — must not matter.
      mtf.check.mockResolvedValue({
        aligned: false,
        agreedDirection: null,
        directions: { '1d': 'UP', '1h': 'UP', '15m': 'DOWN', '5m': 'UP' },
        summary: '1d=UP 1h=UP 15m=DOWN 5m=UP',
      });
      scoring.score.mockResolvedValue({ score: 70, lotCount: 2, checks: [macd5mCheck(true), supertrendCheck(true)] });

      await service.processOne('alert-1', { symbol: 'RELIANCE', hitPrice: 2885 });

      // Pipeline reached scoring and produced a setup — no early MTF reject.
      expect(scoring.score).toHaveBeenCalled();
      expect(repo.createAlertSetup).toHaveBeenCalledWith(expect.objectContaining({ kind: 'setup' }));
    });

    it('never produces kind=mtf-misaligned', async () => {
      mdRepo.getInstrumentBySymbol.mockResolvedValue({ id: 'inst-1', token: '2885', exchange: 'NSE' });
      mdRepo.getInstrumentByToken.mockResolvedValue({ id: 'sec-1', token: '99926019', exchange: 'NSE' });
      mtf.check.mockResolvedValue({
        aligned: false,
        agreedDirection: null,
        directions: { '1d': 'UP', '1h': 'UP', '15m': 'DOWN', '5m': 'UP' },
        summary: '1d=UP 1h=UP 15m=DOWN 5m=UP',
      });

      await service.processOne('alert-1', { symbol: 'RELIANCE', hitPrice: 2885 });

      const kinds = repo.createAlertSetup.mock.calls.map((c) => c[0].kind);
      expect(kinds).not.toContain('mtf-misaligned');
    });
  });

  // ─── Step 3: Direction gate (sector with stock-trend fallback) ────────────

  describe('Direction gate (sector with stock-trend fallback)', () => {
    beforeEach(() => {
      mdRepo.getInstrumentBySymbol.mockResolvedValue({ id: 'inst-1', token: '2885', exchange: 'NSE' });
      mdRepo.getInstrumentByToken.mockResolvedValue({ id: 'sec-1', token: '99926019', exchange: 'NSE', symbol: 'NIFTY ENERGY' });
    });

    // Helper: build flat candles that make classifyTrend return INDETERMINATE.
    const flatCandles = Array.from({ length: 50 }, () => ({
      close: 100, timestamp: new Date(), open: 100, high: 100, low: 100, volume: 1,
    }));
    // Helper: build short candles (under 26 bars) — insufficient for classifyTrend.
    const shortCandles = Array.from({ length: 10 }, (_, i) => ({
      close: 100 + i, timestamp: new Date(), open: 100 + i, high: 100 + i, low: 100 + i, volume: 1,
    }));

    it('falls back to stock trend (UP→BUY) when no sector mapping exists', async () => {
      nseSector.getSectorIndexForSymbol.mockResolvedValue(null);
      // Default UP_CANDLES → stock trend UP → side=BUY → scoring → setup
      await service.processOne('alert-1', { symbol: 'RELIANCE', hitPrice: 100 });

      expect(scoring.score).toHaveBeenCalledWith(expect.objectContaining({ side: 'BUY' }));
      expect(repo.createAlertSetup).toHaveBeenCalledWith(expect.objectContaining({ kind: 'setup' }));
    });

    it('falls back to stock trend when sector index token not in DB', async () => {
      nseSector.getSectorIndexForSymbol.mockResolvedValue('99926019');
      mdRepo.getInstrumentByToken.mockResolvedValue(null);
      await service.processOne('alert-1', { symbol: 'RELIANCE', hitPrice: 100 });

      expect(scoring.score).toHaveBeenCalledWith(expect.objectContaining({ side: 'BUY' }));
      expect(repo.createAlertSetup).toHaveBeenCalledWith(expect.objectContaining({ kind: 'setup' }));
    });

    it('falls back to stock trend when sector candles insufficient', async () => {
      // Sector returns short candles. Stock fetch (second call) returns UP_CANDLES.
      angelOne.getHistoricalData
        .mockResolvedValueOnce(shortCandles)  // sector
        .mockResolvedValueOnce(UP_CANDLES);    // stock fallback
      await service.processOne('alert-1', { symbol: 'RELIANCE', hitPrice: 100 });

      expect(scoring.score).toHaveBeenCalledWith(expect.objectContaining({ side: 'BUY' }));
      expect(repo.createAlertSetup).toHaveBeenCalledWith(expect.objectContaining({ kind: 'setup' }));
    });

    it('falls back to stock trend when sector trend is INDETERMINATE', async () => {
      const downCandles = makeTrendingCloses('DOWN', 50).map((close) => ({
        close, timestamp: new Date(), open: close, high: close, low: close, volume: 1,
      }));
      angelOne.getHistoricalData
        .mockResolvedValueOnce(flatCandles)   // sector → INDETERMINATE
        .mockResolvedValueOnce(downCandles);  // stock fallback → DOWN → side SELL
      await service.processOne('alert-1', { symbol: 'RELIANCE', hitPrice: 100 });

      expect(scoring.score).toHaveBeenCalledWith(expect.objectContaining({ side: 'SELL' }));
      expect(repo.createAlertSetup).toHaveBeenCalledWith(expect.objectContaining({ kind: 'setup' }));
    });

    it('persists no-direction when sector AND stock trend both unclear', async () => {
      // Both calls return flat candles → both INDETERMINATE.
      angelOne.getHistoricalData.mockResolvedValue(flatCandles);
      await service.processOne('alert-1', { symbol: 'RELIANCE', hitPrice: 100 });

      expect(repo.createAlertSetup).toHaveBeenCalledWith(expect.objectContaining({
        kind: 'no-direction',
        rejectReason: expect.stringContaining('stock trend also unclear'),
      }));
      expect(scoring.score).not.toHaveBeenCalled();
    });

    it('persists no-direction when sector fetch fails AND stock candles insufficient', async () => {
      angelOne.getHistoricalData
        .mockRejectedValueOnce(new Error('broker timeout'))  // sector
        .mockResolvedValueOnce(shortCandles);                 // stock fallback also insufficient
      await service.processOne('alert-1', { symbol: 'RELIANCE', hitPrice: 100 });

      expect(repo.createAlertSetup).toHaveBeenCalledWith(expect.objectContaining({
        kind: 'no-direction',
        rejectReason: expect.stringContaining('sector candle fetch failed: broker timeout'),
      }));
      expect(scoring.score).not.toHaveBeenCalled();
    });

    it('derives side=BUY when sector trend is UP (happy path)', async () => {
      // Default UP_CANDLES on sector fetch → side=BUY directly, no stock fallback.
      await service.processOne('alert-1', { symbol: 'RELIANCE', hitPrice: 2885 });
      expect(scoring.score).toHaveBeenCalledWith(expect.objectContaining({ side: 'BUY' }));
    });

    it('derives side=SELL when sector trend is DOWN', async () => {
      const downCandles = makeTrendingCloses('DOWN', 50).map((close) => ({
        close, timestamp: new Date(), open: close, high: close, low: close, volume: 1,
      }));
      angelOne.getHistoricalData.mockResolvedValue(downCandles);
      await service.processOne('alert-1', { symbol: 'RELIANCE', hitPrice: 2885 });
      expect(scoring.score).toHaveBeenCalledWith(expect.objectContaining({ side: 'SELL' }));
    });
  });

  // ─── Steps 4+5: Scoring + persistence ─────────────────────────────────────

  describe('Scoring and persistence', () => {
    beforeEach(() => {
      mdRepo.getInstrumentBySymbol.mockResolvedValue({ id: 'inst-1', token: '2885', exchange: 'NSE' });
      mdRepo.getInstrumentByToken.mockResolvedValue({ id: 'sec-1', token: '99926019', exchange: 'NSE', symbol: 'NIFTY ENERGY' });
      // UP candles → sector trend UP → side BUY
      angelOne.getHistoricalData.mockResolvedValue(UP_CANDLES);
    });

    it('persists kind=setup and calls watch.createFromAlert when score >= 60', async () => {
      scoring.score.mockResolvedValue({ score: 70, lotCount: 2, checks: [{ name: 'Sector aligned', points: 10, pointsPossible: 10, passed: true }, macd5mCheck(true), supertrendCheck(true)] });

      await service.processOne('alert-1', { symbol: 'RELIANCE', hitPrice: 2885 });

      expect(repo.createAlertSetup).toHaveBeenCalledWith(expect.objectContaining({
        alertId: 'alert-1',
        symbol: 'RELIANCE',
        token: '2885',
        hitPrice: 2885,
        kind: 'setup',
        setupId: null,
        rejectReason: null,
        score: 70,
        lotCount: 2,
        scoreBreakdown: expect.any(Array),
      }));
      expect(watchSvc.createFromAlert).toHaveBeenCalledWith(expect.objectContaining({
        alertId: 'alert-1',
        setupId: 'setup-row-1',
        symbol: 'RELIANCE',
        token: '2885',
        exchange: 'NSE',
        side: 'BUY',
        initialPrice: 2885,
        initialScore: 70,
      }));
    });

    it('ANAND_SWING: creates intraday+swing entries with NO score filter (even on a low score)', async () => {
      scoring.score.mockResolvedValue({ score: 30, lotCount: 0, checks: [] }); // would reject the gated track
      await service.processOne('alert-1', { symbol: 'RELIANCE', hitPrice: 2885 }, 'ANAND SWING 1ST JUNE 26', 'ANAND_SWING');
      expect(anandDualTrack.createEntries).toHaveBeenCalledWith(expect.objectContaining({
        alertId: 'alert-1', symbol: 'RELIANCE', token: '2885', hitPrice: 2885,
      }));
    });

    it('ANAND_SWING: dual-track fires even when scoring THROWS (proves it runs before scoring)', async () => {
      scoring.score.mockRejectedValue(new Error('scoring down'));
      await service.processOne('alert-1', { symbol: 'RELIANCE', hitPrice: 2885 }, 'scan', 'ANAND_SWING');
      expect(anandDualTrack.createEntries).toHaveBeenCalledWith(expect.objectContaining({
        symbol: 'RELIANCE', token: '2885',
      }));
    });

    it('non-ANAND_SWING category does NOT create dual-track entries', async () => {
      scoring.score.mockResolvedValue({ score: 70, lotCount: 2, checks: [macd5mCheck(true), supertrendCheck(true)] });
      await service.processOne('alert-1', { symbol: 'RELIANCE', hitPrice: 2885 }, 'scan', 'OTHER');
      expect(anandDualTrack.createEntries).not.toHaveBeenCalled();
    });

    it('ANAND_SWING: also fires breakoutSwing.createFromAlert on the same signal', async () => {
      scoring.score.mockResolvedValue({ score: 30, lotCount: 0, checks: [] });
      await service.processOne('alert-1', { symbol: 'RELIANCE', hitPrice: 2885 }, 'scan', 'ANAND_SWING');
      expect(breakoutSwing.createFromAlert).toHaveBeenCalledWith(expect.objectContaining({
        alertId: 'alert-1', symbol: 'RELIANCE', token: '2885', hitPrice: 2885, scoreBreakdown: null,
      }));
    });

    it('ANAND_SWING: breakoutSwing reject is swallowed and does not block anand dual-track', async () => {
      scoring.score.mockResolvedValue({ score: 30, lotCount: 0, checks: [] });
      breakoutSwing.createFromAlert.mockRejectedValue(new Error('breakout-swing: RELIANCE rejected — not near resistance'));
      await expect(
        service.processOne('alert-1', { symbol: 'RELIANCE', hitPrice: 2885 }, 'scan', 'ANAND_SWING'),
      ).resolves.toBeUndefined();
      expect(anandDualTrack.createEntries).toHaveBeenCalled();
    });

    it('non-ANAND_SWING category does NOT fire breakoutSwing', async () => {
      scoring.score.mockResolvedValue({ score: 70, lotCount: 2, checks: [macd5mCheck(true), supertrendCheck(true)] });
      await service.processOne('alert-1', { symbol: 'RELIANCE', hitPrice: 2885 }, 'scan', 'OTHER');
      expect(breakoutSwing.createFromAlert).not.toHaveBeenCalled();
    });

    it('persists kind=scored-low and does NOT call watch.createFromAlert when score < 47', async () => {
      scoring.score.mockResolvedValue({ score: 30, lotCount: 0, checks: [] });

      await service.processOne('alert-1', { symbol: 'RELIANCE', hitPrice: 2885 });

      expect(repo.createAlertSetup).toHaveBeenCalledWith(expect.objectContaining({
        kind: 'scored-low',
        rejectReason: 'score 30 below 47',
        score: 30,
        lotCount: 0,
      }));
      expect(watchSvc.createFromAlert).not.toHaveBeenCalled();
    });

    it('persists kind=scored-low for a score of 40 (below the 47 floor)', async () => {
      scoring.score.mockResolvedValue({ score: 40, lotCount: 0, checks: [macd5mCheck(true), supertrendCheck(true)] });

      await service.processOne('alert-1', { symbol: 'RELIANCE', hitPrice: 2885 });

      expect(repo.createAlertSetup).toHaveBeenCalledWith(expect.objectContaining({
        kind: 'scored-low',
        rejectReason: 'score 40 below 47',
      }));
      expect(watchSvc.createFromAlert).not.toHaveBeenCalled();
    });

    it('persists kind=error when scoring.score throws', async () => {
      scoring.score.mockRejectedValue(new Error('indicator crash'));

      await service.processOne('alert-1', { symbol: 'RELIANCE', hitPrice: 2885 });

      expect(repo.createAlertSetup).toHaveBeenCalledWith(expect.objectContaining({
        kind: 'error',
        rejectReason: 'indicator crash',
      }));
      expect(watchSvc.createFromAlert).not.toHaveBeenCalled();
    });

    it('still persists kind=setup even when watch.createFromAlert throws WatchCapExceededError', async () => {
      scoring.score.mockResolvedValue({ score: 70, lotCount: 2, checks: [macd5mCheck(true), supertrendCheck(true)] });
      watchSvc.createFromAlert.mockRejectedValue(new WatchCapExceededError(50));

      await service.processOne('alert-1', { symbol: 'RELIANCE', hitPrice: 2885 });

      // setup must be persisted before the watch call
      expect(repo.createAlertSetup).toHaveBeenCalledWith(expect.objectContaining({ kind: 'setup' }));
      // No second createAlertSetup call (watch error must not re-persist)
      expect(repo.createAlertSetup).toHaveBeenCalledTimes(1);
    });

    it('still persists kind=setup even when watch.createFromAlert throws unexpected error', async () => {
      scoring.score.mockResolvedValue({ score: 70, lotCount: 2, checks: [macd5mCheck(true), supertrendCheck(true)] });
      watchSvc.createFromAlert.mockRejectedValue(new Error('db connection lost'));

      await service.processOne('alert-1', { symbol: 'RELIANCE', hitPrice: 2885 });

      expect(repo.createAlertSetup).toHaveBeenCalledWith(expect.objectContaining({ kind: 'setup' }));
      expect(repo.createAlertSetup).toHaveBeenCalledTimes(1);
    });

    it('scores with correct token, symbol, exchange, entryPrice from hit (no level book → setupContext null)', async () => {
      scoring.score.mockResolvedValue({ score: 60, lotCount: 1, checks: [] });
      // Default mock: lazyLoad returns null → setupContext null

      await service.processOne('alert-99', { symbol: 'TCS', hitPrice: 3500 });

      expect(scoring.score).toHaveBeenCalledWith(expect.objectContaining({
        token: '2885',
        symbol: 'TCS',
        exchange: 'NSE',
        side: 'BUY',
        entryPrice: 3500,
        setupContext: null,
        // FIX 2: scoring now also receives a candleSource pre-seeded with the
        // 15m series the direction gate already fetched, so it doesn't re-pull
        // the same series from the rate-paced broker.
        candleSource: expect.objectContaining({ getCandles: expect.any(Function), has: expect.any(Function) }),
      }));
    });

    it('passes levelBookSnapshot setupContext to scoring when level book is available', async () => {
      scoring.score.mockResolvedValue({ score: 70, lotCount: 2, checks: [] });
      levelBook.lazyLoad.mockResolvedValue({
        token: '2885', symbol: 'TCS', exchange: 'NSE', asOf: new Date(),
        pdh: 3600, pdl: 3400, orh: 3550, orl: 3450, vwap: 3500,
        prevClose: 3480, orLocked: true, prevOrh: null, prevOrl: null,
        spot: 3500, todayHigh: 3580, todayLow: 3420, atr14: 60,
        lastTickAt: new Date(), roundNumbers: [], topVolStrikes: undefined,
      });

      await service.processOne('alert-99', { symbol: 'TCS', hitPrice: 3500 });

      expect(scoring.score).toHaveBeenCalledWith(expect.objectContaining({
        setupContext: {
          levelBookSnapshot: { pdh: 3600, pdl: 3400, orh: 3550, orl: 3450, vwap: 3500 },
        },
      }));
    });

    // ─── Pure score-based: MACD-5m and SuperTrend no longer veto ────────────
    // These two checks remain SCORED factors inside ChartinkScoringService —
    // they contribute points — but a failing/absent check no longer kills an
    // entry. As long as the total score reaches 60 the stock becomes a setup.

    it('becomes a setup when the 5m MACD check FAILS but score is still >= 60', async () => {
      scoring.score.mockResolvedValue({
        score: 80, lotCount: 3, checks: [macd5mCheck(false), supertrendCheck(true)],
      });

      await service.processOne('alert-1', { symbol: 'RELIANCE', hitPrice: 2885 });

      expect(repo.createAlertSetup).toHaveBeenCalledWith(expect.objectContaining({
        kind: 'setup',
        score: 80,
      }));
      expect(watchSvc.createFromAlert).toHaveBeenCalled();
    });

    it('becomes a setup when the SuperTrend check FAILS but score is still >= 60', async () => {
      scoring.score.mockResolvedValue({
        score: 80, lotCount: 3, checks: [macd5mCheck(true), supertrendCheck(false)],
      });

      await service.processOne('alert-1', { symbol: 'RELIANCE', hitPrice: 2885 });

      expect(repo.createAlertSetup).toHaveBeenCalledWith(expect.objectContaining({
        kind: 'setup',
        score: 80,
        lotCount: 3,
      }));
      expect(watchSvc.createFromAlert).toHaveBeenCalled();
    });

    it('becomes a setup when the SuperTrend check is missing entirely but score is >= 60', async () => {
      scoring.score.mockResolvedValue({
        score: 75, lotCount: 2, checks: [macd5mCheck(true)],
      });

      await service.processOne('alert-1', { symbol: 'RELIANCE', hitPrice: 2885 });

      expect(repo.createAlertSetup).toHaveBeenCalledWith(expect.objectContaining({
        kind: 'setup',
        score: 75,
      }));
      expect(watchSvc.createFromAlert).toHaveBeenCalled();
    });

    it('becomes a setup when BOTH the 5m MACD and SuperTrend checks fail but score is >= 60', async () => {
      scoring.score.mockResolvedValue({
        score: 65, lotCount: 1, checks: [macd5mCheck(false), supertrendCheck(false)],
      });

      await service.processOne('alert-1', { symbol: 'RELIANCE', hitPrice: 2885 });

      expect(repo.createAlertSetup).toHaveBeenCalledWith(expect.objectContaining({ kind: 'setup' }));
      expect(watchSvc.createFromAlert).toHaveBeenCalled();
    });

    it('still rejects as scored-low when the 5m MACD passes but the total score is < 47', async () => {
      scoring.score.mockResolvedValue({
        score: 35, lotCount: 0, checks: [macd5mCheck(true), supertrendCheck(true)],
      });

      await service.processOne('alert-1', { symbol: 'RELIANCE', hitPrice: 2885 });

      expect(repo.createAlertSetup).toHaveBeenCalledWith(expect.objectContaining({
        kind: 'scored-low',
        rejectReason: 'score 35 below 47',
      }));
      expect(watchSvc.createFromAlert).not.toHaveBeenCalled();
    });

    it('never produces kind=macd-misaligned or kind=supertrend-misaligned', async () => {
      scoring.score.mockResolvedValue({
        score: 80, lotCount: 3, checks: [macd5mCheck(false), supertrendCheck(false)],
      });

      await service.processOne('alert-1', { symbol: 'RELIANCE', hitPrice: 2885 });

      const kinds = repo.createAlertSetup.mock.calls.map((c) => c[0].kind);
      expect(kinds).not.toContain('macd-misaligned');
      expect(kinds).not.toContain('supertrend-misaligned');
    });

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
  });

  // ─── Stage 2 integration: watch.createFromAlert wiring ────────────────────

  describe('Stage 2 wiring (watch monitor)', () => {
    beforeEach(() => {
      mdRepo.getInstrumentBySymbol.mockResolvedValue({ id: 'inst-1', token: '2885', exchange: 'NSE' });
      mdRepo.getInstrumentByToken.mockResolvedValue({ id: 'sec-1', token: '99926019', exchange: 'NSE' });
      angelOne.getHistoricalData.mockResolvedValue(UP_CANDLES);
    });

    it('calls createFromAlert with setupId returned by repo.createAlertSetup', async () => {
      repo.createAlertSetup.mockResolvedValue({ id: 'my-setup-id-42' });
      scoring.score.mockResolvedValue({ score: 75, lotCount: 2, checks: [macd5mCheck(true), supertrendCheck(true)] });

      await service.processOne('alert-A', { symbol: 'INFY', hitPrice: 1800 });

      expect(watchSvc.createFromAlert).toHaveBeenCalledWith(expect.objectContaining({
        setupId: 'my-setup-id-42',
      }));
    });

    it('does NOT call createFromAlert when score is exactly 44 (just under the 45 floor)', async () => {
      scoring.score.mockResolvedValue({ score: 44, lotCount: 0, checks: [macd5mCheck(true), supertrendCheck(true)] });

      await service.processOne('alert-A', { symbol: 'INFY', hitPrice: 1800 });

      expect(watchSvc.createFromAlert).not.toHaveBeenCalled();
      expect(repo.createAlertSetup).toHaveBeenCalledWith(expect.objectContaining({
        kind: 'scored-low',
      }));
    });

    it('calls createFromAlert when score is exactly 60', async () => {
      scoring.score.mockResolvedValue({ score: 60, lotCount: 1, checks: [macd5mCheck(true), supertrendCheck(true)] });

      await service.processOne('alert-A', { symbol: 'INFY', hitPrice: 1800 });

      expect(watchSvc.createFromAlert).toHaveBeenCalled();
    });
  });

  // ─── 15:00 IST entry cutoff (ingest gate) ─────────────────────────────────
  // No new WATCHING entry may be created after 15:00 IST. When outside the
  // entry window the stock is rejected with kind='market-closed' BEFORE any
  // scoring or broker work — no symbol resolution, no scoring, no watch entry.

  describe('15:00 IST entry cutoff', () => {
    let windowSpy: jest.SpyInstance;

    afterEach(() => {
      windowSpy?.mockRestore();
    });

    it('rejects with kind=market-closed and skips scoring when outside the entry window', async () => {
      windowSpy = jest.spyOn(marketHours, 'isWithinEntryWindow').mockReturnValue(false);
      mdRepo.getInstrumentBySymbol.mockResolvedValue({ id: 'inst-1', token: '2885', exchange: 'NSE' });

      await service.processOne('alert-1', { symbol: 'RELIANCE', hitPrice: 2885 });

      expect(repo.createAlertSetup).toHaveBeenCalledWith(expect.objectContaining({
        alertId: 'alert-1',
        symbol: 'RELIANCE',
        kind: 'market-closed',
        rejectReason: expect.stringContaining('entry window 09:15-15:00 IST'),
      }));
      // No scoring, no watch entry, no symbol resolution work after the gate.
      expect(scoring.score).not.toHaveBeenCalled();
      expect(watchSvc.createFromAlert).not.toHaveBeenCalled();
    });

    it('logs an ingest-stage [trade-rejected] line when outside the entry window', async () => {
      windowSpy = jest.spyOn(marketHours, 'isWithinEntryWindow').mockReturnValue(false);
      const logSpy = jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);

      await service.processOne('alert-1', { symbol: 'RELIANCE', hitPrice: 2885 }, 'MY SCANNER');

      const line = logSpy.mock.calls
        .map((c) => String(c[0]))
        .find((s) => s.startsWith('[trade-rejected]'));
      expect(line).toBeDefined();
      expect(line).toContain('RELIANCE');
      expect(line).toContain('stage=ingest');
      logSpy.mockRestore();
    });

    it('proceeds normally (scores + creates setup) when inside the entry window', async () => {
      windowSpy = jest.spyOn(marketHours, 'isWithinEntryWindow').mockReturnValue(true);
      mdRepo.getInstrumentBySymbol.mockResolvedValue({ id: 'inst-1', token: '2885', exchange: 'NSE' });
      mdRepo.getInstrumentByToken.mockResolvedValue({ id: 'sec-1', token: '99926019', exchange: 'NSE' });
      angelOne.getHistoricalData.mockResolvedValue(UP_CANDLES);
      scoring.score.mockResolvedValue({ score: 70, lotCount: 2, checks: [macd5mCheck(true), supertrendCheck(true)] });

      await service.processOne('alert-1', { symbol: 'RELIANCE', hitPrice: 2885 });

      expect(scoring.score).toHaveBeenCalled();
      expect(repo.createAlertSetup).toHaveBeenCalledWith(expect.objectContaining({ kind: 'setup' }));
    });
  });

  // ─── "Why was this not traded" rejection logging ──────────────────────────

  describe('rejection logging', () => {
    let logSpy: jest.SpyInstance;
    let warnSpy: jest.SpyInstance;

    beforeEach(() => {
      logSpy = jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
      warnSpy = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    });

    afterEach(() => {
      logSpy.mockRestore();
      warnSpy.mockRestore();
    });

    it('logs a [trade-rejected] line for unresolved symbols (process stage)', async () => {
      angelOne.resolveSymbolToken.mockResolvedValue(null);

      await service.processOne('alert-1', { symbol: 'UNKNOWN', hitPrice: 100 }, 'MY SCANNER');

      expect(logSpy).toHaveBeenCalledWith(
        '[trade-rejected] UNKNOWN | scan="MY SCANNER" hit=100 | stage=process reason="symbol not found in Angel instrument master (NSE)"',
      );
    });

    it('logs a [trade-rejected] line for no-direction (process stage)', async () => {
      mdRepo.getInstrumentBySymbol.mockResolvedValue({ id: 'inst-1', token: '2885', exchange: 'NSE' });
      mdRepo.getInstrumentByToken.mockResolvedValue({ id: 'sec-1', token: '99926019', exchange: 'NSE' });
      // Both sector and stock trend INDETERMINATE → no-direction.
      const flatCandles = Array.from({ length: 50 }, () => ({
        close: 100, timestamp: new Date(), open: 100, high: 100, low: 100, volume: 1,
      }));
      angelOne.getHistoricalData.mockResolvedValue(flatCandles);

      await service.processOne('alert-1', { symbol: 'GESHIP', hitPrice: 1664 }, 'ANAND HIGH GAINER');

      const noDirCall = logSpy.mock.calls.find(
        (c) => typeof c[0] === 'string' && c[0].includes('[trade-rejected] GESHIP') && c[0].includes('stage=process'),
      );
      expect(noDirCall).toBeDefined();
    });

    it('logs a [trade-rejected] line for scored-low with side and score (scoring stage)', async () => {
      mdRepo.getInstrumentBySymbol.mockResolvedValue({ id: 'inst-1', token: '2885', exchange: 'NSE' });
      mdRepo.getInstrumentByToken.mockResolvedValue({ id: 'sec-1', token: '99926019', exchange: 'NSE' });
      angelOne.getHistoricalData.mockResolvedValue(UP_CANDLES);
      scoring.score.mockResolvedValue({ score: 40, lotCount: 0, checks: [] });

      await service.processOne('alert-1', { symbol: 'RAYMOND', hitPrice: 496.6 }, 'ANAND HIGH GAINER');

      expect(logSpy).toHaveBeenCalledWith(
        '[trade-rejected] RAYMOND | scan="ANAND HIGH GAINER" hit=496.6 side=BUY score=40 | stage=scoring reason="score 40 below 47"',
      );
    });

    it('uses logger.warn (not log) for the error kind', async () => {
      mdRepo.getInstrumentBySymbol.mockResolvedValue({ id: 'inst-1', token: '2885', exchange: 'NSE' });
      mdRepo.getInstrumentByToken.mockResolvedValue({ id: 'sec-1', token: '99926019', exchange: 'NSE' });
      angelOne.getHistoricalData.mockResolvedValue(UP_CANDLES);
      scoring.score.mockRejectedValue(new Error('indicator crash'));

      await service.processOne('alert-1', { symbol: 'TCS', hitPrice: 3500 }, 'ANAND HIGH GAINER');

      expect(warnSpy).toHaveBeenCalledWith(
        '[trade-rejected] TCS | scan="ANAND HIGH GAINER" hit=3500 side=BUY | stage=scoring reason="indicator crash"',
      );
    });

    it('omits the scan ctx field when no scan name is supplied', async () => {
      angelOne.resolveSymbolToken.mockResolvedValue(null);

      await service.processOne('alert-1', { symbol: 'UNKNOWN', hitPrice: 100 });

      expect(logSpy).toHaveBeenCalledWith(
        '[trade-rejected] UNKNOWN | hit=100 | stage=process reason="symbol not found in Angel instrument master (NSE)"',
      );
    });

    it('captures the stock-trend fallback failure text into the no-direction log line', async () => {
      mdRepo.getInstrumentBySymbol.mockResolvedValue({ id: 'inst-1', token: '2885', exchange: 'NSE' });
      mdRepo.getInstrumentByToken.mockResolvedValue({ id: 'sec-1', token: '99926019', exchange: 'NSE' });
      // sector fetch fails, stock fallback fetch also throws — must not be swallowed silently
      angelOne.getHistoricalData
        .mockRejectedValueOnce(new Error('sector down'))
        .mockRejectedValueOnce(new Error('stock fetch boom'));

      await service.processOne('alert-1', { symbol: 'RELIANCE', hitPrice: 100 }, 'ANAND HIGH GAINER');

      const noDirCall = logSpy.mock.calls.find(
        (c) => typeof c[0] === 'string' && c[0].includes('[trade-rejected]') && c[0].includes('stage=process'),
      );
      expect(noDirCall).toBeDefined();
      expect(noDirCall![0]).toContain('stock fetch boom');
    });
  });

  // ─── Ungated shadow track fork ─────────────────────────────────────────────

  describe('ChartinkProcessService — ungated fork', () => {
    beforeEach(() => {
      // Standard happy-path instrument setup for every fork test.
      mdRepo.getInstrumentBySymbol.mockResolvedValue({ id: 'inst-1', token: '2885', exchange: 'NSE' });
      mdRepo.getInstrumentByToken.mockResolvedValue({ id: 'sec-1', token: '99926019', exchange: 'NSE' });
      angelOne.getHistoricalData.mockResolvedValue(
        makeTrendingCloses('UP', 50).map((close) => ({
          close, timestamp: new Date(), open: close, high: close, low: close, volume: 1000,
        })),
      );
    });

    it('scored-low alert: gated rejects, ungated still calls createFromAlert', async () => {
      const LOW_SCORE = 40;
      scoring.score.mockResolvedValue({ score: LOW_SCORE, lotCount: 0, checks: [] });

      await service.processOne('alert-ug-1', { symbol: 'RELIANCE', hitPrice: 2885 });

      // Gated path: kind=scored-low persisted
      expect(repo.createAlertSetup).toHaveBeenCalledWith(
        expect.objectContaining({ kind: 'scored-low' }),
      );
      // Ungated path: still called despite gated rejection
      expect(ungatedWatch.createFromAlert).toHaveBeenCalledWith(
        expect.objectContaining({ initialScore: LOW_SCORE }),
      );
    });

    it('ungated createFromAlert failure does NOT affect the gated path', async () => {
      scoring.score.mockResolvedValue({ score: 70, lotCount: 2, checks: [macd5mCheck(true), supertrendCheck(true)] });
      ungatedWatch.createFromAlert.mockRejectedValue(new Error('ungated db crash'));

      // processOne must resolve cleanly — ungated failure must not propagate
      await expect(service.processOne('alert-ug-2', { symbol: 'RELIANCE', hitPrice: 2885 })).resolves.toBeUndefined();

      // Gated path still produced the setup
      expect(repo.createAlertSetup).toHaveBeenCalledWith(
        expect.objectContaining({ kind: 'setup' }),
      );
    });

    it('UngatedCapitalExhaustedError persists a rejection row', async () => {
      scoring.score.mockResolvedValue({ score: 70, lotCount: 2, checks: [] });
      ungatedWatch.createFromAlert.mockRejectedValue(new UngatedCapitalExhaustedError(50_000));

      await service.processOne('alert-ug-3', { symbol: 'RELIANCE', hitPrice: 2885 });

      expect(ungatedRejections.record).toHaveBeenCalledWith(
        expect.objectContaining({ reason: 'capital-exhausted' }),
      );
    });

    it('UngatedScannerNotAllowedError maps to a scanner-not-allowed rejection row', async () => {
      scoring.score.mockResolvedValue({ score: 70, lotCount: 2, checks: [] });
      ungatedWatch.createFromAlert.mockRejectedValue(
        new UngatedScannerNotAllowedError('RELIANCE', 'ANAND HIGH GAINER'),
      );

      await service.processOne('alert-ug-4', { symbol: 'RELIANCE', hitPrice: 2885 }, 'ANAND HIGH GAINER');

      expect(ungatedRejections.record).toHaveBeenCalledWith(
        expect.objectContaining({ reason: 'scanner-not-allowed' }),
      );
    });

    it('forwards the resolved scanName as scannerName into the ungated input', async () => {
      scoring.score.mockResolvedValue({ score: 70, lotCount: 2, checks: [] });

      await service.processOne('alert-ug-5', { symbol: 'RELIANCE', hitPrice: 2885 }, 'Anand 100Hull >200 hull');

      expect(ungatedWatch.createFromAlert).toHaveBeenCalledWith(
        expect.objectContaining({ scannerName: 'Anand 100Hull >200 hull' }),
      );
    });
  });

  // ─── Adaptive-Stop shadow track fork (Stage-4 hook on admitted entries) ─────
  // The adaptive-stop track mirrors the ungated fork but fires ONLY on the
  // policy.admitted (kind=setup) path, after the watch wiring. Its createFromAlert
  // is wrapped in an independent try/catch — a throw must never affect the gated path.

  describe('ChartinkProcessService — adaptive-stop fork', () => {
    beforeEach(() => {
      mdRepo.getInstrumentBySymbol.mockResolvedValue({ id: 'inst-1', token: '2885', exchange: 'NSE' });
      mdRepo.getInstrumentByToken.mockResolvedValue({ id: 'sec-1', token: '99926019', exchange: 'NSE' });
      angelOne.getHistoricalData.mockResolvedValue(UP_CANDLES);
    });

    it('admitted alert: calls adaptiveStopWatch.createFromAlert exactly once', async () => {
      scoring.score.mockResolvedValue({ score: 70, lotCount: 2, checks: [macd5mCheck(true), supertrendCheck(true)] });

      await service.processOne('alert-as-1', { symbol: 'RELIANCE', hitPrice: 2885 });

      // Gated path admitted (kind=setup) and the adaptive-stop hook fired once.
      expect(repo.createAlertSetup).toHaveBeenCalledWith(expect.objectContaining({ kind: 'setup' }));
      expect(adaptiveStopWatch.createFromAlert).toHaveBeenCalledTimes(1);
      expect(adaptiveStopWatch.createFromAlert).toHaveBeenCalledWith(expect.objectContaining({
        alertId: 'alert-as-1',
        setupId: 'setup-row-1',
        symbol: 'RELIANCE',
        token: '2885',
        exchange: 'NSE',
        side: 'BUY',
        initialPrice: 2885,
        initialScore: 70,
      }));
    });

    it('does NOT call adaptiveStopWatch.createFromAlert on a scored-low rejection', async () => {
      scoring.score.mockResolvedValue({ score: 40, lotCount: 0, checks: [] });

      await service.processOne('alert-as-2', { symbol: 'RELIANCE', hitPrice: 2885 });

      expect(repo.createAlertSetup).toHaveBeenCalledWith(expect.objectContaining({ kind: 'scored-low' }));
      expect(adaptiveStopWatch.createFromAlert).not.toHaveBeenCalled();
    });

    it('adaptiveStopWatch.createFromAlert throw is swallowed — gated path still completes', async () => {
      scoring.score.mockResolvedValue({ score: 70, lotCount: 2, checks: [macd5mCheck(true), supertrendCheck(true)] });
      adaptiveStopWatch.createFromAlert.mockRejectedValue(new Error('adaptive-stop db crash'));

      // processOne must resolve cleanly — the adaptive-stop failure must not propagate.
      await expect(
        service.processOne('alert-as-3', { symbol: 'RELIANCE', hitPrice: 2885 }),
      ).resolves.toBeUndefined();

      // Gated path still produced the setup and the ungated fork still ran.
      expect(repo.createAlertSetup).toHaveBeenCalledWith(expect.objectContaining({ kind: 'setup' }));
      expect(repo.createAlertSetup).toHaveBeenCalledTimes(1);
      expect(adaptiveStopWatch.createFromAlert).toHaveBeenCalledTimes(1);
      expect(ungatedWatch.createFromAlert).toHaveBeenCalled();
    });
  });

  // ─── FIX 2: direction-gate / scoring 15m candle dedupe ──────────────────────
  // The direction gate already fetches the sector-index 15m (and, on fallback,
  // the stock 15m). Those series are handed to scoring via candleSource so the
  // scoring checks read them from memory instead of re-fetching the SAME series
  // from the rate-paced broker.
  describe('ChartinkProcessService — gate/scoring candle dedupe (FIX 2)', () => {
    beforeEach(() => {
      mdRepo.getInstrumentBySymbol.mockResolvedValue({ id: 'inst-1', token: '2885', exchange: 'NSE' });
      mdRepo.getInstrumentByToken.mockResolvedValue({ id: 'sec-1', token: '99926019', exchange: 'NSE' });
      nseSector.getSectorIndexForSymbol.mockResolvedValue('99926019');
      // Full OHLCV 15m series so the candleSource can serve real bars.
      angelOne.getHistoricalData.mockResolvedValue(
        Array.from({ length: 60 }, (_, i) => ({
          timestamp: new Date(Date.UTC(2026, 4, 19, 4, i * 15)),
          open: 100 + i, high: 100 + i + 0.5, low: 100 + i - 0.5, close: 100 + i + 0.25, volume: 1000 + i,
        })),
      );
      scoring.score.mockResolvedValue({ score: 70, lotCount: 2, checks: [] });
    });

    it('fetches the sector-15m series exactly ONCE and hands it to scoring', async () => {
      await service.processOne('alert-dedupe-1', { symbol: 'RELIANCE', hitPrice: 2885 });

      // The gate's sector trend resolves UP → side BUY → stock fallback NOT
      // taken. The sector index 15m is fetched exactly once by the gate.
      const sectorFetches = angelOne.getHistoricalData.mock.calls.filter(
        (c: any[]) => c[0] === '99926019' && c[2] === '15m',
      );
      expect(sectorFetches).toHaveLength(1);

      // scoring received a candleSource that already serves that sector series,
      // so it will not re-fetch it from the broker.
      const arg = scoring.score.mock.calls[0][0];
      expect(arg.candleSource).toBeDefined();
      expect(arg.candleSource.has('99926019', 'NSE', '15m')).toBe(true);
      const served = arg.candleSource.getCandles('99926019', 'NSE', '15m', new Date());
      expect(served.length).toBeGreaterThan(0);
      // Series the gate did NOT pre-fetch fall through to the broker in scoring.
      expect(arg.candleSource.has('2885', 'NSE', '5m')).toBe(false);
    });
  });

  // ─── SELL-Futures shadow track fork (bearish signals → short the future) ────
  // Guarded by side==='SELL'. A SELL signal routes to sellFutures.createFromAlert;
  // a BUY signal does not. Errors map to a sell-futures rejection row. A throw
  // must never affect the gated/ungated/adaptive paths.
  describe('ChartinkProcessService — sell-futures fork', () => {
    const DOWN_CANDLES = makeTrendingCloses('DOWN', 50).map((close) => ({
      close, timestamp: new Date(), open: close, high: close, low: close, volume: 1000,
    }));

    beforeEach(() => {
      mdRepo.getInstrumentBySymbol.mockResolvedValue({ id: 'inst-1', token: '2885', exchange: 'NSE' });
      mdRepo.getInstrumentByToken.mockResolvedValue({ id: 'sec-1', token: '99926019', exchange: 'NSE' });
      scoring.score.mockResolvedValue({ score: 70, lotCount: 2, checks: [] });
    });

    it('routes a SELL signal (sector DOWN) to sellFutures.createFromAlert with the equity symbol + side', async () => {
      angelOne.getHistoricalData.mockResolvedValue(DOWN_CANDLES); // sector DOWN → side SELL
      await service.processOne('alert-sf-1', { symbol: 'RELIANCE', hitPrice: 2885 }, 'scan');
      expect(sellFutures.createFromAlert).toHaveBeenCalledWith(expect.objectContaining({
        symbol: 'RELIANCE', token: '2885', exchange: 'NSE', side: 'SELL', initialPrice: 2885,
      }));
    });

    it('does NOT route a BUY signal (sector UP) to the sell-futures track', async () => {
      angelOne.getHistoricalData.mockResolvedValue(UP_CANDLES); // sector UP → side BUY
      await service.processOne('alert-sf-2', { symbol: 'RELIANCE', hitPrice: 2885 }, 'scan');
      expect(sellFutures.createFromAlert).not.toHaveBeenCalled();
    });

    it('SellFuturesNoFutureError maps to a no-future rejection row', async () => {
      angelOne.getHistoricalData.mockResolvedValue(DOWN_CANDLES);
      sellFutures.createFromAlert.mockRejectedValue(new SellFuturesNoFutureError('RELIANCE'));
      await service.processOne('alert-sf-3', { symbol: 'RELIANCE', hitPrice: 2885 }, 'scan');
      expect(sellFuturesRejections.record).toHaveBeenCalledWith(
        expect.objectContaining({ reason: 'no-future', symbol: 'RELIANCE' }),
      );
    });

    it('SellFuturesCooldownError maps to a cooldown rejection row', async () => {
      angelOne.getHistoricalData.mockResolvedValue(DOWN_CANDLES);
      sellFutures.createFromAlert.mockRejectedValue(new SellFuturesCooldownError('RELIANCE'));
      await service.processOne('alert-sf-4', { symbol: 'RELIANCE', hitPrice: 2885 }, 'scan');
      expect(sellFuturesRejections.record).toHaveBeenCalledWith(
        expect.objectContaining({ reason: 'cooldown' }),
      );
    });

    it('a sell-futures throw does NOT affect the gated path (setup still persisted)', async () => {
      angelOne.getHistoricalData.mockResolvedValue(DOWN_CANDLES);
      sellFutures.createFromAlert.mockRejectedValue(new Error('sell-futures db crash'));
      await expect(
        service.processOne('alert-sf-5', { symbol: 'RELIANCE', hitPrice: 2885 }, 'scan'),
      ).resolves.toBeUndefined();
      expect(repo.createAlertSetup).toHaveBeenCalledWith(expect.objectContaining({ kind: 'setup' }));
    });
  });

  // ─── FIX 3: shadow tracks fire-and-forget (don't block the worker) ──────────
  describe('ChartinkProcessService — shadow tracks fire-and-forget (FIX 3)', () => {
    beforeEach(() => {
      mdRepo.getInstrumentBySymbol.mockResolvedValue({ id: 'inst-1', token: '2885', exchange: 'NSE' });
      mdRepo.getInstrumentByToken.mockResolvedValue({ id: 'sec-1', token: '99926019', exchange: 'NSE' });
      angelOne.getHistoricalData.mockResolvedValue(UP_CANDLES);
      scoring.score.mockResolvedValue({ score: 70, lotCount: 2, checks: [] });
    });

    it('processOne returns WITHOUT awaiting the adaptive + ungated shadow tracks', async () => {
      // Both shadow tracks return a promise that stays pending and flips a flag
      // only WHEN/IF it finally resolves. If processOne awaited either, it
      // could not resolve before we resolve them — yet it does, proving the
      // tracks are fire-and-forget. (Outer beforeEach installs fake timers; we
      // never rely on timers here, only on promise ordering.)
      let resolveAdaptive!: () => void;
      let resolveUngated!: () => void;
      let adaptiveSettled = false;
      let ungatedSettled = false;
      adaptiveStopWatch.createFromAlert.mockReturnValue(
        new Promise<void>((r) => { resolveAdaptive = r; }).then(() => { adaptiveSettled = true; }),
      );
      ungatedWatch.createFromAlert.mockReturnValue(
        new Promise<void>((r) => { resolveUngated = r; }).then(() => { ungatedSettled = true; }),
      );

      // processOne resolves even though both shadow tracks are still pending.
      await service.processOne('alert-ff-1', { symbol: 'RELIANCE', hitPrice: 2885 });

      // Both were kicked off (fire-and-forget, not skipped)...
      expect(adaptiveStopWatch.createFromAlert).toHaveBeenCalledTimes(1);
      expect(ungatedWatch.createFromAlert).toHaveBeenCalledTimes(1);
      // ...but neither had to settle for processOne to return.
      expect(adaptiveSettled).toBe(false);
      expect(ungatedSettled).toBe(false);

      // Drain them so the detached promises don't leak into other tests.
      resolveAdaptive();
      resolveUngated();
      await Promise.resolve();
    });
  });
});
