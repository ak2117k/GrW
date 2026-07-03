// Queue/job names, rate + concurrency knobs, and shared Bull job options for the
// TDA-010 signal fan-out engine.

import type { JobOptions } from 'bull';

/** Queue names (§3). */
export const SIGNAL_FANOUT_QUEUE = 'signal-fanout';
export const EXECUTE_USER_QUEUE = 'execute-user';
export const EXECUTE_USER_DEAD_QUEUE = 'execute-user-dead';

/** Job names. */
export const FANOUT_JOB = 'fanout';
export const EXECUTE_USER_JOB = 'execute-user';

/**
 * Angel One rate-limit refill target (§5). A deliberate margin under Angel's
 * 10 req/sec, matching the existing adapter's conservative posture.
 */
export const ANGEL_REFILL_PER_SEC = 8;

/** execute-user worker concurrency (§5) — N users progress in parallel; the
 * per-user token bucket, not this, bounds a single user's broker call rate. */
export const EXECUTE_USER_CONCURRENCY = 5;

/** Max time `PerUserRateLimiter.acquire` waits for a token before throwing. */
export const RATE_ACQUIRE_TIMEOUT_MS = 5000;

/**
 * Per-job retry/backoff (§6): 2s → 4s → 8s. `removeOnFail:false` retains the
 * exhausted job so the DLQ move + inspection can read its payload.
 */
export const FANOUT_JOB_OPTS: JobOptions = {
  attempts: 3,
  backoff: { type: 'exponential', delay: 2000 },
  removeOnComplete: true,
  removeOnFail: false,
};
