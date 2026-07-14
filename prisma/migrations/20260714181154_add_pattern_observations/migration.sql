-- CreateEnum
CREATE TYPE "PatternOutcome" AS ENUM ('WIN', 'LOSS', 'TIMEOUT', 'PENDING');

-- CreateTable
CREATE TABLE "pattern_observations" (
    "id" TEXT NOT NULL,
    "token" TEXT NOT NULL,
    "exchange" TEXT NOT NULL,
    "timeframe" TEXT NOT NULL,
    "patternName" TEXT NOT NULL,
    "category" TEXT NOT NULL,
    "bias" TEXT NOT NULL,
    "barTime" TIMESTAMP(3) NOT NULL,
    "candleWindow" JSONB NOT NULL,
    "atrAtDetection" DOUBLE PRECISION NOT NULL,
    "outcome" "PatternOutcome" NOT NULL DEFAULT 'PENDING',
    "label" INTEGER,
    "resolvedAt" TIMESTAMP(3),
    "modelScore" DOUBLE PRECISION,
    "modelVersion" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "pattern_observations_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "pattern_observations_outcome_idx" ON "pattern_observations"("outcome");

-- CreateIndex
CREATE INDEX "pattern_observations_timeframe_idx" ON "pattern_observations"("timeframe");

-- CreateIndex
CREATE UNIQUE INDEX "pattern_observations_token_exchange_timeframe_patternName_b_key" ON "pattern_observations"("token", "exchange", "timeframe", "patternName", "barTime");
