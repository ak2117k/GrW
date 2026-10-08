-- SP1 M2: TimescaleDB setup for the market hub's candles_1m.
--
-- Applied by scripts/deploy/deploy.sh after `prisma migrate deploy`, on EVERY
-- deploy, never by a migration: a migration runs only where it is first
-- applied, and a pg_dump/pg_restore cutover carries _prisma_migrations along,
-- so migration-side setup would never reach the database we restore into.
--
-- Safe to run any number of times and on any Postgres:
--   * candles_1m missing (migrations not applied yet)      -> nothing, no error
--   * no timescaledb, or the Apache-only build (Neon)      -> nothing: we want
--     compression + retention or a plain table, never a bare Apache hypertable
--   * full licence ('timescale', the VPS image)            -> hypertable,
--     compression and 180-day retention, each step skipped when already done
--   * anything unexpected                                  -> WARNING, never an abort
--
-- create_default_indexes => FALSE: the primary key (exchange, token, ts) already
-- serves every query, and an extra ts index would show up as Prisma schema drift.
-- 180 days matches ONE_MINUTE_HORIZON_DAYS in candle.types.ts (reads clamp to it).
-- One DO block on purpose: the integration test executes this file as one statement.
DO $$
BEGIN
  IF to_regclass('candles_1m') IS NULL THEN
    RAISE NOTICE 'candles_1m does not exist yet: TimescaleDB setup skipped';
    RETURN;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_available_extensions WHERE name = 'timescaledb') THEN
    RAISE NOTICE 'timescaledb not available: candles_1m stays a plain table';
    RETURN;
  END IF;
  IF coalesce(current_setting('timescaledb.license', TRUE), '') <> 'timescale' THEN
    RAISE NOTICE 'timescaledb is not the full-licence build here: candles_1m stays a plain table';
    RETURN;
  END IF;

  CREATE EXTENSION IF NOT EXISTS timescaledb;
  PERFORM create_hypertable('candles_1m', 'ts',
    chunk_time_interval => INTERVAL '7 days',
    create_default_indexes => FALSE,
    if_not_exists => TRUE,
    migrate_data => TRUE);

  -- SET (timescaledb.compress ...) errors on a table that already has compression on.
  IF NOT EXISTS (
    SELECT 1 FROM timescaledb_information.hypertables
    WHERE hypertable_schema = current_schema() AND hypertable_name = 'candles_1m' AND compression_enabled
  ) THEN
    ALTER TABLE "candles_1m" SET (
      timescaledb.compress,
      timescaledb.compress_segmentby = 'exchange, token',
      timescaledb.compress_orderby = 'ts');
  END IF;
  PERFORM add_compression_policy('candles_1m', INTERVAL '7 days', if_not_exists => TRUE);
  PERFORM add_retention_policy('candles_1m', INTERVAL '180 days', if_not_exists => TRUE);
EXCEPTION WHEN OTHERS THEN
  RAISE WARNING 'candles_1m TimescaleDB setup failed (%): left as it was', SQLERRM;
END
$$;
