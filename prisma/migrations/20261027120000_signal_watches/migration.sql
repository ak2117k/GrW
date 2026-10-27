-- Breakout levels from Telegram WATCH posts, watched until crossed or expired (owner 2026-10-27).
CREATE TABLE "signal_watches" (
    "id" TEXT NOT NULL,
    "message_id" TEXT NOT NULL,
    "item_index" INTEGER NOT NULL,
    "channel_id" TEXT NOT NULL,
    "posted_at" TIMESTAMPTZ(6) NOT NULL,
    "underlying" TEXT NOT NULL,
    "instrument_kind" TEXT NOT NULL,
    "side" TEXT NOT NULL,
    "level" DOUBLE PRECISION NOT NULL,
    "exchange" TEXT,
    "token" TEXT,
    "status" TEXT NOT NULL DEFAULT 'ACTIVE',
    "reason" TEXT,
    "expires_at" TIMESTAMPTZ(6) NOT NULL,
    "last_ltp" DOUBLE PRECISION,
    "last_check_at" TIMESTAMPTZ(6),
    "fired_at" TIMESTAMPTZ(6),
    "signal_id" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "signal_watches_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "signal_watches_message_id_item_index_key" ON "signal_watches"("message_id", "item_index");
CREATE INDEX "signal_watches_status_expires_at_idx" ON "signal_watches"("status", "expires_at");
