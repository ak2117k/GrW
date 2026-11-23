-- News AI (2026-11-23, apps/api/src/modules/news-ai). Expand-only: three new tables, nothing altered or dropped.
--
-- news_ai_reads: Claude's read of one news article (job 'news.sentiment'): direction, strength, importance,
-- one-line takeaway and the affected instruments. One row per article (article_id unique). No FK to
-- news_articles (pruned separately; the module prunes reads after 30 days).
CREATE TABLE "news_ai_reads" (
    "id" TEXT NOT NULL,
    "article_id" TEXT NOT NULL,
    "model" TEXT NOT NULL,
    "direction" TEXT NOT NULL,
    "strength" INTEGER NOT NULL,
    "importance" INTEGER NOT NULL,
    "takeaway" TEXT NOT NULL,
    "affected" JSONB NOT NULL DEFAULT '[]',
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "news_ai_reads_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "news_ai_reads_article_id_key" ON "news_ai_reads"("article_id");
CREATE INDEX "news_ai_reads_created_at_idx" ON "news_ai_reads"("created_at");

-- news_ai_read_failures: failed attempts per article (max 3 in all = first read + 2 retries).
CREATE TABLE "news_ai_read_failures" (
    "article_id" TEXT NOT NULL,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "last_error" TEXT,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "news_ai_read_failures_pkey" PRIMARY KEY ("article_id")
);

-- news_briefs: the news page's "what matters now" brief (job 'news.brief'); every point cites article ids.
CREATE TABLE "news_briefs" (
    "id" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "model" TEXT NOT NULL,
    "window_from" TIMESTAMPTZ(6) NOT NULL,
    "window_to" TIMESTAMPTZ(6) NOT NULL,
    "brief" JSONB NOT NULL,
    CONSTRAINT "news_briefs_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "news_briefs_created_at_idx" ON "news_briefs"("created_at");
