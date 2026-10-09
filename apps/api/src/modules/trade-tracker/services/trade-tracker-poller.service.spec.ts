import { Test } from '@nestjs/testing';
import { PrismaService } from '../../../common/prisma/prisma.service';
import { MarketFeedService } from '../../market-data/services/market-feed.service';
import { UserFeedManager } from '../../market-data/services/user-feed-manager.service';
import { TradeTrackerService } from './trade-tracker.service';
import { TradeTrackerPoller } from './trade-tracker-poller.service';
import { HubEngine } from '../../market-hub/hub-engine';
import { HUB_PRICE_SOURCE, engineHubPrices } from '../../market-hub/hub-prices';
import { SessionClock } from '../../market-hub/session-clock';
import { FakeBroker } from '../../market-hub/testing/fake-broker';
import { MARKET_HOLIDAYS } from '../../market-data/services/market-holidays.service';

/** A socket quote the sweep should treat as live (stamped now). */
function liveQuote(ltp: number, exchange = 'NSE') {
  return { ltp, exchange, timestamp: new Date() };
}

/** A socket quote as stale as the KEI option's was — hours old, never evicted. */
function staleQuote(ltp: number, exchange = 'NSE') {
  return { ltp, exchange, timestamp: new Date(Date.now() - 21 * 60 * 60 * 1000) };
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
      prisma.brokerCredential.findMany.mockResolvedValue([{ userId: 'u1' }, { userId: 'u2' }]);
      service.distinctOpenTokens.mockResolvedValue(['111', '222']);

      await poller.reconcileAll();

      expect(service.backfill).toHaveBeenCalledWith('u1');
      expect(service.backfill).toHaveBeenCalledWith('u2');
      expect(feed.subscribe).toHaveBeenCalledWith(['111', '222']);
    });

    it('one user failing does not abort the batch', async () => {
      prisma.brokerCredential.findMany.mockResolvedValue([{ userId: 'u1' }, { userId: 'u2' }]);
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

  describe('sweepQuotes (legacy tiers)', () => {
    it('is idle when the market is closed', async () => {
      feed.isMarketOpen.mockReturnValue(false);
      await poller.sweepQuotes();
      expect(service.openTrackerRefsByUser).not.toHaveBeenCalled();
      expect(userFeeds.fetchQuotes).not.toHaveBeenCalled();
      expect(service.applyTick).not.toHaveBeenCalled();
    });

    it('applies a fresh socket quote without spending a broker call', async () => {
      service.openTrackerRefsByUser.mockResolvedValue(new Map([['u1', [{ token: '111', exchange: 'NSE' }]]]));
      feed.getQuote.mockReturnValue(liveQuote(105));

      await poller.sweepQuotes();

      expect(service.applyTick).toHaveBeenCalledWith({ token: '111', exchange: 'NSE' }, 105);
      expect(userFeeds.fetchQuotes).not.toHaveBeenCalled();
    });

    it('does not stamp a socket quote from another exchange onto the ref (NSE equity vs NFO option)', async () => {
      // The socket cache is read by token and resolves NSE → BSE → MCX: an NFO
      // option sharing its token with a streamed NSE equity must not take its price.
      service.openTrackerRefsByUser.mockResolvedValue(new Map([['u1', [{ token: '35001', exchange: 'NFO' }]]]));
      feed.getQuote.mockReturnValue(liveQuote(2500, 'NSE'));
      userFeeds.fetchQuotes.mockResolvedValue(new Map([['35001', { ltp: 120 }]]));

      await poller.sweepQuotes();

      expect(service.applyTick).not.toHaveBeenCalledWith(expect.anything(), 2500);
      expect(userFeeds.fetchQuotes).toHaveBeenCalledWith('u1', [{ token: '35001', exchange: 'NFO' }]);
      expect(service.applyTick).toHaveBeenCalledWith({ token: '35001', exchange: 'NFO' }, 120);
      expect(service.applyTick).toHaveBeenCalledTimes(1);
    });

    it('applies a socket quote whose exchange matches the ref (case-insensitive)', async () => {
      service.openTrackerRefsByUser.mockResolvedValue(new Map([['u1', [{ token: '777', exchange: 'mcx' }]]]));
      feed.getQuote.mockReturnValue(liveQuote(7010, 'MCX'));

      await poller.sweepQuotes();

      expect(service.applyTick).toHaveBeenCalledWith({ token: '777', exchange: 'mcx' }, 7010);
      expect(userFeeds.fetchQuotes).not.toHaveBeenCalled();
    });

    it('REST-fetches a token whose socket quote is hours old (the KEI failure)', async () => {
      service.openTrackerRefsByUser.mockResolvedValue(new Map([['u1', [{ token: 'KEI', exchange: 'NFO' }]]]));
      feed.getQuote.mockReturnValue(staleQuote(3.5, 'NFO'));
      userFeeds.fetchQuotes.mockResolvedValue(new Map([['KEI', { ltp: 41.2 }]]));

      await poller.sweepQuotes();

      expect(userFeeds.fetchQuotes).toHaveBeenCalledWith('u1', [{ token: 'KEI', exchange: 'NFO' }]);
      expect(service.applyTick).toHaveBeenCalledWith({ token: 'KEI', exchange: 'NFO' }, 41.2);
      expect(service.applyTick).not.toHaveBeenCalledWith(expect.anything(), 3.5);
    });

    it('REST-fetches a token the socket pool never served at all', async () => {
      service.openTrackerRefsByUser.mockResolvedValue(new Map([['u1', [{ token: '999', exchange: 'NFO' }]]]));
      userFeeds.fetchQuotes.mockResolvedValue(new Map([['999', { ltp: 12 }]]));

      await poller.sweepQuotes();

      expect(service.applyTick).toHaveBeenCalledWith({ token: '999', exchange: 'NFO' }, 12);
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
      userFeeds.fetchQuotes.mockImplementation((_userId: string, refs: Array<{ token: string }>) =>
        Promise.resolve(new Map(refs.map((r) => [r.token, { ltp: Number(r.token) }]))),
      );

      await poller.sweepQuotes();

      expect(userFeeds.fetchQuotes).toHaveBeenCalledTimes(2);
      expect(userFeeds.fetchQuotes).toHaveBeenCalledWith('u1', [
        { token: '111', exchange: 'NFO' },
        { token: '222', exchange: 'NSE' },
        { token: '333', exchange: 'MCX' },
      ]);
      expect(userFeeds.fetchQuotes).toHaveBeenCalledWith('u2', [{ token: '444', exchange: 'NSE' }]);
      expect(service.applyTick).toHaveBeenCalledTimes(4);
      expect(service.applyTick).toHaveBeenCalledWith({ token: '333', exchange: 'MCX' }, 333);
    });

    it('prices far more tokens than the 30-slot socket pool could carry', async () => {
      const refs = Array.from({ length: 50 }, (_, i) => ({ token: `t${i}`, exchange: 'NSE' }));
      service.openTrackerRefsByUser.mockResolvedValue(new Map([['u1', refs]]));
      userFeeds.fetchQuotes.mockResolvedValue(new Map(refs.map((r) => [r.token, { ltp: 7 }])));

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
        userId === 'u1' ? Promise.reject(new Error('Invalid session')) : Promise.resolve(new Map([['222', { ltp: 99 }]])),
      );

      await poller.sweepQuotes();

      expect(userFeeds.fetchQuotes).toHaveBeenCalledTimes(2);
      expect(service.applyTick).toHaveBeenCalledTimes(1);
      expect(service.applyTick).toHaveBeenCalledWith({ token: '222', exchange: 'NSE' }, 99);
    });

    it('a shared instrument is quoted once, and a second holder can cover a failed session', async () => {
      service.openTrackerRefsByUser.mockResolvedValue(
        new Map([
          ['u1', [{ token: 'SHARED', exchange: 'NSE' }]],
          ['u2', [{ token: 'SHARED', exchange: 'NSE' }]],
          ['u3', [{ token: 'SHARED', exchange: 'NSE' }]],
        ]),
      );
      userFeeds.fetchQuotes.mockImplementation((userId: string) =>
        userId === 'u1' ? Promise.reject(new Error('Invalid session')) : Promise.resolve(new Map([['SHARED', { ltp: 55 }]])),
      );

      await poller.sweepQuotes();

      // u1 failed, u2 answered, u3 was never asked — the legacy price is market-wide.
      expect(userFeeds.fetchQuotes).toHaveBeenCalledTimes(2);
      expect(service.applyTick).toHaveBeenCalledTimes(1);
      expect(service.applyTick).toHaveBeenCalledWith({ token: 'SHARED', exchange: 'NSE' }, 55);
    });

    it('legacy: keeps the same token on two exchanges apart', async () => {
      // The socket cache and Angel's REST answer are both keyed by token alone.
      feed.getQuote.mockReturnValue(liveQuote(1));
      service.openTrackerRefsByUser.mockResolvedValue(
        new Map([
          ['u1', [{ token: '500', exchange: 'NSE' }]],
          ['u2', [{ token: '500', exchange: 'MCX' }]],
        ]),
      );
      userFeeds.fetchQuotes.mockImplementation((userId: string) =>
        Promise.resolve(new Map([['500', { ltp: userId === 'u1' ? 9 : 7000 }]])),
      );

      await poller.sweepQuotes();

      // The token-only socket cache cannot tell the two apart, so it is not read for them.
      expect(feed.getQuote).not.toHaveBeenCalled();
      expect(service.applyTick).toHaveBeenCalledWith({ token: '500', exchange: 'NSE' }, 9);
      expect(service.applyTick).toHaveBeenCalledWith({ token: '500', exchange: 'MCX' }, 7000);
      expect(service.applyTick).toHaveBeenCalledTimes(2);
    });

    it('legacy: a token-keyed REST answer is not guessed onto one of two exchanges', async () => {
      service.openTrackerRefsByUser.mockResolvedValue(
        new Map([['u1', [{ token: '500', exchange: 'NSE' }, { token: '500', exchange: 'MCX' }]]]),
      );
      userFeeds.fetchQuotes.mockResolvedValue(new Map([['500', { ltp: 9 }]]));

      await poller.sweepQuotes();

      expect(service.applyTick).not.toHaveBeenCalled();
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
      feed.getQuote.mockImplementation((token: string) => (token === '111' ? liveQuote(0) : null));
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

describe('TradeTrackerPoller — hub tier (HUB_PRICES_POSITIONS)', () => {
  const IST = (local: string) => Date.parse(`${local}+05:30`);
  const OPT = { token: '35001', exchange: 'NFO' };
  let poller: TradeTrackerPoller;
  let engine: HubEngine;
  let broker: FakeBroker;
  let feed: { subscribe: jest.Mock; getQuote: jest.Mock; isMarketOpen: jest.Mock };
  let userFeeds: { fetchQuotes: jest.Mock };
  let service: { backfill: jest.Mock; distinctOpenTokens: jest.Mock; openTrackerRefsByUser: jest.Mock; applyTick: jest.Mock };
  let record: jest.Mock;
  /** Users the hub serves: stands in for MarketHubService.hubFor (owner + flag on). */
  let serves: Set<string>;

  beforeEach(async () => {
    record = jest.fn();
    serves = new Set(['owner']);
    const source = {
      hubFor: jest.fn((userId: string | null) => (userId !== null && serves.has(userId) ? engineHubPrices(engine) : null)),
      record,
    };
    feed = { subscribe: jest.fn(), getQuote: jest.fn().mockReturnValue(null), isMarketOpen: jest.fn().mockReturnValue(true) };
    userFeeds = { fetchQuotes: jest.fn().mockResolvedValue(new Map()) };
    service = {
      backfill: jest.fn(),
      distinctOpenTokens: jest.fn(),
      openTrackerRefsByUser: jest.fn().mockResolvedValue(new Map([['owner', [OPT]]])),
      applyTick: jest.fn(),
    };
    const mod = await Test.createTestingModule({
      providers: [
        TradeTrackerPoller,
        { provide: PrismaService, useValue: { brokerCredential: { findMany: jest.fn() } } },
        { provide: MarketFeedService, useValue: feed },
        { provide: UserFeedManager, useValue: userFeeds },
        { provide: TradeTrackerService, useValue: service },
        { provide: HUB_PRICE_SOURCE, useValue: source },
      ],
    }).compile();
    poller = mod.get(TradeTrackerPoller);

    jest.useFakeTimers();
    jest.setSystemTime(IST('2026-10-07T10:00:00')); // Wednesday, NSE/NFO/MCX open
    broker = new FakeBroker();
    engine = new HubEngine({ broker, clock: new SessionClock({ holidays: MARKET_HOLIDAYS }), cap: 50, defaults: [] });
    await engine.start();
    broker.emitState('live'); // socket up: no critical-lane polling in these tests
    await engine.setPositions([{ exchange: 'NFO', token: '35001', symbol: 'NIFTY26OCT25000CE' }]);
  });

  afterEach(() => {
    poller.onModuleDestroy();
    engine.stop();
    jest.useRealTimers();
  });

  it('prices the owner’s position from a fresh hub price, scoped to the owner, with no broker call', async () => {
    broker.emitTick(FakeBroker.tick('35001', 250.5, 'NFO'));

    await poller.sweepQuotes();

    expect(service.applyTick).toHaveBeenCalledTimes(1);
    expect(service.applyTick).toHaveBeenCalledWith({ exchange: 'NFO', token: '35001' }, 250.5, { userId: 'owner' });
    expect(userFeeds.fetchQuotes).not.toHaveBeenCalled();
    expect(feed.getQuote).not.toHaveBeenCalled();
    expect(record).toHaveBeenCalledWith('positions', 'hub', 1);
    expect(record).toHaveBeenCalledWith('positions', 'unpriced', 0);
  });

  it('between sweeps, every hub price for an owned position reaches applyTick (the ≤ 5 s path), subscribed once', async () => {
    await poller.sweepQuotes(); // learns the owned set and subscribes
    await poller.sweepQuotes(); // must not subscribe a second listener
    service.applyTick.mockClear();

    broker.emitTick(FakeBroker.tick('35001', 251, 'NFO'));

    expect(service.applyTick).toHaveBeenCalledTimes(1);
    expect(service.applyTick).toHaveBeenCalledWith({ exchange: 'NFO', token: '35001' }, 251, { userId: 'owner' });
  });

  it('a never-priced or stale hub answer falls back to the legacy tiers over the owner’s own session', async () => {
    userFeeds.fetchQuotes.mockResolvedValue(new Map([['35001', { ltp: 41.2 }]]));

    await poller.sweepQuotes(); // the hub has never priced it yet

    expect(userFeeds.fetchQuotes).toHaveBeenCalledWith('owner', [OPT]);
    expect(service.applyTick).toHaveBeenCalledWith(OPT, 41.2);
    expect(record).toHaveBeenCalledWith('positions', 'legacy', 1);

    broker.emitTick(FakeBroker.tick('35001', 250.5, 'NFO'));
    service.applyTick.mockClear();
    userFeeds.fetchQuotes.mockClear();
    jest.setSystemTime(Date.now() + 6000); // older than the 5 s bound

    await poller.sweepQuotes();

    expect(service.applyTick).not.toHaveBeenCalledWith(expect.anything(), 250.5, expect.anything());
    expect(userFeeds.fetchQuotes).toHaveBeenCalledWith('owner', [OPT]);
  });

  it('never prices a non-owner’s tracker from the owner’s hub', async () => {
    service.openTrackerRefsByUser.mockResolvedValue(new Map([['owner', [OPT]], ['u2', [OPT]]]));
    userFeeds.fetchQuotes.mockResolvedValue(new Map([['35001', { ltp: 249 }]]));
    broker.emitTick(FakeBroker.tick('35001', 250.5, 'NFO'));

    await poller.sweepQuotes();

    expect(service.applyTick).toHaveBeenCalledWith({ exchange: 'NFO', token: '35001' }, 250.5, { userId: 'owner' });
    // u2 is priced over u2's OWN session (legacy), never by the owner's hub.
    expect(userFeeds.fetchQuotes).toHaveBeenCalledTimes(1);
    expect(userFeeds.fetchQuotes).toHaveBeenCalledWith('u2', [OPT]);
    expect(service.applyTick).toHaveBeenCalledWith(OPT, 249);

    broker.emitTick(FakeBroker.tick('35001', 252, 'NFO'));
    const scopes = service.applyTick.mock.calls.map((c) => (c[2] as { userId: string } | undefined)?.userId ?? null);
    expect(scopes).not.toContain('u2');
    expect(service.applyTick).toHaveBeenLastCalledWith({ exchange: 'NFO', token: '35001' }, 252, { userId: 'owner' });
  });

  it('same token on two exchanges: the hub prices each instrument separately', async () => {
    const MCX = { token: '35001', exchange: 'MCX' };
    await engine.setPositions([
      { exchange: 'NFO', token: '35001', symbol: 'NIFTY26OCT25000CE' },
      { exchange: 'MCX', token: '35001', symbol: 'CRUDEOIL26OCTFUT' },
    ]);
    service.openTrackerRefsByUser.mockResolvedValue(new Map([['owner', [OPT, MCX]]]));
    userFeeds.fetchQuotes.mockResolvedValue(new Map([['35001', { ltp: 41.2 }]]));
    broker.emitTick(FakeBroker.tick('35001', 6400, 'MCX'));

    await poller.sweepQuotes();

    expect(service.applyTick).toHaveBeenCalledWith({ exchange: 'MCX', token: '35001' }, 6400, { userId: 'owner' });
    expect(service.applyTick).not.toHaveBeenCalledWith({ exchange: 'NFO', token: '35001' }, 6400, expect.anything());
    // The NFO contract was not hub-priced, so it went to REST alone: its answer is unambiguous.
    expect(userFeeds.fetchQuotes).toHaveBeenCalledWith('owner', [OPT]);
    expect(service.applyTick).toHaveBeenCalledWith(OPT, 41.2);
    expect(feed.getQuote).not.toHaveBeenCalled();
  });

  it('with no hub for the user (flag off or hub not running) the sweep is exactly the legacy path', async () => {
    serves.clear();
    broker.emitTick(FakeBroker.tick('35001', 250.5, 'NFO'));
    userFeeds.fetchQuotes.mockResolvedValue(new Map([['35001', { ltp: 41.2 }]]));

    await poller.sweepQuotes();

    expect(service.applyTick).toHaveBeenCalledTimes(1);
    expect(service.applyTick).toHaveBeenCalledWith(OPT, 41.2);
    broker.emitTick(FakeBroker.tick('35001', 251, 'NFO'));
    expect(service.applyTick).toHaveBeenCalledTimes(1); // no listener was ever attached
  });

  it('stops applying hub ticks once the position is no longer open', async () => {
    await poller.sweepQuotes();
    service.openTrackerRefsByUser.mockResolvedValue(new Map());
    await poller.sweepQuotes();
    service.applyTick.mockClear();

    broker.emitTick(FakeBroker.tick('35001', 251, 'NFO'));

    expect(service.applyTick).not.toHaveBeenCalled();
  });

  it('an owner instrument the hub priced fresh gets NO unscoped legacy tick in the same sweep (no hub/legacy flip-flop)', async () => {
    // Every legacy tier would answer if asked: a live socket quote and a REST answer.
    feed.getQuote.mockReturnValue(liveQuote(240, 'NFO'));
    userFeeds.fetchQuotes.mockResolvedValue(new Map([['35001', { ltp: 241 }]]));
    broker.emitTick(FakeBroker.tick('35001', 250.5, 'NFO'));

    await poller.sweepQuotes();

    const unscoped = service.applyTick.mock.calls.filter((c) => c[2] === undefined);
    expect(unscoped).toEqual([]);
    expect(service.applyTick).toHaveBeenCalledWith({ exchange: 'NFO', token: '35001' }, 250.5, { userId: 'owner' });
    expect(feed.getQuote).not.toHaveBeenCalled();
    expect(userFeeds.fetchQuotes).not.toHaveBeenCalled();
    expect(record).toHaveBeenCalledWith('positions', 'hub', 1);
    expect(record).toHaveBeenCalledWith('positions', 'legacy', 0);
  });

  it('owner instruments the hub could not price fresh still take the socket tier, unscoped and counted as legacy', async () => {
    const CASH = { token: '2885', exchange: 'NSE' };
    service.openTrackerRefsByUser.mockResolvedValue(new Map([['owner', [OPT, CASH]]]));
    feed.getQuote.mockImplementation((token: string) => (token === '2885' ? liveQuote(1300, 'NSE') : null));
    broker.emitTick(FakeBroker.tick('35001', 250.5, 'NFO'));

    await poller.sweepQuotes();

    expect(service.applyTick).toHaveBeenCalledWith({ exchange: 'NFO', token: '35001' }, 250.5, { userId: 'owner' });
    expect(service.applyTick).toHaveBeenCalledWith(CASH, 1300);
    expect(service.applyTick).not.toHaveBeenCalledWith(OPT, expect.anything());
    expect(feed.getQuote).not.toHaveBeenCalledWith('35001');
    expect(record).toHaveBeenCalledWith('positions', 'hub', 1);
    expect(record).toHaveBeenCalledWith('positions', 'legacy', 1);
  });

  describe('a hub that silently stops serving is visible (I2)', () => {
    const hubZeroWarns = (warn: jest.SpyInstance) =>
      warn.mock.calls.filter((c) => /hub served 0 of/.test(String(c[0])));

    it('5 sweeps with a served user and hub-unpriceable refs → one warn, at most once per 10 min', async () => {
      const warn = jest.spyOn((poller as any).logger, 'warn').mockImplementation(() => undefined);
      userFeeds.fetchQuotes.mockResolvedValue(new Map([['35001', { ltp: 41.2 }]])); // legacy covers it

      for (let i = 0; i < 4; i++) await poller.sweepQuotes();
      expect(hubZeroWarns(warn)).toHaveLength(0);
      await poller.sweepQuotes(); // the 5th consecutive hub=0 sweep
      expect(hubZeroWarns(warn)).toHaveLength(1);
      expect(String(hubZeroWarns(warn)[0][0])).toMatch(/hub served 0 of 1 open instrument\(s\) for 1 hub-served user\(s\)/);
      expect(String(hubZeroWarns(warn)[0][0])).not.toMatch(/owner/);

      for (let i = 0; i < 10; i++) await poller.sweepQuotes(); // still within 10 minutes
      expect(hubZeroWarns(warn)).toHaveLength(1);

      jest.setSystemTime(Date.now() + 10 * 60_000);
      for (let i = 0; i < 5; i++) await poller.sweepQuotes();
      expect(hubZeroWarns(warn)).toHaveLength(2);
    });

    it('a hub-served sweep resets the run', async () => {
      const warn = jest.spyOn((poller as any).logger, 'warn').mockImplementation(() => undefined);
      userFeeds.fetchQuotes.mockResolvedValue(new Map([['35001', { ltp: 41.2 }]]));

      for (let i = 0; i < 4; i++) await poller.sweepQuotes();
      broker.emitTick(FakeBroker.tick('35001', 250.5, 'NFO'));
      await poller.sweepQuotes(); // hub-served: the run starts over
      jest.setSystemTime(Date.now() + 6000); // the hub price is now older than 5 s
      for (let i = 0; i < 4; i++) await poller.sweepQuotes();
      expect(hubZeroWarns(warn)).toHaveLength(0);
      await poller.sweepQuotes();
      expect(hubZeroWarns(warn)).toHaveLength(1);
    });

    it('no warn while the instruments’ own exchange is shut (NFO at 18:00, the sweep runs for MCX)', async () => {
      const warn = jest.spyOn((poller as any).logger, 'warn').mockImplementation(() => undefined);
      jest.setSystemTime(IST('2026-10-07T18:00:00')); // the sweep's gate is open (MCX), NFO is closed
      userFeeds.fetchQuotes.mockResolvedValue(new Map([['35001', { ltp: 41.2 }]]));

      for (let i = 0; i < 10; i++) await poller.sweepQuotes();

      expect(hubZeroWarns(warn)).toHaveLength(0);
    });

    it('no warn when hubFor is null (flag off or a non-served user)', async () => {
      const warn = jest.spyOn((poller as any).logger, 'warn').mockImplementation(() => undefined);
      serves.clear();
      userFeeds.fetchQuotes.mockResolvedValue(new Map([['35001', { ltp: 41.2 }]]));

      for (let i = 0; i < 10; i++) await poller.sweepQuotes();

      expect(hubZeroWarns(warn)).toHaveLength(0);
    });
  });

  describe('position counters count only hub-served users (M1)', () => {
    it('a non-served user’s legacy and unpriced instruments never land in consumers.positions', async () => {
      const CASH = { token: '2885', exchange: 'NSE' };
      const BANK = { token: '1333', exchange: 'NSE' };
      service.openTrackerRefsByUser.mockResolvedValue(new Map([['owner', [OPT]], ['u2', [CASH, BANK]]]));
      // u2: CASH priced from the socket (legacy), BANK answered by nobody (unpriced).
      feed.getQuote.mockImplementation((token: string) => (token === '2885' ? liveQuote(1300, 'NSE') : null));
      broker.emitTick(FakeBroker.tick('35001', 250.5, 'NFO'));

      await poller.sweepQuotes();

      expect(service.applyTick).toHaveBeenCalledWith(CASH, 1300); // u2 is still priced, just not counted
      expect(record).toHaveBeenCalledWith('positions', 'hub', 1);
      expect(record).toHaveBeenCalledWith('positions', 'legacy', 0);
      expect(record).toHaveBeenCalledWith('positions', 'unpriced', 0);
    });

    it('a served user’s own legacy and unpriced instruments are still counted', async () => {
      const CASH = { token: '2885', exchange: 'NSE' };
      const BANK = { token: '1333', exchange: 'NSE' };
      service.openTrackerRefsByUser.mockResolvedValue(new Map([['owner', [OPT, CASH, BANK]]]));
      feed.getQuote.mockImplementation((token: string) => (token === '2885' ? liveQuote(1300, 'NSE') : null));
      broker.emitTick(FakeBroker.tick('35001', 250.5, 'NFO'));

      await poller.sweepQuotes();

      expect(record).toHaveBeenCalledWith('positions', 'hub', 1);
      expect(record).toHaveBeenCalledWith('positions', 'legacy', 1);
      expect(record).toHaveBeenCalledWith('positions', 'unpriced', 1);
    });

    it('with no hub-served user the sweep records nothing for positions', async () => {
      serves.clear();
      userFeeds.fetchQuotes.mockResolvedValue(new Map([['35001', { ltp: 41.2 }]]));

      await poller.sweepQuotes();

      expect(record).not.toHaveBeenCalled();
    });
  });

  describe('a throwing hub tier never costs the legacy price (H2)', () => {
    it('hub.prices throws → legacy still prices, no rejection, one rate-limited warn', async () => {
      const warn = jest.spyOn((poller as any).logger, 'warn').mockImplementation(() => undefined);
      jest.spyOn(engine, 'prices').mockImplementation(() => {
        throw new Error('hub exploded');
      });
      userFeeds.fetchQuotes.mockResolvedValue(new Map([['35001', { ltp: 41.2 }]]));

      await expect(poller.sweepQuotes()).resolves.toBeUndefined();
      await expect(poller.sweepQuotes()).resolves.toBeUndefined();

      expect(service.applyTick).toHaveBeenCalledWith(OPT, 41.2);
      expect(warn.mock.calls.filter((c) => /hub tier failed/.test(String(c[0])))).toHaveLength(1);
    });
  });
});
