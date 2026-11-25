-- AI setups (2026-11-25, apps/api/src/modules/ai-setups). Expand-only: one new table, nothing altered or dropped.
--
-- ai_setups: one AI setup decision per verified channel claim: an intraday option BUY on the underlying's
-- levels (PENDING -> FILLED -> EXITED, or EXPIRED), NO_TRADE with the reason / failed code check, or SKIPPED.
-- Paper only in v1. No FK to message_readings / telegram_channels / trades (same as message_readings).
CREATE TABLE "ai_setups" (
    "id" TEXT NOT NULL,
    "reading_id" TEXT NOT NULL,
    "underlying" TEXT NOT NULL,
    "channel_id" TEXT NOT NULL,
    "decision" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "setup" JSONB,
    "checks" JSONB,
    "packet" JSONB,
    "status" TEXT NOT NULL,
    "trade_id" TEXT,
    "valid_until" TIMESTAMPTZ(6),
    "entry_at" TIMESTAMPTZ(6),
    "exit_at" TIMESTAMPTZ(6),
    "exit_reason" TEXT,
    "pnl" DOUBLE PRECISION,
    "grade" JSONB,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    CONSTRAINT "ai_setups_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "ai_setups_status_idx" ON "ai_setups"("status");
CREATE INDEX "ai_setups_underlying_created_at_idx" ON "ai_setups"("underlying", "created_at");
CREATE INDEX "ai_setups_created_at_idx" ON "ai_setups"("created_at");
