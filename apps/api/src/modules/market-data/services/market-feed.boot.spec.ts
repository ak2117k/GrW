/**
 * The feed opens no Redis connection.
 *
 * It used to publish every tick to a `market:ticks` channel and subscribe to it,
 * "for cross-process distribution". No other process ever read that channel, and
 * the subscribe raced the connect (`enableOfflineQueue: false` refuses commands
 * before the socket is ready), so every boot logged "Stream isn't writeable" and
 * the channel had zero subscribers while each tick was still serialised and
 * published. Ticks are served from this process's memory; Redis here was pure
 * cost. Bull queues and the cron lease own their own Redis clients elsewhere.
 */
const constructed: unknown[] = [];

jest.mock('ioredis', () => ({
  __esModule: true,
  default: class FakeRedis {
    constructor(options: unknown) {
      constructed.push(options);
    }
    on() {
      return this;
    }
    subscribe = jest.fn().mockResolvedValue(1);
    publish = jest.fn().mockResolvedValue(0);
    quit = jest.fn().mockResolvedValue('OK');
  },
}));

import { MarketFeedService } from './market-feed.service';

describe('MarketFeedService boot — no Redis pub/sub', () => {
  const OLD_ENV = process.env.BOOT_JOBS;

  beforeEach(() => {
    constructed.length = 0;
    // No feed auto-start, no broker traffic.
    process.env.BOOT_JOBS = 'false';
  });

  afterEach(() => {
    if (OLD_ENV === undefined) delete process.env.BOOT_JOBS;
    else process.env.BOOT_JOBS = OLD_ENV;
  });

  function buildFeed(): MarketFeedService {
    const inert = new Proxy({}, { get: () => jest.fn() }) as never;
    return new MarketFeedService(
      { get: () => undefined } as never,
      inert,
      inert,
      inert,
      null as never,
      { isAuthenticated: () => false } as never,
      null as never,
    );
  }

  it('opens no Redis connection at boot', async () => {
    const feed = buildFeed();
    await feed.onModuleInit();
    await new Promise((resolve) => setImmediate(resolve));

    expect(constructed).toHaveLength(0);
  });

  it('shuts down cleanly with no Redis to close', async () => {
    const feed = buildFeed();
    await feed.onModuleInit();

    await expect(feed.onModuleDestroy()).resolves.toBeUndefined();
  });
});
