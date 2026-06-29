-- CreateEnum
CREATE TYPE "TradeEventType" AS ENUM ('CREATED', 'FILLED', 'SL_SET', 'TARGET_SET', 'PARTIAL_EXIT', 'SL_HIT', 'TARGET_HIT', 'MODIFIED', 'CANCELLED', 'CLOSED');

-- AlterEnum
ALTER TYPE "WatchEventType" ADD VALUE 'NOT_TRADED';

-- AlterEnum
ALTER TYPE "WatchStatus" ADD VALUE 'MISSED';

-- AlterTable
ALTER TABLE "chartink_scanners" ADD COLUMN     "category" TEXT NOT NULL DEFAULT 'OTHER';

-- AlterTable
ALTER TABLE "signals" ADD COLUMN     "setupContext" JSONB;

-- AlterTable
ALTER TABLE "trades" ADD COLUMN     "adRatioAtEntry" DOUBLE PRECISION,
ADD COLUMN     "contextSnapshot" JSONB,
ADD COLUMN     "entryReason" TEXT,
ADD COLUMN     "entryTags" TEXT[] DEFAULT ARRAY[]::TEXT[],
ADD COLUMN     "exitNotes" TEXT,
ADD COLUMN     "exitReasonTag" TEXT,
ADD COLUMN     "limitPrice" DOUBLE PRECISION,
ADD COLUMN     "maxPainAtEntry" DOUBLE PRECISION,
ADD COLUMN     "pcrAtEntry" DOUBLE PRECISION,
ADD COLUMN     "source" TEXT NOT NULL DEFAULT 'MANUAL',
ADD COLUMN     "spotAtEntry" DOUBLE PRECISION,
ADD COLUMN     "triggerPrice" DOUBLE PRECISION,
ADD COLUMN     "vixAtEntry" DOUBLE PRECISION,
ADD COLUMN     "vixRegimeAtEntry" TEXT;

-- AlterTable
ALTER TABLE "watch_entries" ADD COLUMN     "quantity" INTEGER,
ADD COLUMN     "recoveryReEntry" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "slBreachCount" INTEGER NOT NULL DEFAULT 0;

-- CreateTable
CREATE TABLE "option_chain_snapshots" (
    "id" TEXT NOT NULL,
    "underlying" TEXT NOT NULL,
    "expiryDate" DATE NOT NULL,
    "spotPrice" DECIMAL(12,2) NOT NULL,
    "source" TEXT NOT NULL,
    "strikeCount" INTEGER NOT NULL,
    "chainJson" JSONB NOT NULL,
    "capturedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "option_chain_snapshots_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "broker_credentials" (
    "id" TEXT NOT NULL,
    "broker" TEXT NOT NULL DEFAULT 'angel_one',
    "apiKey" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "password" TEXT NOT NULL,
    "totpSecret" TEXT NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "lastConnected" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "broker_credentials_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "trade_events" (
    "id" TEXT NOT NULL,
    "tradeId" TEXT NOT NULL,
    "eventType" "TradeEventType" NOT NULL,
    "price" DOUBLE PRECISION,
    "quantity" INTEGER,
    "pnl" DOUBLE PRECISION,
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "trade_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ungated_watch_entries" (
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
    "currentBreakdown" JSONB,
    "maxFavorable" DOUBLE PRECISION,
    "maxAdverse" DOUBLE PRECISION,
    "lastTickAt" TIMESTAMP(3),
    "lastRescoreAt" TIMESTAMP(3),
    "lastEventPrice" DOUBLE PRECISION,
    "paperTradeId" TEXT,
    "executedAt" TIMESTAMP(3),
    "executedPrice" DOUBLE PRECISION,
    "quantity" INTEGER,
    "closedAt" TIMESTAMP(3),
    "closedReason" TEXT,
    "notes" TEXT,
    "dismissedAt" TIMESTAMP(3),
    "partialExitedAt" TIMESTAMP(3),
    "partialExitPrice" DOUBLE PRECISION,
    "partialQty" INTEGER,
    "remainingQty" INTEGER,
    "trailingHighWater" DOUBLE PRECISION,
    "trailingStopPrice" DOUBLE PRECISION,
    "slBreachCount" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ungated_watch_entries_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ungated_watch_events" (
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

    CONSTRAINT "ungated_watch_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ungated_trades" (
    "id" TEXT NOT NULL,
    "instrumentId" TEXT NOT NULL,
    "signalId" TEXT,
    "orderId" TEXT,
    "side" TEXT NOT NULL,
    "orderType" TEXT NOT NULL,
    "positionType" TEXT NOT NULL,
    "quantity" INTEGER NOT NULL,
    "closedQuantity" INTEGER NOT NULL DEFAULT 0,
    "entryPrice" DOUBLE PRECISION,
    "exitPrice" DOUBLE PRECISION,
    "stoploss" DOUBLE PRECISION,
    "target" DOUBLE PRECISION,
    "pnl" DOUBLE PRECISION,
    "pnlPercent" DOUBLE PRECISION,
    "fees" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "strategy" TEXT,
    "isPaperTrade" BOOLEAN NOT NULL DEFAULT true,
    "entryTime" TIMESTAMP(3),
    "exitTime" TIMESTAMP(3),
    "notes" TEXT,
    "entryReason" TEXT,
    "exitReasonTag" TEXT,
    "exitNotes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ungated_trades_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ungated_paper_account" (
    "id" TEXT NOT NULL,
    "startingBalance" DOUBLE PRECISION NOT NULL,
    "cash" DOUBLE PRECISION NOT NULL,
    "realizedPnl" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "fees" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "deployedCapital" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "killSwitchAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ungated_paper_account_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ungated_rejections" (
    "id" TEXT NOT NULL,
    "alertId" TEXT,
    "symbol" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "score" INTEGER,
    "hitPrice" DOUBLE PRECISION,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ungated_rejections_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "adaptive_stop_watch_entries" (
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
    "currentBreakdown" JSONB,
    "maxFavorable" DOUBLE PRECISION,
    "maxAdverse" DOUBLE PRECISION,
    "lastTickAt" TIMESTAMP(3),
    "lastRescoreAt" TIMESTAMP(3),
    "lastEventPrice" DOUBLE PRECISION,
    "paperTradeId" TEXT,
    "executedAt" TIMESTAMP(3),
    "executedPrice" DOUBLE PRECISION,
    "quantity" INTEGER,
    "riskAmount" DOUBLE PRECISION,
    "atrAtEntry" DOUBLE PRECISION,
    "stopPct" DOUBLE PRECISION,
    "stopPrice" DOUBLE PRECISION,
    "stopBasis" TEXT,
    "gateSkipped" BOOLEAN,
    "gateReason" TEXT,
    "gateDetail" JSONB,
    "closedAt" TIMESTAMP(3),
    "closedReason" TEXT,
    "notes" TEXT,
    "dismissedAt" TIMESTAMP(3),
    "partialExitedAt" TIMESTAMP(3),
    "partialExitPrice" DOUBLE PRECISION,
    "partialQty" INTEGER,
    "remainingQty" INTEGER,
    "trailingHighWater" DOUBLE PRECISION,
    "trailingStopPrice" DOUBLE PRECISION,
    "slBreachCount" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "adaptive_stop_watch_entries_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "adaptive_stop_watch_events" (
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

    CONSTRAINT "adaptive_stop_watch_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "adaptive_stop_trades" (
    "id" TEXT NOT NULL,
    "instrumentId" TEXT NOT NULL,
    "signalId" TEXT,
    "orderId" TEXT,
    "side" TEXT NOT NULL,
    "orderType" TEXT NOT NULL,
    "positionType" TEXT NOT NULL,
    "quantity" INTEGER NOT NULL,
    "closedQuantity" INTEGER NOT NULL DEFAULT 0,
    "entryPrice" DOUBLE PRECISION,
    "exitPrice" DOUBLE PRECISION,
    "stoploss" DOUBLE PRECISION,
    "target" DOUBLE PRECISION,
    "pnl" DOUBLE PRECISION,
    "pnlPercent" DOUBLE PRECISION,
    "fees" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "strategy" TEXT,
    "isPaperTrade" BOOLEAN NOT NULL DEFAULT true,
    "entryTime" TIMESTAMP(3),
    "exitTime" TIMESTAMP(3),
    "notes" TEXT,
    "entryReason" TEXT,
    "exitReasonTag" TEXT,
    "exitNotes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "adaptive_stop_trades_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "adaptive_stop_paper_account" (
    "id" TEXT NOT NULL,
    "startingBalance" DOUBLE PRECISION NOT NULL,
    "cash" DOUBLE PRECISION NOT NULL,
    "realizedPnl" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "fees" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "deployedCapital" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "killSwitchAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "adaptive_stop_paper_account_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "intraday_entries" (
    "id" TEXT NOT NULL,
    "symbol" TEXT NOT NULL,
    "token" TEXT,
    "entryPrice" DOUBLE PRECISION NOT NULL,
    "enteredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "targetPct" DOUBLE PRECISION NOT NULL DEFAULT 5.0,
    "stopPct" DOUBLE PRECISION NOT NULL DEFAULT 5.0,
    "status" TEXT NOT NULL DEFAULT 'TRADED',
    "exitPrice" DOUBLE PRECISION,
    "exitedAt" TIMESTAMP(3),
    "alertId" TEXT NOT NULL,
    "scoreBreakdown" JSONB,
    "trailing" BOOLEAN NOT NULL DEFAULT false,
    "partialBookedAt" TIMESTAMP(3),
    "partialExitPrice" DOUBLE PRECISION,
    "partialFraction" DOUBLE PRECISION,
    "stopMovedToBE" BOOLEAN NOT NULL DEFAULT false,
    "peakPrice" DOUBLE PRECISION,
    "exitReason" TEXT,

    CONSTRAINT "intraday_entries_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "swing_entries" (
    "id" TEXT NOT NULL,
    "symbol" TEXT NOT NULL,
    "token" TEXT,
    "entryPrice" DOUBLE PRECISION NOT NULL,
    "enteredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "targetPct" DOUBLE PRECISION NOT NULL DEFAULT 10.0,
    "stopPct" DOUBLE PRECISION NOT NULL DEFAULT 10.0,
    "status" TEXT NOT NULL DEFAULT 'TRADED',
    "exitPrice" DOUBLE PRECISION,
    "exitedAt" TIMESTAMP(3),
    "alertId" TEXT NOT NULL,
    "scoreBreakdown" JSONB,

    CONSTRAINT "swing_entries_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "breakout_swing_entries" (
    "id" TEXT NOT NULL,
    "symbol" TEXT NOT NULL,
    "token" TEXT,
    "alertId" TEXT NOT NULL,
    "scoreBreakdown" JSONB,
    "signalPrice" DOUBLE PRECISION NOT NULL,
    "resistance" DOUBLE PRECISION,
    "limitPrice" DOUBLE PRECISION NOT NULL,
    "prevDayClose" DOUBLE PRECISION,
    "status" TEXT NOT NULL DEFAULT 'QUEUED',
    "queuedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "entryPrice" DOUBLE PRECISION,
    "enteredAt" TIMESTAMP(3),
    "quantity" INTEGER,
    "targetPct" DOUBLE PRECISION NOT NULL DEFAULT 10.0,
    "stopPct" DOUBLE PRECISION NOT NULL DEFAULT 10.0,
    "trailing" BOOLEAN NOT NULL DEFAULT false,
    "trailingHighWater" DOUBLE PRECISION,
    "stopPrice" DOUBLE PRECISION,
    "currentPrice" DOUBLE PRECISION,
    "lastTickAt" TIMESTAMP(3),
    "exitPrice" DOUBLE PRECISION,
    "exitedAt" TIMESTAMP(3),
    "exitReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "breakout_swing_entries_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "swing_daily_ohlc" (
    "id" TEXT NOT NULL,
    "swingEntryId" TEXT NOT NULL,
    "date" TIMESTAMP(3) NOT NULL,
    "open" DOUBLE PRECISION NOT NULL,
    "high" DOUBLE PRECISION NOT NULL,
    "low" DOUBLE PRECISION NOT NULL,
    "close" DOUBLE PRECISION NOT NULL,
    "phase" TEXT NOT NULL DEFAULT 'HOLD',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "swing_daily_ohlc_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "symbol_lead_stats" (
    "id" TEXT NOT NULL,
    "symbol" TEXT NOT NULL,
    "track" TEXT NOT NULL DEFAULT 'swing',
    "count" INTEGER NOT NULL DEFAULT 0,
    "dates" JSONB NOT NULL DEFAULT '[]',
    "lastLedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "symbol_lead_stats_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "reinvestment_lots" (
    "id" TEXT NOT NULL,
    "symbol" TEXT NOT NULL,
    "sourceSwingEntryId" TEXT NOT NULL,
    "capital" DOUBLE PRECISION NOT NULL,
    "entryPrice" DOUBLE PRECISION NOT NULL,
    "enteredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "targetPct" DOUBLE PRECISION NOT NULL DEFAULT 10.0,
    "stopPct" DOUBLE PRECISION NOT NULL DEFAULT 10.0,
    "status" TEXT NOT NULL DEFAULT 'OPEN',
    "exitPrice" DOUBLE PRECISION,
    "exitedAt" TIMESTAMP(3),
    "exitReason" TEXT,

    CONSTRAINT "reinvestment_lots_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "reinvestment_pool" (
    "id" TEXT NOT NULL DEFAULT 'singleton',
    "harvestedTotal" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "deployedActive" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "idleBalance" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "realizedPnl" DOUBLE PRECISION NOT NULL DEFAULT 0,

    CONSTRAINT "reinvestment_pool_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "cautionary_symbols" (
    "id" TEXT NOT NULL,
    "symbol" TEXT NOT NULL,
    "exchange" TEXT NOT NULL DEFAULT 'NSE',
    "token" TEXT,
    "reason" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "deliveryOnly" BOOLEAN NOT NULL DEFAULT true,
    "notes" TEXT,
    "firstSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "cautionary_symbols_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "option_chain_snapshots_underlying_expiryDate_capturedAt_idx" ON "option_chain_snapshots"("underlying", "expiryDate", "capturedAt" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "broker_credentials_broker_key" ON "broker_credentials"("broker");

-- CreateIndex
CREATE INDEX "trade_events_tradeId_createdAt_idx" ON "trade_events"("tradeId", "createdAt");

-- CreateIndex
CREATE INDEX "trade_events_eventType_idx" ON "trade_events"("eventType");

-- CreateIndex
CREATE INDEX "ungated_watch_entries_status_idx" ON "ungated_watch_entries"("status");

-- CreateIndex
CREATE INDEX "ungated_watch_entries_token_idx" ON "ungated_watch_entries"("token");

-- CreateIndex
CREATE INDEX "ungated_watch_entries_symbol_idx" ON "ungated_watch_entries"("symbol");

-- CreateIndex
CREATE INDEX "ungated_watch_entries_createdAt_idx" ON "ungated_watch_entries"("createdAt");

-- CreateIndex
CREATE INDEX "ungated_watch_events_watchEntryId_createdAt_idx" ON "ungated_watch_events"("watchEntryId", "createdAt");

-- CreateIndex
CREATE INDEX "ungated_watch_events_eventType_idx" ON "ungated_watch_events"("eventType");

-- CreateIndex
CREATE INDEX "ungated_trades_status_idx" ON "ungated_trades"("status");

-- CreateIndex
CREATE INDEX "ungated_trades_createdAt_idx" ON "ungated_trades"("createdAt");

-- CreateIndex
CREATE INDEX "ungated_rejections_createdAt_idx" ON "ungated_rejections"("createdAt");

-- CreateIndex
CREATE INDEX "ungated_rejections_reason_idx" ON "ungated_rejections"("reason");

-- CreateIndex
CREATE INDEX "adaptive_stop_watch_entries_status_idx" ON "adaptive_stop_watch_entries"("status");

-- CreateIndex
CREATE INDEX "adaptive_stop_watch_entries_token_idx" ON "adaptive_stop_watch_entries"("token");

-- CreateIndex
CREATE INDEX "adaptive_stop_watch_entries_symbol_idx" ON "adaptive_stop_watch_entries"("symbol");

-- CreateIndex
CREATE INDEX "adaptive_stop_watch_entries_createdAt_idx" ON "adaptive_stop_watch_entries"("createdAt");

-- CreateIndex
CREATE INDEX "adaptive_stop_watch_events_watchEntryId_createdAt_idx" ON "adaptive_stop_watch_events"("watchEntryId", "createdAt");

-- CreateIndex
CREATE INDEX "adaptive_stop_watch_events_eventType_idx" ON "adaptive_stop_watch_events"("eventType");

-- CreateIndex
CREATE INDEX "adaptive_stop_trades_status_idx" ON "adaptive_stop_trades"("status");

-- CreateIndex
CREATE INDEX "adaptive_stop_trades_createdAt_idx" ON "adaptive_stop_trades"("createdAt");

-- CreateIndex
CREATE INDEX "intraday_entries_status_enteredAt_idx" ON "intraday_entries"("status", "enteredAt");

-- CreateIndex
CREATE INDEX "intraday_entries_alertId_idx" ON "intraday_entries"("alertId");

-- CreateIndex
CREATE INDEX "intraday_entries_symbol_status_idx" ON "intraday_entries"("symbol", "status");

-- CreateIndex
CREATE INDEX "swing_entries_status_enteredAt_idx" ON "swing_entries"("status", "enteredAt");

-- CreateIndex
CREATE INDEX "swing_entries_alertId_idx" ON "swing_entries"("alertId");

-- CreateIndex
CREATE INDEX "swing_entries_symbol_status_idx" ON "swing_entries"("symbol", "status");

-- CreateIndex
CREATE INDEX "breakout_swing_entries_status_idx" ON "breakout_swing_entries"("status");

-- CreateIndex
CREATE INDEX "breakout_swing_entries_token_idx" ON "breakout_swing_entries"("token");

-- CreateIndex
CREATE INDEX "breakout_swing_entries_alertId_idx" ON "breakout_swing_entries"("alertId");

-- CreateIndex
CREATE INDEX "breakout_swing_entries_symbol_status_idx" ON "breakout_swing_entries"("symbol", "status");

-- CreateIndex
CREATE INDEX "swing_daily_ohlc_swingEntryId_idx" ON "swing_daily_ohlc"("swingEntryId");

-- CreateIndex
CREATE UNIQUE INDEX "swing_daily_ohlc_swingEntryId_date_key" ON "swing_daily_ohlc"("swingEntryId", "date");

-- CreateIndex
CREATE UNIQUE INDEX "symbol_lead_stats_symbol_track_key" ON "symbol_lead_stats"("symbol", "track");

-- CreateIndex
CREATE UNIQUE INDEX "reinvestment_lots_sourceSwingEntryId_key" ON "reinvestment_lots"("sourceSwingEntryId");

-- CreateIndex
CREATE INDEX "reinvestment_lots_status_enteredAt_idx" ON "reinvestment_lots"("status", "enteredAt");

-- CreateIndex
CREATE INDEX "reinvestment_lots_symbol_idx" ON "reinvestment_lots"("symbol");

-- CreateIndex
CREATE INDEX "cautionary_symbols_token_idx" ON "cautionary_symbols"("token");

-- CreateIndex
CREATE UNIQUE INDEX "cautionary_symbols_symbol_exchange_key" ON "cautionary_symbols"("symbol", "exchange");

-- CreateIndex
CREATE INDEX "trades_vixRegimeAtEntry_idx" ON "trades"("vixRegimeAtEntry");

-- CreateIndex
CREATE INDEX "trades_exitReasonTag_idx" ON "trades"("exitReasonTag");

-- CreateIndex
CREATE INDEX "trades_source_idx" ON "trades"("source");

-- CreateIndex
CREATE INDEX "trades_status_createdAt_idx" ON "trades"("status", "createdAt");

-- CreateIndex
CREATE INDEX "trades_source_status_idx" ON "trades"("source", "status");

-- CreateIndex
CREATE INDEX "watch_entries_token_closedAt_idx" ON "watch_entries"("token", "closedAt");

-- CreateIndex
CREATE INDEX "watch_entries_status_initialAt_idx" ON "watch_entries"("status", "initialAt");

-- AddForeignKey
ALTER TABLE "trade_events" ADD CONSTRAINT "trade_events_tradeId_fkey" FOREIGN KEY ("tradeId") REFERENCES "trades"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ungated_watch_events" ADD CONSTRAINT "ungated_watch_events_watchEntryId_fkey" FOREIGN KEY ("watchEntryId") REFERENCES "ungated_watch_entries"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "adaptive_stop_watch_events" ADD CONSTRAINT "adaptive_stop_watch_events_watchEntryId_fkey" FOREIGN KEY ("watchEntryId") REFERENCES "adaptive_stop_watch_entries"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "swing_daily_ohlc" ADD CONSTRAINT "swing_daily_ohlc_swingEntryId_fkey" FOREIGN KEY ("swingEntryId") REFERENCES "swing_entries"("id") ON DELETE CASCADE ON UPDATE CASCADE;
