/**
 * Boot must reach `app.listen()` even when Redis is unreachable.
 *
 * Nest awaits every `onModuleInit` before the port is bound, and Render fails a
 * deploy that never opens a port. `initRedis` awaited `subscribe()` on a client
 * built with ioredis defaults — `enableOfflineQueue: true` and a retry strategy
 * that never gives up — so an unreachable Redis produced a promise that neither
 * resolved nor rejected. The surrounding try/catch caught nothing, because
 * nothing was ever thrown. The service was healthy; it simply never listened.
 *
 * Observed as: "Port scan timeout reached, no open ports detected."
 */
const subscribeNeverSettles = jest.fn(() => new Promise<void>(() => {}));
const capturedOptions: Array<Record<string, unknown>> = [];

jest.mock('ioredis', () => ({
  __esModule: true,
  default: class FakeRedis {
    constructor(options: Record<string, unknown>) {
      capturedOptions.push(options);
    }
    on() {
      return this;
    }
    subscribe = subscribeNeverSettles;
    publish = jest.fn();
    quit = jest.fn().mockResolvedValue('OK');
  },
}));

import { MarketFeedService } from './market-feed.service';

describe('MarketFeedService boot — an unreachable Redis must not block the port bind', () => {
  const OLD_ENV = process.env.BOOT_JOBS;

  beforeEach(() => {
    capturedOptions.length = 0;
    subscribeNeverSettles.mockClear();
    // Isolate the Redis path: no feed auto-start, no broker traffic.
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

  it('resolves onModuleInit even when subscribe() never settles', async () => {
    const feed = buildFeed();

    // A hang here is the production failure. Race against a timer so the test
    // reports it as a failure rather than sitting until jest's own timeout.
    const settled = await Promise.race([
      feed.onModuleInit().then(() => 'initialised' as const),
      new Promise<'hung'>((resolve) => setTimeout(() => resolve('hung'), 1_000)),
    ]);

    expect(settled).toBe('initialised');
  });

  it('bounds the connection so an unreachable Redis fails instead of waiting', () => {
    // The same bounds cron-lease.redis.ts and auth.module.ts already use.
    // Without them ioredis queues the command offline and retries forever,
    // which is what turns a missing Redis into a hung boot.
    buildFeed().onModuleInit();

    expect(capturedOptions.length).toBeGreaterThan(0);
    for (const options of capturedOptions) {
      expect(options).toMatchObject({
        maxRetriesPerRequest: 1,
        enableOfflineQueue: false,
        connectTimeout: 3000,
      });
    }
  });
});
