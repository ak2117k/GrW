-- Decision ledger (2026-11-05, docs/superpowers/plans/2026-11-04-self-review-wrong-decision-loop.md, stream F):
-- every trade decision (entry take / skip / blocked, size, exit / hold / gated exit / floor / spike bank /
-- hard loss / ladder, intraday carry) and every system-detector hit, graded nightly against the other
-- choice in real rupees per lot net of charges, one row per horizon. Unique per (ref_table, ref_id,
-- decision_type, horizon): a rerun overwrites the grade. Expand-only: one new table, nothing altered. No FK.
-- Rollback: SELF_REVIEW_DECISION_LOOP=off stops the writes; the table can stay.

-- CreateTable
CREATE TABLE "decision_grades" (
    "id" TEXT NOT NULL,
    "session_date" TEXT NOT NULL,
    "decision_type" TEXT NOT NULL,
    "detector" TEXT,
    "ref_table" TEXT NOT NULL,
    "ref_id" TEXT NOT NULL,
    "user_id" TEXT,
    "symbol" TEXT,
    "underlying" TEXT,
    "mode" TEXT NOT NULL,
    "decided_at" TIMESTAMPTZ(6) NOT NULL,
    "chosen" TEXT NOT NULL,
    "alternative" TEXT NOT NULL,
    "pnl_chosen" DOUBLE PRECISION,
    "pnl_alternative" DOUBLE PRECISION,
    "delta_rupees" DOUBLE PRECISION,
    "horizon" TEXT NOT NULL,
    "verdict" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "facts" JSONB NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "decision_grades_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "decision_grades_ref_table_ref_id_decision_type_horizon_key" ON "decision_grades"("ref_table", "ref_id", "decision_type", "horizon");
CREATE INDEX "decision_grades_session_date_verdict_idx" ON "decision_grades"("session_date", "verdict");
CREATE INDEX "decision_grades_decision_type_session_date_idx" ON "decision_grades"("decision_type", "session_date");
