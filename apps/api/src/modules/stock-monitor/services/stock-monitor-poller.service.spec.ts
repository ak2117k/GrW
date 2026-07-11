import { Test } from '@nestjs/testing';
import { MarketFeedService } from '../../market-data/services/market-feed.service';
import { StockMonitorService } from './stock-monitor.service';
import { StockMonitorPoller } from './stock-monitor-poller.service';

describe('StockMonitorPoller', () => {
  let poller: StockMonitorPoller;
  let feed: { subscribe: jest.Mock; isMarketOpen: jest.Mock };
  let service: { distinctWatchingTokens: jest.Mock; sweep: jest.Mock };

  beforeEach(async () => {
    feed = {
      subscribe: jest.fn().mockResolvedValue([]),
      isMarketOpen: jest.fn().mockReturnValue(true),
    };
    service = {
      distinctWatchingTokens: jest.fn().mockResolvedValue([]),
      sweep: jest.fn().mockResolvedValue(undefined),
    };

    const mod = await Test.createTestingModule({
      providers: [
        StockMonitorPoller,
        { provide: MarketFeedService, useValue: feed },
        { provide: StockMonitorService, useValue: service },
      ],
    }).compile();

    poller = mod.get(StockMonitorPoller);
  });

  describe('subscribeAll', () => {
    it('subscribes every distinct WATCHING token to the feed', async () => {
      service.distinctWatchingTokens.mockResolvedValue(['111', '222']);
      await poller.subscribeAll();
      expect(feed.subscribe).toHaveBeenCalledWith(['111', '222']);
    });

    it('no-ops when there are no WATCHING tokens', async () => {
      service.distinctWatchingTokens.mockResolvedValue([]);
      await poller.subscribeAll();
      expect(feed.subscribe).not.toHaveBeenCalled();
    });

    it('swallows a feed subscribe failure', async () => {
      service.distinctWatchingTokens.mockResolvedValue(['111']);
      feed.subscribe.mockRejectedValue(new Error('feed down'));
      await expect(poller.subscribeAll()).resolves.toBeUndefined();
    });
  });

  describe('sweep', () => {
    it('is idle when the market is closed', async () => {
      feed.isMarketOpen.mockReturnValue(false);
      await poller.sweep();
      expect(service.sweep).not.toHaveBeenCalled();
    });

    it('sweeps the service when the market is open', async () => {
      feed.isMarketOpen.mockReturnValue(true);
      await poller.sweep();
      expect(service.sweep).toHaveBeenCalledTimes(1);
    });

    it('does not stack overlapping sweeps', async () => {
      feed.isMarketOpen.mockReturnValue(true);
      let release!: () => void;
      service.sweep.mockImplementation(
        () => new Promise<void>((resolve) => (release = resolve)),
      );

      const first = poller.sweep(); // acquires the guard, awaits inside
      await poller.sweep(); // guard is held → returns immediately
      expect(service.sweep).toHaveBeenCalledTimes(1);

      release();
      await first;
    });
  });
});
