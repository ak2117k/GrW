-- Stock monitor (target-profit watcher).
CREATE TABLE "stock_monitors" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "symbol" TEXT NOT NULL,
    "exchange" TEXT NOT NULL,
    "token" TEXT NOT NULL,
    "referencePrice" DOUBLE PRECISION,
    "targetPercent" DOUBLE PRECISION NOT NULL,
    "targetPrice" DOUBLE PRECISION,
    "status" TEXT NOT NULL DEFAULT 'WATCHING',
    "lastLtp" DOUBLE PRECISION,
    "currentPercent" DOUBLE PRECISION,
    "triggeredAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "stock_monitors_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "stock_monitors_userId_token_key" ON "stock_monitors"("userId", "token");
CREATE INDEX "stock_monitors_userId_status_idx" ON "stock_monitors"("userId", "status");

ALTER TABLE "stock_monitors" ADD CONSTRAINT "stock_monitors_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
