import { Injectable } from '@nestjs/common';
import { CronLeaseService, type LeaseFailureMode } from '../cron-lease';
import { JobRunRepository } from './job-run.repository';

export interface JobRunOptions {
  /**
   * Lease TTL. Set comfortably above the job's WORST observed runtime, and well
   * under its schedule interval. A TTL shorter than the job lets a second
   * instance start it — the exact outcome the lease exists to prevent.
   */
  ttlMs: number;
  /** Fail-open or fail-closed when Redis itself is unreachable. No default: money is on one side. */
  onRedisError: LeaseFailureMode;
}

/**
 * The single seam every scheduled job passes through.
 *
 * Leasing and recording are deliberately ONE wrapper rather than two. Applied
 * as separate passes over the call sites they would inevitably drift — some
 * jobs leased but unrecorded, others recorded but unleased — and a registry
 * with holes is worse than none, because it invites the reader to trust it.
 */
@Injectable()
export class JobRunnerService {
  constructor(
    private readonly lease: CronLeaseService,
    private readonly runs: JobRunRepository,
  ) {}

  async run<T>(jobName: string, opts: JobRunOptions, fn: () => Promise<T>): Promise<T | null> {
    let entered = false;

    try {
      const result = await this.lease.runExclusive(
        jobName,
        opts.ttlMs,
        async () => {
          entered = true;
          const id = await this.runs.recordStart(jobName);
          try {
            const value = await fn();
            await this.runs.recordEnd(id, 'SUCCESS', undefined);
            return value;
          } catch (err) {
            // Recorded, then rethrown. Swallowing here would convert a failing job
            // into a silently-succeeding one, which is the failure this codebase
            // already specialises in.
            await this.runs.recordEnd(id, 'FAILED', err);
            throw err;
          }
        },
        opts.onRedisError,
      );

      // `entered` distinguishes the two ways runExclusive returns null: the lease
      // was held elsewhere (never entered), or the job itself legitimately
      // returned null. Only the former is a skip.
      if (!entered) {
        await this.runs.recordSkipped(jobName);
        return null;
      }
      return result;
    } finally {
      // Retention rides on write traffic — see PRUNE_INTERVAL_MS. It sweeps after
      // EVERY completed run, not just successful ones: a deployment where every
      // tick fails still writes a RUNNING row and a FAILED row per tick, so the
      // table grows fastest in exactly the state a success-only sweep would never
      // fire in — and "everything is failing" is the condition most likely to
      // persist unnoticed. `finally` also puts the sweep after the outcome has
      // been recorded on all three paths, and adds no `return`/`throw`, so a
      // failing job still rethrows its own error unchanged.
      //
      // Two guards, not one, and NEITHER is redundant with the other:
      //   - `void` … not awaited. A prune must never add latency to, or fail, a
      //     scheduled job.
      //   - `.catch()` … `maybePrune` already guarantees it never rejects, and
      //     job-run.retention.spec.ts pins that. But a `void`ed rejection
      //     TERMINATES the Node process by default, so if a future edit breaks
      //     that guarantee the failure mode is not "a prune was missed", it is
      //     "retention killed the API" — the observer destroying the thing it
      //     observes. The spec guarantees the invariant today; this bounds the
      //     blast radius if someone breaks it later. Do not delete either as
      //     duplication.
      void this.runs.maybePrune(new Date()).catch(() => undefined);
    }
  }
}
