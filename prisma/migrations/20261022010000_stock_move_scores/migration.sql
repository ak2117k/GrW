-- Stock big-move scores (SHADOW). Expand-only: one new table. grw_ai (MBM service) writes it:
-- grants live in deploy/sql/grw-ai-role.sql (re-run after this migration).

-- CreateTable
CREATE TABLE "stock_move_scores" (
    "id" BIGSERIAL NOT NULL,
    "as_of" DATE NOT NULL,
    "symbol" TEXT NOT NULL,
    "horizon_days" INTEGER NOT NULL DEFAULT 5,
    "threshold_atr" DOUBLE PRECISION NOT NULL DEFAULT 1.5,
    "p_big" DOUBLE PRECISION NOT NULL,
    "rank_pct" DOUBLE PRECISION NOT NULL,
    "bucket" TEXT NOT NULL,
    "results_date" DATE,
    "results_in_window" BOOLEAN NOT NULL DEFAULT false,
    "atr_pct" DOUBLE PRECISION,
    "close" DOUBLE PRECISION,
    "features" JSONB,
    "model_id" TEXT NOT NULL,
    "data_quality" TEXT NOT NULL DEFAULT 'ok',
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "outcome_ret_bp" DOUBLE PRECISION,
    "outcome_big" BOOLEAN,
    "outcome_at" TIMESTAMPTZ(6),

    CONSTRAINT "stock_move_scores_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "stock_move_scores_as_of_symbol_horizon_days_threshold_atr_key" ON "stock_move_scores"("as_of", "symbol", "horizon_days", "threshold_atr");

-- CreateIndex
CREATE INDEX "stock_move_scores_symbol_as_of_idx" ON "stock_move_scores"("symbol", "as_of" DESC);
