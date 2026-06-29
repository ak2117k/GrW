-- CreateTable
CREATE TABLE "setups" (
    "id" TEXT NOT NULL,
    "token" INTEGER NOT NULL,
    "symbol" TEXT NOT NULL,
    "exchange" TEXT NOT NULL,
    "side" TEXT NOT NULL,
    "setupType" TEXT NOT NULL,
    "levelType" TEXT NOT NULL,
    "levelValue" DOUBLE PRECISION NOT NULL,
    "entry" DOUBLE PRECISION NOT NULL,
    "stoploss" DOUBLE PRECISION NOT NULL,
    "target" DOUBLE PRECISION NOT NULL,
    "partialTakeAt" DOUBLE PRECISION,
    "grade" TEXT NOT NULL,
    "atr14" DOUBLE PRECISION,
    "regime" TEXT,
    "intradayRangeRatio" DOUBLE PRECISION,
    "higherTimeframeTrend" JSONB,
    "recommendedStrike" JSONB,
    "reason" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "lockedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "triggeredAt" TIMESTAMP(3),
    "triggerBarTimestamp" TIMESTAMP(3),
    "closedAt" TIMESTAMP(3),
    "closeReason" TEXT,
    "invalidationKind" TEXT,
    "invalidationReason" TEXT,
    "mfeR" DOUBLE PRECISION,
    "maeR" DOUBLE PRECISION,
    "barsSinceEntry" INTEGER,
    "lastUpdatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "setups_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "setups_token_status_idx" ON "setups"("token", "status");

-- CreateIndex
CREATE INDEX "setups_symbol_lockedAt_idx" ON "setups"("symbol", "lockedAt");

-- CreateIndex
CREATE INDEX "setups_closeReason_idx" ON "setups"("closeReason");
