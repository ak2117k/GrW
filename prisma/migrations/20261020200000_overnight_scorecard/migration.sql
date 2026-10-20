-- Overnight scorecard + news ideas (docs/superpowers/specs/2026-10-20-overnight-scorecard-design.md §6).
-- Expand-only: two new tables, nothing altered. Body matches `prisma migrate diff` output for schema.prisma.
-- No grw_ai grants: the MBM service does not read these tables in v1.

-- CreateTable
CREATE TABLE "analysis_scorecards" (
    "id" TEXT NOT NULL,
    "user_id" TEXT,
    "symbol" TEXT NOT NULL,
    "exchange" TEXT NOT NULL,
    "underlying" TEXT NOT NULL,
    "side" TEXT NOT NULL,
    "window" TEXT NOT NULL,
    "computed_at" TIMESTAMPTZ(6) NOT NULL,
    "factors" JSONB NOT NULL,
    "total" INTEGER NOT NULL,
    "band" TEXT NOT NULL,
    "verdict_id" TEXT,
    "next_open" DOUBLE PRECISION,
    "next_close" DOUBLE PRECISION,
    "move_bp" DOUBLE PRECISION,
    "filled_at" TIMESTAMPTZ(6),

    CONSTRAINT "analysis_scorecards_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "news_ideas" (
    "id" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "symbol" TEXT NOT NULL,
    "exchange" TEXT NOT NULL,
    "news_ids" TEXT[],
    "headline" TEXT NOT NULL,
    "idea" TEXT NOT NULL,
    "rationale" TEXT NOT NULL,
    "invalidation" TEXT NOT NULL,
    "what_to_do" TEXT NOT NULL,
    "scorecard_id" TEXT,
    "ai_call_id" TEXT,
    "next_open" DOUBLE PRECISION,
    "next_close" DOUBLE PRECISION,
    "move_bp" DOUBLE PRECISION,
    "filled_at" TIMESTAMPTZ(6),

    CONSTRAINT "news_ideas_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "analysis_scorecards_user_id_window_computed_at_idx" ON "analysis_scorecards"("user_id", "window", "computed_at" DESC);

-- CreateIndex
CREATE INDEX "analysis_scorecards_symbol_computed_at_idx" ON "analysis_scorecards"("symbol", "computed_at" DESC);

-- CreateIndex
CREATE INDEX "news_ideas_created_at_idx" ON "news_ideas"("created_at" DESC);
