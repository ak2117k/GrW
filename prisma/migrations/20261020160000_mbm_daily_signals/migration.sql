-- MBM daily setups monitor (OBSERVE only). Expand-only: one new table, nothing altered.
-- Body matches `prisma migrate diff` output for schema.prisma. The grw_ai grants live in
-- deploy/sql/grw-ai-role.sql (re-run it after this migration).

-- CreateTable
CREATE TABLE "mbm_daily_signals" (
    "id" BIGSERIAL NOT NULL,
    "instrument" TEXT NOT NULL,
    "signal_date" DATE NOT NULL,
    "setup" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "close" DOUBLE PRECISION NOT NULL,
    "details" JSONB NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "ret_5d_bp" DOUBLE PRECISION,
    "ret_10d_bp" DOUBLE PRECISION,
    "ret_20d_bp" DOUBLE PRECISION,
    "outcome_at" TIMESTAMPTZ(6),

    CONSTRAINT "mbm_daily_signals_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "mbm_daily_signals_instrument_signal_date_setup_key" ON "mbm_daily_signals"("instrument", "signal_date", "setup");
