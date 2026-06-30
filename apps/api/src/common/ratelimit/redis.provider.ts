import { Provider } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Redis from 'ioredis';
import { MemoryRateLimitStore } from './memory-rate-limit.store';
import { RATE_LIMIT_STORE, RateLimitStore } from './rate-limit-store.interface';
import { RedisRateLimitStore } from './redis-rate-limit.store';

/** DI token for the shared ioredis client (only instantiated when gated on). */
export const REDIS_CLIENT = Symbol('REDIS_CLIENT');

/**
 * Whether the Redis-backed rate-limit storage is gated ON. Defaults to OFF so
 * dev/test/CI run fully in-memory with no Redis dependency. Flip to 'true' in
 * production to share counters across instances.
 */
export function redisThrottlerEnabled(): boolean {
  return process.env.REDIS_THROTTLER === 'true';
}

/**
 * `REDIS_CLIENT` factory. GATED: returns a shared ioredis connection from the
 * `redis.*` config ONLY when `REDIS_THROTTLER==='true'`; otherwise `null`, so no
 * socket is opened in dev/test/CI.
 */
export const redisClientProvider: Provider = {
  provide: REDIS_CLIENT,
  inject: [ConfigService],
  useFactory: (config: ConfigService): Redis | null => {
    if (!redisThrottlerEnabled()) return null;
    return new Redis({
      host: config.get<string>('redis.host'),
      port: config.get<number>('redis.port'),
      password: config.get<string>('redis.password') || undefined,
    });
  },
};

/**
 * `RATE_LIMIT_STORE` factory consumed by the per-account limiter (Task 7). When
 * Redis is gated on, wraps the shared client in {@link RedisRateLimitStore};
 * otherwise falls back to the in-process {@link MemoryRateLimitStore}.
 */
export const rateLimitStoreProvider: Provider = {
  provide: RATE_LIMIT_STORE,
  inject: [REDIS_CLIENT],
  useFactory: (redis: Redis | null): RateLimitStore =>
    redis ? new RedisRateLimitStore(redis) : new MemoryRateLimitStore(),
};

/**
 * Storage seam for `@nestjs/throttler`'s global guard.
 *
 * Gated: when `REDIS_THROTTLER==='true'` a Redis-backed `ThrottlerStorage`
 * should be supplied so the central throttler shares counters across instances.
 * That requires `@nest-lab/throttler-storage-redis` (or a thin ThrottlerStorage
 * adapter over {@link RedisRateLimitStore}) — DEFERRED to prod wiring; the
 * package is intentionally NOT added in this lane. Until then this returns
 * `undefined`, so ThrottlerModule uses its DEFAULT in-memory storage.
 */
export function throttlerStorageFactory(): undefined {
  // NOTE(prod): add `@nest-lab/throttler-storage-redis` and return
  //   new ThrottlerStorageRedisService(redisClient)
  // here when REDIS_THROTTLER is enabled. Kept undefined for dev/test/CI.
  return undefined;
}
