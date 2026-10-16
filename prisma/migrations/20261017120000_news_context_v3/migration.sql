-- Position news context v3 (docs/superpowers/specs/2026-10-16-position-news-context-design.md §12). Expand-only.
-- "drivers" is nullable-with-default exactly as Prisma emits `String[] @default([])` (same as v2's text[] columns).
ALTER TABLE "news_articles"
  ADD COLUMN "ruleSetVersion" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "drivers" TEXT[] DEFAULT ARRAY[]::TEXT[];
CREATE INDEX "news_articles_drivers_idx" ON "news_articles" USING GIN ("drivers");

CREATE TABLE "news_entity_profiles" (
    "id" TEXT NOT NULL,
    "symbol" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT false,
    "builtBy" TEXT NOT NULL,
    "model" TEXT,
    "promptVersion" TEXT,
    "profile" JSONB NOT NULL,
    "rejected" JSONB NOT NULL DEFAULT '[]',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "news_entity_profiles_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "news_entity_profiles_symbol_version_key" ON "news_entity_profiles"("symbol", "version");
CREATE INDEX "news_entity_profiles_symbol_active_idx" ON "news_entity_profiles"("symbol", "active");

CREATE TABLE "news_tag_rules" (
    "id" TEXT NOT NULL,
    "ruleSetVersion" INTEGER NOT NULL,
    "kind" TEXT NOT NULL,
    "symbol" TEXT,
    "pattern" TEXT NOT NULL,
    "params" JSONB NOT NULL DEFAULT '{}',
    "status" TEXT NOT NULL,
    "origin" TEXT NOT NULL,
    "evidence" JSONB NOT NULL DEFAULT '{}',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "news_tag_rules_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "news_tag_rules_ruleSetVersion_idx" ON "news_tag_rules"("ruleSetVersion");
CREATE INDEX "news_tag_rules_kind_status_idx" ON "news_tag_rules"("kind", "status");

CREATE TABLE "news_tag_rule_sets" (
    "id" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "parentVersion" INTEGER,
    "active" BOOLEAN NOT NULL DEFAULT false,
    "metrics" JSONB NOT NULL DEFAULT '{}',
    "summary" TEXT NOT NULL DEFAULT '',
    "appliedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "news_tag_rule_sets_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "news_tag_rule_sets_version_key" ON "news_tag_rule_sets"("version");

CREATE TABLE "news_tag_feedback" (
    "id" TEXT NOT NULL,
    "articleId" TEXT NOT NULL,
    "tag" TEXT NOT NULL,
    "symbol" TEXT,
    "kind" TEXT NOT NULL,
    "signal" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "verdictId" TEXT,
    "trackerId" TEXT,
    "tagVersion" INTEGER NOT NULL,
    "ruleSetVersion" INTEGER NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'open',
    "resolvedByRuleId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "news_tag_feedback_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "news_tag_feedback_createdAt_idx" ON "news_tag_feedback"("createdAt");
CREATE INDEX "news_tag_feedback_kind_status_idx" ON "news_tag_feedback"("kind", "status");
CREATE INDEX "news_tag_feedback_articleId_idx" ON "news_tag_feedback"("articleId");

CREATE TABLE "night_job_runs" (
    "id" TEXT NOT NULL,
    "job" TEXT NOT NULL,
    "nightOf" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finishedAt" TIMESTAMP(3),
    "budget" JSONB NOT NULL DEFAULT '{}',
    "summary" JSONB NOT NULL DEFAULT '{}',
    "error" TEXT,
    CONSTRAINT "night_job_runs_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "night_job_runs_job_nightOf_key" ON "night_job_runs"("job", "nightOf");
CREATE INDEX "night_job_runs_job_startedAt_idx" ON "night_job_runs"("job", "startedAt");
