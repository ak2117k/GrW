-- AI message reader (2026-11-25, apps/api/src/modules/message-reader). Expand-only: one new table, nothing altered or dropped.
--
-- message_readings: the AI's reading of one Telegram post (kind, scope, claims with verdict + evidence, any call)
-- and the latency of each stage. One row per message (message_id PK, upsert on edit). No FK to
-- telegram_messages (same as channel_infos).
CREATE TABLE "message_readings" (
    "message_id" TEXT NOT NULL,
    "channel_id" TEXT NOT NULL,
    "posted_at" TIMESTAMPTZ(6) NOT NULL,
    "session_date" TEXT NOT NULL,
    "read_at" TIMESTAMPTZ(6),
    "status" TEXT NOT NULL,
    "kind" TEXT,
    "scope" TEXT,
    "claims" JSONB NOT NULL,
    "call" JSONB,
    "parse_agrees" BOOLEAN,
    "missed_by_rules" BOOLEAN NOT NULL DEFAULT false,
    "rule_status" TEXT,
    "summary" TEXT,
    "model" TEXT,
    "packet" JSONB,
    "queued_ms" INTEGER,
    "packet_ms" INTEGER,
    "ai_ms" INTEGER,
    "text_hash" TEXT NOT NULL,
    "outcomes" JSONB,
    "outcome_filled_at" TIMESTAMPTZ(6),
    "error" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    CONSTRAINT "message_readings_pkey" PRIMARY KEY ("message_id")
);
CREATE INDEX "message_readings_posted_at_idx" ON "message_readings"("posted_at");
CREATE INDEX "message_readings_scope_posted_at_idx" ON "message_readings"("scope", "posted_at");
CREATE INDEX "message_readings_text_hash_idx" ON "message_readings"("text_hash");
CREATE INDEX "message_readings_outcome_filled_at_idx" ON "message_readings"("outcome_filled_at");
CREATE INDEX "message_readings_session_date_status_idx" ON "message_readings"("session_date", "status");
