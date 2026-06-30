import { RateLimitHit, RateLimitStore } from './rate-limit-store.interface';

/**
 * In-process {@link RateLimitStore} (dev/test default).
 *
 * A fixed-window counter backed by a `Map`, with LAZY expiry: an entry whose
 * window has elapsed is reset on the next `hit` rather than via a timer. This
 * keeps the store dependency-free (no Redis) at the cost of being per-process —
 * production with >1 instance should use the Redis-backed store instead.
 */
export class MemoryRateLimitStore implements RateLimitStore {
  private readonly buckets = new Map<string, { count: number; expiresAt: number }>();

  async hit(key: string, ttlMs: number): Promise<RateLimitHit> {
    const now = Date.now();
    const existing = this.buckets.get(key);

    if (!existing || existing.expiresAt <= now) {
      // First hit, or the previous window has elapsed: start a fresh window.
      const bucket = { count: 1, expiresAt: now + ttlMs };
      this.buckets.set(key, bucket);
      return { count: 1, resetMs: ttlMs };
    }

    existing.count += 1;
    return { count: existing.count, resetMs: Math.max(0, existing.expiresAt - now) };
  }
}
