-- Re-entry watch (2026-11-05, docs/superpowers/specs/2026-11-05-reentry-watch-design.md): after an option
-- position is exited, its underlying is watched for the rest of the session for a SAME / OPPOSITE direction
-- re-entry (PAPER only, strategy REENTRY_WATCH). One row per watch whenever its outcome category changes
-- (SIGNAL / WAIT reason / SKIP / CAP / ENDED). `watch_key` = '<table>:<id>' of the exited position;
-- `trade_id` = the PAPER trade a SIGNAL opened, else NULL. `mode` = REENTRY_WATCH at the time. No FK.
-- Expand-only: one new table, nothing altered.
CREATE TABLE "reentry_watch_decisions" (
    "id" TEXT NOT NULL,
    "watch_key" TEXT NOT NULL,
    "underlying" TEXT NOT NULL,
    "at" TIMESTAMPTZ(6) NOT NULL,
    "action" TEXT NOT NULL,
    "direction" TEXT,
    "category" TEXT NOT NULL,
    "inputs" JSONB NOT NULL,
    "reasons" JSONB NOT NULL,
    "trade_id" TEXT,
    "mode" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "reentry_watch_decisions_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "reentry_watch_decisions_at_idx" ON "reentry_watch_decisions"("at");
CREATE INDEX "reentry_watch_decisions_watch_key_at_idx" ON "reentry_watch_decisions"("watch_key", "at");
CREATE INDEX "reentry_watch_decisions_action_at_idx" ON "reentry_watch_decisions"("action", "at");
CREATE INDEX "reentry_watch_decisions_trade_id_idx" ON "reentry_watch_decisions"("trade_id");
