-- News relevance filter (2026-11-23, apps/api/src/modules/news-events/filter/news-relevance.ts).
-- Expand-only: one defaulted boolean and one nullable text column; nothing altered, dropped or deleted.
-- Every article stays stored (keep-all-data rule); `filtered = true` only HIDES a row from the readers
-- when NEWS_FILTER=on. `filter_reason` is the rule that hid it (or, in observe mode, would have).
-- PG 11+: ADD COLUMN with a constant default is metadata-only (no table rewrite).
ALTER TABLE "news_articles" ADD COLUMN "filtered" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "news_articles" ADD COLUMN "filter_reason" TEXT;
