-- Exit discipline (docs/superpowers/plans/2026-10-15-exit-discipline.md Task 2).
-- Expand-only: ten nullable columns on ai_exit_executions, one new table.
-- No existing column, index, CHECK or function is touched. No FK.

ALTER TABLE "ai_exit_executions"
  ADD COLUMN "gate" JSONB,
  ADD COLUMN "decisionLtp" DOUBLE PRECISION,
  ADD COLUMN "decisionAt" TIMESTAMP(3),
  ADD COLUMN "orderLtp" DOUBLE PRECISION,
  ADD COLUMN "orderSentAt" TIMESTAMP(3),
  ADD COLUMN "fillPrice" DOUBLE PRECISION,
  ADD COLUMN "fillQty" INTEGER,
  ADD COLUMN "fillAt" TIMESTAMP(3),
  ADD COLUMN "slippage" DOUBLE PRECISION,
  ADD COLUMN "latencyMs" INTEGER;

CREATE TABLE "ai_exit_outcomes" (
    "id" TEXT NOT NULL,
    "executionId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "verdictId" TEXT NOT NULL,
    "trackerId" TEXT NOT NULL,
    "symbol" TEXT NOT NULL,
    "exchange" TEXT NOT NULL,
    "token" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "positionSide" TEXT NOT NULL,
    "qty" DOUBLE PRECISION NOT NULL,
    "decisionPrice" DOUBLE PRECISION NOT NULL,
    "decisionAt" TIMESTAMP(3) NOT NULL,
    "windowEnd" TIMESTAMP(3) NOT NULL,
    "status" TEXT NOT NULL,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "barsUsed" INTEGER,
    "maxAfter" DOUBLE PRECISION,
    "minAfter" DOUBLE PRECISION,
    "closeAt15" DOUBLE PRECISION,
    "closeAt30" DOUBLE PRECISION,
    "closeAt60" DOUBLE PRECISION,
    "closeAtEnd" DOUBLE PRECISION,
    "missedPnl" DOUBLE PRECISION,
    "savedPnl" DOUBLE PRECISION,
    "netAtEnd" DOUBLE PRECISION,
    "dataSource" TEXT,
    "note" TEXT,
    "computedAt" TIMESTAMP(3),
    "corpusAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ai_exit_outcomes_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "ai_exit_outcomes_executionId_key" ON "ai_exit_outcomes"("executionId");
CREATE INDEX "ai_exit_outcomes_userId_decisionAt_idx" ON "ai_exit_outcomes"("userId", "decisionAt");
CREATE INDEX "ai_exit_outcomes_status_windowEnd_idx" ON "ai_exit_outcomes"("status", "windowEnd");

ALTER TABLE "ai_exit_outcomes" ADD CONSTRAINT "ai_exit_outcomes_vocab_check" CHECK (
    "kind" IN ('EXECUTED', 'DRY_RUN', 'GATED', 'AWAITING')
    AND "positionSide" IN ('LONG', 'SHORT')
    AND "status" IN ('PENDING', 'DONE', 'NO_DATA')
);
