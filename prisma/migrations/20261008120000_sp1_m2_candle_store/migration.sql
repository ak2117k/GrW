-- SP1 M2 — market hub CandleStore (docs/superpowers/specs/2026-10-05-sp1-market-data-hub-design.md §6).
--
-- WHY the TimescaleDB block is guarded: production runs on Neon until the VPS
-- move, and Neon offers only TimescaleDB's Apache-licensed subset (no
-- compression, no retention policies). The same migration must succeed there
-- (plain tables) and on the VPS's timescale/timescaledb image (hypertable +
-- compression + 180-day retention). Expand-only: creates tables, drops nothing.
--
-- create_default_indexes => FALSE: the primary key (exchange, token, ts) already
-- serves every query, and an extra ts index would show up as Prisma schema drift.

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

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_available_extensions WHERE name = 'timescaledb') THEN
    BEGIN
      CREATE EXTENSION IF NOT EXISTS timescaledb;
      PERFORM create_hypertable('candles_1m', 'ts',
        chunk_time_interval => INTERVAL '7 days',
        create_default_indexes => FALSE,
        if_not_exists => TRUE);
      IF current_setting('timescaledb.license', TRUE) = 'timescale' THEN
        ALTER TABLE "candles_1m" SET (
          timescaledb.compress,
          timescaledb.compress_segmentby = 'exchange, token',
          timescaledb.compress_orderby = 'ts');
        PERFORM add_compression_policy('candles_1m', INTERVAL '7 days', if_not_exists => TRUE);
        PERFORM add_retention_policy('candles_1m', INTERVAL '180 days', if_not_exists => TRUE);
      ELSE
        RAISE NOTICE 'timescaledb is Apache-licensed here: candles_1m is a hypertable without compression or retention';
      END IF;
    EXCEPTION WHEN OTHERS THEN
      RAISE NOTICE 'timescaledb unavailable (%): candles_1m stays a plain table', SQLERRM;
    END;
  ELSE
    RAISE NOTICE 'timescaledb not installed: candles_1m stays a plain table';
  END IF;
END
$$;
