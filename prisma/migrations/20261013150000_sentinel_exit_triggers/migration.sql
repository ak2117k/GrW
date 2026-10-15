-- Sentinel price triggers (docs/superpowers/plans/2026-10-13-sentinel-price-triggers.md).
--
-- Expand-only: one nullable column on sentinel_verdicts (metadata-only ALTER in
-- PostgreSQL: no default, no rewrite) and one new table with its indexes and
-- CHECKs. No existing column, index or function is changed. No FK.

ALTER TABLE "sentinel_verdicts" ADD COLUMN "exitTrigger" JSONB;

CREATE TABLE "sentinel_exit_triggers" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "trackerId" TEXT NOT NULL,
    "verdictId" TEXT NOT NULL,
    "symbol" TEXT NOT NULL,
    "instrument" TEXT,
    "op" TEXT,
    "price" DOUBLE PRECISION,
    "watchExchange" TEXT,
    "watchToken" TEXT,
    "watchSymbol" TEXT,
    "refPrice" DOUBLE PRECISION,
    "status" TEXT NOT NULL,
    "reason" TEXT,
    "armedAt" TIMESTAMP(3),
    "endedAt" TIMESTAMP(3),
    "firedAt" TIMESTAMP(3),
    "firedPrice" DOUBLE PRECISION,
    "firedTickAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "sentinel_exit_triggers_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "sentinel_exit_triggers_verdictId_key" ON "sentinel_exit_triggers"("verdictId");
CREATE INDEX "sentinel_exit_triggers_userId_createdAt_idx" ON "sentinel_exit_triggers"("userId", "createdAt");
CREATE INDEX "sentinel_exit_triggers_status_idx" ON "sentinel_exit_triggers"("status");
CREATE INDEX "sentinel_exit_triggers_trackerId_createdAt_idx" ON "sentinel_exit_triggers"("trackerId", "createdAt");

-- At most ONE armed trigger per tracker (spec §3.3). Partial: history rows are unlimited.
CREATE UNIQUE INDEX "sentinel_exit_triggers_one_armed_per_tracker"
    ON "sentinel_exit_triggers"("trackerId") WHERE "status" = 'ARMED';

ALTER TABLE "sentinel_exit_triggers" ADD CONSTRAINT "sentinel_exit_triggers_vocab_check" CHECK (
    "status" IN ('ARMED', 'FIRED', 'SUPERSEDED', 'REJECTED', 'EXPIRED')
    AND ("instrument" IS NULL OR "instrument" IN ('UNDERLYING', 'PREMIUM'))
    AND ("op" IS NULL OR "op" IN ('BELOW', 'ABOVE'))
);

-- A row that can fire, or did, must be complete.
ALTER TABLE "sentinel_exit_triggers" ADD CONSTRAINT "sentinel_exit_triggers_armed_complete_check" CHECK (
    "status" NOT IN ('ARMED', 'FIRED')
    OR ("instrument" IS NOT NULL AND "op" IS NOT NULL AND "price" > 0
        AND "watchExchange" IS NOT NULL AND "watchToken" IS NOT NULL AND "armedAt" IS NOT NULL)
);
