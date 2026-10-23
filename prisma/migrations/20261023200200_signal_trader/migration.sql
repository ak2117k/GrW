-- Telegram signal trading (stream X, signal-trader): decisions + live entry orders. ADD only.
-- docs/superpowers/plans/2026-10-23-telegram-signals-contract.md

-- CreateTable
CREATE TABLE "signal_decisions" (
    "id" TEXT NOT NULL,
    "signal_id" TEXT NOT NULL,
    "evaluation" INTEGER NOT NULL DEFAULT 1,
    "cluster_id" TEXT,
    "channel_id" TEXT,
    "user_id" TEXT,
    "underlying" TEXT,
    "decided_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "mode" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "agree_count" INTEGER,
    "conflict" BOOLEAN,
    "gate" JSONB,
    "judge" JSONB,
    "plan" JSONB,
    "decision" TEXT,
    "skip_reason" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "signal_decisions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "signal_orders" (
    "id" TEXT NOT NULL,
    "decision_id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "exchange" TEXT NOT NULL,
    "token" TEXT NOT NULL,
    "tradingsymbol" TEXT NOT NULL,
    "qty" INTEGER NOT NULL,
    "lots" INTEGER,
    "side" TEXT NOT NULL,
    "order_type" TEXT NOT NULL,
    "product_type" TEXT NOT NULL,
    "limit_price" DOUBLE PRECISION NOT NULL,
    "sl" DOUBLE PRECISION NOT NULL,
    "targets" JSONB NOT NULL,
    "order_tag" TEXT NOT NULL,
    "broker_order_id" TEXT,
    "status" TEXT NOT NULL,
    "status_reason" TEXT,
    "fill_price" DOUBLE PRECISION,
    "fill_qty" INTEGER,
    "filled_at" TIMESTAMPTZ(6),
    "tracker_id" TEXT,
    "sl_verdict_id" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "signal_orders_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "signal_decisions_signal_id_evaluation_key" ON "signal_decisions"("signal_id", "evaluation");
CREATE INDEX "signal_decisions_decided_at_idx" ON "signal_decisions"("decided_at");
CREATE INDEX "signal_decisions_cluster_id_idx" ON "signal_decisions"("cluster_id");
CREATE UNIQUE INDEX "signal_orders_decision_id_key" ON "signal_orders"("decision_id");
CREATE INDEX "signal_orders_created_at_idx" ON "signal_orders"("created_at");
CREATE INDEX "signal_orders_status_idx" ON "signal_orders"("status");
CREATE INDEX "signal_orders_token_status_idx" ON "signal_orders"("token", "status");
