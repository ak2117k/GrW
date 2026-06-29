-- CreateEnum
CREATE TYPE "WatchStatus" AS ENUM ('WATCHING', 'TRADED', 'TARGET_HIT', 'STOPPED', 'EXITED', 'DISMISSED');

-- CreateEnum
CREATE TYPE "WatchEventType" AS ENUM ('INITIAL', 'PRICE_CHANGE', 'SCORE_CHANGE', 'TARGET_HIT', 'SL_HIT_SCORE', 'SL_HIT_PRICE', 'TRADE_OPENED', 'TRADE_CLOSED', 'DISMISSED');

-- CreateTable
CREATE TABLE "watch_entries" (
    "id" TEXT NOT NULL,
    "alertId" TEXT,
    "setupId" TEXT,
    "symbol" TEXT NOT NULL,
    "token" TEXT NOT NULL,
    "exchange" TEXT NOT NULL,
    "side" TEXT NOT NULL,
    "initialPrice" DOUBLE PRECISION NOT NULL,
    "initialScore" INTEGER NOT NULL,
    "initialBreakdown" JSONB NOT NULL,
    "initialAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "profitTarget" DOUBLE PRECISION NOT NULL,
    "profitTargetSource" TEXT NOT NULL,
    "stopLossScore" INTEGER NOT NULL DEFAULT 60,
    "status" "WatchStatus" NOT NULL DEFAULT 'WATCHING',
    "currentPrice" DOUBLE PRECISION,
    "currentScore" INTEGER,
    "maxFavorable" DOUBLE PRECISION,
    "maxAdverse" DOUBLE PRECISION,
    "lastTickAt" TIMESTAMP(3),
    "lastRescoreAt" TIMESTAMP(3),
    "lastEventPrice" DOUBLE PRECISION,
    "optionsToken" TEXT,
    "optionsType" TEXT,
    "optionsExpiry" TIMESTAMP(3),
    "optionsStrike" DOUBLE PRECISION,
    "optionsLotSize" INTEGER,
    "optionsSelectionScore" DOUBLE PRECISION,
    "paperTradeId" TEXT,
    "liveTradeId" TEXT,
    "executedAt" TIMESTAMP(3),
    "executedPrice" DOUBLE PRECISION,
    "closedAt" TIMESTAMP(3),
    "closedReason" TEXT,
    "notes" TEXT,
    "dismissedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "watch_entries_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "watch_events" (
    "id" TEXT NOT NULL,
    "watchEntryId" TEXT NOT NULL,
    "eventType" "WatchEventType" NOT NULL,
    "price" DOUBLE PRECISION,
    "score" INTEGER,
    "breakdown" JSONB,
    "priceDelta" DOUBLE PRECISION,
    "scoreDelta" INTEGER,
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "watch_events_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "watch_entries_setupId_key" ON "watch_entries"("setupId");

-- CreateIndex
CREATE INDEX "watch_entries_status_idx" ON "watch_entries"("status");

-- CreateIndex
CREATE INDEX "watch_entries_token_idx" ON "watch_entries"("token");

-- CreateIndex
CREATE INDEX "watch_entries_symbol_idx" ON "watch_entries"("symbol");

-- CreateIndex
CREATE INDEX "watch_entries_createdAt_idx" ON "watch_entries"("createdAt");

-- CreateIndex
CREATE INDEX "watch_events_watchEntryId_createdAt_idx" ON "watch_events"("watchEntryId", "createdAt");

-- CreateIndex
CREATE INDEX "watch_events_eventType_idx" ON "watch_events"("eventType");

-- AddForeignKey
ALTER TABLE "watch_events" ADD CONSTRAINT "watch_events_watchEntryId_fkey" FOREIGN KEY ("watchEntryId") REFERENCES "watch_entries"("id") ON DELETE CASCADE ON UPDATE CASCADE;
