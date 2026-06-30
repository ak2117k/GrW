/**
 * TDA-004 Task 6 — pluggable rate-limit storage (unit test).
 *
 * Exercises the dev/test default {@link MemoryRateLimitStore}: a single-process
 * Map with lazy TTL expiry. No Redis required.
 *
 * Run from apps/api:
 *   npx jest --config test/tda004/jest.config.js --verbose
 */
import { MemoryRateLimitStore } from '../../src/common/ratelimit/memory-rate-limit.store';

describe('MemoryRateLimitStore', () => {
  it('increments within the window and resets after TTL', async () => {
    const s = new MemoryRateLimitStore();
    expect((await s.hit('k', 50)).count).toBe(1);
    expect((await s.hit('k', 50)).count).toBe(2);
    await new Promise((r) => setTimeout(r, 70));
    expect((await s.hit('k', 50)).count).toBe(1); // window expired
  });
  it('keys are independent', async () => {
    const s = new MemoryRateLimitStore();
    await s.hit('a', 1000);
    expect((await s.hit('b', 1000)).count).toBe(1);
  });
});
