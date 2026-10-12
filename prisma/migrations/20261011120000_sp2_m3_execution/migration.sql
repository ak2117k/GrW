-- SP2 M3 — paper execution: orders, fills, cash ledger, paper defaults
-- (docs/superpowers/specs/2026-10-11-sp2-m3-execution-design.md §4.5).
--
-- Expand-only: four new tables, CHECK constraints, two append-only triggers (reusing
-- M2's core_append_only_guard()) and 14 seed default rows. Drops and alters nothing
-- that exists.

CREATE TABLE "core_orders" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "idempotencyKey" TEXT NOT NULL,
    "vehicle" TEXT NOT NULL,
    "exchange" TEXT NOT NULL,
    "token" TEXT NOT NULL,
    "symbol" TEXT NOT NULL,
    "lotSize" INTEGER NOT NULL,
    "underlying" TEXT,
    "side" TEXT NOT NULL,
    "qty" INTEGER NOT NULL,
    "filledQty" INTEGER NOT NULL DEFAULT 0,
    "avgFillPrice" DECIMAL(14,4),
    "type" TEXT NOT NULL,
    "limitPrice" DECIMAL(14,2),
    "triggerPrice" DECIMAL(14,2),
    "refPrice" DECIMAL(14,2) NOT NULL,
    "purpose" TEXT NOT NULL,
    "strategyVersionId" TEXT,
    "state" TEXT NOT NULL,
    "rejectReason" TEXT,
    "submittedAt" TIMESTAMP(3) NOT NULL,
    -- Ruling P10: set once when an SL_MARKET order's trigger is reached; never cleared.
    "triggered_at" TIMESTAMP(3),
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "core_orders_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "core_fills" (
    "id" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "price" DECIMAL(14,4) NOT NULL,
    "qty" INTEGER NOT NULL,
    "charges" JSONB NOT NULL,
    "chargesTotal" DECIMAL(14,2) NOT NULL,
    "priceAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "core_fills_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "core_cash_ledger" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "amount" DECIMAL(14,2) NOT NULL,
    "orderId" TEXT,
    "fillId" TEXT,
    "token" TEXT,
    "interestDate" DATE,
    "note" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "core_cash_ledger_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "core_paper_defaults" (
    "key" TEXT NOT NULL,
    "scope" TEXT NOT NULL,
    "numValue" DECIMAL(14,2) NOT NULL,
    "note" TEXT NOT NULL,
    "updatedBy" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "core_paper_defaults_pkey" PRIMARY KEY ("key","scope")
);

CREATE UNIQUE INDEX "core_orders_idempotencyKey_key" ON "core_orders"("idempotencyKey");
CREATE INDEX "core_orders_userId_state_idx" ON "core_orders"("userId", "state");
CREATE INDEX "core_orders_state_idx" ON "core_orders"("state");
CREATE INDEX "core_orders_userId_vehicle_token_idx" ON "core_orders"("userId", "vehicle", "token");
CREATE INDEX "core_fills_userId_createdAt_idx" ON "core_fills"("userId", "createdAt");
CREATE INDEX "core_fills_orderId_idx" ON "core_fills"("orderId");
CREATE UNIQUE INDEX "core_cash_ledger_userId_token_interestDate_key" ON "core_cash_ledger"("userId", "token", "interestDate");
CREATE INDEX "core_cash_ledger_userId_createdAt_idx" ON "core_cash_ledger"("userId", "createdAt");
CREATE INDEX "core_cash_ledger_orderId_idx" ON "core_cash_ledger"("orderId");

ALTER TABLE "core_orders" ADD CONSTRAINT "core_orders_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "core_fills" ADD CONSTRAINT "core_fills_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "core_orders"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "core_fills" ADD CONSTRAINT "core_fills_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "core_cash_ledger" ADD CONSTRAINT "core_cash_ledger_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "core_cash_ledger" ADD CONSTRAINT "core_cash_ledger_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "core_orders"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "core_cash_ledger" ADD CONSTRAINT "core_cash_ledger_fillId_fkey" FOREIGN KEY ("fillId") REFERENCES "core_fills"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Vocabularies and shapes (Prisma models them as String/Int/Decimal; its diff ignores CHECKs).
-- A REJECTED order keeps what was asked, so the lot-multiple rule binds only the others.
ALTER TABLE "core_orders" ADD CONSTRAINT "core_orders_vocab_check" CHECK (
    "vehicle" IN ('CASH_INTRADAY', 'MTF', 'OPTIONS_BUY')
    AND "side" IN ('BUY', 'SELL')
    AND "type" IN ('MARKET', 'LIMIT', 'SL_MARKET')
    AND "purpose" IN ('ENTRY', 'EXIT')
    AND "state" IN ('NEW', 'OPEN', 'PARTIAL', 'FILLED', 'CANCELLED', 'REJECTED'));
ALTER TABLE "core_orders" ADD CONSTRAINT "core_orders_shape_check" CHECK (
    "qty" > 0 AND "lotSize" > 0 AND "refPrice" > 0
    AND "filledQty" >= 0 AND "filledQty" <= "qty"
    AND ("state" = 'REJECTED' OR "qty" % "lotSize" = 0)
    AND ("type" <> 'LIMIT' OR ("limitPrice" IS NOT NULL AND "limitPrice" > 0))
    AND ("type" <> 'SL_MARKET' OR ("triggerPrice" IS NOT NULL AND "triggerPrice" > 0))
    AND ("state" <> 'FILLED' OR "filledQty" = "qty")
    AND ("state" <> 'REJECTED' OR length(btrim(coalesce("rejectReason", ''))) > 0));

ALTER TABLE "core_fills" ADD CONSTRAINT "core_fills_shape_check" CHECK (
    "qty" > 0 AND "price" > 0 AND "chargesTotal" >= 0);

-- Ledger signs (ledger-math.ts balances() relies on them) and links.
ALTER TABLE "core_cash_ledger" ADD CONSTRAINT "core_cash_ledger_type_check" CHECK (
    CASE "type"
      WHEN 'DEPOSIT' THEN "amount" > 0
      WHEN 'MARGIN_BLOCK' THEN "amount" < 0 AND "orderId" IS NOT NULL
      WHEN 'MARGIN_RELEASE' THEN "amount" > 0 AND "orderId" IS NOT NULL
      WHEN 'CHARGES' THEN "amount" < 0 AND "fillId" IS NOT NULL
      WHEN 'REALISED_PNL' THEN "fillId" IS NOT NULL
      WHEN 'MTF_INTEREST' THEN "amount" <= 0 AND "token" IS NOT NULL
      ELSE false
    END);
ALTER TABLE "core_cash_ledger" ADD CONSTRAINT "core_cash_ledger_interest_date_check" CHECK (
    ("type" = 'MTF_INTEREST') = ("interestDate" IS NOT NULL));
ALTER TABLE "core_cash_ledger" ADD CONSTRAINT "core_cash_ledger_note_check" CHECK (length(btrim("note")) > 0);

-- The fixed pairs must equal REQUIRED_PAPER_PAIRS in paper-settings.ts (core-paper-defaults.spec.ts
-- checks it); maxLotsPerOrder is scoped by any upper-case underlying name (E4).
ALTER TABLE "core_paper_defaults" ADD CONSTRAINT "core_paper_defaults_pair_check" CHECK (
    ("key", "scope") IN (
      ('startingCapital', 'ALL'), ('intradayLeverage', 'CASH_INTRADAY'),
      ('slippageBps', 'CASH_INTRADAY'), ('slippageBps', 'MTF'), ('slippageBps', 'OPTIONS_BUY'),
      ('noPriceRejectMs', 'ALL'), ('mtfFundedShare', 'MTF'), ('mtfAnnualRatePct', 'MTF'), ('mtfPledgeFee', 'MTF'))
    OR ("key" = 'maxLotsPerOrder' AND "scope" ~ '^[A-Z0-9&-]{1,30}$' AND "scope" NOT IN ('ALL', 'CASH_INTRADAY', 'MTF', 'OPTIONS_BUY')));
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
      ELSE false
    END);
ALTER TABLE "core_paper_defaults" ADD CONSTRAINT "core_paper_defaults_note_check" CHECK (length(btrim("note")) > 0);

-- Append-only (spec §4.5). UPDATE is refused; DELETE stays possible only so deleting a
-- user (or its orders) cascades. No repository has an update or delete method for these.
CREATE TRIGGER "core_fills_append_only"
    BEFORE UPDATE ON "core_fills"
    FOR EACH ROW EXECUTE FUNCTION core_append_only_guard();

CREATE TRIGGER "core_cash_ledger_append_only"
    BEFORE UPDATE ON "core_cash_ledger"
    FOR EACH ROW EXECUTE FUNCTION core_append_only_guard();

-- SEED BEGIN
-- Paper defaults are data (D4), idempotent (ON CONFLICT DO NOTHING) and owner-editable
-- (PUT /api/trade-core/paper/defaults/:key/:scope). E1/E2 are owner decisions; every other
-- value is a placeholder listed for review in docs/superpowers/plans/2026-10-11-sp2-m3-execution.md.
-- Notes contain no apostrophes or semicolons.
INSERT INTO "core_paper_defaults" ("key", "scope", "numValue", "note") VALUES
    ('startingCapital', 'ALL', 1000000.00, 'owner decision E1 (2026-10-11): starting paper capital per user'),
    ('intradayLeverage', 'CASH_INTRADAY', 5.00, 'owner decision E2 (2026-10-11): cash intraday margin is notional / 5'),
    ('slippageBps', 'CASH_INTRADAY', 5.00, 'default — please review: used only when a price has no depth, the wide end of large-cap NSE spreads'),
    ('slippageBps', 'MTF', 5.00, 'default — please review: same NSE equities as cash intraday'),
    ('slippageBps', 'OPTIONS_BUY', 50.00, 'default — please review: option spreads of 0.05 to 0.10 on premiums of 20 to 200, the wide end'),
    ('noPriceRejectMs', 'ALL', 30000, 'default — please review: twice the 15 s freshness window'),
    ('mtfFundedShare', 'MTF', 0.50, 'default — please review: placeholder, 2x leverage like the M2 mtfMaxLeverage default, verify the Angel One funded share'),
    ('mtfAnnualRatePct', 'MTF', 18.00, 'default — please review: placeholder at the high end of advertised MTF rates, verify the Angel One rate'),
    ('mtfPledgeFee', 'MTF', 23.60, 'default — please review: placeholder 20 plus 18 percent GST per MTF buy order, verify the Angel One pledge charge'),
    ('maxLotsPerOrder', 'NIFTY', 10, 'default — please review: owner cap per order (E4), not an NSE freeze quantity'),
    ('maxLotsPerOrder', 'BANKNIFTY', 10, 'default — please review: owner cap per order (E4), not an NSE freeze quantity'),
    ('maxLotsPerOrder', 'FINNIFTY', 10, 'default — please review: owner cap per order (E4), not an NSE freeze quantity'),
    ('maxLotsPerOrder', 'MIDCPNIFTY', 10, 'default — please review: owner cap per order (E4), not an NSE freeze quantity'),
    ('maxLotsPerOrder', 'SENSEX', 10, 'default — please review: owner cap per order (E4), not an NSE freeze quantity, inert until BFO is a core venue')
ON CONFLICT ("key", "scope") DO NOTHING;
-- SEED END
