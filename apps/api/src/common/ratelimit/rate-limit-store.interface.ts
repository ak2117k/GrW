/**
 * Pluggable rate-limit storage seam (TDA-004 Task 6).
 *
 * A minimal counter abstraction used by the per-account limiter (Task 7) and
 * any other fixed-window throttling. Two implementations exist:
 *   - {@link MemoryRateLimitStore} — single-process Map, the dev/test default.
 *   - RedisRateLimitStore — shared cross-instance counter for production.
 *
 * The implementation is selected at the composition root (see redis.provider.ts)
 * so callers depend only on this interface via the {@link RATE_LIMIT_STORE} token.
 */
export const RATE_LIMIT_STORE = Symbol('RATE_LIMIT_STORE');

/** Result of a single `hit`: the post-increment count and ms until the window resets. */
export interface RateLimitHit {
  count: number;
  resetMs: number;
}

export interface RateLimitStore {
  /**
   * Atomically increment the counter for `key` within a fixed `ttlMs` window
   * and return the new count plus the time remaining until the window resets.
   * The window starts on the first hit and is NOT extended by later hits.
   */
  hit(key: string, ttlMs: number): Promise<RateLimitHit>;
}
