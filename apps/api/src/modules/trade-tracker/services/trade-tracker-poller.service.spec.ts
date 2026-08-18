import { Test } from '@nestjs/testing';
import { PrismaService } from '../../../common/prisma/prisma.service';
import { MarketFeedService } from '../../market-data/services/market-feed.service';
import { UserFeedManager } from '../../market-data/services/user-feed-manager.service';
import { TradeTrackerService } from './trade-tracker.service';
import { TradeTrackerPoller } from './trade-tracker-poller.service';

/** A socket quote the sweep should treat as live (stamped now). */
function liveQuote(ltp: number) {
  return { ltp, timestamp: new Date() };
}

/** A socket quote as stale as the KEI option's was — hours old, never evicted. */
function staleQuote(ltp: number) {
  return { ltp, timestamp: new Date(Date.now() - 21 * 60 * 60 * 1000) };
}

describe('TradeTrackerPoller', () => {
  let poller: TradeTrackerPoller;
  let prisma: { brokerCredential: { findMany: jest.Mock } };
  let feed: { subscribe: jest.Mock; getQuote: jest.Mock; isMarketOpen: jest.Mock };
  let userFeeds: { fetchQuotes: jest.Mock };
  let service: {
    backfill: jest.Mock;
    distinctOpenTokens: jest.Mock;
    openTrackerRefsByUser: jest.Mock;
    applyTick: jest.Mock;
  };

  beforeEach(async () => {
    prisma = { brokerCredential: { findMany: jest.fn().mockResolvedValue([]) } };
    feed = {
      subscribe: jest.fn().mockResolvedValue([]),
      getQuote: jest.fn().mockReturnValue(null),
      isMarketOpen: jest.fn().mockReturnValue(true),
    };
    userFeeds = { fetchQuotes: jest.fn().mockResolvedValue(new Map()) };
    service = {
      backfill: jest.fn().mockResolvedValue(undefined),
      distinctOpenTokens: jest.fn().mockResolvedValue([]),
      openTrackerRefsByUser: jest.fn().mockResolvedValue(new Map()),
      applyTick: jest.fn(),
    };

    const mod = await Test.createTestingModule({
      providers: [
        TradeTrackerPoller,
        { provide: PrismaService, useValue: prisma },
        { provide: MarketFeedService, useValue: feed },
        { provide: UserFeedManager, useValue: userFeeds },
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
      expect(service.openTrackerRefsByUser).not.toHaveBeenCalled();
      expect(userFeeds.fetchQuotes).not.toHaveBeenCalled();
      expect(service.applyTick).not.toHaveBeenCalled();
    });

    it('applies a fresh socket quote without spending a broker call', async () => {
      service.openTrackerRefsByUser.mockResolvedValue(
        new Map([['u1', [{ token: '111', exchange: 'NSE' }]]]),
      );
      feed.getQuote.mockReturnValue(liveQuote(105));

      await poller.sweepQuotes();

      expect(service.applyTick).toHaveBeenCalledWith('111', 105);
      expect(userFeeds.fetchQuotes).not.toHaveBeenCalled();
    });

    it('REST-fetches a token whose socket quote is hours old (the KEI failure)', async () => {
      service.openTrackerRefsByUser.mockResolvedValue(
        new Map([['u1', [{ token: 'KEI', exchange: 'NFO' }]]]),
      );
      feed.getQuote.mockReturnValue(staleQuote(3.5));
      userFeeds.fetchQuotes.mockResolvedValue(new Map([['KEI', { ltp: 41.2 }]]));

      await poller.sweepQuotes();

      expect(userFeeds.fetchQuotes).toHaveBeenCalledWith('u1', [
        { token: 'KEI', exchange: 'NFO' },
      ]);
      expect(service.applyTick).toHaveBeenCalledWith('KEI', 41.2);
      expect(service.applyTick).not.toHaveBeenCalledWith('KEI', 3.5);
    });

    it('REST-fetches a token the socket pool never served at all', async () => {
      service.openTrackerRefsByUser.mockResolvedValue(
        new Map([['u1', [{ token: '999', exchange: 'NFO' }]]]),
      );
      feed.getQuote.mockReturnValue(null);
      userFeeds.fetchQuotes.mockResolvedValue(new Map([['999', { ltp: 12 }]]));

      await poller.sweepQuotes();

      expect(service.applyTick).toHaveBeenCalledWith('999', 12);
    });

    it('issues exactly ONE batched call per user, carrying all that user’s tokens', async () => {
      service.openTrackerRefsByUser.mockResolvedValue(
        new Map([
          [
            'u1',
            [
              { token: '111', exchange: 'NFO' },
              { token: '222', exchange: 'NSE' },
              { token: '333', exchange: 'MCX' },
            ],
          ],
          ['u2', [{ token: '444', exchange: 'NSE' }]],
        ]),
      );
      userFeeds.fetchQuotes.mockImplementation(
        (_userId: string, refs: Array<{ token: string }>) =>
          Promise.resolve(
            new Map(refs.map((r) => [r.token, { ltp: Number(r.token) }])),
          ),
      );

      await poller.sweepQuotes();

      expect(userFeeds.fetchQuotes).toHaveBeenCalledTimes(2);
      expect(userFeeds.fetchQuotes).toHaveBeenCalledWith('u1', [
        { token: '111', exchange: 'NFO' },
        { token: '222', exchange: 'NSE' },
        { token: '333', exchange: 'MCX' },
      ]);
      expect(userFeeds.fetchQuotes).toHaveBeenCalledWith('u2', [
        { token: '444', exchange: 'NSE' },
      ]);
      expect(service.applyTick).toHaveBeenCalledTimes(4);
    });

    it('prices far more tokens than the 30-slot socket pool could carry', async () => {
      const refs = Array.from({ length: 50 }, (_, i) => ({
        token: `t${i}`,
        exchange: 'NSE',
      }));
      service.openTrackerRefsByUser.mockResolvedValue(new Map([['u1', refs]]));
      userFeeds.fetchQuotes.mockResolvedValue(
        new Map(refs.map((r) => [r.token, { ltp: 7 }])),
      );

      await poller.sweepQuotes();

      expect(userFeeds.fetchQuotes).toHaveBeenCalledTimes(1);
      expect(service.applyTick).toHaveBeenCalledTimes(50);
    });

    it('one user’s expired session does not stop the other users being priced', async () => {
      service.openTrackerRefsByUser.mockResolvedValue(
        new Map([
          ['u1', [{ token: '111', exchange: 'NSE' }]],
          ['u2', [{ token: '222', exchange: 'NSE' }]],
        ]),
      );
      userFeeds.fetchQuotes.mockImplementation((userId: string) =>
        userId === 'u1'
          ? Promise.reject(new Error('Invalid session'))
          : Promise.resolve(new Map([['222', { ltp: 99 }]])),
      );

      await poller.sweepQuotes();

      expect(userFeeds.fetchQuotes).toHaveBeenCalledTimes(2);
      expect(service.applyTick).toHaveBeenCalledTimes(1);
      expect(service.applyTick).toHaveBeenCalledWith('222', 99);
    });

    it('a shared token is quoted once, and a second holder can cover a failed session', async () => {
      service.openTrackerRefsByUser.mockResolvedValue(
        new Map([
          ['u1', [{ token: 'SHARED', exchange: 'NSE' }]],
          ['u2', [{ token: 'SHARED', exchange: 'NSE' }]],
          ['u3', [{ token: 'SHARED', exchange: 'NSE' }]],
        ]),
      );
      userFeeds.fetchQuotes.mockImplementation((userId: string) =>
        userId === 'u1'
          ? Promise.reject(new Error('Invalid session'))
          : Promise.resolve(new Map([['SHARED', { ltp: 55 }]])),
      );

      await poller.sweepQuotes();

      // u1 failed, u2 answered, u3 was never asked — the price is market-wide.
      expect(userFeeds.fetchQuotes).toHaveBeenCalledTimes(2);
      expect(service.applyTick).toHaveBeenCalledTimes(1);
      expect(service.applyTick).toHaveBeenCalledWith('SHARED', 55);
    });

    it('ignores non-positive quotes from either tier', async () => {
      service.openTrackerRefsByUser.mockResolvedValue(
        new Map([
          [
            'u1',
            [
              { token: '111', exchange: 'NSE' },
              { token: '222', exchange: 'NSE' },
            ],
          ],
        ]),
      );
      feed.getQuote.mockImplementation((token: string) =>
        token === '111' ? liveQuote(0) : null,
      );
      userFeeds.fetchQuotes.mockResolvedValue(
        new Map([
          ['111', { ltp: 0 }],
          ['222', { ltp: 0 }],
        ]),
      );

      await poller.sweepQuotes();

      expect(service.applyTick).not.toHaveBeenCalled();
    });

    it('no open trackers means no broker traffic', async () => {
      service.openTrackerRefsByUser.mockResolvedValue(new Map());
      await poller.sweepQuotes();
      expect(userFeeds.fetchQuotes).not.toHaveBeenCalled();
    });
  });
});
