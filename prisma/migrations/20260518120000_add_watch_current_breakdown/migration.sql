-- AlterTable: add currentBreakdown to watch_entries
-- Persists the per-factor score breakdown computed on each live re-score so
-- the UI can show the current (not just buy-time) factor state. Nullable —
-- entries that have never been re-scored have no current breakdown yet.

ALTER TABLE "watch_entries" ADD COLUMN "currentBreakdown" JSONB;
