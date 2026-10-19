-- MBM M2 serving + logging (docs/superpowers/plans/2026-10-19-mbm-m2-serving.md §1). Expand-only.
-- Body is `prisma migrate diff` output for schema.prisma, so there is no drift. Columns are snake_case
-- (@map) because the Python MBM service reads/writes them as the grw_ai role; grants live in
-- deploy/sql/grw-ai-role.sql (re-run it after this migration).

-- AlterTable
ALTER TABLE "ai_models" ADD COLUMN     "horizon" TEXT,
ADD COLUMN     "instrument" TEXT;

-- CreateTable
CREATE TABLE "mbm_bars_1m" (
    "series" TEXT NOT NULL,
    "ts" TIMESTAMPTZ(6) NOT NULL,
    "open" DOUBLE PRECISION NOT NULL,
    "high" DOUBLE PRECISION NOT NULL,
    "low" DOUBLE PRECISION NOT NULL,
    "close" DOUBLE PRECISION NOT NULL,
    "volume" DOUBLE PRECISION NOT NULL DEFAULT 0,

    CONSTRAINT "mbm_bars_1m_pkey" PRIMARY KEY ("series","ts")
);

-- CreateTable
CREATE TABLE "mbm_predictions" (
    "id" BIGSERIAL NOT NULL,
    "instrument" TEXT NOT NULL,
    "horizon" TEXT NOT NULL,
    "as_of" TIMESTAMPTZ(6) NOT NULL,
    "p" DOUBLE PRECISION NOT NULL,
    "regime" TEXT NOT NULL,
    "q25_bp" DOUBLE PRECISION,
    "q50_bp" DOUBLE PRECISION,
    "q75_bp" DOUBLE PRECISION,
    "model_id" TEXT NOT NULL,
    "feature_set" TEXT NOT NULL,
    "data_quality" TEXT NOT NULL DEFAULT 'ok',
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "outcome_range_bp" DOUBLE PRECISION,
    "outcome_threshold_bp" DOUBLE PRECISION,
    "outcome_big" BOOLEAN,
    "outcome_quality" TEXT,
    "outcome_at" TIMESTAMPTZ(6),

    CONSTRAINT "mbm_predictions_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "mbm_predictions_instrument_as_of_idx" ON "mbm_predictions"("instrument", "as_of" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "mbm_predictions_instrument_horizon_as_of_key" ON "mbm_predictions"("instrument", "horizon", "as_of");

-- CreateIndex
CREATE INDEX "ai_models_kind_instrument_horizon_active_idx" ON "ai_models"("kind", "instrument", "horizon", "active");

-- SP3's "ai_models_one_active_per_kind" allowed one active row per KIND, which would forbid the two
-- active mbm-move rows (30m + 60m) the contract §2 needs. Widen it to kind × instrument × horizon.
-- For existing rows (instrument/horizon NULL) the new index enforces exactly what the old one did,
-- so this only relaxes the constraint: old code keeps working. Create the new one before dropping.
CREATE UNIQUE INDEX "ai_models_one_active_per_kind_instrument_horizon"
  ON "ai_models"("kind", COALESCE("instrument", ''), COALESCE("horizon", '')) WHERE "active";
DROP INDEX "ai_models_one_active_per_kind";
