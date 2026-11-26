-- Desk manager (2026-11-26, apps/api/src/modules/desk-manager). Expand-only: five new tables, nothing altered or dropped.
CREATE TABLE "desk_manager_runs" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "started_at" TIMESTAMPTZ(6) NOT NULL,
    "finished_at" TIMESTAMPTZ(6),
    "wake_reasons" JSONB NOT NULL,
    "mode" TEXT NOT NULL,
    "packet" JSONB,
    "packet_ms" INTEGER,
    "ai_ms" INTEGER,
    "reply" JSONB,
    "summary" TEXT,
    "error" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    CONSTRAINT "desk_manager_runs_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "desk_manager_runs_user_id_started_at_idx" ON "desk_manager_runs"("user_id", "started_at");

CREATE TABLE "desk_manager_decisions" (
    "id" TEXT NOT NULL,
    "run_id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "underlying" TEXT,
    "tracker_id" TEXT,
    "payload" JSONB NOT NULL,
    "validation" JSONB NOT NULL,
    "status" TEXT NOT NULL,
    "result" JSONB,
    "order_row_id" TEXT,
    "trade_id" TEXT,
    "exec_id" TEXT,
    "grade" JSONB,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    CONSTRAINT "desk_manager_decisions_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "desk_manager_decisions_user_id_created_at_idx" ON "desk_manager_decisions"("user_id", "created_at");
CREATE INDEX "desk_manager_decisions_action_status_idx" ON "desk_manager_decisions"("action", "status");

CREATE TABLE "desk_manager_pending_entries" (
    "id" TEXT NOT NULL,
    "decision_id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "underlying" TEXT NOT NULL,
    "mode" TEXT NOT NULL,
    "decision" JSONB NOT NULL,
    "valid_until" TIMESTAMPTZ(6) NOT NULL,
    "status" TEXT NOT NULL,
    "result" JSONB,
    "order_row_id" TEXT,
    "trade_id" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    CONSTRAINT "desk_manager_pending_entries_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "desk_manager_pending_entries_decision_id_key" ON "desk_manager_pending_entries"("decision_id");
CREATE INDEX "desk_manager_pending_entries_status_valid_until_idx" ON "desk_manager_pending_entries"("status", "valid_until");

CREATE TABLE "desk_guard_events" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "at" TIMESTAMPTZ(6) NOT NULL,
    "source" TEXT NOT NULL,
    "blocked" BOOLEAN NOT NULL,
    "reasons" JSONB NOT NULL,
    "path" JSONB NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "desk_guard_events_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "desk_guard_events_user_id_at_idx" ON "desk_guard_events"("user_id", "at");

CREATE TABLE "desk_guard_state" (
    "user_id" TEXT NOT NULL,
    "day" TEXT NOT NULL,
    "paused_until" TIMESTAMPTZ(6),
    "pause_scope" TEXT,
    "reset_at" TIMESTAMPTZ(6),
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    CONSTRAINT "desk_guard_state_pkey" PRIMARY KEY ("user_id")
);
