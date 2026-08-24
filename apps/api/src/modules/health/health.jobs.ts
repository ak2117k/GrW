import type { JobOutcome, JobRunRecord } from '../../common/job-registry';
import { toFreshness } from './health.service';

/** A job's last run, or an explicit statement that it has never had one. */
export interface JobFreshness {
  at: string | null;
  ageSec: number | null;
  outcome: JobOutcome | null;
  durationMs: number | null;
  error: string | null;
}

const NEVER: JobFreshness = {
  at: null,
  ageSec: null,
  outcome: null,
  durationMs: null,
  error: null,
};

/**
 * Merge recorded runs with the list of jobs we EXPECT to exist.
 *
 * The expected list is the point. Reporting only what the table contains means
 * a job that has never run is simply missing from the payload — indistinguishable
 * from a job nobody ever wrote. Seeding every expected name with an explicit
 * `NEVER` is what makes "this has never executed in production" a visible row
 * rather than an absence someone has to notice.
 *
 * Recorded jobs absent from the expected list are still included: an orphan
 * name usually means the expected list has drifted, and hiding it would hide
 * the drift.
 */
export function toJobFreshness(
  records: JobRunRecord[],
  expected: string[],
  now: Date,
): Record<string, JobFreshness> {
  const out: Record<string, JobFreshness> = {};
  for (const name of expected) out[name] = { ...NEVER };

  for (const r of records) {
    const f = toFreshness(r.startedAt, now);
    out[r.jobName] = {
      at: f.at,
      ageSec: f.ageSec,
      outcome: r.outcome,
      durationMs: r.durationMs,
      error: r.error,
    };
  }
  return out;
}
