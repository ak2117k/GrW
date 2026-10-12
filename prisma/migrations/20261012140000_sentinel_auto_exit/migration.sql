-- Sentinel auto-exit (docs/superpowers/plans/2026-10-12-sentinel-auto-exit.md).
--
-- Expand-only: one new table with its indexes and CHECKs. No existing table,
-- column, index or function is touched. No FK (mirrors sentinel_verdicts).

CREATE TABLE "ai_exit_executions" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "verdictId" TEXT NOT NULL,
    "trackerId" TEXT NOT NULL,
    "symbol" TEXT NOT NULL,
    "exchange" TEXT,
    "token" TEXT,
    "side" TEXT,
    "quantity" INTEGER,
    "productType" TEXT,
    "orderType" TEXT,
    "limitPrice" DOUBLE PRECISION,
    "mode" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "reason" TEXT,
    "sessionSource" TEXT,
    "brokerOrderId" TEXT,
    "brokerMessage" TEXT,
    "orderStatus" TEXT,
    "marketOrderId" TEXT,
    "verdictReason" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ai_exit_executions_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "ai_exit_executions_verdictId_key" ON "ai_exit_executions"("verdictId");
CREATE INDEX "ai_exit_executions_userId_createdAt_idx" ON "ai_exit_executions"("userId", "createdAt");
CREATE INDEX "ai_exit_executions_status_createdAt_idx" ON "ai_exit_executions"("status", "createdAt");
CREATE INDEX "ai_exit_executions_trackerId_createdAt_idx" ON "ai_exit_executions"("trackerId", "createdAt");

ALTER TABLE "ai_exit_executions" ADD CONSTRAINT "ai_exit_executions_vocab_check" CHECK (
    "status" IN ('CLAIMED', 'SKIPPED', 'DRY_RUN', 'PLACED', 'FILLED', 'REJECTED', 'FAILED')
    AND "mode" IN ('dry-run', 'live')
    AND ("side" IS NULL OR "side" IN ('BUY', 'SELL'))
);
