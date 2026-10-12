-- SP2 M4 — lifecycle: core positions (docs/superpowers/plans/2026-10-12-sp2-m4-lifecycle.md).
--
-- Expand-only: one new table, one nullable column (+ index, FK) on core_orders (empty in
-- production: nothing places core orders before M5), the two core_paper_defaults CHECKs
-- widened by one optional pair (dropped and re-added in this transaction), and one seed
-- row. No table, column or function is dropped or redefined.

CREATE TABLE "core_positions" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "intentId" TEXT NOT NULL,
    "strategyId" TEXT NOT NULL,
    "strategyVersionId" TEXT NOT NULL,
    "vehicle" TEXT NOT NULL,
    "exchange" TEXT NOT NULL,
    "token" TEXT NOT NULL,
    "symbol" TEXT NOT NULL,
    "lotSize" INTEGER NOT NULL,
    "underlying" TEXT NOT NULL,
    "side" TEXT NOT NULL,
    "direction" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "requestedQty" INTEGER NOT NULL,
    "entryFilledQty" INTEGER NOT NULL DEFAULT 0,
    "exitFilledQty" INTEGER NOT NULL DEFAULT 0,
    "entryAvgPrice" DECIMAL(14,4),
    "plan" JSONB NOT NULL,
    "initialStopPrice" DECIMAL(14,4),
    "stopPrice" DECIMAL(14,4),
    "targetPrice" DECIMAL(14,4),
    "partialPrice" DECIMAL(14,4),
    "partialQty" INTEGER NOT NULL DEFAULT 0,
    "trailActive" BOOLEAN NOT NULL DEFAULT false,
    "partialDone" BOOLEAN NOT NULL DEFAULT false,
    "highWater" DECIMAL(14,4),
    "lowWater" DECIMAL(14,4),
    "exitSeq" INTEGER NOT NULL DEFAULT 0,
    "exitReason" TEXT,
    "blindSince" TIMESTAMP(3),
    "openedAt" TIMESTAMP(3),
    "closedAt" TIMESTAMP(3),
    "version" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "core_positions_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "core_positions_intentId_key" ON "core_positions"("intentId");
CREATE INDEX "core_positions_userId_status_idx" ON "core_positions"("userId", "status");
CREATE INDEX "core_positions_status_idx" ON "core_positions"("status");
CREATE INDEX "core_positions_userId_vehicle_token_idx" ON "core_positions"("userId", "vehicle", "token");
ALTER TABLE "core_positions" ADD CONSTRAINT "core_positions_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "core_orders" ADD COLUMN "positionId" TEXT;
CREATE INDEX "core_orders_userId_positionId_idx" ON "core_orders"("userId", "positionId");
ALTER TABLE "core_orders" ADD CONSTRAINT "core_orders_positionId_fkey" FOREIGN KEY ("positionId") REFERENCES "core_positions"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Vocabularies and shapes (lifecycle.types.ts; lifecycle-defaults.spec.ts checks the lists).
ALTER TABLE "core_positions" ADD CONSTRAINT "core_positions_vocab_check" CHECK (
    "vehicle" IN ('CASH_INTRADAY', 'MTF', 'OPTIONS_BUY')
    AND "side" IN ('BUY', 'SELL')
    AND "direction" IN ('LONG', 'SHORT')
    AND "status" IN ('PENDING_ENTRY', 'OPEN', 'PARTIAL', 'EXITING', 'CLOSED', 'CANCELLED')
    AND ("exitReason" IS NULL OR "exitReason" IN ('KILL_SWITCH', 'DAILY_LOSS', 'STOP', 'GAP_STOP', 'RECOVERY_STOP', 'UNDERLYING_STOP', 'GUARD_RAIL', 'MANUAL', 'TARGET', 'TRAIL', 'TIME_EXIT', 'THETA_STOP', 'EXPIRY_DAY', 'HOLD_LIMIT', 'SQUARE_OFF')));
ALTER TABLE "core_positions" ADD CONSTRAINT "core_positions_shape_check" CHECK (
    "requestedQty" > 0 AND "lotSize" > 0 AND "requestedQty" % "lotSize" = 0
    AND "entryFilledQty" >= 0 AND "entryFilledQty" <= "requestedQty"
    AND "exitFilledQty" >= 0 AND "exitFilledQty" <= "entryFilledQty"
    AND "partialQty" >= 0 AND "exitSeq" >= 0 AND "version" >= 0
    AND (("status" IN ('CLOSED', 'CANCELLED')) = ("closedAt" IS NOT NULL)));

-- core_paper_defaults: one optional pair, blindAfterMs@ALL (ruling L10). The fixed pairs are
-- copied unchanged from 20261011120000_sp2_m3_execution.
ALTER TABLE "core_paper_defaults" DROP CONSTRAINT "core_paper_defaults_pair_check";
ALTER TABLE "core_paper_defaults" ADD CONSTRAINT "core_paper_defaults_pair_check" CHECK (
    ("key", "scope") IN (
      ('startingCapital', 'ALL'), ('intradayLeverage', 'CASH_INTRADAY'),
      ('slippageBps', 'CASH_INTRADAY'), ('slippageBps', 'MTF'), ('slippageBps', 'OPTIONS_BUY'),
      ('noPriceRejectMs', 'ALL'), ('mtfFundedShare', 'MTF'), ('mtfAnnualRatePct', 'MTF'), ('mtfPledgeFee', 'MTF'),
      ('blindAfterMs', 'ALL'))
    OR ("key" = 'maxLotsPerOrder' AND "scope" ~ '^[A-Z0-9&-]{1,30}$' AND "scope" NOT IN ('ALL', 'CASH_INTRADAY', 'MTF', 'OPTIONS_BUY')));
ALTER TABLE "core_paper_defaults" DROP CONSTRAINT "core_paper_defaults_value_check";
ALTER TABLE "core_paper_defaults" ADD CONSTRAINT "core_paper_defaults_value_check" CHECK (
    "numValue" >= 0 AND "numValue" <> 'NaN'::numeric AND
    CASE "key"
      WHEN 'startingCapital' THEN "numValue" > 0
      WHEN 'intradayLeverage' THEN "numValue" >= 1
      WHEN 'slippageBps' THEN "numValue" <= 10000
      WHEN 'noPriceRejectMs' THEN "numValue" >= 1000 AND "numValue" = trunc("numValue")
      WHEN 'mtfFundedShare' THEN "numValue" < 1
      WHEN 'mtfAnnualRatePct' THEN "numValue" <= 100
      WHEN 'mtfPledgeFee' THEN true
      WHEN 'maxLotsPerOrder' THEN "numValue" >= 1 AND "numValue" = trunc("numValue")
      WHEN 'blindAfterMs' THEN "numValue" >= 1000 AND "numValue" = trunc("numValue")
      ELSE false
    END);

-- SEED BEGIN
-- Owner-editable (PUT /api/trade-core/paper/defaults/blindAfterMs/ALL). Listed for review in the M4 plan (O7).
INSERT INTO "core_paper_defaults" ("key", "scope", "numValue", "note") VALUES
    ('blindAfterMs', 'ALL', 30000, 'default — please review: an open core position with no fresh price this long is marked blind (O7)')
ON CONFLICT ("key", "scope") DO NOTHING;
-- SEED END
