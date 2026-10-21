-- Self-review loop (docs/superpowers/plans/2026-10-21-self-review-contract.md).
-- Expand-only: five new tables, nothing altered.

-- CreateTable
CREATE TABLE "verification_results" (
    "id" TEXT NOT NULL,
    "run_id" TEXT NOT NULL,
    "session_date" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "ref_id" TEXT NOT NULL,
    "subject" TEXT,
    "symbol" TEXT,
    "predicted" TEXT NOT NULL,
    "actual" TEXT NOT NULL,
    "correct" BOOLEAN,
    "score" DOUBLE PRECISION,
    "details" JSONB,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "verification_results_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "self_review_runs" (
    "id" TEXT NOT NULL,
    "session_date" TEXT NOT NULL,
    "started_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finished_at" TIMESTAMPTZ(6),
    "status" TEXT NOT NULL,
    "summary" JSONB,
    "diagnosis" JSONB,
    "ai_call_id" TEXT,
    "error" TEXT,

    CONSTRAINT "self_review_runs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "agent_lessons" (
    "id" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "text" TEXT NOT NULL,
    "scope" TEXT NOT NULL,
    "right_count" INTEGER NOT NULL DEFAULT 0,
    "wrong_count" INTEGER NOT NULL DEFAULT 0,
    "status" TEXT NOT NULL DEFAULT 'ACTIVE',
    "first_seen" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_seen" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "source_run" TEXT,

    CONSTRAINT "agent_lessons_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "tuning_proposals" (
    "id" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "target" TEXT NOT NULL,
    "current_value" JSONB NOT NULL,
    "proposed_value" JSONB NOT NULL,
    "rationale" TEXT NOT NULL,
    "evidence" JSONB NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "decided_at" TIMESTAMPTZ(6),
    "decided_by" TEXT,
    "source_run" TEXT,

    CONSTRAINT "tuning_proposals_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "tuning_overrides" (
    "target" TEXT NOT NULL,
    "value" JSONB NOT NULL,
    "proposal_id" TEXT,
    "applied_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "applied_by" TEXT,

    CONSTRAINT "tuning_overrides_pkey" PRIMARY KEY ("target")
);

-- CreateIndex
CREATE INDEX "verification_results_session_date_kind_idx" ON "verification_results"("session_date", "kind");

-- CreateIndex
CREATE UNIQUE INDEX "verification_results_kind_ref_id_key" ON "verification_results"("kind", "ref_id");

-- CreateIndex
CREATE INDEX "self_review_runs_session_date_idx" ON "self_review_runs"("session_date");

-- CreateIndex
CREATE UNIQUE INDEX "agent_lessons_key_key" ON "agent_lessons"("key");

-- CreateIndex
CREATE INDEX "agent_lessons_status_scope_idx" ON "agent_lessons"("status", "scope");

-- CreateIndex
CREATE INDEX "tuning_proposals_status_created_at_idx" ON "tuning_proposals"("status", "created_at" DESC);
