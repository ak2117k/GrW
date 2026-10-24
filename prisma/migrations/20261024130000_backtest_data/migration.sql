-- Backtest data store (2026-10-24). Expand-only: five new tables, nothing altered or dropped.
-- Body is `prisma migrate diff` output for schema.prisma, so there is no drift.
-- backtest_bars becomes a compressed TimescaleDB hypertable where the server has the full-licence
-- build: that is done by scripts/backtest-data/load-backtest-data.sh (idempotent), never here.

-- CreateTable
CREATE TABLE "backtest_datasets" (
    "id" SERIAL NOT NULL,
    "symbol" TEXT NOT NULL,
    "exchange" TEXT NOT NULL,
    "interval" TEXT NOT NULL,
    "from_ts" TIMESTAMPTZ(6),
    "to_ts" TIMESTAMPTZ(6),
    "rows" INTEGER NOT NULL DEFAULT 0,
    "source" TEXT NOT NULL,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "backtest_datasets_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "backtest_bars" (
    "dataset_id" INTEGER NOT NULL,
    "ts" TIMESTAMPTZ(6) NOT NULL,
    "open" DOUBLE PRECISION NOT NULL,
    "high" DOUBLE PRECISION NOT NULL,
    "low" DOUBLE PRECISION NOT NULL,
    "close" DOUBLE PRECISION NOT NULL,
    "volume" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "oi" DOUBLE PRECISION,

    CONSTRAINT "backtest_bars_pkey" PRIMARY KEY ("dataset_id","ts")
);

-- CreateTable
CREATE TABLE "backtest_fo_eod" (
    "underlying" TEXT NOT NULL,
    "date" DATE NOT NULL,
    "expiry" DATE NOT NULL,
    "kind" TEXT NOT NULL,
    "strike" REAL NOT NULL,
    "open" REAL NOT NULL,
    "high" REAL NOT NULL,
    "low" REAL NOT NULL,
    "close" REAL NOT NULL,
    "settle" REAL,
    "contracts" INTEGER NOT NULL DEFAULT 0,
    "oi" INTEGER NOT NULL DEFAULT 0,
    "chg_oi" INTEGER NOT NULL DEFAULT 0,
    "undl" REAL,

    CONSTRAINT "backtest_fo_eod_pkey" PRIMARY KEY ("underlying","date","expiry","kind","strike")
);

-- CreateTable
CREATE TABLE "backtest_fetch_jobs" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "symbol" TEXT NOT NULL,
    "exchange" TEXT NOT NULL,
    "interval" TEXT NOT NULL,
    "from_ts" TIMESTAMPTZ(6) NOT NULL,
    "to_ts" TIMESTAMPTZ(6) NOT NULL,
    "status" TEXT NOT NULL,
    "provider" TEXT,
    "calls" INTEGER NOT NULL DEFAULT 0,
    "rows" INTEGER NOT NULL DEFAULT 0,
    "message" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finished_at" TIMESTAMPTZ(6),

    CONSTRAINT "backtest_fetch_jobs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "backtest_ai_requests" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "request_hash" TEXT NOT NULL,
    "prompt" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "progress" JSONB,
    "spec" JSONB,
    "run_id" TEXT,
    "metrics" JSONB,
    "summary" TEXT,
    "error" TEXT,
    "llm_calls" INTEGER NOT NULL DEFAULT 0,
    "cached_from" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "backtest_ai_requests_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "backtest_datasets_symbol_exchange_interval_key" ON "backtest_datasets"("symbol", "exchange", "interval");

-- CreateIndex
CREATE INDEX "backtest_fetch_jobs_created_at_idx" ON "backtest_fetch_jobs"("created_at");

-- CreateIndex
CREATE INDEX "backtest_ai_requests_user_id_created_at_idx" ON "backtest_ai_requests"("user_id", "created_at");

-- CreateIndex
CREATE INDEX "backtest_ai_requests_request_hash_idx" ON "backtest_ai_requests"("request_hash");

-- AddForeignKey
ALTER TABLE "backtest_bars" ADD CONSTRAINT "backtest_bars_dataset_id_fkey" FOREIGN KEY ("dataset_id") REFERENCES "backtest_datasets"("id") ON DELETE CASCADE ON UPDATE CASCADE;

