import { Test } from '@nestjs/testing';
import { PrismaService } from '../../../common/prisma/prisma.service';
import { MarketFeedService } from '../../market-data/services/market-feed.service';
import { TradeTrackerService } from './trade-tracker.service';
import { TradeTrackerPoller } from './trade-tracker-poller.service';

describe('TradeTrackerPoller', () => {
  let poller: TradeTrackerPoller;
  let prisma: { brokerCredential: { findMany: jest.Mock } };
  let feed: { subscribe: jest.Mock; getQuote: jest.Mock; isMarketOpen: jest.Mock };
  let service: {
    backfill: jest.Mock;
    distinctOpenTokens: jest.Mock;
    applyTick: jest.Mock;
  };

  beforeEach(async () => {
    prisma = { brokerCredential: { findMany: jest.fn().mockResolvedValue([]) } };
    feed = {
      subscribe: jest.fn().mockResolvedValue([]),
      getQuote: jest.fn(),
      isMarketOpen: jest.fn().mockReturnValue(true),
    };
    service = {
      backfill: jest.fn().mockResolvedValue(undefined),
      distinctOpenTokens: jest.fn().mockResolvedValue([]),
      applyTick: jest.fn(),
    };

    const mod = await Test.createTestingModule({
      providers: [
        TradeTrackerPoller,
        { provide: PrismaService, useValue: prisma },
        { provide: MarketFeedService, useValue: feed },
        { provide: TradeTrackerService, useValue: service },
      ],
    }).compile();

    poller = mod.get(TradeTrackerPoller);
  });

  describe('reconcileAll', () => {
    it('backfills every credentialed user then subscribes all OPEN tokens', async () => {
      prisma.brokerCredential.findMany.mockResolvedValue([
        { userId: 'u1' },
        { userId: 'u2' },
      ]);
      service.distinctOpenTokens.mockResolvedValue(['111', '222']);

      await poller.reconcileAll();

      expect(service.backfill).toHaveBeenCalledWith('u1');
      expect(service.backfill).toHaveBeenCalledWith('u2');
      expect(feed.subscribe).toHaveBeenCalledWith(['111', '222']);
    });

    it('one user failing does not abort the batch', async () => {
      prisma.brokerCredential.findMany.mockResolvedValue([
        { userId: 'u1' },
        { userId: 'u2' },
      ]);
      service.backfill.mockRejectedValueOnce(new Error('broker down'));

      await poller.reconcileAll();

      expect(service.backfill).toHaveBeenCalledTimes(2);
    });

    it('no-ops with no credentialed users', async () => {
      prisma.brokerCredential.findMany.mockResolvedValue([]);
      await poller.reconcileAll();
      expect(service.backfill).not.toHaveBeenCalled();
      expect(feed.subscribe).not.toHaveBeenCalled();
    });
  });

  describe('sweepQuotes', () => {
    it('is idle when the market is closed', async () => {
      feed.isMarketOpen.mockReturnValue(false);
      await poller.sweepQuotes();
      expect(service.distinctOpenTokens).not.toHaveBeenCalled();
      expect(service.applyTick).not.toHaveBeenCalled();
    });

    it('applies the socket quote for each OPEN token with a positive ltp', async () => {
      service.distinctOpenTokens.mockResolvedValue(['111', '222', '333']);
      feed.getQuote.mockImplementation((token: string) => {
        if (token === '111') return { ltp: 105 };
        if (token === '222') return { ltp: 0 }; // no price yet — skipped
        return null; // 333 uncached — skipped
      });

      await poller.sweepQuotes();

      expect(service.applyTick).toHaveBeenCalledTimes(1);
      expect(service.applyTick).toHaveBeenCalledWith('111', 105);
    });
  });
});
