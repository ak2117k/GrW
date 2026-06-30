import Redis from 'ioredis';
import { RateLimitHit, RateLimitStore } from './rate-limit-store.interface';

/**
 * Redis-backed {@link RateLimitStore} for production / multi-instance deploys.
 *
 * Implements a fixed-window counter: `INCR` the key, and on the FIRST hit
 * (count === 1) set the window TTL via `PEXPIRE`. `PTTL` yields the ms until the
 * window resets. Only instantiated when the Redis throttler is gated on
 * (`REDIS_THROTTLER==='true'`) — see redis.provider.ts.
 */
export class RedisRateLimitStore implements RateLimitStore {
  constructor(private readonly redis: Redis) {}

  async hit(key: string, ttlMs: number): Promise<RateLimitHit> {
    const k = `rl:${key}`;
    const count = await this.redis.incr(k);
    if (count === 1) await this.redis.pexpire(k, ttlMs);
    const ttl = await this.redis.pttl(k);
    return { count, resetMs: ttl < 0 ? ttlMs : ttl };
  }
}
