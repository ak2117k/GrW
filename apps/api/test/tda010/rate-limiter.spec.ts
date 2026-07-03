import { PerUserRateLimiter, RateAcquireTimeoutError } from '../../src/modules/signal-fanout/services/per-user-rate-limiter';

describe('PerUserRateLimiter', () => {
  let limiter: PerUserRateLimiter;

  beforeEach(() => {
    limiter = new PerUserRateLimiter();
  });

  it('self-paces a single-user burst to ~8/sec while another user is unaffected', async () => {
    // Saturate userA's bucket: 8 burst tokens are immediate, the 4 over-budget
    // tokens refill at 8/sec (~125ms each) → the 12th resolves ~500ms in.
    const start = Date.now();
    for (let i = 0; i < 12; i++) {
      await limiter.acquire('userA');
    }
    const userAElapsed = Date.now() - start;
    expect(userAElapsed).toBeGreaterThanOrEqual(300);

    // userB has its own bucket — a single acquire resolves immediately.
    const bStart = Date.now();
    await limiter.acquire('userB');
    expect(Date.now() - bStart).toBeLessThan(50);
  }, 10000);

  it('grants the full burst (8) immediately for a fresh user', async () => {
    const start = Date.now();
    for (let i = 0; i < 8; i++) {
      await limiter.acquire('freshUser');
    }
    expect(Date.now() - start).toBeLessThan(50);
  });

  it('throws RateAcquireTimeoutError when a token cannot be acquired within the cap', async () => {
    // Drain the burst, then demand another token with a tiny timeout it can't meet.
    for (let i = 0; i < 8; i++) await limiter.acquire('slowUser');
    await expect(limiter.acquire('slowUser', 1, 5)).rejects.toBeInstanceOf(RateAcquireTimeoutError);
  });
});
