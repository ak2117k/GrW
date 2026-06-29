-- CreateEnum
CREATE TYPE "VerificationTokenType" AS ENUM ('EMAIL_VERIFY', 'PASSWORD_RESET');

-- AlterTable
ALTER TABLE "users" ADD COLUMN     "lastLoginAt" TIMESTAMP(3),
ADD COLUMN     "mfaEnabled" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "mfaSecretEnc" TEXT;

-- CreateTable
CREATE TABLE "sell_futures_watch_entries" (
    "id" TEXT NOT NULL,
    "alertId" TEXT,
    "setupId" TEXT,
    "symbol" TEXT NOT NULL,
    "token" TEXT NOT NULL,
    "exchange" TEXT NOT NULL,
    "eqToken" TEXT,
    "futTradingsymbol" TEXT,
    "futExpiry" TIMESTAMP(3),
    "lotSize" INTEGER,
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

    CONSTRAINT "sell_futures_watch_entries_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sell_futures_watch_events" (
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

    CONSTRAINT "sell_futures_watch_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sell_futures_trades" (
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

    CONSTRAINT "sell_futures_trades_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sell_futures_paper_account" (
    "id" TEXT NOT NULL,
    "startingBalance" DOUBLE PRECISION NOT NULL,
    "cash" DOUBLE PRECISION NOT NULL,
    "realizedPnl" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "fees" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "deployedCapital" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "killSwitchAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "sell_futures_paper_account_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sell_futures_rejections" (
    "id" TEXT NOT NULL,
    "alertId" TEXT,
    "symbol" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "score" INTEGER,
    "hitPrice" DOUBLE PRECISION,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "sell_futures_rejections_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "refresh_tokens" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "familyId" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "revokedAt" TIMESTAMP(3),
    "replacedById" TEXT,
    "userAgent" TEXT,
    "ip" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "refresh_tokens_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "verification_tokens" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "type" "VerificationTokenType" NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "usedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "verification_tokens_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "sell_futures_watch_entries_status_idx" ON "sell_futures_watch_entries"("status");

-- CreateIndex
CREATE INDEX "sell_futures_watch_entries_token_idx" ON "sell_futures_watch_entries"("token");

-- CreateIndex
CREATE INDEX "sell_futures_watch_entries_symbol_idx" ON "sell_futures_watch_entries"("symbol");

-- CreateIndex
CREATE INDEX "sell_futures_watch_entries_createdAt_idx" ON "sell_futures_watch_entries"("createdAt");

-- CreateIndex
CREATE INDEX "sell_futures_watch_events_watchEntryId_createdAt_idx" ON "sell_futures_watch_events"("watchEntryId", "createdAt");

-- CreateIndex
CREATE INDEX "sell_futures_watch_events_eventType_idx" ON "sell_futures_watch_events"("eventType");

-- CreateIndex
CREATE INDEX "sell_futures_trades_status_idx" ON "sell_futures_trades"("status");

-- CreateIndex
CREATE INDEX "sell_futures_trades_createdAt_idx" ON "sell_futures_trades"("createdAt");

-- CreateIndex
CREATE INDEX "sell_futures_rejections_createdAt_idx" ON "sell_futures_rejections"("createdAt");

-- CreateIndex
CREATE INDEX "sell_futures_rejections_reason_idx" ON "sell_futures_rejections"("reason");

-- CreateIndex
CREATE UNIQUE INDEX "refresh_tokens_tokenHash_key" ON "refresh_tokens"("tokenHash");

-- CreateIndex
CREATE INDEX "refresh_tokens_userId_idx" ON "refresh_tokens"("userId");

-- CreateIndex
CREATE INDEX "refresh_tokens_familyId_idx" ON "refresh_tokens"("familyId");

-- CreateIndex
CREATE UNIQUE INDEX "verification_tokens_tokenHash_key" ON "verification_tokens"("tokenHash");

-- CreateIndex
CREATE INDEX "verification_tokens_userId_type_idx" ON "verification_tokens"("userId", "type");

-- AddForeignKey
ALTER TABLE "sell_futures_watch_events" ADD CONSTRAINT "sell_futures_watch_events_watchEntryId_fkey" FOREIGN KEY ("watchEntryId") REFERENCES "sell_futures_watch_entries"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "refresh_tokens" ADD CONSTRAINT "refresh_tokens_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "verification_tokens" ADD CONSTRAINT "verification_tokens_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
