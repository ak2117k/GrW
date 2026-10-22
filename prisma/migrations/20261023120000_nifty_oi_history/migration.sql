-- Past intraday OI of live NIFTY futures + options (Angel getOIData backfill) and the backfill's
-- per-contract progress. Expand-only: two new tables, nothing altered or dropped.

-- CreateTable
CREATE TABLE "nifty_oi_history" (
    "token" TEXT NOT NULL,
    "symbol" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "expiry" DATE NOT NULL,
    "strike" DOUBLE PRECISION,
    "interval" TEXT NOT NULL,
    "ts" TIMESTAMPTZ(6) NOT NULL,
    "oi" DOUBLE PRECISION NOT NULL,

    CONSTRAINT "nifty_oi_history_pkey" PRIMARY KEY ("token","interval","ts")
);

-- CreateTable
CREATE TABLE "nifty_oi_backfill_progress" (
    "token" TEXT NOT NULL,
    "interval" TEXT NOT NULL,
    "symbol" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "expiry" DATE NOT NULL,
    "strike" DOUBLE PRECISION,
    "cursor" TIMESTAMPTZ(6),
    "covered_to" TIMESTAMPTZ(6),
    "empty_streak" INTEGER NOT NULL DEFAULT 0,
    "done" BOOLEAN NOT NULL DEFAULT false,
    "earliest_ts" TIMESTAMPTZ(6),
    "latest_ts" TIMESTAMPTZ(6),
    "rows" INTEGER NOT NULL DEFAULT 0,
    "calls" INTEGER NOT NULL DEFAULT 0,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "nifty_oi_backfill_progress_pkey" PRIMARY KEY ("token","interval")
);

-- CreateIndex
CREATE INDEX "nifty_oi_history_expiry_kind_ts_idx" ON "nifty_oi_history"("expiry", "kind", "ts");
