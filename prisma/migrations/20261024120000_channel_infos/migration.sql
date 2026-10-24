-- Telegram INFO posts (2026-10-24): structured market information per message + the classifier version on
-- signal_message_classes. Expand-only: one new table, one new nullable column.

-- AlterTable
ALTER TABLE "signal_message_classes" ADD COLUMN "class_version" INTEGER;

-- CreateTable
CREATE TABLE "channel_infos" (
    "id" TEXT NOT NULL,
    "message_id" TEXT NOT NULL,
    "channel_id" TEXT NOT NULL,
    "posted_at" TIMESTAMPTZ(6) NOT NULL,
    "session_date" TEXT NOT NULL,
    "text_hash" TEXT NOT NULL,
    "items" JSONB NOT NULL,
    "extractor" TEXT NOT NULL,
    "confidence" DOUBLE PRECISION NOT NULL,
    "llm_reply" JSONB,
    "outcomes" JSONB,
    "outcome_session" TEXT,
    "outcome_filled_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "channel_infos_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "channel_infos_message_id_key" ON "channel_infos"("message_id");

-- CreateIndex
CREATE INDEX "channel_infos_posted_at_idx" ON "channel_infos"("posted_at");

-- CreateIndex
CREATE INDEX "channel_infos_channel_id_posted_at_idx" ON "channel_infos"("channel_id", "posted_at");

-- CreateIndex
CREATE INDEX "channel_infos_text_hash_idx" ON "channel_infos"("text_hash");

-- CreateIndex
CREATE INDEX "channel_infos_outcome_session_idx" ON "channel_infos"("outcome_session");

-- CreateIndex
CREATE INDEX "channel_infos_outcome_filled_at_posted_at_idx" ON "channel_infos"("outcome_filled_at", "posted_at");
