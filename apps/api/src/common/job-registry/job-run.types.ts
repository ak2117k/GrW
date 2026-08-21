/**
 * How a scheduled run ended.
 *
 * `SKIPPED_LEASE` is not a failure and must never be silently dropped: a job
 * correctly deferring to another instance and a job that is dead both write
 * nothing to their own tables, so without this outcome the registry cannot
 * tell them apart — which is the same silent-absence trap this whole spine
 * exists to close.
 */
export type JobOutcome = 'SUCCESS' | 'FAILED' | 'SKIPPED_LEASE';

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
