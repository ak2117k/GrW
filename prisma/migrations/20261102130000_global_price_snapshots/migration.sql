-- Pre-open outlook (owner 2026-11-02): "crude is ~400 points down; we should have predicted this in the night".
--
-- global_price_snapshots: the overnight global price input (Yahoo Finance public chart endpoint; WTI CL=F,
-- Brent BZ=F, S&P 500 futures ES=F), every 30 min including weekends. One row per (symbol, source price
-- time): a repeat of the same quote (weekend, US holiday) is not stored again. A failed read is a
-- status 'NO_DATA' row with the reason and NULL price / price_time (never a zero). `bars` holds the
-- fetched hourly closes ([{t: ms epoch bar open, close}]) so the outlook can fall back to the DB.
CREATE TABLE "global_price_snapshots" (
    "id" TEXT NOT NULL,
    "symbol" TEXT NOT NULL,
    "price" DOUBLE PRECISION,
    "price_time" TIMESTAMPTZ(6),
    "fetched_at" TIMESTAMPTZ(6) NOT NULL,
    "status" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "reason" TEXT,
    "interval_ms" INTEGER,
    "bars" JSONB,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "global_price_snapshots_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "global_price_snapshots_symbol_price_time_key" ON "global_price_snapshots"("symbol", "price_time");
CREATE INDEX "global_price_snapshots_symbol_fetched_at_idx" ON "global_price_snapshots"("symbol", "fetched_at");

-- pre_open_outlooks: one row per underlying per run (08:30 IST cron or GET /api/pre-open-outlook/run).
-- bias BULLISH | BEARISH | NEUTRAL; gap_pct / gap_points the expected open gap; payload the whole outlook
-- (global move, theme, headlines, method). Read by the night report and by the entry engine
-- (a strong bias = the news component in the opening window, still needing trend + OI). No FK.
CREATE TABLE "pre_open_outlooks" (
    "id" TEXT NOT NULL,
    "underlying" TEXT NOT NULL,
    "session_date" DATE NOT NULL,
    "at" TIMESTAMPTZ(6) NOT NULL,
    "bias" TEXT NOT NULL,
    "confidence" DOUBLE PRECISION NOT NULL,
    "score" DOUBLE PRECISION NOT NULL,
    "gap_pct" DOUBLE PRECISION,
    "gap_points" DOUBLE PRECISION,
    "last_close" DOUBLE PRECISION,
    "payload" JSONB NOT NULL,
    "summary" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "pre_open_outlooks_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "pre_open_outlooks_underlying_session_date_at_idx" ON "pre_open_outlooks"("underlying", "session_date", "at");
CREATE INDEX "pre_open_outlooks_at_idx" ON "pre_open_outlooks"("at");
