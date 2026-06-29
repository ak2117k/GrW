-- CreateTable
CREATE TABLE "chartink_scanners" (
    "id" TEXT NOT NULL,
    "scanUrl" TEXT NOT NULL,
    "scanName" TEXT NOT NULL,
    "alertName" TEXT,
    "firstSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastFiredAt" TIMESTAMP(3),
    "fireCount" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "chartink_scanners_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "chartink_alerts" (
    "id" TEXT NOT NULL,
    "scannerId" TEXT NOT NULL,
    "triggeredAt" TIMESTAMP(3) NOT NULL,
    "receivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "rawPayload" JSONB NOT NULL,

    CONSTRAINT "chartink_alerts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "chartink_alert_setups" (
    "id" TEXT NOT NULL,
    "alertId" TEXT NOT NULL,
    "symbol" TEXT NOT NULL,
    "token" TEXT,
    "hitPrice" DOUBLE PRECISION NOT NULL,
    "kind" TEXT NOT NULL,
    "setupId" TEXT,
    "rejectReason" TEXT,
    "processedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "chartink_alert_setups_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "chartink_scanners_scanUrl_key" ON "chartink_scanners"("scanUrl");

-- CreateIndex
CREATE INDEX "chartink_alerts_scannerId_triggeredAt_idx" ON "chartink_alerts"("scannerId", "triggeredAt");

-- CreateIndex
CREATE INDEX "chartink_alert_setups_alertId_idx" ON "chartink_alert_setups"("alertId");

-- CreateIndex
CREATE INDEX "chartink_alert_setups_token_idx" ON "chartink_alert_setups"("token");

-- AddForeignKey
ALTER TABLE "chartink_alerts" ADD CONSTRAINT "chartink_alerts_scannerId_fkey" FOREIGN KEY ("scannerId") REFERENCES "chartink_scanners"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "chartink_alert_setups" ADD CONSTRAINT "chartink_alert_setups_alertId_fkey" FOREIGN KEY ("alertId") REFERENCES "chartink_alerts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
