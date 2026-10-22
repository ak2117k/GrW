-- Next-morning trade setups (advisory only) + last-known broker margin. Expand-only: two new tables.

-- CreateTable
CREATE TABLE "trade_setups" (
    "id" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    "user_id" TEXT NOT NULL,
    "session_date" TEXT NOT NULL,
    "symbol" TEXT NOT NULL,
    "exchange" TEXT NOT NULL,
    "instrument" TEXT NOT NULL,
    "instrument_kind" TEXT NOT NULL,
    "instrument_token" TEXT,
    "expiry" TEXT,
    "lot_size" INTEGER,
    "side" TEXT NOT NULL,
    "news_idea_id" TEXT,
    "entry_rule" TEXT NOT NULL,
    "entry_ref" DOUBLE PRECISION NOT NULL,
    "stop" DOUBLE PRECISION NOT NULL,
    "stop_distance" DOUBLE PRECISION NOT NULL,
    "target1" DOUBLE PRECISION NOT NULL,
    "target2" DOUBLE PRECISION NOT NULL,
    "atr" DOUBLE PRECISION NOT NULL,
    "qty" INTEGER NOT NULL,
    "lots" INTEGER,
    "risk_rs" DOUBLE PRECISION NOT NULL,
    "risk_pct" DOUBLE PRECISION NOT NULL,
    "reward_t1_rs" DOUBLE PRECISION NOT NULL,
    "reward_t2_rs" DOUBLE PRECISION NOT NULL,
    "margin_used" DOUBLE PRECISION NOT NULL,
    "margin_available" DOUBLE PRECISION,
    "margin_as_of" TIMESTAMPTZ(6),
    "margin_source" TEXT NOT NULL,
    "exceeds_risk" BOOLEAN NOT NULL DEFAULT false,
    "inputs" JSONB NOT NULL,
    "outcome_status" TEXT,
    "outcome_entry_at" TIMESTAMPTZ(6),
    "outcome_entry_price" DOUBLE PRECISION,
    "outcome_exit_price" DOUBLE PRECISION,
    "outcome_r" DOUBLE PRECISION,
    "outcome_hit_t1" BOOLEAN,
    "outcome_details" JSONB,
    "filled_at" TIMESTAMPTZ(6),

    CONSTRAINT "trade_setups_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "account_margin_snapshots" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "as_of" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "available_cash" DOUBLE PRECISION NOT NULL,
    "net" DOUBLE PRECISION,

    CONSTRAINT "account_margin_snapshots_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "trade_setups_user_id_session_date_symbol_key" ON "trade_setups"("user_id", "session_date", "symbol");

-- CreateIndex
CREATE INDEX "trade_setups_user_id_session_date_idx" ON "trade_setups"("user_id", "session_date");

-- CreateIndex
CREATE INDEX "account_margin_snapshots_user_id_as_of_idx" ON "account_margin_snapshots"("user_id", "as_of" DESC);
