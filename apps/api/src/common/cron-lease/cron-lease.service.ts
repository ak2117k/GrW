import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { randomUUID } from 'crypto';
import { CRON_LEASE_REDIS, LeaseRedis } from './cron-lease.redis';

/**
 * What to do when REDIS ITSELF is unreachable — the caller must decide, because
 * there is no answer that is right for every job.
 *
 * `run-anyway` (fail-OPEN): correct for work that is merely WASTEFUL when it
 * happens twice — an instrument-master refresh, a cache warm, a stats
 * recompute. Redis having a bad minute must not silently stop all scheduled
 * work; a refresh that runs twice costs a few duplicate reads, a refresh that
 * stops running rots the data everything else reads.
 *
 * `skip` (fail-CLOSED): correct for work that SPENDS MONEY or PLACES ORDERS —
 * an LLM-judged sentinel cycle, an auto-trade execution pass, a broker order
 * reconcile that can re-submit. Doubling those is worse than skipping them: a
 * skipped tick is recovered by the next tick, a duplicated order or a duplicated
 * metered-API cycle is not recoverable at all.
 */
export type LeaseFailureMode = 'run-anyway' | 'skip';

/**
 * Compare-and-delete: only delete the key if it still holds OUR token.
 *
 * This is not defensive padding, it is the whole correctness argument for the
 * release. Deleting by key alone is safe only while the job finishes inside its
 * TTL, and the case that matters is precisely the one where it does not. Picture
 * a 60s TTL on a reconcile that today takes 20s and one bad morning takes 75s:
 * at t=60 the lease expires, at t=61 instance B legitimately acquires it and
 * starts working, at t=75 instance A finishes and issues an unconditional DEL —
 * wiping a lease it no longer owns while B is mid-run. The next tick then finds
 * the key free and a third runner joins. A delete-by-key lease does not merely
 * fail to prevent double-runs under slowness, it manufactures them.
 *
 * Runs as a Lua script because the get-then-delete must be ATOMIC; done as two
 * round-trips, the same expiry can land in the gap between them and reintroduce
 * exactly the bug. (`redis.call` here is server-side Redis Lua — this is EVAL
 * the Redis command, no JavaScript is being evaluated.)
 */
const RELEASE_IF_OWNER =
  "if redis.call('get',KEYS[1])==ARGV[1] then return redis.call('del',KEYS[1]) else return 0 end";

/**
 * Mutual exclusion for scheduled work across app instances.
 *
 * There are ~47 `@Cron`/`@Interval` jobs in this codebase and, before this, no
 * distributed lock anywhere. That is invisible with exactly one Render instance
 * and stops being invisible the moment there are two — a scale-up, or the
 * ordinary rolling deploy where the outgoing and incoming containers overlap for
 * a minute. Then every job fires twice: two instrument-master refreshes, two
 * broker reconciles, two sentinel cycles per user, double consumption of Angel
 * One's 10 req/sec budget and double billing against a metered LLM API.
 *
 * The trade-sentinel's in-process `inFlight` Set is not a substitute: it is a
 * Set inside ONE node process and knows nothing about the container next door.
 * Cross-container exclusion has to live in shared state, which is Redis.
 */
@Injectable()
export class CronLeaseService {
  private readonly logger = new Logger(CronLeaseService.name);

  /**
   * Identity of this process's lease holdings, unique per boot. Combined below
   * with a monotonic counter so that each ACQUISITION — not merely each process
   * — gets its own token: a job whose lease expired mid-run and was re-acquired
   * by this same process on a later tick must not be able to release the newer
   * acquisition when the older run finally returns. Same hazard as the
   * cross-instance one in {@link RELEASE_IF_OWNER}, same fix.
   */
  private readonly processId = randomUUID();
  private seq = 0;

  constructor(
    @Optional() @Inject(CRON_LEASE_REDIS) private readonly redis: LeaseRedis | null = null,
  ) {}

  /**
   * Run `fn` on at most one instance at a time; return `null` when another
   * instance already holds the lease (the job did NOT run — this is not an
   * error, it is the mechanism working).
   *
   * `ttlMs` IS A PER-JOB SAFETY NET, NOT A GUESS. It exists so a holder that
   * crashes, is OOM-killed, or has its container yanked mid-deploy does not
   * wedge the job forever — the lease evaporates on its own. The cost of that
   * property is that a TTL SHORTER THAN THE JOB'S ACTUAL RUNTIME permits a
   * second instance to start the job while the first is still running, which is
   * the exact outcome the lease exists to prevent. Set it comfortably above the
   * job's worst observed runtime (not its typical one), and keep it well under
   * the schedule interval so a crashed holder is cleared before the next tick.
   *
   * `onRedisError` is required and deliberately has no default: fail-open vs
   * fail-closed is a real decision with money on one side of it, and a default
   * would let a caller make that decision by accident. See
   * {@link LeaseFailureMode}.
   */
  async runExclusive<T>(
    jobName: string,
    ttlMs: number,
    fn: () => Promise<T>,
    onRedisError: LeaseFailureMode,
  ): Promise<T | null> {
    if (!Number.isFinite(ttlMs) || ttlMs <= 0) {
      // A zero/negative PX is rejected by Redis at the SET, which would surface
      // as a "Redis is broken" error and route through onRedisError — turning a
      // plain coding mistake into either silent double-runs or a silently dead
      // job. Fail loudly at the call site instead.
      throw new Error(`CronLeaseService: ttlMs must be a positive number (job "${jobName}")`);
    }

    // Leasing switched off (dev/CI, or a deliberately single-instance deploy):
    // run the job. Skipping here would make scheduled work simply disappear on
    // every machine that has no Redis.
    if (!this.redis) return fn();

    const key = `cron-lease:${jobName}`;
    const token = `${this.processId}:${++this.seq}`;

    let acquired: boolean;
    try {
      acquired = (await this.redis.set(key, token, 'PX', ttlMs, 'NX')) === 'OK';
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (onRedisError === 'skip') {
        this.logger.error(
          `Lease "${jobName}" unavailable (Redis: ${msg}) — SKIPPING this run (fail-closed). ` +
            `The next tick retries; a duplicate run of this job is costlier than a missed one.`,
        );
        return null;
      }
      this.logger.warn(
        `Lease "${jobName}" unavailable (Redis: ${msg}) — running ANYWAY (fail-open). ` +
          `If a second instance is live this run may be duplicated.`,
      );
      return fn();
    }

    if (!acquired) {
      this.logger.debug(`Lease "${jobName}" held by another instance — skipping this run.`);
      return null;
    }

    try {
      return await fn();
    } finally {
      // In `finally` so a THROWING job releases immediately. Otherwise a job
      // that fails fast would still hold its lease for the whole TTL, and every
      // tick inside that window would be skipped — one exception would mute the
      // job for minutes.
      await this.release(key, token, jobName);
    }
  }

  /** Fail-OPEN convenience wrapper. See {@link LeaseFailureMode}. */
  async runExclusiveFailOpen<T>(
    jobName: string,
    ttlMs: number,
    fn: () => Promise<T>,
  ): Promise<T | null> {
    return this.runExclusive(jobName, ttlMs, fn, 'run-anyway');
  }

  /** Fail-CLOSED convenience wrapper. See {@link LeaseFailureMode}. */
  async runExclusiveFailClosed<T>(
    jobName: string,
    ttlMs: number,
    fn: () => Promise<T>,
  ): Promise<T | null> {
    return this.runExclusive(jobName, ttlMs, fn, 'skip');
  }

  private async release(key: string, token: string, jobName: string): Promise<void> {
    try {
      await this.redis!.eval(RELEASE_IF_OWNER, 1, key, token);
    } catch (err) {
      // Never let a release failure escape: it would replace the job's own
      // result (or its own exception, which is the one worth seeing) with a
      // Redis error. The TTL already guarantees the lease is eventually freed,
      // so the worst case of a failed release is one skipped tick.
      const msg = err instanceof Error ? err.message : String(err);
      this.logger.warn(`Lease "${jobName}" release failed (${msg}); it will expire via TTL.`);
    }
  }
}
