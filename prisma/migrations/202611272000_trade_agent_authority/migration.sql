-- Trade agent exit authority (2026-11-27, apps/api/src/modules/exit-authority). Expand-only: two new tables, nothing altered or dropped.
CREATE TABLE "trade_alarms" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "tracker_id" TEXT NOT NULL,
    "symbol" TEXT NOT NULL,
    "rule" TEXT NOT NULL,
    "urgency" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "would_have" TEXT NOT NULL,
    "deadline" TIMESTAMPTZ(6),
    "severity_n" DOUBLE PRECISION,
    "source_ref" TEXT,
    "payload" JSONB,
    "status" TEXT NOT NULL,
    "raised_at" TIMESTAMPTZ(6) NOT NULL,
    "last_raised_at" TIMESTAMPTZ(6) NOT NULL,
    "answered_at" TIMESTAMPTZ(6),
    "answer_verdict_id" TEXT,
    "answer" TEXT,
    "alerted_at" TIMESTAMPTZ(6),
    "alert_count" INTEGER NOT NULL DEFAULT 0,
    "telegram_message_id" INTEGER,
    "snoozed_until" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    CONSTRAINT "trade_alarms_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "trade_alarms_status_tracker_id_idx" ON "trade_alarms"("status", "tracker_id");
CREATE INDEX "trade_alarms_tracker_id_rule_status_idx" ON "trade_alarms"("tracker_id", "rule", "status");
-- At most one live (OPEN/SNOOZED) alarm per (tracker, rule), even across processes. Partial: not expressible in
-- schema.prisma, so it lives only here; a concurrent second create gets P2002 and TradeAlarmsService treats it as deduped.
CREATE UNIQUE INDEX "trade_alarms_tracker_id_rule_live_key" ON "trade_alarms"("tracker_id", "rule") WHERE "status" IN ('OPEN', 'SNOOZED');

CREATE TABLE "trade_briefs" (
    "tracker_id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "text" TEXT NOT NULL,
    "by" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    CONSTRAINT "trade_briefs_pkey" PRIMARY KEY ("tracker_id")
);
