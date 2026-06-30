/**
 * Whether the Redis-backed rate-limit storage is gated ON. Defaults to OFF so
 * dev/test/CI run fully in-memory with no Redis dependency. Flip to 'true' in
 * production to share counters across instances.
 */
export function redisThrottlerEnabled(): boolean {
  return process.env.REDIS_THROTTLER === 'true';
}
