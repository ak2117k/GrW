-- CreateEnum
CREATE TYPE "TelegramSignalStatus" AS ENUM ('PENDING', 'ACTIVE', 'TARGET_HIT', 'SL_HIT', 'EXPIRED', 'UNTRACKABLE', 'INVALIDATED');

-- CreateTable
CREATE TABLE "telegram_channels" (
    "id" TEXT NOT NULL,
    "tgChannelId" TEXT NOT NULL,
    "username" TEXT,
    "title" TEXT NOT NULL,
    "inviteLink" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "lastSeenMsgId" INTEGER NOT NULL DEFAULT 0,
    "joinedAt" TIMESTAMP(3),
    "addedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "telegram_channels_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "telegram_messages" (
    "id" TEXT NOT NULL,
    "channelId" TEXT NOT NULL,
    "tgMessageId" INTEGER NOT NULL,
    "rawText" TEXT NOT NULL,
    "postedAt" TIMESTAMP(3) NOT NULL,
    "receivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "parseStatus" TEXT NOT NULL,
    "rawPayload" JSONB NOT NULL,

    CONSTRAINT "telegram_messages_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "telegram_signals" (
    "id" TEXT NOT NULL,
    "messageId" TEXT NOT NULL,
    "channelId" TEXT NOT NULL,
    "symbol" TEXT NOT NULL,
    "token" TEXT,
    "exchange" TEXT,
    "instrument" TEXT NOT NULL,
    "side" TEXT NOT NULL,
    "optionType" TEXT,
    "strike" DOUBLE PRECISION,
    "expiry" TIMESTAMP(3),
    "signalType" TEXT NOT NULL,
    "entryMode" TEXT NOT NULL,
    "entryLow" DOUBLE PRECISION,
    "entryHigh" DOUBLE PRECISION,
    "slMode" TEXT NOT NULL,
    "stopLoss" DOUBLE PRECISION,
    "targets" DOUBLE PRECISION[],
    "horizon" TEXT NOT NULL,
    "parseConfidence" DOUBLE PRECISION NOT NULL,
    "status" "TelegramSignalStatus" NOT NULL DEFAULT 'PENDING',
    "entryPrice" DOUBLE PRECISION,
    "entryFilledAt" TIMESTAMP(3),
    "exitPrice" DOUBLE PRECISION,
    "exitAt" TIMESTAMP(3),
    "hitTargetIndex" INTEGER,
    "resultPct" DOUBLE PRECISION,
    "trackExpiresAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "telegram_signals_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "telegram_signal_events" (
    "id" TEXT NOT NULL,
    "signalId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "price" DOUBLE PRECISION,
    "note" TEXT,
    "at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "telegram_signal_events_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "telegram_channels_tgChannelId_key" ON "telegram_channels"("tgChannelId");

-- CreateIndex
CREATE INDEX "telegram_messages_channelId_postedAt_idx" ON "telegram_messages"("channelId", "postedAt");

-- CreateIndex
CREATE UNIQUE INDEX "telegram_messages_channelId_tgMessageId_key" ON "telegram_messages"("channelId", "tgMessageId");

-- CreateIndex
CREATE UNIQUE INDEX "telegram_signals_messageId_key" ON "telegram_signals"("messageId");

-- CreateIndex
CREATE INDEX "telegram_signals_channelId_status_idx" ON "telegram_signals"("channelId", "status");

-- CreateIndex
CREATE INDEX "telegram_signals_token_status_idx" ON "telegram_signals"("token", "status");

-- CreateIndex
CREATE INDEX "telegram_signal_events_signalId_idx" ON "telegram_signal_events"("signalId");

-- AddForeignKey
ALTER TABLE "telegram_messages" ADD CONSTRAINT "telegram_messages_channelId_fkey" FOREIGN KEY ("channelId") REFERENCES "telegram_channels"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "telegram_signals" ADD CONSTRAINT "telegram_signals_messageId_fkey" FOREIGN KEY ("messageId") REFERENCES "telegram_messages"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "telegram_signals" ADD CONSTRAINT "telegram_signals_channelId_fkey" FOREIGN KEY ("channelId") REFERENCES "telegram_channels"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "telegram_signal_events" ADD CONSTRAINT "telegram_signal_events_signalId_fkey" FOREIGN KEY ("signalId") REFERENCES "telegram_signals"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
