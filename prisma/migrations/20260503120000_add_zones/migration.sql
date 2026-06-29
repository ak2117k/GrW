-- CreateTable
CREATE TABLE "zones" (
    "id" TEXT NOT NULL,
    "token" TEXT NOT NULL,
    "symbol" TEXT NOT NULL,
    "exchange" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "upper" DOUBLE PRECISION NOT NULL,
    "lower" DOUBLE PRECISION NOT NULL,
    "isLine" BOOLEAN NOT NULL,
    "strength" INTEGER NOT NULL,
    "classification" TEXT NOT NULL,
    "touchCount" INTEGER NOT NULL,
    "lastTouchTimestamp" TIMESTAMP(3) NOT NULL,
    "scoreBreakdown" JSONB NOT NULL,
    "computedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "zones_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "zones_token_classification_idx" ON "zones"("token", "classification");

-- CreateIndex
CREATE INDEX "zones_expiresAt_idx" ON "zones"("expiresAt");
