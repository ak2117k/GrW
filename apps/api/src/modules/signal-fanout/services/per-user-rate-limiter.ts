import { Injectable } from '@nestjs/common';
import { ANGEL_REFILL_PER_SEC, RATE_ACQUIRE_TIMEOUT_MS } from '../constants';

/**
 * Thrown when {@link PerUserRateLimiter.acquire} cannot obtain a token within the
 * timeout cap. A TRANSIENT fault — TDA-011 classifies it as retryable so the
 * job's remaining Bull attempts can re-attempt after backoff.
 */
export class RateAcquireTimeoutError extends Error {
  constructor(userId: string) {
    super(`rate-limit token not acquired for user ${userId} within cap`);
    this.name = 'RateAcquireTimeoutError';
  }
}

interface Bucket {
  tokens: number;
  lastRefillMs: number;
}

/**
 * Per-user Angel One rate-limit isolation (TDA-010 §5).
 *
 * A token bucket keyed on `userId`, refilling at {@link ANGEL_REFILL_PER_SEC}
 * (8/sec — a margin under Angel's per-client 10/sec) with a burst equal to the
 * rate. `acquire` self-paces one user's burst WITHOUT touching another user's
 * bucket: the key includes `userId`, so User A saturating their 8/sec never
 * consumes User B's tokens. This is the rate-limit half of the §6 failure
 * isolation guarantee.
 *
 * NOTE: this MVP impl holds bucket state in-process, which is correct for a
 * single API replica. TDA-013 (horizontal scale) must back this with a
 * Redis-scripted bucket so the limit holds across replicas — the `acquire`
 * contract is unchanged.
 */
@Injectable()
export class PerUserRateLimiter {
  private readonly buckets = new Map<string, Bucket>();
  // Fixed at the Angel One refill target. Kept as fields (not constructor
  // params) so Nest can instantiate this provider — a primitive constructor
  // param is unresolvable by the DI container. Burst equals the rate.
  private readonly ratePerSec = ANGEL_REFILL_PER_SEC;
  private readonly burst = ANGEL_REFILL_PER_SEC;

  /**
   * Resolve when a token is available for `userId`; otherwise wait (bounded by
   * `timeoutMs`, default {@link RATE_ACQUIRE_TIMEOUT_MS}), throwing
   * {@link RateAcquireTimeoutError} if the cap elapses first.
   */
  async acquire(
    userId: string,
    weight = 1,
    timeoutMs: number = RATE_ACQUIRE_TIMEOUT_MS,
  ): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    // Loop: refill by elapsed time, consume if enough tokens, else sleep until
    // the next token would arrive (capped by the remaining deadline).
    for (;;) {
      const waitMs = this.tryConsume(userId, weight);
      if (waitMs === 0) return;
      const remaining = deadline - Date.now();
      if (remaining <= 0) throw new RateAcquireTimeoutError(userId);
      await sleep(Math.min(waitMs, remaining));
    }
  }

  /** Returns 0 if `weight` tokens were consumed, else ms until enough refill. */
  private tryConsume(userId: string, weight: number): number {
    const now = Date.now();
    const bucket = this.buckets.get(userId) ?? { tokens: this.burst, lastRefillMs: now };

    const elapsedSec = (now - bucket.lastRefillMs) / 1000;
    bucket.tokens = Math.min(this.burst, bucket.tokens + elapsedSec * this.ratePerSec);
    bucket.lastRefillMs = now;

    if (bucket.tokens >= weight) {
      bucket.tokens -= weight;
      this.buckets.set(userId, bucket);
      return 0;
    }

    this.buckets.set(userId, bucket);
    const deficit = weight - bucket.tokens;
    return Math.ceil((deficit / this.ratePerSec) * 1000);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
