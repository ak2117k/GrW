-- Telegram reader (stream R): the owner's MTProto session + reader columns on the existing
-- legacy scorecard tables. ADD only.

-- CreateTable
CREATE TABLE "telegram_sessions" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "apiId" INTEGER NOT NULL,
    "encApiHash" TEXT NOT NULL,
    "encSession" TEXT NOT NULL,
    "encDataKey" TEXT NOT NULL,
    "keyVersion" TEXT NOT NULL,
    "phoneMasked" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'connected',
    "lastError" TEXT,
    "connectedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "telegram_sessions_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "telegram_sessions_userId_key" ON "telegram_sessions"("userId");

-- AlterTable
ALTER TABLE "telegram_channels" ADD COLUMN "userId" TEXT,
ADD COLUMN "enabled" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN "memberCount" INTEGER;

-- CreateIndex
CREATE INDEX "telegram_channels_userId_enabled_idx" ON "telegram_channels"("userId", "enabled");

-- AlterTable
ALTER TABLE "telegram_messages" ADD COLUMN "hasMedia" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN "editedAt" TIMESTAMP(3);
