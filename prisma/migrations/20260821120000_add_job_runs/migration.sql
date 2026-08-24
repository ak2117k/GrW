-- CreateEnum
CREATE TYPE "JobOutcome" AS ENUM ('RUNNING', 'SUCCESS', 'FAILED', 'SKIPPED_LEASE');

-- CreateTable
CREATE TABLE "job_runs" (
    "id" TEXT NOT NULL,
    "jobName" TEXT NOT NULL,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finishedAt" TIMESTAMP(3),
    "outcome" "JobOutcome" NOT NULL,
    "error" TEXT,
    "durationMs" INTEGER,

    CONSTRAINT "job_runs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
-- Serves the per-job "when did this last run" lookup.
CREATE INDEX "job_runs_jobName_startedAt_idx" ON "job_runs"("jobName", "startedAt");

-- CreateIndex
-- Serves retention pruning, which filters on startedAt alone. The composite
-- above leads with jobName, so a btree cannot range-scan it for a bare
-- startedAt predicate.
CREATE INDEX "job_runs_startedAt_idx" ON "job_runs"("startedAt");
