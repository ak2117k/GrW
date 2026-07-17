-- Bucket-A external context (MTF/SR/sector) captured at the live edge.
-- Nullable: backfill and chart-load rows have no trustworthy external context.
ALTER TABLE "pattern_observations" ADD COLUMN "detectionContext" JSONB;
