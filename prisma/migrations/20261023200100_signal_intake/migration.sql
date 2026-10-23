-- Signal intake (stream S): parsed Telegram tips, their clusters, and the per-message classification. Expand-only: three new tables, no FK to stream R's tables.

-- CreateTable
CREATE TABLE "trade_signals" (
    "id" TEXT NOT NULL,
    "message_id" TEXT NOT NULL,
    "channel_id" TEXT NOT NULL,
    "received_at" TIMESTAMPTZ(6) NOT NULL,
    "session_date" TEXT NOT NULL,
    "parser" TEXT NOT NULL,
    "underlying" TEXT NOT NULL,
    "instrument_kind" TEXT NOT NULL,
    "strike" DOUBLE PRECISION,
    "expiry" TEXT,
    "expiry_source" TEXT,
    "exchange" TEXT,
    "token" TEXT,
    "tradingsymbol" TEXT,
    "side" TEXT NOT NULL,
    "direction" TEXT NOT NULL,
    "entry_low" DOUBLE PRECISION NOT NULL,
    "entry_high" DOUBLE PRECISION NOT NULL,
    "entry_type" TEXT NOT NULL,
    "sl" DOUBLE PRECISION,
    "targets" JSONB NOT NULL,
    "qty" INTEGER,
    "horizon" TEXT NOT NULL DEFAULT 'INTRADAY',
    "tags" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "confidence" DOUBLE PRECISION NOT NULL,
    "raw_text" TEXT NOT NULL,
    "dedup_key" TEXT NOT NULL,
    "cluster_id" TEXT,
    "outcome_status" TEXT,
    "outcome_session" TEXT,
    "outcome_entry_at" TIMESTAMPTZ(6),
    "outcome_exit_at" TIMESTAMPTZ(6),
    "outcome_details" JSONB,
    "outcome_filled_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "trade_signals_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "signal_clusters" (
    "id" TEXT NOT NULL,
    "underlying" TEXT NOT NULL,
    "direction" TEXT NOT NULL,
    "window_start" TIMESTAMPTZ(6) NOT NULL,
    "channel_ids" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "signal_ids" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "agree_count" INTEGER NOT NULL DEFAULT 1,
    "conflict" BOOLEAN NOT NULL DEFAULT false,
    "status" TEXT NOT NULL DEFAULT 'OPEN',
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "signal_clusters_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "signal_message_classes" (
    "message_id" TEXT NOT NULL,
    "channel_id" TEXT NOT NULL,
    "posted_at" TIMESTAMPTZ(6) NOT NULL,
    "text_hash" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "reason" TEXT,
    "parser" TEXT,
    "llm_result" JSONB,
    "signal_id" TEXT,
    "update_kind" TEXT,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "signal_message_classes_pkey" PRIMARY KEY ("message_id")
);

-- CreateIndex
CREATE UNIQUE INDEX "trade_signals_message_id_key" ON "trade_signals"("message_id");

-- CreateIndex
CREATE INDEX "trade_signals_underlying_received_at_idx" ON "trade_signals"("underlying", "received_at");

-- CreateIndex
CREATE INDEX "trade_signals_channel_id_received_at_idx" ON "trade_signals"("channel_id", "received_at");

-- CreateIndex
CREATE INDEX "trade_signals_dedup_key_received_at_idx" ON "trade_signals"("dedup_key", "received_at");

-- CreateIndex
CREATE INDEX "trade_signals_outcome_filled_at_session_date_idx" ON "trade_signals"("outcome_filled_at", "session_date");

-- CreateIndex
CREATE INDEX "trade_signals_outcome_session_idx" ON "trade_signals"("outcome_session");

-- CreateIndex
CREATE INDEX "signal_clusters_underlying_window_start_idx" ON "signal_clusters"("underlying", "window_start");

-- CreateIndex
CREATE INDEX "signal_message_classes_text_hash_idx" ON "signal_message_classes"("text_hash");

-- CreateIndex
CREATE INDEX "signal_message_classes_status_posted_at_idx" ON "signal_message_classes"("status", "posted_at");

-- CreateIndex
CREATE INDEX "signal_message_classes_channel_id_posted_at_idx" ON "signal_message_classes"("channel_id", "posted_at");

