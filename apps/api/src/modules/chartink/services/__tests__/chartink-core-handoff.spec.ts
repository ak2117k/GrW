import { Test } from '@nestjs/testing';
import * as marketHours from '../../../../common/utils/market-hours';
import { AdaptiveStopWatchService } from '../../../adaptive-stop-track/services/adaptive-stop-watch.service';
import { AnandDualTrackService } from '../../../anand-dual-track/services/anand-dual-track.service';
import { BreakoutSwingService } from '../../../breakout-swing-track/services/breakout-swing.service';
import { MarketDataRepository } from '../../../market-data/repositories/market-data.repository';
import { AngelOneAdapterService } from '../../../market-data/services/angel-one-adapter.service';
import { NseSectorIndexService } from '../../../market-data/services/nse-sector-index.service';
import { SellFuturesRejectionRepository } from '../../../sell-futures-track/repositories/sell-futures-rejection.repository';
import { SellFuturesService } from '../../../sell-futures-track/services/sell-futures.service';
import { LevelBookService } from '../../../signal-generator/services/level-book.service';
import { setCoreAlertIntake } from '../../../trade-core/intake/alert-handoff';
import { UngatedRejectionRepository } from '../../../ungated-track/repositories/ungated-rejection.repository';
import { UngatedWatchService } from '../../../ungated-track/services/ungated-watch.service';
import { WatchService } from '../../../watch-monitor/services/watch.service';
import { ChartinkRepository } from '../../repositories/chartink.repository';
import { ChartinkProcessService } from '../chartink-process.service';
import { ChartinkScoringService } from '../chartink-scoring.service';

/** SP2 M5 (O3, J2): the core hand-off at the end of processOne, and its isolation from the silo paths. */
const UP = Array.from({ length: 50 }, (_, i) => ({ close: 100 + i, open: 100 + i, high: 100 + i, low: 100 + i, volume: 1000, timestamp: new Date() }));

async function build(candles: unknown[] = UP) {
  const mocks = {
    repo: { createAlertSetup: jest.fn().mockResolvedValue({ id: 'setup-row-1' }) },
    mdRepo: { getInstrumentBySymbol: jest.fn(), getInstrumentByToken: jest.fn().mockResolvedValue({ token: '99926019' }) },
    scoring: { score: jest.fn().mockResolvedValue({ score: 70, lotCount: 2, checks: [] }), scoreToLotCount: jest.fn() },
    angelOne: { getHistoricalData: jest.fn().mockResolvedValue(candles), resolveSymbolToken: jest.fn().mockResolvedValue({ token: '2885', tradingSymbol: 'RELIANCE-EQ' }) },
    nseSector: { getSectorIndexForSymbol: jest.fn().mockResolvedValue('99926019') },
    watch: { createFromAlert: jest.fn().mockResolvedValue({ id: 'w1' }) },
    ungated: { createFromAlert: jest.fn().mockResolvedValue({ id: 'uw1' }) },
    adaptive: { createFromAlert: jest.fn().mockResolvedValue({ id: 'as1' }) },
    ungatedRejections: { record: jest.fn().mockResolvedValue(undefined) },
    anand: { createEntries: jest.fn().mockResolvedValue(undefined) },
    breakout: { createFromAlert: jest.fn().mockResolvedValue({ id: 'bs1' }) },
    sellFutures: { createFromAlert: jest.fn().mockResolvedValue({ id: 'sf1' }) },
    sellFuturesRejections: { record: jest.fn().mockResolvedValue(undefined) },
    levelBook: { lazyLoad: jest.fn().mockResolvedValue(null) },
  };
  const moduleRef = await Test.createTestingModule({
    providers: [
      ChartinkProcessService,
      { provide: ChartinkRepository, useValue: mocks.repo },
      { provide: MarketDataRepository, useValue: mocks.mdRepo },
      { provide: ChartinkScoringService, useValue: mocks.scoring },
      { provide: AngelOneAdapterService, useValue: mocks.angelOne },
      { provide: NseSectorIndexService, useValue: mocks.nseSector },
      { provide: WatchService, useValue: mocks.watch },
      { provide: UngatedWatchService, useValue: mocks.ungated },
      { provide: AdaptiveStopWatchService, useValue: mocks.adaptive },
      { provide: UngatedRejectionRepository, useValue: mocks.ungatedRejections },
      { provide: AnandDualTrackService, useValue: mocks.anand },
      { provide: BreakoutSwingService, useValue: mocks.breakout },
      { provide: SellFuturesService, useValue: mocks.sellFutures },
      { provide: SellFuturesRejectionRepository, useValue: mocks.sellFuturesRejections },
      { provide: LevelBookService, useValue: mocks.levelBook },
    ],
  }).compile();
  return { service: moduleRef.get(ChartinkProcessService), mocks };
}

/** What the silo did, as comparable data. */
const siloCalls = (m: Awaited<ReturnType<typeof build>>['mocks']) => ({
  setups: m.repo.createAlertSetup.mock.calls,
  watch: m.watch.createFromAlert.mock.calls,
  ungated: m.ungated.createFromAlert.mock.calls,
  adaptive: m.adaptive.createFromAlert.mock.calls,
  sellFutures: m.sellFutures.createFromAlert.mock.calls,
});

beforeEach(() => {
  jest.useFakeTimers({ now: new Date('2026-05-19T04:30:00Z'), doNotFake: ['nextTick', 'setImmediate', 'queueMicrotask'] });
  jest.spyOn(marketHours, 'isWithinEntryWindow').mockReturnValue(true);
});
afterEach(() => {
  setCoreAlertIntake(null);
  jest.restoreAllMocks();
  jest.useRealTimers();
});

describe('ChartinkProcessService → core hand-off (SP2 M5)', () => {
  it('hands a scored hit to the core once, after the silo paths, with the trading symbol, side and score', async () => {
    const { service, mocks } = await build();
    const accept = jest.fn();
    setCoreAlertIntake({ accept });
    await service.processOne('alert_1', { symbol: 'RELIANCE', hitPrice: 100 }, 'Hull MA cross', 'INTRADAY');
    expect(accept).toHaveBeenCalledTimes(1);
    expect(accept).toHaveBeenCalledWith({
      alertId: 'alert_1', symbol: 'RELIANCE', tradingSymbol: 'RELIANCE-EQ', token: '2885', exchange: 'NSE', hitPrice: 100,
      scanName: 'Hull MA cross', side: 'BUY', score: 70, receivedAt: expect.any(Date),
    });
    expect(mocks.watch.createFromAlert.mock.invocationCallOrder[0]).toBeLessThan(accept.mock.invocationCallOrder[0]);
    expect(mocks.ungated.createFromAlert.mock.invocationCallOrder[0]).toBeLessThan(accept.mock.invocationCallOrder[0]);
  });

  it('a throwing core intake changes nothing in the silo path (Review Focus 1)', async () => {
    const plain = await build();
    await plain.service.processOne('alert_1', { symbol: 'RELIANCE', hitPrice: 100 }, 'Hull MA cross', 'INTRADAY');
    const throwing = await build();
    setCoreAlertIntake({ accept: () => { throw new Error('core broke'); } });
    await expect(throwing.service.processOne('alert_1', { symbol: 'RELIANCE', hitPrice: 100 }, 'Hull MA cross', 'INTRADAY')).resolves.toBeUndefined();
    expect(siloCalls(throwing.mocks)).toEqual(siloCalls(plain.mocks));
  });

  it('an unscored hit (no direction) never reaches the core', async () => {
    const { service } = await build([]);
    const accept = jest.fn();
    setCoreAlertIntake({ accept });
    await service.processOne('alert_1', { symbol: 'RELIANCE', hitPrice: 100 }, 'Hull MA cross', 'INTRADAY');
    expect(accept).not.toHaveBeenCalled();
  });
});
