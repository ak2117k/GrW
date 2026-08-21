# Evidence Spine Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make every silently-inert path in this platform report, in production, when it last actually ran — so the fixes that follow can be proven rather than assumed.

**Architecture:** Extend the existing `/healthz` `Signal<T>` discipline rather than invent a new one. A single `JobRunnerService` composes the existing Redis lease with a new `JobRun` recording table, so leasing and recording share one seam. Richer detail (per-job history, memory, feed pressure) goes behind an admin-only `/healthz/detail`; the public `/healthz` stays cheap, unauthenticated and always HTTP 200.

**Tech Stack:** NestJS 10, Prisma + PostgreSQL (Neon), Redis (Render KV), Jest (`apps/api`), React + Vite + Vitest (`apps/web`), socket.io.

**Spec:** `docs/superpowers/specs/2026-08-21-production-hardening-and-data-path-design.md`

## Global Constraints

- **`/healthz` returns HTTP 200 and `status: 'ok'` unconditionally.** Render kills containers on probe failure; a verdict-returning probe manufactures the outage it detects. Never change this.
- **Absent means absent.** A path that has never run reports `at: null`. Never `ageSec: 0` — that asserts "ran this instant", the exact opposite of the truth.
- **Nothing in the health path may reject.** Every signal degrades independently via `settle()` in `health.service.ts:67`.
- **`/healthz` is unauthenticated and externally scraped.** No credentials, connection strings, user ids, symbols or prices in its body. Counts and clocks only. Use `describe()` (`health.service.ts:100`) for every error string — Prisma errors carry `DATABASE_URL`.
- **Every new table carries a retention policy in the same change that creates it.** Less in RAM; more on disk, always with an expiry.
- **Retention is lazy, never a new cron.** This plan reduces scheduled work; it must not add to it.
- **Signal budget is 1,500 ms; snapshot cache TTL is 5,000 ms.** New signals join the existing cache in `collect()`.
- Agents share one working tree: **commit with explicit pathspecs.** Never `git add -A`, never `git commit -a`.
- Test commands: `npm test --workspace apps/api` (Jest), `npm test --workspace apps/web` (Vitest). Single file: `npx jest <path> -t "<name>"` from `apps/api`.

---

## File Structure

| File | Responsibility |
|---|---|
| `prisma/schema.prisma` | `JobRun` model, `JobOutcome` enum, `ClientFeedReport` model |
| `apps/api/src/common/job-registry/job-run.types.ts` | `JobOutcome`, `JobRunRecord`, retention constant — no I/O |
| `apps/api/src/common/job-registry/job-run.repository.ts` | Writes and reads `job_runs`; owns lazy pruning |
| `apps/api/src/common/job-registry/job-runner.service.ts` | **The one wrapper**: lease + record. All scheduled work routes through it |
| `apps/api/src/common/job-registry/job-registry.module.ts` | Wires the above; imports `CronLeaseModule` |
| `apps/api/src/modules/health/health.types.ts` | Extend: `ProcessMemory`, `JobFreshness`, `SlotPressure`, `HealthDetailPayload` |
| `apps/api/src/modules/health/health.memory.ts` | Pure `toProcessMemory()` — testable without a process |
| `apps/api/src/modules/health/health-detail.service.ts` | Collects the admin-only signals |
| `apps/api/src/modules/health/health.controller.ts` | Extend: `GET /healthz/detail`, `POST /healthz/client-report` |
| `apps/api/src/modules/market-data/services/market-feed.service.ts` | Extend: slot high-water + rejection counters |
| `apps/web/src/services/feed-health.ts` | Pure stall-classification + report shape |
| `apps/web/src/services/websocket.ts` | Replace temp diagnostics with the structured reporter |

**Parallelisation for agents.** Tasks 1 → 2 → 3 are strictly sequential (schema, then repository, then wrapper). Once Task 2 lands: **Task 5** (jobs signal) can start. **Task 4** (memory), **Task 6** (slot pressure) and **Task 8** (client report) are independent of 1–3 entirely and may run from the start. **Task 7** needs 4, 5 and 6. **Task 9** needs 1 and 2.

---

## Task 1: `JobRun` schema and migration

**Files:**
- Modify: `prisma/schema.prisma`
- Create: `apps/api/src/common/job-registry/job-run.types.ts`
- Test: `apps/api/src/common/job-registry/job-run.types.spec.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: Prisma model `JobRun`, enum `JobOutcome`; TypeScript `JobOutcome` union, `JOB_RUN_RETENTION_DAYS: number`, `retentionCutoff(now: Date): Date`.

- [ ] **Step 1: Write the failing test**

Create `apps/api/src/common/job-registry/job-run.types.spec.ts`:

```typescript
import { JOB_RUN_RETENTION_DAYS, retentionCutoff } from './job-run.types';

describe('job-run retention', () => {
  it('retains 30 days', () => {
    expect(JOB_RUN_RETENTION_DAYS).toBe(30);
  });

  it('computes the cutoff 30 days before now', () => {
    const now = new Date('2026-08-21T10:00:00.000Z');
    expect(retentionCutoff(now).toISOString()).toBe('2026-07-22T10:00:00.000Z');
  });

  it('does not mutate the input date', () => {
    const now = new Date('2026-08-21T10:00:00.000Z');
    retentionCutoff(now);
    expect(now.toISOString()).toBe('2026-08-21T10:00:00.000Z');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/api && npx jest src/common/job-registry/job-run.types.spec.ts`
Expected: FAIL — `Cannot find module './job-run.types'`

- [ ] **Step 3: Write the types**

Create `apps/api/src/common/job-registry/job-run.types.ts`:

```typescript
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
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd apps/api && npx jest src/common/job-registry/job-run.types.spec.ts`
Expected: PASS, 3 tests.

- [ ] **Step 5: Add the Prisma model**

Append to `prisma/schema.prisma`:

```prisma
enum JobOutcome {
  SUCCESS
  FAILED
  SKIPPED_LEASE
}

/// One execution of a scheduled job. The absence of rows for a jobName is the
/// signal that matters: it means the job has never run in this environment.
model JobRun {
  id         String     @id @default(cuid())
  jobName    String
  startedAt  DateTime   @default(now())
  finishedAt DateTime?
  outcome    JobOutcome
  error      String?
  durationMs Int?

  /// Serves the per-job "when did this last run" lookup.
  @@index([jobName, startedAt])
  /// Serves retention pruning, which filters on startedAt alone and cannot use
  /// the composite above.
  @@index([startedAt])
  @@map("job_runs")
}
```

- [ ] **Step 6: Generate the migration**

Run: `npx prisma migrate dev --name add_job_run_registry`
Expected: a new folder under `prisma/migrations/`, and `prisma generate` succeeds.

Note: this requires a working local `DATABASE_URL`. If migrate cannot connect, stop and report — do not hand-write the SQL.

- [ ] **Step 7: Commit**

```bash
git add prisma/schema.prisma prisma/migrations apps/api/src/common/job-registry/job-run.types.ts apps/api/src/common/job-registry/job-run.types.spec.ts
git commit -m "feat(job-registry): record scheduled runs so a never-run job is visible"
```

---

## Task 2: `JobRunRepository`

**Files:**
- Create: `apps/api/src/common/job-registry/job-run.repository.ts`
- Test: `apps/api/src/common/job-registry/job-run.repository.spec.ts`

**Interfaces:**
- Consumes: `JobOutcome`, `JobRunRecord`, `retentionCutoff` from Task 1; `PrismaService` from `apps/api/src/common/prisma/prisma.service`.
- Produces:
  - `recordStart(jobName: string): Promise<string | null>` — the row id, or `null` if the write failed
  - `recordEnd(id: string | null, outcome: JobOutcome, error?: unknown): Promise<void>` — a `null` id is a no-op
  - `recordSkipped(jobName: string): Promise<void>`
  - `lastRunPerJob(): Promise<JobRunRecord[]>`
  - `pruneOlderThan(cutoff: Date): Promise<number>`

- [ ] **Step 1: Write the failing test**

Create `apps/api/src/common/job-registry/job-run.repository.spec.ts`:

```typescript
import { JobRunRepository } from './job-run.repository';

function makePrisma() {
  return {
    jobRun: {
      create: jest.fn().mockResolvedValue({ id: 'row-1' }),
      update: jest.fn().mockResolvedValue({}),
      deleteMany: jest.fn().mockResolvedValue({ count: 7 }),
      findMany: jest.fn().mockResolvedValue([]),
      // recordEnd reads startedAt back to compute durationMs. Omitting this
      // makes the lookup throw, the catch swallow it, and `update` never run —
      // so the truncation assertion below would fail for the wrong reason.
      findUnique: jest.fn().mockResolvedValue({ startedAt: new Date('2026-08-21T09:59:00.000Z') }),
    },
  };
}

describe('JobRunRepository', () => {
  it('records a start and returns the row id', async () => {
    const prisma = makePrisma();
    const repo = new JobRunRepository(prisma as never);
    await expect(repo.recordStart('nightly-sweep')).resolves.toBe('row-1');
    expect(prisma.jobRun.create).toHaveBeenCalledWith({
      data: { jobName: 'nightly-sweep', outcome: 'FAILED' },
      select: { id: true },
    });
  });

  it('truncates an error message to 200 chars', async () => {
    const prisma = makePrisma();
    const repo = new JobRunRepository(prisma as never);
    await repo.recordEnd('row-1', 'FAILED', 'x'.repeat(500));
    const arg = prisma.jobRun.update.mock.calls[0][0];
    expect(arg.data.error).toHaveLength(200);
  });

  it('never throws when the database write fails', async () => {
    const prisma = makePrisma();
    prisma.jobRun.create.mockRejectedValue(new Error('db down'));
    const repo = new JobRunRepository(prisma as never);
    await expect(repo.recordStart('nightly-sweep')).resolves.toBeNull();
  });

  it('prunes rows older than the cutoff', async () => {
    const prisma = makePrisma();
    const repo = new JobRunRepository(prisma as never);
    const cutoff = new Date('2026-07-22T00:00:00.000Z');
    await expect(repo.pruneOlderThan(cutoff)).resolves.toBe(7);
    expect(prisma.jobRun.deleteMany).toHaveBeenCalledWith({
      where: { startedAt: { lt: cutoff } },
    });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/api && npx jest src/common/job-registry/job-run.repository.spec.ts`
Expected: FAIL — `Cannot find module './job-run.repository'`

- [ ] **Step 3: Write the repository**

Create `apps/api/src/common/job-registry/job-run.repository.ts`:

```typescript
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
   * Opens a row, pessimistically marked FAILED.
   *
   * A process OOM-killed mid-job never reaches `recordEnd`, so the row it
   * leaves behind must already say something true. Defaulting to SUCCESS would
   * make every hard kill look like a clean run — precisely the lie this table
   * exists to prevent.
   */
  async recordStart(jobName: string): Promise<string | null> {
    try {
      const row = await this.prisma.jobRun.create({
        data: { jobName, outcome: 'FAILED' },
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
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd apps/api && npx jest src/common/job-registry/job-run.repository.spec.ts`
Expected: PASS, 4 tests. If the truncation test fails, check that `describe()` slices to 200.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/common/job-registry/job-run.repository.ts apps/api/src/common/job-registry/job-run.repository.spec.ts
git commit -m "feat(job-registry): persist run evidence without ever breaking the job"
```

---

## Task 3: `JobRunnerService` — the one wrapper

**Files:**
- Create: `apps/api/src/common/job-registry/job-runner.service.ts`
- Create: `apps/api/src/common/job-registry/job-registry.module.ts`
- Test: `apps/api/src/common/job-registry/job-runner.service.spec.ts`

**Interfaces:**
- Consumes: `CronLeaseService.runExclusive(jobName, ttlMs, fn, onRedisError)` from `apps/api/src/common/cron-lease/cron-lease.service.ts` (returns `T | null`; `null` means the lease was held elsewhere). `JobRunRepository` from Task 2. `LeaseFailureMode` from `../cron-lease`.
- Produces: `JobRunnerService.run<T>(jobName: string, opts: { ttlMs: number; onRedisError: LeaseFailureMode }, fn: () => Promise<T>): Promise<T | null>` — the single entry point every surviving `@Cron` will call in Plan 2.

- [ ] **Step 1: Write the failing test**

Create `apps/api/src/common/job-registry/job-runner.service.spec.ts`:

```typescript
import { JobRunnerService } from './job-runner.service';

function makeDeps(leaseAcquired = true) {
  const lease = {
    runExclusive: jest.fn(async (_name: string, _ttl: number, fn: () => Promise<unknown>) =>
      leaseAcquired ? await fn() : null,
    ),
  };
  const repo = {
    recordStart: jest.fn().mockResolvedValue('row-1'),
    recordEnd: jest.fn().mockResolvedValue(undefined),
    recordSkipped: jest.fn().mockResolvedValue(undefined),
  };
  return { lease, repo };
}

describe('JobRunnerService', () => {
  it('records SUCCESS and returns the job result', async () => {
    const { lease, repo } = makeDeps();
    const runner = new JobRunnerService(lease as never, repo as never);
    const result = await runner.run('reconcile', { ttlMs: 60_000, onRedisError: 'skip' }, async () => 42);
    expect(result).toBe(42);
    expect(repo.recordStart).toHaveBeenCalledWith('reconcile');
    expect(repo.recordEnd).toHaveBeenCalledWith('row-1', 'SUCCESS', undefined);
  });

  it('records FAILED and rethrows when the job throws', async () => {
    const { lease, repo } = makeDeps();
    const runner = new JobRunnerService(lease as never, repo as never);
    const boom = new Error('boom');
    await expect(
      runner.run('reconcile', { ttlMs: 60_000, onRedisError: 'skip' }, async () => {
        throw boom;
      }),
    ).rejects.toThrow('boom');
    expect(repo.recordEnd).toHaveBeenCalledWith('row-1', 'FAILED', boom);
  });

  it('records SKIPPED_LEASE and does not open a run row when the lease is held', async () => {
    const { lease, repo } = makeDeps(false);
    const runner = new JobRunnerService(lease as never, repo as never);
    const result = await runner.run('reconcile', { ttlMs: 60_000, onRedisError: 'skip' }, async () => 42);
    expect(result).toBeNull();
    expect(repo.recordSkipped).toHaveBeenCalledWith('reconcile');
    expect(repo.recordStart).not.toHaveBeenCalled();
  });

  it('passes the caller-chosen failure mode straight through to the lease', async () => {
    const { lease, repo } = makeDeps();
    const runner = new JobRunnerService(lease as never, repo as never);
    await runner.run('refresh', { ttlMs: 30_000, onRedisError: 'run-anyway' }, async () => 1);
    expect(lease.runExclusive).toHaveBeenCalledWith(
      'refresh',
      30_000,
      expect.any(Function),
      'run-anyway',
    );
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/api && npx jest src/common/job-registry/job-runner.service.spec.ts`
Expected: FAIL — `Cannot find module './job-runner.service'`

- [ ] **Step 3: Write the runner**

Create `apps/api/src/common/job-registry/job-runner.service.ts`:

```typescript
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
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd apps/api && npx jest src/common/job-registry/job-runner.service.spec.ts`
Expected: PASS, 4 tests.

- [ ] **Step 5: Create the module**

Create `apps/api/src/common/job-registry/job-registry.module.ts`:

```typescript
import { Global, Module } from '@nestjs/common';
import { CronLeaseModule } from '../cron-lease/cron-lease.module';
import { JobRunRepository } from './job-run.repository';
import { JobRunnerService } from './job-runner.service';

/**
 * Global because Plan 2 routes ~12 jobs across ~10 feature modules through
 * `JobRunnerService`, and a per-module import list is one more place for a job
 * to be quietly left out.
 */
@Global()
@Module({
  imports: [CronLeaseModule],
  providers: [JobRunRepository, JobRunnerService],
  exports: [JobRunRepository, JobRunnerService],
})
export class JobRegistryModule {}
```

Create `apps/api/src/common/job-registry/index.ts`:

```typescript
export { JobRunnerService, type JobRunOptions } from './job-runner.service';
export { JobRunRepository } from './job-run.repository';
export { JOB_RUN_RETENTION_DAYS, retentionCutoff } from './job-run.types';
export type { JobOutcome, JobRunRecord } from './job-run.types';
```

- [ ] **Step 6: Register in the app module**

Modify `apps/api/src/app.module.ts` — add `JobRegistryModule` to the `imports` array, immediately after the existing `CronLeaseModule` entry.

- [ ] **Step 7: Verify the app still boots**

Run: `cd apps/api && npx jest` (full suite)
Expected: PASS, no new failures. A DI resolution error here means `CronLeaseModule` does not export `CronLeaseService` — check and fix its `exports`.

- [ ] **Step 8: Commit**

```bash
git add apps/api/src/common/job-registry apps/api/src/app.module.ts
git commit -m "feat(job-registry): one wrapper for lease and run-recording"
```

---

## Task 4: Process memory signal

**Files:**
- Create: `apps/api/src/modules/health/health.memory.ts`
- Test: `apps/api/src/modules/health/health.memory.spec.ts`
- Modify: `apps/api/src/modules/health/health.types.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `interface ProcessMemory { rssMb: number; heapUsedMb: number; heapTotalMb: number; externalMb: number }` and `toProcessMemory(usage: NodeJS.MemoryUsage): ProcessMemory`.

Independent of Tasks 1–3; may start immediately.

- [ ] **Step 1: Write the failing test**

Create `apps/api/src/modules/health/health.memory.spec.ts`:

```typescript
import { toProcessMemory } from './health.memory';

describe('toProcessMemory', () => {
  it('converts bytes to whole megabytes', () => {
    expect(
      toProcessMemory({
        rss: 268_435_456,
        heapUsed: 134_217_728,
        heapTotal: 201_326_592,
        external: 8_388_608,
        arrayBuffers: 0,
      }),
    ).toEqual({ rssMb: 256, heapUsedMb: 128, heapTotalMb: 192, externalMb: 8 });
  });

  it('rounds rather than truncates', () => {
    const mem = toProcessMemory({
      rss: 1_572_864, // 1.5 MB
      heapUsed: 0,
      heapTotal: 0,
      external: 0,
      arrayBuffers: 0,
    });
    expect(mem.rssMb).toBe(2);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/api && npx jest src/modules/health/health.memory.spec.ts`
Expected: FAIL — `Cannot find module './health.memory'`

- [ ] **Step 3: Write the implementation**

Create `apps/api/src/modules/health/health.memory.ts`:

```typescript
/**
 * Resident memory, in megabytes.
 *
 * Render's free AND Starter tiers both cap at 512 MB, and an OOM kill presents
 * as a healthy service with a small `uptimeSec` — the only clue anyone had
 * during the scrip-master crash loop. Reporting RSS turns "the container
 * restarted again" into "the container restarted at 480 MB during the
 * instrument refresh", which names the culprit.
 */
export interface ProcessMemory {
  rssMb: number;
  heapUsedMb: number;
  heapTotalMb: number;
  externalMb: number;
}

const BYTES_PER_MB = 1024 * 1024;

/** Pure so it can be tested without provoking real memory pressure. */
export function toProcessMemory(usage: NodeJS.MemoryUsage): ProcessMemory {
  const mb = (bytes: number) => Math.round(bytes / BYTES_PER_MB);
  return {
    rssMb: mb(usage.rss),
    heapUsedMb: mb(usage.heapUsed),
    heapTotalMb: mb(usage.heapTotal),
    externalMb: mb(usage.external),
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd apps/api && npx jest src/modules/health/health.memory.spec.ts`
Expected: PASS, 2 tests.

- [ ] **Step 5: Export the type from health.types.ts**

Add to the end of `apps/api/src/modules/health/health.types.ts`:

```typescript
export type { ProcessMemory } from './health.memory';
```

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/modules/health/health.memory.ts apps/api/src/modules/health/health.memory.spec.ts apps/api/src/modules/health/health.types.ts
git commit -m "feat(health): report RSS so the 512MB ceiling is measurable"
```

---

## Task 5: Jobs freshness signal

**Files:**
- Create: `apps/api/src/modules/health/health.jobs.ts`
- Test: `apps/api/src/modules/health/health.jobs.spec.ts`

**Interfaces:**
- Consumes: `JobRunRecord`, `JobOutcome` from Task 1; `toFreshness(at, now)` exported from `apps/api/src/modules/health/health.service.ts:113`.
- Produces: `interface JobFreshness { at: string | null; ageSec: number | null; outcome: JobOutcome | null; durationMs: number | null; error: string | null }` and `toJobFreshness(records: JobRunRecord[], expected: string[], now: Date): Record<string, JobFreshness>`.

- [ ] **Step 1: Write the failing test**

Create `apps/api/src/modules/health/health.jobs.spec.ts`:

```typescript
import { toJobFreshness } from './health.jobs';

const NOW = new Date('2026-08-21T10:00:00.000Z');

describe('toJobFreshness', () => {
  it('reports a job that has never run as at:null, NOT ageSec:0', () => {
    const out = toJobFreshness([], ['sentinel-tick'], NOW);
    expect(out['sentinel-tick']).toEqual({
      at: null,
      ageSec: null,
      outcome: null,
      durationMs: null,
      error: null,
    });
  });

  it('reports age in seconds for a job that has run', () => {
    const out = toJobFreshness(
      [
        {
          jobName: 'sentinel-tick',
          startedAt: new Date('2026-08-21T09:59:00.000Z'),
          finishedAt: new Date('2026-08-21T09:59:02.000Z'),
          outcome: 'SUCCESS',
          error: null,
          durationMs: 2000,
        },
      ],
      ['sentinel-tick'],
      NOW,
    );
    expect(out['sentinel-tick'].ageSec).toBe(60);
    expect(out['sentinel-tick'].outcome).toBe('SUCCESS');
  });

  it('includes a recorded job that was not in the expected list', () => {
    const out = toJobFreshness(
      [
        {
          jobName: 'orphan-job',
          startedAt: new Date('2026-08-21T09:00:00.000Z'),
          finishedAt: null,
          outcome: 'FAILED',
          error: 'exploded',
          durationMs: null,
        },
      ],
      ['sentinel-tick'],
      NOW,
    );
    expect(Object.keys(out).sort()).toEqual(['orphan-job', 'sentinel-tick']);
    expect(out['orphan-job'].error).toBe('exploded');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/api && npx jest src/modules/health/health.jobs.spec.ts`
Expected: FAIL — `Cannot find module './health.jobs'`

- [ ] **Step 3: Write the implementation**

Create `apps/api/src/modules/health/health.jobs.ts`:

```typescript
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
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd apps/api && npx jest src/modules/health/health.jobs.spec.ts`
Expected: PASS, 3 tests.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/modules/health/health.jobs.ts apps/api/src/modules/health/health.jobs.spec.ts
git commit -m "feat(health): a never-run job reports as never-run, by name"
```

---

## Task 6: Feed slot pressure

**Files:**
- Modify: `apps/api/src/modules/market-data/services/market-feed.service.ts` (near `PRIMARY_SLOT_MAX` at line 55 and `getStatus()` at line 482)
- Create: `apps/api/src/modules/market-data/services/slot-pressure.ts`
- Test: `apps/api/src/modules/market-data/services/slot-pressure.spec.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `interface SlotPressure { primaryHighWater: number; primaryMax: number; rejections: number; saturated: boolean }`, class `SlotPressureTracker` with `observe(primaryCount: number): void`, `reject(): void`, `snapshot(): SlotPressure`.

Independent of Tasks 1–5; may start immediately.

- [ ] **Step 1: Write the failing test**

Create `apps/api/src/modules/market-data/services/slot-pressure.spec.ts`:

```typescript
import { SlotPressureTracker } from './slot-pressure';

describe('SlotPressureTracker', () => {
  it('starts with no pressure recorded', () => {
    expect(new SlotPressureTracker(30).snapshot()).toEqual({
      primaryHighWater: 0,
      primaryMax: 30,
      rejections: 0,
      saturated: false,
    });
  });

  it('keeps the high-water mark, not the latest reading', () => {
    const t = new SlotPressureTracker(30);
    t.observe(29);
    t.observe(4);
    expect(t.snapshot().primaryHighWater).toBe(29);
  });

  it('reports saturated once the cap is reached', () => {
    const t = new SlotPressureTracker(30);
    t.observe(30);
    expect(t.snapshot().saturated).toBe(true);
  });

  it('counts rejections', () => {
    const t = new SlotPressureTracker(30);
    t.reject();
    t.reject();
    expect(t.snapshot().rejections).toBe(2);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/api && npx jest src/modules/market-data/services/slot-pressure.spec.ts`
Expected: FAIL — `Cannot find module './slot-pressure'`

- [ ] **Step 3: Write the tracker**

Create `apps/api/src/modules/market-data/services/slot-pressure.ts`:

```typescript
/** Feed subscription pressure over a process lifetime. */
export interface SlotPressure {
  primaryHighWater: number;
  primaryMax: number;
  rejections: number;
  saturated: boolean;
}

/**
 * Tracks how close the primary subscription pool has come to its cap.
 *
 * `getStatus().primarySubscriptions` is a POINT reading — it said 29 of 30 once,
 * which proves nothing about whether the cap is ever actually reached. A price
 * that never updates because its token could not get a slot is invisible in a
 * point reading and obvious in a high-water mark next to a rejection count.
 *
 * Deliberately in-memory and per-process: the question is "does this container
 * saturate during a session", and it is answered by reading the value before
 * the container restarts. Persisting it would be a second table for a number
 * that costs nothing to re-derive.
 */
export class SlotPressureTracker {
  private highWater = 0;
  private rejections = 0;

  constructor(private readonly primaryMax: number) {}

  observe(primaryCount: number): void {
    if (primaryCount > this.highWater) this.highWater = primaryCount;
  }

  reject(): void {
    this.rejections++;
  }

  snapshot(): SlotPressure {
    return {
      primaryHighWater: this.highWater,
      primaryMax: this.primaryMax,
      rejections: this.rejections,
      saturated: this.highWater >= this.primaryMax,
    };
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd apps/api && npx jest src/modules/market-data/services/slot-pressure.spec.ts`
Expected: PASS, 4 tests.

- [ ] **Step 5: Wire into MarketFeedService**

In `apps/api/src/modules/market-data/services/market-feed.service.ts`. There are exactly three sites; they have been located, so do not go hunting.

1. Import the tracker, next to the existing imports:

```typescript
import { SlotPressureTracker, type SlotPressure } from './slot-pressure';
```

2. Add a field alongside the other private state:

```typescript
  /** Subscription pressure since boot. See slot-pressure.ts for why a point reading is not enough. */
  private readonly slotPressure = new SlotPressureTracker(PRIMARY_SLOT_MAX);
```

3. **Rejection site — line 294**, the existing guard. Add the counter inside the branch, above the existing `logger` call:

```typescript
      if (this.primaryTokens.size >= PRIMARY_SLOT_MAX) {
        this.slotPressure.reject();
        this.logger.warn(
          `Primary slot limit (${PRIMARY_SLOT_MAX}) reached — cannot subscribe ${token}`,
        );
```

4. **Add site — line 300.** Immediately after `this.primaryTokens.add(token);`:

```typescript
      this.primaryTokens.add(token);
      this.slotPressure.observe(this.primaryTokens.size);
```

5. **Second add site — line 1008**, inside the resubscribe path. After `if (token !== '0') this.primaryTokens.add(token);`, add on the following line:

```typescript
        this.slotPressure.observe(this.primaryTokens.size);
```

6. Add a public reader next to the existing `getStatus()` (line 482):

```typescript
  /** Subscription pressure since boot. Read by the admin health surface. */
  getSlotPressure(): SlotPressure {
    return this.slotPressure.snapshot();
  }
```

Note there is no `observe()` on the delete path at line 319 — that is deliberate. A high-water mark must not fall when tokens are released; the whole point is the peak.

- [ ] **Step 6: Verify nothing regressed**

Run: `cd apps/api && npx jest src/modules/market-data`
Expected: PASS, no new failures.

- [ ] **Step 7: Commit**

```bash
git add apps/api/src/modules/market-data/services/slot-pressure.ts apps/api/src/modules/market-data/services/slot-pressure.spec.ts apps/api/src/modules/market-data/services/market-feed.service.ts
git commit -m "feat(market-data): record slot high-water and rejections, not just a point reading"
```

---

## Task 7: `GET /healthz/detail`

**Files:**
- Create: `apps/api/src/modules/health/health-detail.service.ts`
- Modify: `apps/api/src/modules/health/health.controller.ts`
- Modify: `apps/api/src/modules/health/health.module.ts`
- Modify: `apps/api/src/modules/health/health.types.ts`
- Test: `apps/api/src/modules/health/health-detail.service.spec.ts`

**Interfaces:**
- Consumes: `toProcessMemory` (Task 4), `toJobFreshness` (Task 5), `getSlotPressure()` (Task 6), `JobRunRepository.lastRunPerJob()` (Task 2), `Signal<T>`/`present`/`unavailable` from `health.types.ts`.
- Produces: `interface HealthDetailPayload { checkedAt: string; memory: Signal<ProcessMemory>; jobs: Signal<Record<string, JobFreshness>>; slots: Signal<SlotPressure> }`.

Requires Tasks 4, 5 and 6.

- [ ] **Step 1: Write the failing test**

Create `apps/api/src/modules/health/health-detail.service.spec.ts`:

```typescript
import { HealthDetailService } from './health-detail.service';

describe('HealthDetailService', () => {
  it('collects memory, jobs and slot pressure', async () => {
    const runs = { lastRunPerJob: jest.fn().mockResolvedValue([]) };
    const feed = {
      getSlotPressure: jest
        .fn()
        .mockReturnValue({ primaryHighWater: 30, primaryMax: 30, rejections: 4, saturated: true }),
    };
    const svc = new HealthDetailService(runs as never, feed as never);

    const out = await svc.check();

    expect(out.memory.available).toBe(true);
    expect(out.slots.available).toBe(true);
    if (out.slots.available) expect(out.slots.value.rejections).toBe(4);
    expect(out.jobs.available).toBe(true);
  });

  it('degrades the jobs signal alone when the query fails', async () => {
    const runs = { lastRunPerJob: jest.fn().mockRejectedValue(new Error('db down')) };
    const feed = { getSlotPressure: jest.fn().mockReturnValue({}) };
    const svc = new HealthDetailService(runs as never, feed as never);

    const out = await svc.check();

    expect(out.jobs.available).toBe(false);
    expect(out.memory.available).toBe(true); // unaffected
  });

  it('never rejects', async () => {
    const runs = { lastRunPerJob: jest.fn().mockRejectedValue(new Error('x')) };
    const feed = {
      getSlotPressure: jest.fn(() => {
        throw new Error('feed exploded');
      }),
    };
    const svc = new HealthDetailService(runs as never, feed as never);
    await expect(svc.check()).resolves.toBeDefined();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/api && npx jest src/modules/health/health-detail.service.spec.ts`
Expected: FAIL — `Cannot find module './health-detail.service'`

- [ ] **Step 3: Write the service**

Create `apps/api/src/modules/health/health-detail.service.ts`:

```typescript
import { Inject, Injectable, Optional } from '@nestjs/common';
import { JobRunRepository } from '../../common/job-registry';
import { toProcessMemory, type ProcessMemory } from './health.memory';
import { toJobFreshness, type JobFreshness } from './health.jobs';
import type { SlotPressure } from '../market-data/services/slot-pressure';
import { FEED_STATUS_SOURCE, present, unavailable, type Signal } from './health.types';

/**
 * Jobs we EXPECT to exist in this environment.
 *
 * Maintained by hand and deliberately so: this list is the assertion that a job
 * OUGHT to run, and it is the only thing that can make a job which has never
 * executed appear in the payload at all. Plan 2 adds each surviving job's name
 * here as it is routed through JobRunnerService.
 */
export const EXPECTED_JOBS: string[] = [];

/** The narrow slice of MarketFeedService this surface reads. */
export interface SlotPressureSource {
  getSlotPressure(): SlotPressure;
}

export interface HealthDetailPayload {
  checkedAt: string;
  memory: Signal<ProcessMemory>;
  jobs: Signal<Record<string, JobFreshness>>;
  slots: Signal<SlotPressure>;
}

function describe(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err);
  return message.replace(/\s+/g, ' ').slice(0, 200);
}

/**
 * The admin-only half of the health surface.
 *
 * Split from HealthService rather than bolted onto it because these signals are
 * NOT safe to publish: job names describe the platform's internals and slot
 * counts describe capacity. `/healthz` stays public and cheap; this pays for a
 * JWT and a role check.
 *
 * Same non-negotiable as its public sibling: every signal degrades on its own
 * and nothing rejects.
 */
@Injectable()
export class HealthDetailService {
  constructor(
    private readonly runs: JobRunRepository,
    @Optional()
    @Inject(FEED_STATUS_SOURCE)
    private readonly feed: SlotPressureSource | null = null,
  ) {}

  async check(): Promise<HealthDetailPayload> {
    const now = new Date();
    const [memory, jobs, slots] = await Promise.all([
      Promise.resolve(this.checkMemory()),
      this.checkJobs(now),
      Promise.resolve(this.checkSlots()),
    ]);
    return { checkedAt: now.toISOString(), memory, jobs, slots };
  }

  private checkMemory(): Signal<ProcessMemory> {
    try {
      return present(toProcessMemory(process.memoryUsage()), 'process.memoryUsage');
    } catch (err) {
      return unavailable(describe(err));
    }
  }

  private async checkJobs(now: Date): Promise<Signal<Record<string, JobFreshness>>> {
    try {
      const records = await this.runs.lastRunPerJob();
      return present(toJobFreshness(records, EXPECTED_JOBS, now), 'job_runs');
    } catch (err) {
      return unavailable(describe(err));
    }
  }

  private checkSlots(): Signal<SlotPressure> {
    if (!this.feed) return unavailable('market feed service not resolvable from this container');
    try {
      return present(this.feed.getSlotPressure(), 'MarketFeedService.getSlotPressure');
    } catch (err) {
      return unavailable(describe(err));
    }
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd apps/api && npx jest src/modules/health/health-detail.service.spec.ts`
Expected: PASS, 3 tests.

- [ ] **Step 5: Add the route**

In `apps/api/src/modules/health/health.controller.ts`:

1. Change the imports to add `AdminOnly` and the new service:

```typescript
import { AdminOnly, Public } from '../../common/decorators';
import { HealthDetailService, type HealthDetailPayload } from './health-detail.service';
```

2. Remove the class-level `@Public()` and put it on the existing `check()` method instead, so only the public probe is unauthenticated:

```typescript
@ApiTags('Health')
@Controller('healthz')
export class HealthController {
```

...and above `async check()`, add `@Public()` alongside the existing decorators.

3. Inject the new service in the constructor and add the route:

```typescript
  /**
   * Admin-only detail: per-job last-run, process memory, feed slot pressure.
   *
   * Behind a role check because job names describe internals and slot counts
   * describe capacity. `/healthz` stays public precisely so this can be private.
   */
  @Get('detail')
  @AdminOnly()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Admin-only platform execution evidence' })
  async detail(): Promise<HealthDetailPayload> {
    return this.healthDetail.check();
  }
```

- [ ] **Step 6: Wire the module**

In `apps/api/src/modules/health/health.module.ts`, add `HealthDetailService` to `providers`. `JobRunRepository` resolves from the global `JobRegistryModule` (Task 3).

- [ ] **Step 7: Verify public probe is still public**

Run: `cd apps/api && npx jest src/modules/health`
Expected: PASS, all existing health specs still green. **If `health.controller.spec.ts` fails on authentication, the `@Public()` move in step 5.2 is wrong — `GET /healthz` must remain unauthenticated.**

- [ ] **Step 8: Commit**

```bash
git add apps/api/src/modules/health
git commit -m "feat(health): admin-only /healthz/detail for execution evidence"
```

---

## Task 8: Client feed-health reporting

**Files:**
- Create: `apps/web/src/services/feed-health.ts`
- Test: `apps/web/src/services/feed-health.spec.ts`
- Modify: `apps/web/src/services/websocket.ts:119-125` and `:276-310` (replace the temp diagnostics)
- Modify: `prisma/schema.prisma` (add `ClientFeedReport`)
- Modify: `apps/api/src/modules/health/health.controller.ts` (add the ingest route)

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces: `interface FeedHealthReport { tickSocketUp: boolean; secondsSinceLastTick: number | null; transport: string | null; subscribedTokens: number; namespaces: Record<string, boolean> }` and `classifyFeed(input): 'live' | 'stale' | 'offline'`.

- [ ] **Step 1: Write the failing test**

Create `apps/web/src/services/feed-health.spec.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { classifyFeed, STALE_TICK_THRESHOLD_MS } from './feed-health';

describe('classifyFeed', () => {
  it('is offline when the tick socket is down, regardless of other namespaces', () => {
    expect(
      classifyFeed({ tickSocketUp: false, msSinceLastTick: 100, otherNamespacesUp: 3 }),
    ).toBe('offline');
  });

  it('is stale when the socket is up but ticks have stopped', () => {
    expect(
      classifyFeed({
        tickSocketUp: true,
        msSinceLastTick: STALE_TICK_THRESHOLD_MS + 1,
        otherNamespacesUp: 0,
      }),
    ).toBe('stale');
  });

  it('is live when a tick arrived inside the threshold', () => {
    expect(
      classifyFeed({ tickSocketUp: true, msSinceLastTick: 1_000, otherNamespacesUp: 0 }),
    ).toBe('live');
  });

  it('is stale, not live, when no tick has EVER arrived', () => {
    expect(
      classifyFeed({ tickSocketUp: true, msSinceLastTick: null, otherNamespacesUp: 3 }),
    ).toBe('stale');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/web && npx vitest run src/services/feed-health.spec.ts`
Expected: FAIL — cannot resolve `./feed-health`.

- [ ] **Step 3: Write the classifier**

Create `apps/web/src/services/feed-health.ts`:

```typescript
/**
 * How long without a tick before the feed counts as stalled.
 *
 * Matches the 6s the temporary diagnostic used, which was chosen against real
 * observed tick cadence during a live session.
 */
export const STALE_TICK_THRESHOLD_MS = 6_000;

export type FeedHealth = 'live' | 'stale' | 'offline';

export interface FeedClassifierInput {
  /** Is the `/ws` socket — the ONLY namespace carrying ticks — connected? */
  tickSocketUp: boolean;
  /** Milliseconds since the last tick frame, or null if none has ever arrived. */
  msSinceLastTick: number | null;
  /** Count of OTHER namespaces up. Recorded, deliberately not used to decide. */
  otherNamespacesUp: number;
}

/**
 * Three states, decided ONLY by the tick socket and tick recency.
 *
 * The badge this replaces read `connectedCount > 0` across four namespaces, so
 * `/ws/telegram` being up rendered "Live" over a dead tick feed. Other
 * namespaces are carried in the report for diagnosis and are explicitly not
 * allowed to influence the verdict — that conflation IS the bug.
 *
 * A feed that has never delivered a tick is `stale`, never `live`. "We have not
 * heard anything yet" is not evidence of health.
 */
export function classifyFeed(input: FeedClassifierInput): FeedHealth {
  if (!input.tickSocketUp) return 'offline';
  if (input.msSinceLastTick === null) return 'stale';
  return input.msSinceLastTick > STALE_TICK_THRESHOLD_MS ? 'stale' : 'live';
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd apps/web && npx vitest run src/services/feed-health.spec.ts`
Expected: PASS, 4 tests.

- [ ] **Step 5: Add the ingest table**

Append to `prisma/schema.prisma`:

```prisma
/// A browser's own account of a stalled feed. The client is the only party that
/// can see "the badge said Live while ticks were dead", and that observation
/// previously existed only in a console.warn nobody read.
model ClientFeedReport {
  id                  String   @id @default(cuid())
  userId              String?
  health              String   // 'stale' | 'offline'
  tickSocketUp        Boolean
  secondsSinceLastTick Int?
  transport           String?
  subscribedTokens    Int
  namespaces          Json
  recoveredWithoutReload Boolean @default(false)
  createdAt           DateTime @default(now())

  @@index([createdAt])
  @@map("client_feed_reports")
}
```

Run: `npx prisma migrate dev --name add_client_feed_report`

- [ ] **Step 6: Add the ingest route**

In `apps/api/src/modules/health/health.controller.ts`, add:

```typescript
  /**
   * Ingest a browser's stall report. Authenticated (a normal user route, no
   * role needed) so reports carry a user id and cannot be spammed anonymously.
   * Returns 202 and never fails the caller — a rejected diagnostic must not
   * surface as an error in a UI that is already degraded.
   */
  @Post('client-report')
  @HttpCode(HttpStatus.ACCEPTED)
  @ApiOperation({ summary: 'Record a client-observed feed stall' })
  async clientReport(
    @CurrentUser() user: { id: string } | undefined,
    @Body() body: ClientFeedReportDto,
  ): Promise<{ accepted: boolean }> {
    return this.healthDetail.recordClientReport(user?.id ?? null, body);
  }
```

Create `apps/api/src/modules/health/dto/client-feed-report.dto.ts`:

```typescript
import { IsBoolean, IsIn, IsInt, IsObject, IsOptional, IsString, Min } from 'class-validator';

export class ClientFeedReportDto {
  @IsIn(['stale', 'offline'])
  health!: 'stale' | 'offline';

  @IsBoolean()
  tickSocketUp!: boolean;

  @IsOptional()
  @IsInt()
  @Min(0)
  secondsSinceLastTick?: number;

  @IsOptional()
  @IsString()
  transport?: string;

  @IsInt()
  @Min(0)
  subscribedTokens!: number;

  @IsObject()
  namespaces!: Record<string, boolean>;

  @IsOptional()
  @IsBoolean()
  recoveredWithoutReload?: boolean;
}
```

Add to `HealthDetailService` (it needs `PrismaService` injected — add it as the first constructor parameter):

```typescript
  /**
   * Store one client stall report.
   *
   * Returns `{ accepted: false }` instead of throwing. The caller is a browser
   * whose feed is ALREADY degraded; answering its diagnostic with a 500 would
   * add a visible error to a session that is merely stale, and could start a
   * retry loop against an endpoint that is failing.
   */
  async recordClientReport(
    userId: string | null,
    dto: ClientFeedReportDto,
  ): Promise<{ accepted: boolean }> {
    try {
      await this.prisma.clientFeedReport.create({
        data: {
          userId,
          health: dto.health,
          tickSocketUp: dto.tickSocketUp,
          secondsSinceLastTick: dto.secondsSinceLastTick ?? null,
          transport: dto.transport ?? null,
          subscribedTokens: dto.subscribedTokens,
          namespaces: dto.namespaces,
          recoveredWithoutReload: dto.recoveredWithoutReload ?? false,
        },
      });
      return { accepted: true };
    } catch {
      return { accepted: false };
    }
  }
```

- [ ] **Step 7: Replace the temp diagnostics in websocket.ts**

In `apps/web/src/services/websocket.ts`:

1. Delete the `// ---- TEMP DIAGNOSTIC ----` block at lines 119-125 and the `startDiagnostics()` method at 276-310, along with its call at line 273.
2. Keep `lastTickAt` and `nsConnected` — they are now real state, not diagnostics. Move them up with the other private fields and drop the `// DIAG` comments.
3. Add a public reader used by the badge in Plan 3 and by the reporter here:

```typescript
  /** Current feed health, decided by the tick socket alone. */
  getFeedHealth(): FeedHealth {
    return classifyFeed({
      tickSocketUp: this.nsConnected.get('/ws') ?? false,
      msSinceLastTick: this.lastTickAt ? Date.now() - this.lastTickAt : null,
      otherNamespacesUp: [...this.nsConnected.entries()].filter(
        ([p, up]) => p !== '/ws' && up,
      ).length,
    });
  }
```

4. Replace the 3-second `console.warn` loop with an episode-based reporter:

```typescript
  /** Health at the last poll, so we report TRANSITIONS rather than every poll. */
  private lastHealth: FeedHealth = 'live';
  private healthTimer: ReturnType<typeof setInterval> | null = null;

  /**
   * Watch feed health and report each stall EPISODE once.
   *
   * Episode-based, not poll-based: the diagnostic this replaces warned every 3
   * seconds for as long as a stall lasted, which is why nobody read it. One row
   * on the way into a stall and one on the way out gives the two facts actually
   * in question — how often stalls happen, and whether they self-recover
   * without a reload.
   */
  private startHealthWatch(): void {
    if (this.healthTimer) return;
    this.healthTimer = setInterval(() => {
      const health = this.getFeedHealth();
      if (health === this.lastHealth) return;

      const previous = this.lastHealth;
      this.lastHealth = health;

      const entering = health !== 'live';
      const recovering = health === 'live' && previous !== 'live';
      if (!entering && !recovering) return;

      void api
        .post('/healthz/client-report', {
          // On recovery, report the state we recovered FROM — 'live' is not a
          // valid `health` for a report and the DTO would reject it.
          health: entering ? health : previous,
          tickSocketUp: this.nsConnected.get('/ws') ?? false,
          secondsSinceLastTick: this.lastTickAt
            ? Math.round((Date.now() - this.lastTickAt) / 1000)
            : undefined,
          transport: this.transport ?? undefined,
          subscribedTokens: this.subscribedTokens.size,
          namespaces: Object.fromEntries(this.nsConnected),
          recoveredWithoutReload: recovering,
        })
        // A failed diagnostic must never surface in a UI that is already degraded.
        .catch(() => undefined);
    }, 3000);
  }
```

Call `this.startHealthWatch()` where `this.startDiagnostics()` was called (line 273), and clear `healthTimer` in `disconnect()`. Import `api` from `./api` and `classifyFeed`, `type FeedHealth` from `./feed-health`.

`previous` is captured before the assignment because a recovery row must report the state it recovered *from*; reporting `'live'` would fail the DTO's `@IsIn(['stale','offline'])` validation and the report would be silently dropped — the exact failure shape this whole plan exists to eliminate.

- [ ] **Step 8: Run the web suite**

Run: `cd apps/web && npx vitest run`
Expected: PASS, no new failures.

- [ ] **Step 9: Commit**

```bash
git add apps/web/src/services/feed-health.ts apps/web/src/services/feed-health.spec.ts apps/web/src/services/websocket.ts apps/api/src/modules/health prisma/schema.prisma prisma/migrations
git commit -m "feat(health): the browser reports its own stalls instead of warning to a console nobody reads"
```

---

## Task 9: Lazy retention for `job_runs`

**Files:**
- Modify: `apps/api/src/common/job-registry/job-run.repository.ts`
- Test: `apps/api/src/common/job-registry/job-run.retention.spec.ts`

**Interfaces:**
- Consumes: `pruneExpired(now)` from Task 2, `retentionCutoff` from Task 1.
- Produces: `maybePrune(now: Date): Promise<number>` — prunes at most once per `PRUNE_INTERVAL_MS`.

Requires Tasks 1 and 2.

- [ ] **Step 1: Write the failing test**

Create `apps/api/src/common/job-registry/job-run.retention.spec.ts`:

```typescript
import { JobRunRepository } from './job-run.repository';

function makePrisma() {
  return {
    jobRun: {
      create: jest.fn().mockResolvedValue({ id: 'row-1' }),
      update: jest.fn(),
      findUnique: jest.fn(),
      deleteMany: jest.fn().mockResolvedValue({ count: 3 }),
    },
  };
}

describe('lazy retention', () => {
  it('prunes on the first call', async () => {
    const prisma = makePrisma();
    const repo = new JobRunRepository(prisma as never);
    await repo.maybePrune(new Date('2026-08-21T10:00:00.000Z'));
    expect(prisma.jobRun.deleteMany).toHaveBeenCalledTimes(1);
  });

  it('does not prune again within the interval', async () => {
    const prisma = makePrisma();
    const repo = new JobRunRepository(prisma as never);
    await repo.maybePrune(new Date('2026-08-21T10:00:00.000Z'));
    await repo.maybePrune(new Date('2026-08-21T10:30:00.000Z'));
    expect(prisma.jobRun.deleteMany).toHaveBeenCalledTimes(1);
  });

  it('prunes again after the interval elapses', async () => {
    const prisma = makePrisma();
    const repo = new JobRunRepository(prisma as never);
    await repo.maybePrune(new Date('2026-08-21T10:00:00.000Z'));
    await repo.maybePrune(new Date('2026-08-22T11:00:00.000Z'));
    expect(prisma.jobRun.deleteMany).toHaveBeenCalledTimes(2);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/api && npx jest src/common/job-registry/job-run.retention.spec.ts`
Expected: FAIL — `repo.maybePrune is not a function`

- [ ] **Step 3: Add lazy pruning**

Add to `JobRunRepository` in `apps/api/src/common/job-registry/job-run.repository.ts`:

```typescript
/**
 * Minimum gap between prune sweeps.
 *
 * Retention is LAZY on purpose. This program's whole thesis is that a job which
 * silently fails to fire is the dominant failure mode here — so adding a cron
 * to clean up the table that proves jobs fired would be self-defeating. Piggy-
 * backing on write traffic means the pruner runs exactly when the table is
 * growing, and stops when it is not.
 */
const PRUNE_INTERVAL_MS = 24 * 60 * 60 * 1000;
```

...and inside the class:

```typescript
  private lastPruneAt = 0;

  /** Prune expired rows at most once per {@link PRUNE_INTERVAL_MS}. */
  async maybePrune(now: Date): Promise<number> {
    if (now.getTime() - this.lastPruneAt < PRUNE_INTERVAL_MS) return 0;
    this.lastPruneAt = now.getTime();
    return this.pruneExpired(now);
  }
```

- [ ] **Step 4: Call it from the write path**

In `JobRunnerService.run()` (Task 3), after `recordEnd` succeeds, add a fire-and-forget call:

```typescript
    // Retention rides on write traffic — see PRUNE_INTERVAL_MS. Deliberately not
    // awaited: a prune must never add latency to, or fail, a scheduled job.
    void this.runs.maybePrune(new Date());
```

- [ ] **Step 5: Run tests**

Run: `cd apps/api && npx jest src/common/job-registry`
Expected: PASS, all job-registry specs green.

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/common/job-registry
git commit -m "feat(job-registry): lazy 30-day retention, no new cron"
```

---

## Task 10: Count stops that were never evaluated

**Files:**
- Create: `apps/api/src/common/stop-evidence/unevaluated-stops.ts`
- Create: `apps/api/src/common/stop-evidence/stop-evidence.module.ts`
- Test: `apps/api/src/common/stop-evidence/unevaluated-stops.spec.ts`
- Modify: `apps/api/src/modules/watch-monitor/services/watch-backstop-poller.service.ts:62-66`
- Modify: `apps/api/src/modules/ungated-track/services/ungated-tick-poller.service.ts:69-71`
- Modify: `apps/api/src/modules/sell-futures-track/services/sell-futures-tick-poller.service.ts`
- Modify: `apps/api/src/modules/adaptive-stop-track/services/adaptive-stop-tick-poller.service.ts`
- Modify: `apps/api/src/modules/health/health-detail.service.ts`

**Why:** spec §B2.2. Four sites skip a position's stop evaluation when the resolved price is
not fresh, and each records that fact as a `logger.warn` and nothing else. A stop that did
not run is exactly the evidence this spine exists to surface, and Phase 2's baseline is not
trustworthy without it — a consolidation cannot be judged safe against a baseline that does
not count the ticks it never evaluated.

**Interfaces:**
- Consumes: `Signal<T>`, `present`, `unavailable` from `health.types.ts`.
- Produces: `interface UnevaluatedStops { total: number; byTrack: Record<string, number>; lastAt: string | null }`, injectable `UnevaluatedStopsTracker` with `record(track: string): void` and `snapshot(): UnevaluatedStops`.

Requires Task 7 (extends its payload).

- [ ] **Step 1: Write the failing test**

Create `apps/api/src/common/stop-evidence/unevaluated-stops.spec.ts`:

```typescript
import { UnevaluatedStopsTracker } from './unevaluated-stops';

describe('UnevaluatedStopsTracker', () => {
  it('starts empty with a null lastAt, not a zero timestamp', () => {
    expect(new UnevaluatedStopsTracker().snapshot()).toEqual({
      total: 0,
      byTrack: {},
      lastAt: null,
    });
  });

  it('counts per track and in total', () => {
    const t = new UnevaluatedStopsTracker();
    t.record('watch-backstop', new Date('2026-08-21T10:00:00.000Z'));
    t.record('ungated', new Date('2026-08-21T10:00:30.000Z'));
    t.record('ungated', new Date('2026-08-21T10:01:00.000Z'));
    const s = t.snapshot();
    expect(s.total).toBe(3);
    expect(s.byTrack).toEqual({ 'watch-backstop': 1, ungated: 2 });
  });

  it('reports the most recent occurrence', () => {
    const t = new UnevaluatedStopsTracker();
    t.record('ungated', new Date('2026-08-21T10:00:00.000Z'));
    t.record('ungated', new Date('2026-08-21T10:05:00.000Z'));
    expect(t.snapshot().lastAt).toBe('2026-08-21T10:05:00.000Z');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/api && npx jest src/common/stop-evidence/unevaluated-stops.spec.ts`
Expected: FAIL — `Cannot find module './unevaluated-stops'`

- [ ] **Step 3: Write the tracker**

Create `apps/api/src/common/stop-evidence/unevaluated-stops.ts`:

```typescript
import { Injectable } from '@nestjs/common';

/** How often a position's stop could not be evaluated, and for which track. */
export interface UnevaluatedStops {
  total: number;
  byTrack: Record<string, number>;
  /** ISO instant of the most recent skip, or null if it has never happened. */
  lastAt: string | null;
}

/**
 * Counts stop evaluations that did not happen.
 *
 * Four poller sites `continue` past a position when `ExitPriceService` cannot
 * return a fresh price, leaving a `logger.warn` as the only trace. A stop that
 * was NOT evaluated is not a quiet non-event — it is a position that went
 * unwatched for that cycle, and it reads identically to a healthy cycle in
 * every dashboard the platform has.
 *
 * In-memory and per-process, like SlotPressureTracker: the question is "is this
 * happening, and to which track", answered by reading the counter while the
 * container lives. Persisting each occurrence would be a write on the hot path
 * of the thing that is already struggling to get a price.
 */
@Injectable()
export class UnevaluatedStopsTracker {
  private total = 0;
  private readonly byTrack = new Map<string, number>();
  private lastAt: Date | null = null;

  record(track: string, at: Date = new Date()): void {
    this.total++;
    this.byTrack.set(track, (this.byTrack.get(track) ?? 0) + 1);
    if (!this.lastAt || at > this.lastAt) this.lastAt = at;
  }

  snapshot(): UnevaluatedStops {
    return {
      total: this.total,
      byTrack: Object.fromEntries(this.byTrack),
      lastAt: this.lastAt ? this.lastAt.toISOString() : null,
    };
  }
}
```

Create `apps/api/src/common/stop-evidence/stop-evidence.module.ts`:

```typescript
import { Global, Module } from '@nestjs/common';
import { UnevaluatedStopsTracker } from './unevaluated-stops';

/** Global: four feature modules record into one process-wide counter. */
@Global()
@Module({
  providers: [UnevaluatedStopsTracker],
  exports: [UnevaluatedStopsTracker],
})
export class StopEvidenceModule {}
```

Register `StopEvidenceModule` in `apps/api/src/app.module.ts` imports.

- [ ] **Step 4: Run test to verify it passes**

Run: `cd apps/api && npx jest src/common/stop-evidence/unevaluated-stops.spec.ts`
Expected: PASS, 3 tests.

- [ ] **Step 5: Record at all four skip sites**

At each site, inject `UnevaluatedStopsTracker` into the constructor and add a `record()` call
immediately before the existing `continue`. Keep the existing `logger.warn` — the log is
still useful when someone is already reading logs; the counter is for when nobody is.

`watch-backstop-poller.service.ts:62-66` becomes:

```typescript
        if (!r || !r.fresh) {
          this.unevaluatedStops.record('watch-backstop');
          this.logger.warn(
            `[watch-backstop] ${e.symbol} unmonitored — no fresh price, stop not evaluated`,
          );
          continue;
        }
```

`ungated-tick-poller.service.ts:69-71` becomes:

```typescript
        if (!r.fresh) {
          this.unevaluatedStops.record('ungated');
          this.logger.warn(`[ungated-poll] ${token} unmonitored — no fresh price, onTick skipped`);
          continue;
        }
```

Apply the same shape in `sell-futures-tick-poller.service.ts` (track name `'sell-futures'`)
and `adaptive-stop-tick-poller.service.ts` (track name `'adaptive-stop'`), at their
equivalent not-fresh guards. If a track's guard is shaped differently, record at whichever
branch causes the position to be skipped for that cycle — the criterion is "the stop was not
evaluated", not the specific condition text.

- [ ] **Step 6: Surface in /healthz/detail**

In `health-detail.service.ts`, inject `UnevaluatedStopsTracker`, add
`unevaluatedStops: Signal<UnevaluatedStops>` to `HealthDetailPayload`, and collect it in
`check()` alongside the others with the same try/catch-to-`unavailable` shape used by
`checkSlots()`.

- [ ] **Step 7: Run the affected suites**

Run: `cd apps/api && npx jest src/common/stop-evidence src/modules/health src/modules/watch-monitor src/modules/ungated-track src/modules/sell-futures-track src/modules/adaptive-stop-track`
Expected: PASS. A DI failure in a track's existing spec means that spec constructs the
poller directly and needs the new constructor argument — pass a `new UnevaluatedStopsTracker()`.

- [ ] **Step 8: Commit**

```bash
git add apps/api/src/common/stop-evidence apps/api/src/app.module.ts apps/api/src/modules/health apps/api/src/modules/watch-monitor/services/watch-backstop-poller.service.ts apps/api/src/modules/ungated-track/services/ungated-tick-poller.service.ts apps/api/src/modules/sell-futures-track/services/sell-futures-tick-poller.service.ts apps/api/src/modules/adaptive-stop-track/services/adaptive-stop-tick-poller.service.ts
git commit -m "feat(stop-evidence): count stops that were never evaluated"
```

---

## Verification Gate

**This plan is not complete when the tests pass.** It is complete when production answers a question it previously could not.

- [ ] **Step 1: Deploy and confirm the public probe is unchanged**

```bash
curl -s https://grw-api.onrender.com/healthz | head -40
```

Expected: HTTP 200, `status: "ok"`, all pre-existing fields present and unchanged.

- [ ] **Step 2: Query the detail endpoint with an admin JWT**

```bash
curl -s -H "Authorization: Bearer $ADMIN_JWT" https://grw-api.onrender.com/healthz/detail
```

- [ ] **Step 3: Confirm the gate**

Record the answers in the handoff:

| Question | Where |
|---|---|
| What is RSS on a live container, against the 512 MB cap? | `memory.rssMb` |
| Has the primary feed pool ever saturated? How many rejections? | `slots.primaryHighWater`, `slots.rejections` |
| Which jobs report `at: null` — have never run in production? | `jobs` |

**The gate passes when `/healthz/detail` names something we did not already know.** Until Plan 2 populates `EXPECTED_JOBS`, the `jobs` map is legitimately near-empty — `memory` and `slots` carry the gate on their own.

- [ ] **Step 4: Commit the findings**

Write the three answers into `docs/handoffs/` as the input Plan 2 needs: measured job runtimes set the lease TTLs, and observed slot saturation decides whether B5 needs a fix at all.

---

## Notes for the executor

- **User-owned prerequisites.** `ANTHROPIC_API_KEY`, `CRON_LEASE_ENABLED=true` and `DIRECT_URL` must be set in the Render dashboard, and two migrations from a previous session are unapplied. This plan does not depend on them to *build*, but the Verification Gate cannot pass without a deploy, and `prisma migrate deploy` will hang on the pooled endpoint until `DIRECT_URL` exists. Flag immediately if blocked; do not fake the gate.
- **Three commits were unpushed at the start of this work** (`5e01e63`, `6f72d0d`, `3bd1bc0`), with `git push` failing authentication. Confirm the remote is reachable before branching.
- **`EXPECTED_JOBS` is intentionally empty here.** It is populated in Plan 2 as each surviving job is routed through `JobRunnerService`. An empty list is honest; a guessed list would report never-run for jobs that were never wired.
