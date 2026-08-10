-- CreateTable
CREATE TABLE "zone_break_observations" (
    "id" TEXT NOT NULL,
    "token" TEXT NOT NULL,
    "exchange" TEXT NOT NULL,
    "timeframe" TEXT NOT NULL,
    "side" TEXT NOT NULL,
    "barTime" TIMESTAMP(3) NOT NULL,
    "zoneClassification" TEXT NOT NULL,
    "touchCount" INTEGER NOT NULL,
    "volumeBucket" TEXT NOT NULL,
    "htfAgreed" BOOLEAN NOT NULL,
    "atrAtDetection" DOUBLE PRECISION NOT NULL,
    "targetDistAtr" DOUBLE PRECISION NOT NULL,
    "stopDistAtr" DOUBLE PRECISION NOT NULL,
    "targetSource" TEXT NOT NULL,
    "outcome" TEXT NOT NULL DEFAULT 'PENDING',
    "label" INTEGER,
    "resolvedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "zone_break_observations_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "zone_break_observations_timeframe_zoneClassification_volume_idx" ON "zone_break_observations"("timeframe", "zoneClassification", "volumeBucket");

-- CreateIndex
CREATE INDEX "zone_break_observations_token_exchange_timeframe_idx" ON "zone_break_observations"("token", "exchange", "timeframe");

-- CreateIndex
CREATE INDEX "zone_break_observations_outcome_idx" ON "zone_break_observations"("outcome");

-- CreateIndex
CREATE UNIQUE INDEX "zone_break_observations_token_exchange_timeframe_side_barTi_key" ON "zone_break_observations"("token", "exchange", "timeframe", "side", "barTime");

