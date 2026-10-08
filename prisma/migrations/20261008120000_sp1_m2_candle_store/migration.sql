-- SP1 M2 — market hub CandleStore (docs/superpowers/specs/2026-10-05-sp1-market-data-hub-design.md §6).
--
-- Plain tables only. TimescaleDB setup (hypertable, compression, 180-day
-- retention for candles_1m) is NOT done here: the deploy step applies
-- deploy/sql/candles-timescale.sql after every migrate (idempotent, a no-op
-- without the full-licence extension). A migration runs once, where it is first
-- applied, and _prisma_migrations travels with a pg_dump restore, so a
-- migration-side DO block would never run on the database we restore into.
-- Expand-only: creates tables, drops nothing.

CREATE TABLE "candles_1m" (
    "exchange" TEXT NOT NULL,
    "token" TEXT NOT NULL,
    "ts" TIMESTAMPTZ(3) NOT NULL,
    "open" DOUBLE PRECISION NOT NULL,
    "high" DOUBLE PRECISION NOT NULL,
    "low" DOUBLE PRECISION NOT NULL,
    "close" DOUBLE PRECISION NOT NULL,
    "volume" BIGINT NOT NULL DEFAULT 0,
    "oi" BIGINT,
    "source" TEXT NOT NULL,

    CONSTRAINT "candles_1m_pkey" PRIMARY KEY ("exchange","token","ts")
);

CREATE TABLE "candles_1h" (
    "exchange" TEXT NOT NULL,
    "token" TEXT NOT NULL,
    "ts" TIMESTAMPTZ(3) NOT NULL,
    "open" DOUBLE PRECISION NOT NULL,
    "high" DOUBLE PRECISION NOT NULL,
    "low" DOUBLE PRECISION NOT NULL,
    "close" DOUBLE PRECISION NOT NULL,
    "volume" BIGINT NOT NULL DEFAULT 0,

    CONSTRAINT "candles_1h_pkey" PRIMARY KEY ("exchange","token","ts")
);

CREATE TABLE "candles_1d" (
    "exchange" TEXT NOT NULL,
    "token" TEXT NOT NULL,
    "ts" TIMESTAMPTZ(3) NOT NULL,
    "open" DOUBLE PRECISION NOT NULL,
    "high" DOUBLE PRECISION NOT NULL,
    "low" DOUBLE PRECISION NOT NULL,
    "close" DOUBLE PRECISION NOT NULL,
    "volume" BIGINT NOT NULL DEFAULT 0,

    CONSTRAINT "candles_1d_pkey" PRIMARY KEY ("exchange","token","ts")
);

CREATE TABLE "candle_coverage" (
    "exchange" TEXT NOT NULL,
    "token" TEXT NOT NULL,
    "tf" TEXT NOT NULL,
    "day" DATE NOT NULL,
    "fetched_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "candle_coverage_pkey" PRIMARY KEY ("exchange","token","tf","day")
);
