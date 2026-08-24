import { HealthService, sessionContext, toFreshness } from './health.service';
import type { PrismaService } from '../../common/prisma/prisma.service';
import type { FeedStatusSource, HealthPayload, Signal } from './health.types';

/**
 * The contract under test is "a blind platform must LOOK blind". Every case
 * here is a real incident that `/healthz` reported as `ok`.
 */

const NOW = new Date('2026-08-18T05:30:00.000Z'); // 11:00 IST, mid-session

type MockPrisma = {
  $queryRaw: jest.Mock;
  candle: { aggregate: jest.Mock };
  tradeTracker: { aggregate: jest.Mock };
  sentinelVerdict: { aggregate: jest.Mock };
};

function makePrisma(overrides: Partial<MockPrisma> = {}): MockPrisma {
  return {
    $queryRaw: jest.fn().mockResolvedValue([{ '?column?': 1 }]),
    candle: {
      aggregate: jest
        .fn()
        .mockResolvedValue({ _max: { timestamp: new Date('2026-08-18T05:29:00.000Z') } }),
    },
    tradeTracker: {
      aggregate: jest.fn().mockResolvedValue({
        _max: { updatedAt: new Date('2026-08-18T05:29:30.000Z') },
        _count: { _all: 3 },
      }),
    },
    sentinelVerdict: {
      aggregate: jest
        .fn()
        .mockResolvedValue({ _max: { createdAt: new Date('2026-08-18T05:20:00.000Z') } }),
    },
    ...overrides,
  };
}

function makeFeed(): jest.Mocked<FeedStatusSource> {
  return {
    getStatus: jest.fn().mockReturnValue({
      feedActive: true,
      feedMode: 'WEBSOCKET',
      primarySubscriptions: 28,
      scanSubscriptions: 14,
      brokerAdapterAvailable: true,
    }),
    getSubscribedTokens: jest.fn().mockReturnValue(['1', '2', '3']),
    isMarketOpen: jest.fn().mockReturnValue(true),
  };
}

function build(prisma: MockPrisma, feed: FeedStatusSource | null = makeFeed()): HealthService {
  return new HealthService(prisma as unknown as PrismaService, feed);
}

/** Narrowing helper — a test that reads `.value` off an absent block should fail loudly. */
function value<T>(signal: Signal<T>): T {
  if (!signal.available) throw new Error(`expected signal to be available, got: ${signal.reason}`);
  return signal.value;
}

describe('HealthService', () => {
  beforeEach(() => {
    jest.useFakeTimers({ doNotFake: ['nextTick', 'setImmediate'] }).setSystemTime(NOW);
  });
  afterEach(() => {
    jest.useRealTimers();
    // Without this a spy on a global (process.uptime) survives into every
    // later test in the file, since jest is not configured with restoreMocks.
    jest.restoreAllMocks();
  });

  describe('the happy path reports every signal', () => {
    let payload: HealthPayload;

    beforeEach(async () => {
      payload = await build(makePrisma()).check();
    });

    it('keeps the legacy status/db/uptime fields the keep-warm cron reads', () => {
      expect(payload.status).toBe('ok');
      expect(payload.db).toBe('ok');
      expect(typeof payload.uptimeSec).toBe('number');
    });

    it('reports feed mode and the subscription-slot count', () => {
      expect(value(payload.feed)).toEqual({
        active: true,
        mode: 'WEBSOCKET',
        subscribedTokens: 3,
        primarySubscriptions: 28,
        scanSubscriptions: 14,
        brokerAdapterAvailable: true,
        feedThinksMarketOpen: true,
      });
    });

    it('reports the feed opinion of market-open next to the independent session', () => {
      // Agreement here is the boring case; disagreement is a feed that will not
      // subscribe because it thinks the market is shut, which makes every age
      // below it go stale for a non-network reason.
      expect(value(payload.feed).feedThinksMarketOpen).toBe(payload.session.marketOpen);
    });

    it('reports candle, tracker and verdict freshness as ages in seconds', () => {
      expect(value(payload.lastCandleAt).ageSec).toBe(60);
      expect(value(payload.lastTrackerUpdateAt).ageSec).toBe(30);
      expect(value(payload.lastVerdictAt).ageSec).toBe(600);
      expect(value(payload.openPositions)).toBe(3);
    });

    it('states the market session so an age can be interpreted', () => {
      // 11:00 IST on a Tuesday. The same 40 000s candle age is fine at 02:00
      // and means the feed is dead here; without this field the number is
      // unreadable and the endpoint is back to guessing.
      expect(payload.session).toEqual({
        istTime: '2026-08-18 11:00:00',
        marketOpen: true,
        phase: 'REGULAR',
      });
    });
  });

  describe('one failing query degrades exactly one signal', () => {
    it('does not throw, and leaves the other signals intact', async () => {
      const prisma = makePrisma();
      prisma.candle.aggregate.mockRejectedValue(new Error('deadlock detected'));

      const payload = await build(prisma).check();

      expect(payload.lastCandleAt).toEqual({
        available: false,
        reason: expect.stringContaining('deadlock detected'),
      });
      // Everything else still answers — this is the property that stops a
      // transient blip becoming a Render restart loop.
      expect(payload.status).toBe('ok');
      expect(payload.db).toBe('ok');
      expect(value(payload.openPositions)).toBe(3);
      expect(value(payload.lastVerdictAt).ageSec).toBe(600);
      expect(payload.feed.available).toBe(true);
    });

    it('marks db error without hiding the freshness signals', async () => {
      const prisma = makePrisma();
      prisma.$queryRaw.mockRejectedValue(new Error('connection refused'));

      const payload = await build(prisma).check();

      expect(payload.db).toBe('error');
      expect(payload.status).toBe('ok');
      expect(value(payload.lastCandleAt).ageSec).toBe(60);
    });

    it('degrades tracker age AND open count together, since they read one set', async () => {
      const prisma = makePrisma();
      prisma.tradeTracker.aggregate.mockRejectedValue(new Error('relation does not exist'));

      const payload = await build(prisma).check();

      expect(payload.lastTrackerUpdateAt.available).toBe(false);
      expect(payload.openPositions.available).toBe(false);
      expect(value(payload.lastCandleAt).ageSec).toBe(60);
    });

    it('reports a hung query as a stated budget overrun rather than hanging the probe', async () => {
      const prisma = makePrisma();
      prisma.sentinelVerdict.aggregate.mockReturnValue(new Promise(() => undefined));

      const pending = build(prisma).check();
      await jest.advanceTimersByTimeAsync(2_000);
      const payload = await pending;

      expect(payload.lastVerdictAt).toEqual({
        available: false,
        reason: expect.stringContaining('budget'),
      });
      expect(payload.status).toBe('ok');
    });

    it('reports the feed as unavailable-with-reason when it cannot be resolved', async () => {
      const payload = await build(makePrisma(), null).check();

      expect(payload.feed).toEqual({
        available: false,
        reason: expect.stringContaining('market feed'),
      });
    });

    it('survives a feed status getter that throws', async () => {
      const feed = makeFeed();
      feed.getStatus.mockImplementation(() => {
        throw new Error('ws closed');
      });

      const payload = await build(makePrisma(), feed).check();

      expect(payload.feed).toEqual({
        available: false,
        reason: expect.stringContaining('ws closed'),
      });
      expect(payload.status).toBe('ok');
    });
  });

  describe('a thing that has never run reports null, never zero', () => {
    it('reports the never-executed trade-sentinel as at:null / ageSec:null', async () => {
      const prisma = makePrisma();
      prisma.sentinelVerdict.aggregate.mockResolvedValue({ _max: { createdAt: null } });

      const payload = await build(prisma).check();

      // ageSec: 0 would read as "ran this instant" — the precise inversion of
      // the truth that kept a dead sentinel invisible in production.
      expect(value(payload.lastVerdictAt)).toEqual({ at: null, ageSec: null });
      expect(payload.lastVerdictAt.available).toBe(true);
    });

    it('reports an empty book as 0 open positions, which is a real reading', async () => {
      const prisma = makePrisma();
      prisma.tradeTracker.aggregate.mockResolvedValue({
        _max: { updatedAt: null },
        _count: { _all: 0 },
      });

      const payload = await build(prisma).check();

      expect(value(payload.openPositions)).toBe(0);
      expect(value(payload.lastTrackerUpdateAt)).toEqual({ at: null, ageSec: null });
    });
  });

  describe('the payload leaks nothing', () => {
    it('carries no credentials even when the driver puts them in the error', async () => {
      const prisma = makePrisma();
      const secret = 'postgresql://neondb_owner:npg_SUPERSECRET@ep-x.aws.neon.tech/td_saas';
      const err = new Error('connect ECONNREFUSED') as Error & { meta?: unknown };
      err.meta = { url: secret }; // Prisma really does attach this
      prisma.candle.aggregate.mockRejectedValue(err);

      const body = JSON.stringify(await build(prisma).check());

      expect(body).not.toContain('npg_SUPERSECRET');
      expect(body).not.toContain('neondb_owner');
      expect(body).not.toContain('postgresql://');
    });

    it('exposes no symbols, user ids or prices from the open book', async () => {
      const body = JSON.stringify(await build(makePrisma()).check());
      const keys = Object.keys(JSON.parse(body) as Record<string, unknown>).sort();
      expect(keys).toEqual([
        'checkedAt',
        'db',
        'feed',
        'lastCandleAt',
        'lastTrackerUpdateAt',
        'lastVerdictAt',
        'openPositions',
        'session',
        'status',
        'uptimeSec',
      ]);
    });

    it('caps a pathological error message so it cannot leak by volume', async () => {
      const prisma = makePrisma();
      prisma.candle.aggregate.mockRejectedValue(new Error('x'.repeat(5_000)));

      const payload = await build(prisma).check();

      expect(payload.lastCandleAt.available).toBe(false);
      if (!payload.lastCandleAt.available) {
        expect(payload.lastCandleAt.reason.length).toBeLessThanOrEqual(200);
      }
    });
  });

  describe('probe cost', () => {
    it('serves repeat probes from a short cache instead of re-querying', async () => {
      const prisma = makePrisma();
      const service = build(prisma);

      await service.check();
      await service.check();
      await service.check();

      expect(prisma.candle.aggregate).toHaveBeenCalledTimes(1);
    });

    it('still reports uptime exactly on a cached probe', async () => {
      // The OOM crash loop was only ever visible as uptime resetting to ~0.
      // Caching that number would have erased the single clue anyone had.
      //
      // BOTH readings are pinned. Leaving the first one as the real
      // process.uptime() -- which jest's fake timers do not control -- made
      // this test fail whenever the suite happened to boot ~7s before it ran,
      // because the real value collided with the mocked one.
      const uptime = jest.spyOn(process, 'uptime').mockReturnValue(3);
      const service = build(makePrisma());
      const first = await service.check();
      uptime.mockReturnValue(7);
      const second = await service.check();

      expect(first.uptimeSec).toBe(3);
      expect(second.uptimeSec).toBe(7);
    });

    it('collapses overlapping probes into a single collection', async () => {
      const prisma = makePrisma();
      const service = build(prisma);

      await Promise.all([service.check(), service.check(), service.check()]);

      expect(prisma.tradeTracker.aggregate).toHaveBeenCalledTimes(1);
    });
  });
});

describe('toFreshness', () => {
  it('maps no-rows to nulls rather than to an age of zero', () => {
    expect(toFreshness(null, NOW)).toEqual({ at: null, ageSec: null });
  });

  it('never reports a negative age from a host clock running ahead', () => {
    const future = new Date(NOW.getTime() + 5_000);
    expect(toFreshness(future, NOW).ageSec).toBe(0);
  });
});

describe('sessionContext', () => {
  it.each([
    ['2026-08-18T02:00:00.000Z', 'PRE_OPEN', false], // 07:30 IST Tue
    ['2026-08-18T03:45:00.000Z', 'REGULAR', true], // 09:15 IST Tue, open bell
    ['2026-08-18T10:00:00.000Z', 'REGULAR', true], // 15:30 IST Tue, close bell
    ['2026-08-18T10:01:00.000Z', 'POST_CLOSE', false], // 15:31 IST Tue
    ['2026-08-18T20:30:00.000Z', 'PRE_OPEN', false], // 02:00 IST Wed — stale is CORRECT here
    ['2026-08-16T05:30:00.000Z', 'WEEKEND', false], // Sunday
  ])('%s is %s', (iso, phase, open) => {
    const ctx = sessionContext(new Date(iso));
    expect(ctx.phase).toBe(phase);
    expect(ctx.marketOpen).toBe(open);
  });
});
