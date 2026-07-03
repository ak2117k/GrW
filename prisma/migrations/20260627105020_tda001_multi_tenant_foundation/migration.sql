-- CreateEnum
CREATE TYPE "UserRole" AS ENUM ('USER', 'ADMIN');

-- CreateEnum
CREATE TYPE "UserStatus" AS ENUM ('PENDING_VERIFICATION', 'ACTIVE', 'SUSPENDED', 'CLOSED');

-- CreateEnum
CREATE TYPE "Segment" AS ENUM ('INTRADAY', 'SWING');

-- CreateEnum
CREATE TYPE "SubscriptionStatus" AS ENUM ('ACTIVE', 'PAST_DUE', 'CANCELLED', 'EXPIRED');

-- DropIndex
DROP INDEX "alerts_isActive_type_idx";

-- DropIndex
DROP INDEX "broker_credentials_broker_key";

-- DropIndex
DROP INDEX "trades_source_status_idx";

-- DropIndex
DROP INDEX "trades_status_createdAt_idx";

-- AlterTable
ALTER TABLE "ai_trade_analyses" ADD COLUMN     "userId" TEXT NOT NULL;

-- AlterTable
ALTER TABLE "ai_weekly_reports" ADD COLUMN     "userId" TEXT NOT NULL;

-- AlterTable
ALTER TABLE "alerts" ADD COLUMN     "userId" TEXT NOT NULL;

-- AlterTable
ALTER TABLE "broker_credentials" DROP COLUMN "apiKey",
DROP COLUMN "clientId",
DROP COLUMN "password",
DROP COLUMN "totpSecret",
ADD COLUMN     "encApiKey" TEXT NOT NULL,
ADD COLUMN     "encApiSecret" TEXT NOT NULL,
ADD COLUMN     "encClientId" TEXT NOT NULL,
ADD COLUMN     "encDataKey" TEXT NOT NULL,
ADD COLUMN     "encPassword" TEXT NOT NULL,
ADD COLUMN     "encTotpSecret" TEXT NOT NULL,
ADD COLUMN     "keyVersion" INTEGER NOT NULL DEFAULT 1,
ADD COLUMN     "lastValidated" TIMESTAMP(3),
ADD COLUMN     "userId" TEXT NOT NULL;

-- AlterTable
ALTER TABLE "daily_performance" ADD COLUMN     "userId" TEXT NOT NULL;

-- AlterTable
ALTER TABLE "trades" ADD COLUMN     "userId" TEXT NOT NULL;

-- AlterTable
ALTER TABLE "user_settings" ADD COLUMN     "userId" TEXT NOT NULL;

-- CreateTable
CREATE TABLE "users" (
    "id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "passwordHash" TEXT NOT NULL,
    "role" "UserRole" NOT NULL DEFAULT 'USER',
    "status" "UserStatus" NOT NULL DEFAULT 'PENDING_VERIFICATION',
    "emailVerifiedAt" TIMESTAMP(3),
    "displayName" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "subscriptions" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "segment" "Segment" NOT NULL,
    "status" "SubscriptionStatus" NOT NULL DEFAULT 'ACTIVE',
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "subscriptions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "auto_trade_consents" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "segment" "Segment" NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "killSwitch" BOOLEAN NOT NULL DEFAULT false,
    "riskPerTrade" DOUBLE PRECISION,
    "maxCapital" DOUBLE PRECISION,
    "enabledAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "auto_trade_consents_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "consent_documents" (
    "id" TEXT NOT NULL,
    "version" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "contentHash" TEXT NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "consent_documents_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "consent_records" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "documentId" TEXT NOT NULL,
    "version" TEXT NOT NULL,
    "acceptedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "ipAddress" TEXT,
    "userAgent" TEXT,

    CONSTRAINT "consent_records_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "audit_logs" (
    "id" TEXT NOT NULL,
    "userId" TEXT,
    "action" TEXT NOT NULL,
    "target" TEXT,
    "meta" JSONB,
    "prevHash" TEXT,
    "hash" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "audit_logs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "users_email_key" ON "users"("email");

-- CreateIndex
CREATE INDEX "users_status_idx" ON "users"("status");

-- CreateIndex
CREATE INDEX "subscriptions_status_expiresAt_idx" ON "subscriptions"("status", "expiresAt");

-- CreateIndex
CREATE UNIQUE INDEX "subscriptions_userId_segment_key" ON "subscriptions"("userId", "segment");

-- CreateIndex
CREATE UNIQUE INDEX "auto_trade_consents_userId_segment_key" ON "auto_trade_consents"("userId", "segment");

-- CreateIndex
CREATE UNIQUE INDEX "consent_documents_version_key" ON "consent_documents"("version");

-- CreateIndex
CREATE INDEX "consent_records_userId_version_idx" ON "consent_records"("userId", "version");

-- CreateIndex
CREATE INDEX "audit_logs_userId_createdAt_idx" ON "audit_logs"("userId", "createdAt");

-- CreateIndex
CREATE INDEX "audit_logs_action_createdAt_idx" ON "audit_logs"("action", "createdAt");

-- CreateIndex
CREATE INDEX "ai_trade_analyses_userId_idx" ON "ai_trade_analyses"("userId");

-- CreateIndex
CREATE INDEX "ai_weekly_reports_userId_idx" ON "ai_weekly_reports"("userId");

-- CreateIndex
CREATE INDEX "alerts_userId_isActive_type_idx" ON "alerts"("userId", "isActive", "type");

-- CreateIndex
CREATE UNIQUE INDEX "broker_credentials_userId_key" ON "broker_credentials"("userId");

-- CreateIndex
CREATE INDEX "daily_performance_userId_idx" ON "daily_performance"("userId");

-- CreateIndex
CREATE INDEX "trades_userId_idx" ON "trades"("userId");

-- CreateIndex
CREATE INDEX "trades_userId_status_createdAt_idx" ON "trades"("userId", "status", "createdAt");

-- CreateIndex
CREATE INDEX "trades_userId_source_status_idx" ON "trades"("userId", "source", "status");

-- CreateIndex
CREATE UNIQUE INDEX "user_settings_userId_key" ON "user_settings"("userId");

-- AddForeignKey
ALTER TABLE "trades" ADD CONSTRAINT "trades_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "daily_performance" ADD CONSTRAINT "daily_performance_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ai_trade_analyses" ADD CONSTRAINT "ai_trade_analyses_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ai_weekly_reports" ADD CONSTRAINT "ai_weekly_reports_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "user_settings" ADD CONSTRAINT "user_settings_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "alerts" ADD CONSTRAINT "alerts_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "broker_credentials" ADD CONSTRAINT "broker_credentials_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "subscriptions" ADD CONSTRAINT "subscriptions_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "auto_trade_consents" ADD CONSTRAINT "auto_trade_consents_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "consent_records" ADD CONSTRAINT "consent_records_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "consent_records" ADD CONSTRAINT "consent_records_documentId_fkey" FOREIGN KEY ("documentId") REFERENCES "consent_documents"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "audit_logs" ADD CONSTRAINT "audit_logs_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;


-- TDA-001: seed ADMIN user + placeholder consent document (self-contained for prod migrate)
INSERT INTO "users" ("id","email","passwordHash","role","status","createdAt","updatedAt")
VALUES ('usr_admin_seed_0001','admin@local','!UNSET-SET-IN-TDA-002','ADMIN','ACTIVE', now(), now())
ON CONFLICT ("id") DO NOTHING;
INSERT INTO "consent_documents" ("id","version","kind","body","contentHash","active","createdAt")
VALUES ('cdoc_seed_0001','2026-06-27.0-placeholder','risk-disclosure','PLACEHOLDER - replaced in TDA-009','sha256:placeholder', true, now())
ON CONFLICT ("id") DO NOTHING;
