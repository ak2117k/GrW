-- 2026-11-19: lossless TimescaleDB compression for the two largest plain tables.
--   oi_snapshots  825 MB, 3.1 M rows in 5 weeks (~700 MB/month), no retention (OI_SNAPSHOT_RETENTION_DAYS unset)
--   candles       466 MB, 1.2 M rows since 2025-06
-- Nothing is deleted: rows move into hypertable chunks, and chunks past the policy age are compressed
-- (columnar, lossless). Recent chunks stay row-store, so live inserts / upserts are unaffected.
--
-- RUN BY HAND, OFF-HOURS (after MCX closes, 23:55 IST): migrate_data copies each table into chunks under
-- an exclusive lock (minutes). Needs free disk ≈ the table's size while it runs. Idempotent: every step
-- is skipped when already done. Verify with the before/after checks in docs (row counts + sums).
--
-- Primary keys: a hypertable's unique indexes must include the time column, so (id) becomes
-- (id, "timestamp"). The code never relies on id-uniqueness at the DB level (candles are found by
-- (instrumentId, timeframe, timestamp) first, then updated by that row's id; oi_snapshots are only
-- inserted / range-read / range-deleted). prisma/schema.prisma keeps `@id` on id: migrate deploy
-- applies files only and never diffs, as with candles_1m.

\set ON_ERROR_STOP on

-- ── oi_snapshots ────────────────────────────────────────────────────────────────────────────────
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM timescaledb_information.hypertables WHERE hypertable_name = 'oi_snapshots') THEN
    ALTER TABLE "oi_snapshots" DROP CONSTRAINT "oi_snapshots_pkey";
    ALTER TABLE "oi_snapshots" ADD CONSTRAINT "oi_snapshots_pkey" PRIMARY KEY ("id", "timestamp");
    PERFORM create_hypertable('oi_snapshots', 'timestamp',
      chunk_time_interval => INTERVAL '7 days', migrate_data => TRUE);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM timescaledb_information.hypertables
                 WHERE hypertable_name = 'oi_snapshots' AND compression_enabled) THEN
    ALTER TABLE "oi_snapshots" SET (
      timescaledb.compress,
      timescaledb.compress_segmentby = '"instrumentId"',
      timescaledb.compress_orderby = '"timestamp"');
  END IF;
  PERFORM add_compression_policy('oi_snapshots', INTERVAL '7 days', if_not_exists => TRUE);
END $$;

-- ── candles ─────────────────────────────────────────────────────────────────────────────────────
-- The UNIQUE (instrumentId, timeframe, timestamp) key already includes the time column.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM timescaledb_information.hypertables WHERE hypertable_name = 'candles') THEN
    ALTER TABLE "candles" DROP CONSTRAINT "candles_pkey";
    ALTER TABLE "candles" ADD CONSTRAINT "candles_pkey" PRIMARY KEY ("id", "timestamp");
    PERFORM create_hypertable('candles', 'timestamp',
      chunk_time_interval => INTERVAL '30 days', migrate_data => TRUE);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM timescaledb_information.hypertables
                 WHERE hypertable_name = 'candles' AND compression_enabled) THEN
    ALTER TABLE "candles" SET (
      timescaledb.compress,
      timescaledb.compress_segmentby = '"instrumentId", timeframe',
      timescaledb.compress_orderby = '"timestamp"');
  END IF;
  PERFORM add_compression_policy('candles', INTERVAL '30 days', if_not_exists => TRUE);
END $$;

-- Compress the chunks already past their policy age now, instead of waiting for the background job.
SELECT compress_chunk(c, if_not_compressed => TRUE)
  FROM show_chunks('oi_snapshots', older_than => INTERVAL '7 days') c;
SELECT compress_chunk(c, if_not_compressed => TRUE)
  FROM show_chunks('candles', older_than => INTERVAL '30 days') c;
