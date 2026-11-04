-- Self-review fix tickets (2026-11-04, docs/superpowers/plans/2026-11-04-self-review-wrong-decision-loop.md, G1b).
-- Expand-only: one new table, nothing altered. One row per stable key (cause + component); the nightly run upserts
-- it when the diagnosis names a repeated CODE_BUG / DATA cause, bumping occurrences / last_seen / cost_rupees.
-- Read by GET /api/self-review/fix-queue and scripts/ops/pull-fix-queue.sh (read-only). No FK.

-- CreateTable
CREATE TABLE "fix_tickets" (
    "id" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "cause" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "evidence" JSONB NOT NULL,
    "proposed_change" TEXT NOT NULL,
    "files" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "test_description" TEXT NOT NULL DEFAULT '',
    "status" TEXT NOT NULL DEFAULT 'OPEN',
    "occurrences" INTEGER NOT NULL DEFAULT 1,
    "cost_rupees" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "first_seen" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_seen" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "fix_tickets_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "fix_tickets_key_key" ON "fix_tickets"("key");

-- CreateIndex
CREATE INDEX "fix_tickets_status_last_seen_idx" ON "fix_tickets"("status", "last_seen");
