/**
 * How a scheduled run ended — or that it has not ended.
 *
 * `RUNNING` exists because `outcome` is written at INSERT, before the job's
 * fate is known. Without it the opening row must claim an outcome it cannot
 * have: `SUCCESS` would make an OOM-killed job (a live risk on a 512 MB
 * instance) leave a permanent row reading "succeeded", and `FAILED` would
 * report every long-running job as failed for as long as it works correctly.
 * `RUNNING` is the only honest thing to write at that moment, and it stays
 * diagnosable afterwards: a crashed job leaves `RUNNING` whose `startedAt`
 * keeps aging, which is visibly different from a job that is merely busy.
 *
 * `SKIPPED_LEASE` is not a failure and must never be silently dropped: a job
 * correctly deferring to another instance and a job that is dead both write
 * nothing to their own tables, so without this outcome the registry cannot
 * tell them apart — which is the same silent-absence trap this whole spine
 * exists to close.
 *
 * READ IT AS "DEFERRED", NOT AS "ANOTHER INSTANCE IS LIVE". It covers two
 * causes: another instance genuinely holds the lease, AND Redis being
 * unreachable while the caller chose fail-closed (`onRedisError: 'skip'`) — in
 * which case the job stood down rather than risk a double-run. So a wall of
 * `SKIPPED_LEASE` during a Redis incident is a single-instance app declining to
 * gamble, not evidence of a second container. Both readings are honest about
 * the fact that matters — the job did not run — and one recorded row beats an
 * absence, which is why this stays a single outcome rather than splitting.
 */
export type JobOutcome = 'RUNNING' | 'SUCCESS' | 'FAILED' | 'SKIPPED_LEASE';

/** One recorded execution, as read back by the health surface. */
export interface JobRunRecord {
  jobName: string;
  startedAt: Date;
  finishedAt: Date | null;
  outcome: JobOutcome;
  error: string | null;
  durationMs: number | null;
}

/**
 * How long `job_runs` rows are kept.
 *
 * 30 days covers "did this fire across a full month-end and an expiry cycle"
 * without letting an evidence table become the next unbounded-growth problem.
 */
export const JOB_RUN_RETENTION_DAYS = 30;

/** Rows started before this instant are eligible for pruning. */
export function retentionCutoff(now: Date): Date {
  return new Date(now.getTime() - JOB_RUN_RETENTION_DAYS * 24 * 60 * 60 * 1000);
}
