-- Trade setups read from Telegram chart screenshots (owner 2026-11-02: "Stock Wale Bhaiyaa Learning Group" posts its
-- trades only as position-tool screenshots; the text reader never saw them).
--
-- telegram_image_reads: one row per photo message of an IMAGE_SETUP_CHANNELS channel that the vision extractor read
-- (or could not read — then extraction carries the error and reason says why). kind NEW_SETUP | UPDATE | RESULT |
-- NOT_A_SETUP is the kind AFTER the code rules (caption / price / validation); the model's own kind stays in extraction.
-- valid = the levels passed the geometry / number / instrument checks. reason = why not valid, which rule changed the
-- kind, or why a valid NEW_SETUP was not promoted (observe mode, stale screenshot, option SELL refused).
-- linked_signal_id = the trade_signals row it became in IMAGE_SETUPS=signal mode. No FK (keep-all-data rule).
CREATE TABLE "telegram_image_reads" (
    "id" TEXT NOT NULL,
    "message_id" TEXT NOT NULL,
    "channel_id" TEXT NOT NULL,
    "posted_at" TIMESTAMPTZ(6) NOT NULL,
    "kind" TEXT NOT NULL,
    "extraction" JSONB NOT NULL,
    "valid" BOOLEAN NOT NULL,
    "reason" TEXT,
    "model" TEXT,
    "linked_signal_id" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "telegram_image_reads_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "telegram_image_reads_message_id_key" ON "telegram_image_reads"("message_id");
CREATE INDEX "telegram_image_reads_channel_id_posted_at_idx" ON "telegram_image_reads"("channel_id", "posted_at");
CREATE INDEX "telegram_image_reads_created_at_idx" ON "telegram_image_reads"("created_at");
