-- Verdict on candles_1m's TimescaleDB setup, read by scripts/deploy/deploy.sh in a FRESH
-- session after deploy/sql/candles-timescale.sql ran. Prints exactly one word:
--   skip     setup does not apply here (no table yet, no timescaledb, or Apache-only build)
--   ok       hypertable with compression on, plus compression and retention jobs
--   missing  should be set up but is not (deploy.sh retries once, then alerts)
-- timescaledb_information.* only exists once the extension is installed, so it is read
-- through query_to_xml: that query is parsed only when its CASE branch is reached.
SELECT CASE
  WHEN to_regclass('candles_1m') IS NULL THEN 'skip'
  WHEN NOT EXISTS (SELECT 1 FROM pg_available_extensions WHERE name = 'timescaledb') THEN 'skip'
  WHEN coalesce(current_setting('timescaledb.license', TRUE), '') <> 'timescale' THEN 'skip'
  WHEN NOT EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'timescaledb') THEN 'missing'
  WHEN (xpath('/row/n/text()', query_to_xml($q$
          SELECT count(*) AS n FROM timescaledb_information.hypertables
          WHERE hypertable_schema = current_schema() AND hypertable_name = 'candles_1m' AND compression_enabled
        $q$, FALSE, TRUE, '')))[1]::text::int = 1
   AND (xpath('/row/n/text()', query_to_xml($q$
          SELECT count(*) AS n FROM timescaledb_information.jobs
          WHERE hypertable_name = 'candles_1m' AND proc_name IN ('policy_compression', 'policy_retention')
        $q$, FALSE, TRUE, '')))[1]::text::int = 2
  THEN 'ok'
  ELSE 'missing'
END;
