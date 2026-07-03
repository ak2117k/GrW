-- TDA-015: Billing / Payments (Razorpay) — forward-only, ADDITIVE.
--
-- New tables (billing_profiles, webhook_events) + three NULLABLE columns on
-- subscriptions. No backfill, no NOT NULL on existing rows, no changes to the
-- gate's existing reads — so a fresh `migrate deploy` and an in-place upgrade
-- both apply cleanly.

-- ── Subscription billing linkage (nullable, additive) ──────────────────────────
-- The webhook maps a Razorpay subscription back to the gate row via
-- "providerSubId", so there is no join table.
ALTER TABLE "subscriptions" ADD COLUMN "providerSubId" TEXT;
ALTER TABLE "subscriptions" ADD COLUMN "providerPlanId" TEXT;
ALTER TABLE "subscriptions" ADD COLUMN "graceUntil" TIMESTAMP(3);

CREATE UNIQUE INDEX "subscriptions_providerSubId_key" ON "subscriptions"("providerSubId");

-- ── BillingProfile — one per user (Razorpay customer + GST identity) ───────────
-- A TENANT_MODEL (user-owned); the webhook worker reaches it via runWithoutTenant.
CREATE TABLE "billing_profiles" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "providerCustomerId" TEXT NOT NULL,
    "gstin" TEXT,
    "billingName" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "billing_profiles_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "billing_profiles_userId_key" ON "billing_profiles"("userId");
CREATE UNIQUE INDEX "billing_profiles_providerCustomerId_key" ON "billing_profiles"("providerCustomerId");

ALTER TABLE "billing_profiles" ADD CONSTRAINT "billing_profiles_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ── WebhookEvent — the idempotency / dedupe ledger ─────────────────────────────
-- NOT tenant-scoped (written by the unauthenticated webhook worker, cross-user).
-- The unique (provider, eventId) is the dedupe key: a redelivered event id hits
-- P2002 and is acked without reprocessing (mirrors ExecutionClaim).
CREATE TABLE "webhook_events" (
    "id" TEXT NOT NULL,
    "provider" TEXT NOT NULL DEFAULT 'razorpay',
    "eventId" TEXT NOT NULL,
    "eventType" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'RECEIVED',
    "payloadHash" TEXT NOT NULL,
    "receivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "processedAt" TIMESTAMP(3),

    CONSTRAINT "webhook_events_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "webhook_events_provider_eventId_key" ON "webhook_events"("provider", "eventId");
CREATE INDEX "webhook_events_status_receivedAt_idx" ON "webhook_events"("status", "receivedAt");
