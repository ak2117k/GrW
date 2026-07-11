-- Per-trade tracker for the portfolio page.
CREATE TABLE "trade_trackers" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "symbol" TEXT NOT NULL,
    "exchange" TEXT NOT NULL,
    "token" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "entryPrice" DOUBLE PRECISION NOT NULL,
    "qty" DOUBLE PRECISION NOT NULL,
    "entryTime" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "exitPrice" DOUBLE PRECISION,
    "exitTime" TIMESTAMP(3),
    "status" TEXT NOT NULL DEFAULT 'OPEN',
    "holdingHigh" DOUBLE PRECISION,
    "holdingLow" DOUBLE PRECISION,
    "dayHigh" DOUBLE PRECISION,
    "dayLow" DOUBLE PRECISION,
    "dayDate" TEXT,
    "lastLtp" DOUBLE PRECISION,
    "pnl" DOUBLE PRECISION,
    "pnlPercent" DOUBLE PRECISION,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "trade_trackers_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "trade_trackers_userId_status_idx" ON "trade_trackers"("userId", "status");

-- At most one OPEN tracker per (user, instrument, kind).
CREATE UNIQUE INDEX "trade_trackers_open_key" ON "trade_trackers"("userId", "token", "kind") WHERE "status" = 'OPEN';

ALTER TABLE "trade_trackers" ADD CONSTRAINT "trade_trackers_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
