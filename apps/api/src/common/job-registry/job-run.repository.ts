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
 * EVERY WRITE swallows its own failure. Recording is observation, and an
 * observer that can break the thing it observes is worse than no observer: a
 * `job_runs` insert failing during a Neon wake-up must not abort a broker
 * reconcile. A lost row costs one blank cell on a dashboard.
 *
 * The READ (`lastRunPerJob`) deliberately does NOT swallow — see its own
 * docblock. Do not "make it consistent" with the writes; that reintroduces the
 * silent absence this table exists to detect.
 *
 * All timestamps this class writes come from the Node process clock, never the
 * schema's `@default(now())` database clock — see `recordStart`.
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
   *
   * `startedAt` is set explicitly rather than left to the schema's
   * `@default(now())`. One clock, not two: `recordEnd` subtracts `startedAt`
   * from a `finishedAt` taken on the Node process clock, so a database-clock
   * `startedAt` would make every duration carry the Render-to-Neon skew and
   * could record a fast job as negative. The same skew would also perturb
   * `ORDER BY "startedAt"`, which is how `lastRunPerJob` picks the newest row.
   */
  async recordStart(jobName: string): Promise<string | null> {
    try {
      const row = await this.prisma.jobRun.create({
        data: { jobName, startedAt: new Date(), outcome: 'RUNNING' },
        select: { id: true },
      });
      return row.id;
    } catch (err) {
      this.logger.warn(`job_runs start not recorded for "${jobName}": ${describe(err)}`);
      return null;
    }
  }

  /**
   * Closes an open row. A `null` id (its start was never recorded) is a no-op.
   *
   * The `row ? … : null` duration fallback below is defensive only and cannot
   * actually be observed: if `findUnique` returns null the row does not exist,
   * so the `update` on that same id throws P2025 and is swallowed below. A
   * missing row therefore loses the ENTIRE end-record — outcome, finishedAt and
   * error alike — not merely the duration. The run stays visible as a stale
   * RUNNING, which is the correct reading of a row nobody could close.
   */
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

  /**
   * Newest row per jobName, for the health surface.
   *
   * THIS METHOD MUST THROW. It is the one place in this class that does not
   * swallow, and that is deliberate: a swallowed read returns `[]`, which
   * renders as "no jobs have ever run" — indistinguishable from the exact
   * condition this table exists to detect. It must throw so the caller can
   * state the absence WITH a reason. `HealthDetailService.checkJobs` (Task 7)
   * catches it and emits `unavailable(reason)`. Do not add a
   * `catch { return []; }` here.
   *
   * The raw SQL depends on the Prisma model's `@@map("job_runs")` and on its
   * quoted camelCase column names. `tsc` cannot see either, so renaming the
   * mapping or a field compiles green and fails only in production — update
   * this query alongside any such change. `DISTINCT ON` is also Postgres-only,
   * and is chosen over Prisma's `distinct` because the latter de-duplicates in
   * the query engine AFTER fetching every matching row, which on a 30-day
   * table means pulling the whole table into a 512 MB instance.
   */
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
