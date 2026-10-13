-- SP2 M5 — the journal and closed-trade summaries (docs/superpowers/plans/2026-10-13-sp2-m5-journal-and-entries.md).
--
-- Expand-only: two new tables with their indexes, FKs, CHECKs and append-only triggers (the M2
-- function core_append_only_guard() is reused, not redefined). No existing table, column,
-- constraint or function is changed.
CREATE TABLE "core_journal" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "positionId" TEXT,
    "strategyId" TEXT,
    "strategyVersionId" TEXT,
    "intentId" TEXT,
    "symbol" TEXT,
    "payload" JSONB NOT NULL,
    "priceUsed" DECIMAL(14,4),
    "priceAgeMs" INTEGER,
    "dedupeKey" TEXT,
    "istDay" DATE NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "core_journal_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "core_journal_dedupeKey_key" ON "core_journal"("dedupeKey");
CREATE INDEX "core_journal_userId_istDay_type_idx" ON "core_journal"("userId", "istDay", "type");
CREATE INDEX "core_journal_userId_positionId_idx" ON "core_journal"("userId", "positionId");
CREATE INDEX "core_journal_intentId_idx" ON "core_journal"("intentId");
CREATE INDEX "core_journal_type_istDay_idx" ON "core_journal"("type", "istDay");
ALTER TABLE "core_journal" ADD CONSTRAINT "core_journal_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
-- Vocabulary (journal.types.ts JOURNAL_TYPES; journal-migration.spec.ts checks the list).
ALTER TABLE "core_journal" ADD CONSTRAINT "core_journal_type_check" CHECK (
    "type" IN ('ALERT_RECEIVED', 'INTENT_SKIPPED', 'RISK_VERDICT', 'ORDER_PLACED', 'ORDER_STATE', 'FILL', 'STOP_MOVED', 'EXIT_DECIDED', 'POSITION_STATE', 'BLIND', 'RECOVERY_STOP', 'KILL_SWITCH', 'LIMIT_CHANGED', 'RECON_MISMATCH', 'RECON_ACK', 'DAILY_LOSS_LATCHED', 'PRICE_FOLLOWUP'));
ALTER TABLE "core_journal" ADD CONSTRAINT "core_journal_shape_check" CHECK (
    ("priceAgeMs" IS NULL OR "priceAgeMs" >= 0)
    AND ("dedupeKey" IS NULL OR length("dedupeKey") BETWEEN 1 AND 200)
    AND jsonb_typeof("payload") = 'object');

CREATE TABLE "core_trade_summaries" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "positionId" TEXT NOT NULL,
    "intentId" TEXT NOT NULL,
    "strategyId" TEXT NOT NULL,
    "strategyVersionId" TEXT NOT NULL,
    "vehicle" TEXT NOT NULL,
    "exchange" TEXT NOT NULL,
    "token" TEXT NOT NULL,
    "symbol" TEXT NOT NULL,
    "side" TEXT NOT NULL,
    "qty" INTEGER NOT NULL,
    "entryAvgPrice" DECIMAL(14,4) NOT NULL,
    "exitAvgPrice" DECIMAL(14,4) NOT NULL,
    "openedAt" TIMESTAMP(3) NOT NULL,
    "closedAt" TIMESTAMP(3) NOT NULL,
    "grossPnl" DECIMAL(14,2) NOT NULL,
    "charges" DECIMAL(14,2) NOT NULL,
    "mtfInterest" DECIMAL(14,2) NOT NULL,
    "netPnl" DECIMAL(14,2) NOT NULL,
    "initialRisk" DECIMAL(14,2),
    "rMultiple" DECIMAL(12,4),
    "mfePrice" DECIMAL(14,4),
    "maePrice" DECIMAL(14,4),
    "mfeRupees" DECIMAL(14,2),
    "maeRupees" DECIMAL(14,2),
    "holdMinutes" INTEGER NOT NULL,
    "exitReason" TEXT NOT NULL,
    "istDay" DATE NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "core_trade_summaries_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "core_trade_summaries_positionId_key" ON "core_trade_summaries"("positionId");
CREATE UNIQUE INDEX "core_trade_summaries_intentId_key" ON "core_trade_summaries"("intentId");
CREATE INDEX "core_trade_summaries_userId_istDay_idx" ON "core_trade_summaries"("userId", "istDay");
CREATE INDEX "core_trade_summaries_userId_strategyId_token_closedAt_idx" ON "core_trade_summaries"("userId", "strategyId", "token", "closedAt");
ALTER TABLE "core_trade_summaries" ADD CONSTRAINT "core_trade_summaries_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "core_trade_summaries" ADD CONSTRAINT "core_trade_summaries_positionId_fkey" FOREIGN KEY ("positionId") REFERENCES "core_positions"("id") ON DELETE CASCADE ON UPDATE CASCADE;
-- Vocabularies (lifecycle.types.ts EXIT_REASONS; journal-migration.spec.ts checks the list).
ALTER TABLE "core_trade_summaries" ADD CONSTRAINT "core_trade_summaries_vocab_check" CHECK (
    "vehicle" IN ('CASH_INTRADAY', 'MTF', 'OPTIONS_BUY')
    AND "side" IN ('BUY', 'SELL')
    AND "exitReason" IN ('KILL_SWITCH', 'DAILY_LOSS', 'STOP', 'GAP_STOP', 'RECOVERY_STOP', 'UNDERLYING_STOP', 'GUARD_RAIL', 'MANUAL', 'TARGET', 'TRAIL', 'TIME_EXIT', 'THETA_STOP', 'EXPIRY_DAY', 'HOLD_LIMIT', 'SQUARE_OFF'));
ALTER TABLE "core_trade_summaries" ADD CONSTRAINT "core_trade_summaries_shape_check" CHECK (
    "qty" > 0 AND "holdMinutes" >= 0 AND "closedAt" >= "openedAt"
    AND "charges" >= 0 AND "mtfInterest" >= 0
    AND ("initialRisk" IS NULL OR "initialRisk" > 0));

-- Append-only (spec §8.1: "no update or delete path"). DELETE stays possible only so deleting a
-- user (or a position) cascades. No repository has an update or delete method for these.
CREATE TRIGGER "core_journal_append_only"
    BEFORE UPDATE ON "core_journal"
    FOR EACH ROW EXECUTE FUNCTION core_append_only_guard();

CREATE TRIGGER "core_trade_summaries_append_only"
    BEFORE UPDATE ON "core_trade_summaries"
    FOR EACH ROW EXECUTE FUNCTION core_append_only_guard();
