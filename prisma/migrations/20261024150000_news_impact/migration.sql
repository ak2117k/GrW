-- News impact (2026-10-24): story clusters, the batched cheap-LLM impact read, and the market reaction.
-- Expand-only: three new tables and one new nullable column (+ index) on news_articles.

-- AlterTable
ALTER TABLE "news_articles" ADD COLUMN "cluster_id" TEXT;

-- CreateIndex
CREATE INDEX "news_articles_cluster_id_idx" ON "news_articles"("cluster_id");

-- CreateTable
CREATE TABLE "news_clusters" (
    "id" TEXT NOT NULL,
    "headline" TEXT NOT NULL,
    "instruments" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "sectors" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "indices" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "sources" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "source_count" INTEGER NOT NULL DEFAULT 1,
    "article_ids" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "title_tokens" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "first_seen" TIMESTAMPTZ(6) NOT NULL,
    "last_seen" TIMESTAMPTZ(6) NOT NULL,
    "material_type" TEXT NOT NULL,
    "material" BOOLEAN NOT NULL DEFAULT false,
    "boilerplate" BOOLEAN NOT NULL DEFAULT false,
    "relevance" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "reasons" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "impact_attempts" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "news_clusters_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "news_clusters_last_seen_idx" ON "news_clusters"("last_seen");

-- CreateIndex
CREATE INDEX "news_clusters_first_seen_idx" ON "news_clusters"("first_seen");

-- CreateTable
CREATE TABLE "news_impacts" (
    "id" TEXT NOT NULL,
    "cluster_id" TEXT NOT NULL,
    "analysed_at" TIMESTAMPTZ(6) NOT NULL,
    "model" TEXT NOT NULL,
    "source_count_at" INTEGER NOT NULL,
    "direction" TEXT NOT NULL,
    "magnitude" TEXT NOT NULL,
    "horizon" TEXT NOT NULL,
    "symbols" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "sectors" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "index_name" TEXT,
    "priced_in" BOOLEAN NOT NULL,
    "confidence" DOUBLE PRECISION NOT NULL,
    "one_line" TEXT NOT NULL,
    "rank" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "analyses" INTEGER NOT NULL DEFAULT 1,
    "alerted_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "news_impacts_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "news_impacts_cluster_id_key" ON "news_impacts"("cluster_id");

-- CreateIndex
CREATE INDEX "news_impacts_analysed_at_idx" ON "news_impacts"("analysed_at");

-- CreateTable
CREATE TABLE "news_reactions" (
    "id" TEXT NOT NULL,
    "impact_id" TEXT NOT NULL,
    "cluster_id" TEXT NOT NULL,
    "symbol" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "direction" TEXT NOT NULL,
    "magnitude" TEXT NOT NULL,
    "horizon" TEXT NOT NULL,
    "anchor_at" TIMESTAMPTZ(6) NOT NULL,
    "anchor_is_open" BOOLEAN NOT NULL DEFAULT false,
    "judge_session" TEXT,
    "p0" DOUBLE PRECISION,
    "p15" DOUBLE PRECISION,
    "p60" DOUBLE PRECISION,
    "p_close" DOUBLE PRECISION,
    "p_next_close" DOUBLE PRECISION,
    "atr" DOUBLE PRECISION,
    "complete" BOOLEAN NOT NULL DEFAULT false,
    "filled_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "news_reactions_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "news_reactions_cluster_id_symbol_key" ON "news_reactions"("cluster_id", "symbol");

-- CreateIndex
CREATE INDEX "news_reactions_complete_anchor_at_idx" ON "news_reactions"("complete", "anchor_at");

-- CreateIndex
CREATE INDEX "news_reactions_judge_session_idx" ON "news_reactions"("judge_session");
