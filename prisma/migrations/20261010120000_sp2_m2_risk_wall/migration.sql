-- SP2 M2 — Risk Wall limits and the persistent kill switch
-- (docs/superpowers/specs/2026-10-09-sp2-core-trade-lifecycle-design.md §5.2, §5.4).
--
-- Expand-only: creates three tables, CHECK constraints, an append-only trigger and
-- 21 seed default rows. Drops and alters nothing that exists. Per-user limit rows are
-- not copied here: the API seeds each user lazily from user_settings and these
-- defaults (plan decision 7).

CREATE TABLE "core_risk_limits" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "scope" TEXT NOT NULL,
    "numValue" DECIMAL(14,2),
    "textValue" TEXT,
    "effectiveFrom" TIMESTAMP(3) NOT NULL,
    "source" TEXT NOT NULL,
    "setBy" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "core_risk_limits_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "core_risk_limit_defaults" (
    "key" TEXT NOT NULL,
    "scope" TEXT NOT NULL,
    "numValue" DECIMAL(14,2),
    "textValue" TEXT,
    "note" TEXT NOT NULL,
    "updatedBy" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "core_risk_limit_defaults_pkey" PRIMARY KEY ("key","scope")
);

CREATE TABLE "core_kill_switch" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "active" BOOLEAN NOT NULL,
    "effectiveFrom" TIMESTAMP(3) NOT NULL,
    "setBy" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "core_kill_switch_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "core_risk_limits_userId_key_scope_createdAt_idx" ON "core_risk_limits"("userId", "key", "scope", "createdAt");
CREATE INDEX "core_kill_switch_userId_createdAt_idx" ON "core_kill_switch"("userId", "createdAt");

ALTER TABLE "core_risk_limits" ADD CONSTRAINT "core_risk_limits_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "core_kill_switch" ADD CONSTRAINT "core_kill_switch_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Vocabulary and value shapes (Prisma models them as String/Decimal; its diff ignores CHECKs).
-- The pair list must equal LIMIT_PAIRS in limit-keys.ts (core-risk-defaults.spec.ts checks it).
ALTER TABLE "core_risk_limits" ADD CONSTRAINT "core_risk_limits_pair_check" CHECK (("key", "scope") IN (
    ('maxDailyLoss', 'ALL'), ('maxDailyLossPerStrategy', 'ALL'), ('maxTradesPerDay', 'ALL'),
    ('maxOpenPositions', 'ALL'), ('maxOpenPositions', 'CASH_INTRADAY'), ('maxOpenPositions', 'MTF'), ('maxOpenPositions', 'OPTIONS_BUY'),
    ('maxRiskPerTrade', 'ALL'),
    ('maxCapitalDeployed', 'CASH_INTRADAY'), ('maxCapitalDeployed', 'MTF'), ('maxCapitalDeployed', 'OPTIONS_BUY'),
    ('mtfMaxLeverage', 'MTF'), ('mtfMaxHoldDays', 'MTF'), ('optionsMaxPremiumPerTrade', 'OPTIONS_BUY'),
    ('lastEntryTime', 'CASH_INTRADAY'), ('lastEntryTime', 'MTF'), ('lastEntryTime', 'OPTIONS_BUY'),
    ('squareOffTime', 'CASH_INTRADAY'), ('squareOffTime', 'MTF'), ('squareOffTime', 'OPTIONS_BUY'),
    ('dailyLossAction', 'ALL')));
ALTER TABLE "core_risk_limits" ADD CONSTRAINT "core_risk_limits_value_check" CHECK (
    CASE
      WHEN "key" IN ('lastEntryTime', 'squareOffTime') THEN "numValue" IS NULL AND "textValue" IS NOT NULL AND "textValue" ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'
      WHEN "key" = 'dailyLossAction' THEN "numValue" IS NULL AND "textValue" IS NOT NULL AND "textValue" IN ('BLOCK_ENTRIES', 'BLOCK_AND_SQUARE_OFF')
      ELSE "textValue" IS NULL AND "numValue" IS NOT NULL AND "numValue" >= 0 AND "numValue" <> 'NaN'::numeric
           AND ("key" NOT IN ('maxTradesPerDay', 'maxOpenPositions', 'mtfMaxHoldDays') OR "numValue" = trunc("numValue"))
           AND ("key" <> 'mtfMaxLeverage' OR "numValue" >= 1)
    END);
ALTER TABLE "core_risk_limits" ADD CONSTRAINT "core_risk_limits_source_check"
    CHECK ("source" IN ('USER', 'USER_SETTINGS', 'DEFAULT'));
ALTER TABLE "core_risk_limits" ADD CONSTRAINT "core_risk_limits_reason_check"
    CHECK (length(btrim("reason")) > 0);

ALTER TABLE "core_risk_limit_defaults" ADD CONSTRAINT "core_risk_limit_defaults_pair_check" CHECK (("key", "scope") IN (
    ('maxDailyLoss', 'ALL'), ('maxDailyLossPerStrategy', 'ALL'), ('maxTradesPerDay', 'ALL'),
    ('maxOpenPositions', 'ALL'), ('maxOpenPositions', 'CASH_INTRADAY'), ('maxOpenPositions', 'MTF'), ('maxOpenPositions', 'OPTIONS_BUY'),
    ('maxRiskPerTrade', 'ALL'),
    ('maxCapitalDeployed', 'CASH_INTRADAY'), ('maxCapitalDeployed', 'MTF'), ('maxCapitalDeployed', 'OPTIONS_BUY'),
    ('mtfMaxLeverage', 'MTF'), ('mtfMaxHoldDays', 'MTF'), ('optionsMaxPremiumPerTrade', 'OPTIONS_BUY'),
    ('lastEntryTime', 'CASH_INTRADAY'), ('lastEntryTime', 'MTF'), ('lastEntryTime', 'OPTIONS_BUY'),
    ('squareOffTime', 'CASH_INTRADAY'), ('squareOffTime', 'MTF'), ('squareOffTime', 'OPTIONS_BUY'),
    ('dailyLossAction', 'ALL')));
ALTER TABLE "core_risk_limit_defaults" ADD CONSTRAINT "core_risk_limit_defaults_value_check" CHECK (
    CASE
      WHEN "key" IN ('lastEntryTime', 'squareOffTime') THEN "numValue" IS NULL AND "textValue" IS NOT NULL AND "textValue" ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'
      WHEN "key" = 'dailyLossAction' THEN "numValue" IS NULL AND "textValue" IS NOT NULL AND "textValue" IN ('BLOCK_ENTRIES', 'BLOCK_AND_SQUARE_OFF')
      ELSE "textValue" IS NULL AND "numValue" IS NOT NULL AND "numValue" >= 0 AND "numValue" <> 'NaN'::numeric
           AND ("key" NOT IN ('maxTradesPerDay', 'maxOpenPositions', 'mtfMaxHoldDays') OR "numValue" = trunc("numValue"))
           AND ("key" <> 'mtfMaxLeverage' OR "numValue" >= 1)
    END);

ALTER TABLE "core_kill_switch" ADD CONSTRAINT "core_kill_switch_reason_check"
    CHECK (length(btrim("reason")) > 0);

-- Append-only (plan decision 12). UPDATE is refused; DELETE stays possible only so
-- deleting a user cascades. No repository has an update or delete method. M5's
-- core_journal can reuse this function.
CREATE OR REPLACE FUNCTION core_append_only_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION '%: rows are append-only; insert a new row instead', TG_TABLE_NAME;
END;
$$;

CREATE TRIGGER "core_risk_limits_append_only"
    BEFORE UPDATE ON "core_risk_limits"
    FOR EACH ROW EXECUTE FUNCTION core_append_only_guard();

CREATE TRIGGER "core_kill_switch_append_only"
    BEFORE UPDATE ON "core_kill_switch"
    FOR EACH ROW EXECUTE FUNCTION core_append_only_guard();

-- SEED BEGIN
-- Seed defaults are data (D4), idempotent (ON CONFLICT DO NOTHING). A user's limit is
-- seeded from user_settings where an equivalent exists, otherwise from this table and
-- shown as "default — please review". Values are proposals listed for the owner in
-- docs/superpowers/plans/2026-10-10-sp2-m2-risk-wall.md (Owner answers 2026-10-10; the owner edits them on the Core Risk page); sources are
-- checked by core-risk-defaults.spec.ts. Notes contain no apostrophes or semicolons.
INSERT INTO "core_risk_limit_defaults" ("key", "scope", "numValue", "textValue", "note") VALUES
    ('maxDailyLoss', 'ALL', 5000.00, NULL, 'user_settings.maxDailyLoss column default (schema.prisma:405), used when the user has no settings row'),
    ('maxDailyLossPerStrategy', 'ALL', 2500.00, NULL, 'half of the maxDailyLoss default, no existing equivalent'),
    ('maxTradesPerDay', 'ALL', 20, NULL, 'no existing equivalent'),
    ('maxOpenPositions', 'ALL', 5, NULL, 'user_settings.maxConcurrentPositions column default (schema.prisma:407), used when the user has no settings row'),
    ('maxOpenPositions', 'CASH_INTRADAY', 5, NULL, 'equal to the total default, no existing equivalent'),
    ('maxOpenPositions', 'MTF', 3, NULL, 'no existing equivalent'),
    ('maxOpenPositions', 'OPTIONS_BUY', 2, NULL, 'no existing equivalent'),
    ('maxRiskPerTrade', 'ALL', 3000.00, NULL, 'Ungated v1 risks 200000 x 1.5 percent = 3000 per trade, Adaptive-Stop v1 risks 800'),
    ('maxCapitalDeployed', 'CASH_INTRADAY', 1000000.00, NULL, 'five Ungated-sized positions of 200000, no existing equivalent'),
    ('maxCapitalDeployed', 'MTF', 200000.00, NULL, 'no existing equivalent'),
    ('maxCapitalDeployed', 'OPTIONS_BUY', 100000.00, NULL, 'no existing equivalent'),
    ('mtfMaxLeverage', 'MTF', 2.00, NULL, 'no existing equivalent'),
    ('mtfMaxHoldDays', 'MTF', 10, NULL, 'no existing equivalent'),
    ('optionsMaxPremiumPerTrade', 'OPTIONS_BUY', 50000.00, NULL, 'user_settings.maxCapitalPerTrade column default (schema.prisma:406), used when the user has no settings row'),
    ('lastEntryTime', 'CASH_INTRADAY', NULL, '15:00', 'the 15:00 IST entry cutoff of the silos (common/utils/market-hours.ts:22)'),
    ('lastEntryTime', 'MTF', NULL, '15:00', 'the 15:00 IST entry cutoff of the silos (common/utils/market-hours.ts:22)'),
    ('lastEntryTime', 'OPTIONS_BUY', NULL, '14:30', 'no existing equivalent'),
    ('squareOffTime', 'CASH_INTRADAY', NULL, '15:25', 'the Ungated EOD square-off (ungated-tick-poller.service.ts:94), so Ungated v1 keeps its own 15:25 exit and Adaptive-Stop its 15:15'),
    ('squareOffTime', 'MTF', NULL, '15:20', 'no existing equivalent, applies to MTF forced exits'),
    ('squareOffTime', 'OPTIONS_BUY', NULL, '15:15', 'no existing equivalent'),
    ('dailyLossAction', 'ALL', NULL, 'BLOCK_ENTRIES', 'spec 5.3 base behaviour: entries blocked, open positions keep their stops')
ON CONFLICT ("key", "scope") DO NOTHING;
-- SEED END
