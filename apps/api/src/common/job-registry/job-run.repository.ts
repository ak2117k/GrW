import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { retentionCutoff, type JobOutcome, type JobRunRecord } from './job-run.types';

/** Error strings are capped and whitespace-collapsed — same rule as `/healthz`. */
function describe(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err);
  return message.replace(/\s+/g, ' ').slice(0, 200);
}

/**
 * Persists scheduled-run evidence.
 *
 * EVERY method swallows its own failure. Recording is observation, and an
 * observer that can break the thing it observes is worse than no observer: a
 * `job_runs` insert failing during a Neon wake-up must not abort a broker
 * reconcile. A lost row costs one blank cell on a dashboard.
 */
@Injectable()
export class JobRunRepository {
  private readonly logger = new Logger(JobRunRepository.name);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Opens a row marked RUNNING.
   *
   * The outcome column is written at INSERT, before the job's fate is known,
   * so the opening value must be one that is TRUE at that instant. `SUCCESS`
   * would make a process OOM-killed mid-job (a live risk at 512 MB) leave a
   * permanent row reading "succeeded" — the exact lie this table exists to
   * prevent. `FAILED` would be the opposite lie: every long-running job would
   * read as failed for the whole time it is working correctly.
   *
   * RUNNING stays diagnosable after a crash, too: the row keeps its startedAt
   * and never advances, so a stale RUNNING is visibly a death rather than a
   * job that is merely busy.
   */
  async recordStart(jobName: string): Promise<string | null> {
    try {
      const row = await this.prisma.jobRun.create({
        data: { jobName, outcome: 'RUNNING' },
        select: { id: true },
      });
      return row.id;
    } catch (err) {
      this.logger.warn(`job_runs start not recorded for "${jobName}": ${describe(err)}`);
      return null;
    }
  }

  async recordEnd(id: string | null, outcome: JobOutcome, error?: unknown): Promise<void> {
    if (!id) return;
    try {
      const finishedAt = new Date();
      const row = await this.prisma.jobRun.findUnique({
        where: { id },
        select: { startedAt: true },
      });
      await this.prisma.jobRun.update({
        where: { id },
        data: {
          finishedAt,
          outcome,
          error: error === undefined ? null : describe(error),
          durationMs: row ? finishedAt.getTime() - row.startedAt.getTime() : null,
        },
      });
    } catch (err) {
      this.logger.warn(`job_runs end not recorded for row ${id}: ${describe(err)}`);
    }
  }

  /** A run that deferred to another instance. Recorded, never silent. */
  async recordSkipped(jobName: string): Promise<void> {
    try {
      const now = new Date();
      await this.prisma.jobRun.create({
        data: { jobName, startedAt: now, finishedAt: now, outcome: 'SKIPPED_LEASE', durationMs: 0 },
      });
    } catch (err) {
      this.logger.warn(`job_runs skip not recorded for "${jobName}": ${describe(err)}`);
    }
  }

  /** Newest row per jobName, for the health surface. */
  async lastRunPerJob(): Promise<JobRunRecord[]> {
    const rows = await this.prisma.$queryRaw<JobRunRecord[]>`
      SELECT DISTINCT ON ("jobName")
        "jobName", "startedAt", "finishedAt", "outcome"::text as outcome, "error", "durationMs"
      FROM job_runs
      ORDER BY "jobName", "startedAt" DESC
    `;
    return rows;
  }

  async pruneOlderThan(cutoff: Date): Promise<number> {
    try {
      const res = await this.prisma.jobRun.deleteMany({
        where: { startedAt: { lt: cutoff } },
      });
      return res.count;
    } catch (err) {
      this.logger.warn(`job_runs prune failed: ${describe(err)}`);
      return 0;
    }
  }

  /** Convenience for the lazy pruner in Task 9. */
  async pruneExpired(now: Date): Promise<number> {
    return this.pruneOlderThan(retentionCutoff(now));
  }
}
