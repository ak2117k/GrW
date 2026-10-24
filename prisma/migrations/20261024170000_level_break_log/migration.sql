-- Level-break research log (2026-10-24). Expand-only: one new table. Nothing in trading reads it.

-- CreateTable
CREATE TABLE "level_break_log" (
    "id" TEXT NOT NULL,
    "instrument" TEXT NOT NULL,
    "timeframe" TEXT NOT NULL,
    "direction" TEXT NOT NULL,
    "ts" TIMESTAMPTZ(6) NOT NULL,
    "level" DOUBLE PRECISION NOT NULL,
    "zone_type" TEXT NOT NULL,
    "zone_upper" DOUBLE PRECISION NOT NULL,
    "zone_lower" DOUBLE PRECISION NOT NULL,
    "classification" TEXT NOT NULL,
    "touch_count" INTEGER NOT NULL,
    "atr" DOUBLE PRECISION NOT NULL,
    "price" DOUBLE PRECISION NOT NULL,
    "fut_token" TEXT,
    "fut_oi_now" DOUBLE PRECISION,
    "fut_oi_15m_before" DOUBLE PRECISION,
    "fut_oi_change" DOUBLE PRECISION,
    "price_at_15m" DOUBLE PRECISION,
    "price_at_60m" DOUBLE PRECISION,
    "price_eod" DOUBLE PRECISION,
    "move_15m_pts" DOUBLE PRECISION,
    "move_60m_pts" DOUBLE PRECISION,
    "move_eod_pts" DOUBLE PRECISION,
    "mfe_eod_pts" DOUBLE PRECISION,
    "mae_eod_pts" DOUBLE PRECISION,
    "outcome_filled_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "level_break_log_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "level_break_log_instrument_timeframe_ts_direction_level_key" ON "level_break_log"("instrument", "timeframe", "ts", "direction", "level");

-- CreateIndex
CREATE INDEX "level_break_log_outcome_filled_at_ts_idx" ON "level_break_log"("outcome_filled_at", "ts");
