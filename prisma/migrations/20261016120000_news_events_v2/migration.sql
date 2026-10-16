-- News & events v2 (docs/superpowers/specs/2026-10-16-news-events-design.md §11). Expand-only.
-- The text[] columns are nullable-with-default exactly as Prisma emits `String[] @default([])`
-- (same as "relatedSymbols"), so `prisma migrate diff` sees no drift against schema.prisma.
ALTER TABLE "news_articles"
  ADD COLUMN "instruments" TEXT[] DEFAULT ARRAY[]::TEXT[],
  ADD COLUMN "sectors" TEXT[] DEFAULT ARRAY[]::TEXT[],
  ADD COLUMN "indices" TEXT[] DEFAULT ARRAY[]::TEXT[],
  ADD COLUMN "markets" TEXT[] DEFAULT ARRAY[]::TEXT[],
  ADD COLUMN "tagVersion" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "dateInferred" BOOLEAN NOT NULL DEFAULT false;

CREATE INDEX "news_articles_relatedSymbols_idx" ON "news_articles" USING GIN ("relatedSymbols");
CREATE INDEX "news_articles_instruments_idx" ON "news_articles" USING GIN ("instruments");
CREATE INDEX "news_articles_sectors_idx" ON "news_articles" USING GIN ("sectors");
CREATE INDEX "news_articles_indices_idx" ON "news_articles" USING GIN ("indices");
CREATE INDEX "news_articles_fetchedAt_idx" ON "news_articles"("fetchedAt");

CREATE TABLE "instrument_name_aliases" (
    "id" TEXT NOT NULL,
    "symbol" TEXT NOT NULL,
    "alias" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "instrument_name_aliases_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "instrument_name_aliases_alias_symbol_key" ON "instrument_name_aliases"("alias", "symbol");
CREATE INDEX "instrument_name_aliases_symbol_idx" ON "instrument_name_aliases"("symbol");

CREATE TABLE "market_events" (
    "id" TEXT NOT NULL,
    "scope" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "startsAt" TIMESTAMPTZ(3) NOT NULL,
    "allDay" BOOLEAN NOT NULL DEFAULT false,
    "impact" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "sourceRef" TEXT,
    "fetchedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "market_events_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "market_events_kind_key_startsAt_key" ON "market_events"("kind", "key", "startsAt");
CREATE INDEX "market_events_key_startsAt_idx" ON "market_events"("key", "startsAt");

ALTER TABLE "sentinel_verdicts" ADD COLUMN "newsShadow" JSONB;
