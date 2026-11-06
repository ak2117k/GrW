-- FLOOR_BROKER_SL (2026-11-06): a STOPLOSS-LIMIT resting at Angel at the armed noise floor, trailed up as the
-- floor rises (sentinel-executor floor-broker-sl). One row per action taken (live) or that WOULD have been
-- taken (shadow, the default), plus one EXIT_COMPARE per exited position: the stop's simulated fill on
-- candles_1m vs the real exit. Written only by sentinel-executor. No FK.
-- Expand-only: one new table, nothing altered.
CREATE TABLE "floor_broker_sl_events" (
    "id" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "user_id" TEXT NOT NULL,
    "tracker_id" TEXT NOT NULL,
    "symbol" TEXT NOT NULL,
    "exchange" TEXT NOT NULL,
    "token" TEXT NOT NULL,
    "mode" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "reason" TEXT,
    "side" TEXT,
    "trigger_price" DOUBLE PRECISION,
    "limit_price" DOUBLE PRECISION,
    "prev_trigger_price" DOUBLE PRECISION,
    "quantity" INTEGER,
    "product_type" TEXT,
    "floor_price" DOUBLE PRECISION,
    "ltp" DOUBLE PRECISION,
    "order_tag" TEXT,
    "broker_order_id" TEXT,
    "broker_status" TEXT,
    "broker_message" TEXT,
    "exit_price" DOUBLE PRECISION,
    "exit_at" TIMESTAMPTZ(6),
    "would_fill_price" DOUBLE PRECISION,
    "would_fill_limit" DOUBLE PRECISION,
    "would_trigger_at" TIMESTAMPTZ(6),
    "saved_rupees" DOUBLE PRECISION,
    "detail" JSONB,

    CONSTRAINT "floor_broker_sl_events_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "floor_broker_sl_events_tracker_id_created_at_idx" ON "floor_broker_sl_events"("tracker_id", "created_at");
CREATE INDEX "floor_broker_sl_events_action_created_at_idx" ON "floor_broker_sl_events"("action", "created_at");
CREATE INDEX "floor_broker_sl_events_user_id_created_at_idx" ON "floor_broker_sl_events"("user_id", "created_at");
