-- AlterEnum: add PARTIAL_EXIT and TRAILING_STOP_HIT to WatchEventType
-- PostgreSQL 12+ supports adding multiple enum values in one migration.

ALTER TYPE "WatchEventType" ADD VALUE 'PARTIAL_EXIT';
ALTER TYPE "WatchEventType" ADD VALUE 'TRAILING_STOP_HIT';

-- AlterTable: add partial-exit + trailing-stop columns to watch_entries

ALTER TABLE "watch_entries" ADD COLUMN "partialExitedAt"   TIMESTAMP(3),
                            ADD COLUMN "partialExitPrice"   DOUBLE PRECISION,
                            ADD COLUMN "partialQty"         INTEGER,
                            ADD COLUMN "remainingQty"       INTEGER,
                            ADD COLUMN "trailingHighWater"  DOUBLE PRECISION,
                            ADD COLUMN "trailingStopPrice"  DOUBLE PRECISION;
