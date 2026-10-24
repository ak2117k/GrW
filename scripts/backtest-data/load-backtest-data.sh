#!/usr/bin/env bash
# Load the backtest data store from the files build_backtest_data.py wrote on the PC.
#
# Run ON THE SERVER by the coordinator, after `prisma migrate deploy` has applied
# 20261024130000_backtest_data (the tables must exist). Idempotent and resumable:
#   * every file goes through a TEMP staging table and INSERT ... ON CONFLICT DO NOTHING, in one
#     transaction per file, so a re-run (or a run after a partial failure) never duplicates a row;
#   * a file that loaded is marked <file>.loaded and skipped next time (delete the markers to force);
#   * dataset sources are merged (comma set), catalogue stats are recomputed from the bars at the end.
#
# Copy the files over first (from the PC), e.g.:
#   scp -r C:\Users\AryanKumar\grw-mbm\exports\backtest-data root@<vps>:/opt/grw/backtest-data
#   ssh root@<vps> 'bash /opt/grw/app/scripts/backtest-data/load-backtest-data.sh /opt/grw/backtest-data'
#
# TimescaleDB (the VPS image, full licence): backtest_bars becomes a hypertable (180-day chunks)
# with native compression (segment by dataset_id, order by ts) and a 30-day compression policy;
# chunks are compressed at the end of the load. Elsewhere (no extension / Apache build) it stays
# a plain table. Either way the app reads it the same way.
#
# Usage: load-backtest-data.sh DIR
# Env:   PG_CONTAINER (grw-postgres) PG_USER (grw) PG_DB (grw)
#        MIN_FREE_MB (1500): refuse to start below this much free space on the Postgres volume.
# Exit:  0 ok · 1 a file failed (others still loaded; re-run to retry) · 2 bad args ·
#        3 tables missing (migration not applied) · 5 not enough free disk.
set -uo pipefail

PG_CONTAINER="${PG_CONTAINER:-grw-postgres}"
PG_USER="${PG_USER:-grw}"
PG_DB="${PG_DB:-grw}"
MIN_FREE_MB="${MIN_FREE_MB:-1500}"

dir="${1:-}"
[[ -n "$dir" && -d "$dir" ]] || { echo "usage: $0 DIR (the build_backtest_data.py output)" >&2; exit 2; }

psql_c() { docker exec -i "$PG_CONTAINER" psql -U "$PG_USER" -d "$PG_DB" -v ON_ERROR_STOP=1 -q -X "$@"; }

tables=$(psql_c -tA -c "SELECT count(*) FROM pg_tables WHERE tablename IN ('backtest_datasets','backtest_bars','backtest_fo_eod')")
[[ "$tables" == "3" ]] || { echo "backtest tables missing: apply migration 20261024130000_backtest_data first" >&2; exit 3; }

free_mb=$(docker exec "$PG_CONTAINER" df -Pm /var/lib/postgresql/data | awk 'NR==2 {print $4}')
echo "postgres volume free: ${free_mb} MB (need >= ${MIN_FREE_MB})"
(( free_mb >= MIN_FREE_MB )) || { echo "not enough free disk: ${free_mb} MB < ${MIN_FREE_MB} MB" >&2; exit 5; }

# One DO block: never aborts the load (a WARNING at worst), skipped when already done.
psql_c <<'SQL'
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_available_extensions WHERE name = 'timescaledb')
     OR coalesce(current_setting('timescaledb.license', TRUE), '') <> 'timescale' THEN
    RAISE NOTICE 'no full-licence timescaledb: backtest_bars stays a plain table';
    RETURN;
  END IF;
  CREATE EXTENSION IF NOT EXISTS timescaledb;
  PERFORM create_hypertable('backtest_bars', 'ts',
    chunk_time_interval => INTERVAL '180 days',
    create_default_indexes => FALSE,
    if_not_exists => TRUE,
    migrate_data => TRUE);
  IF NOT EXISTS (
    SELECT 1 FROM timescaledb_information.hypertables
    WHERE hypertable_schema = current_schema() AND hypertable_name = 'backtest_bars' AND compression_enabled
  ) THEN
    ALTER TABLE "backtest_bars" SET (
      timescaledb.compress,
      timescaledb.compress_segmentby = 'dataset_id',
      timescaledb.compress_orderby = 'ts');
  END IF;
  PERFORM add_compression_policy('backtest_bars', INTERVAL '30 days', if_not_exists => TRUE);
EXCEPTION WHEN OTHERS THEN
  RAISE WARNING 'backtest_bars TimescaleDB setup failed (%): left as it was', SQLERRM;
END
$$;
SQL

BARS_STAGE="CREATE TEMP TABLE stg (symbol text, exchange text, \"interval\" text, source text, ts timestamptz,
  open float8, high float8, low float8, close float8, volume float8, oi float8)"
BARS_DATASETS="INSERT INTO backtest_datasets (symbol, exchange, \"interval\", source, updated_at)
  SELECT symbol, exchange, \"interval\", string_agg(DISTINCT source, ','), now() FROM stg GROUP BY 1, 2, 3
  ON CONFLICT (symbol, exchange, \"interval\") DO UPDATE SET
    source = (SELECT string_agg(DISTINCT s, ',' ORDER BY s) FROM unnest(string_to_array(
               backtest_datasets.source || ',' || EXCLUDED.source, ',')) AS s),
    updated_at = now()"
BARS_INSERT="INSERT INTO backtest_bars (dataset_id, ts, open, high, low, close, volume, oi)
  SELECT d.id, s.ts, s.open, s.high, s.low, s.close, coalesce(s.volume, 0), s.oi
  FROM stg s JOIN backtest_datasets d
    ON d.symbol = s.symbol AND d.exchange = s.exchange AND d.\"interval\" = s.\"interval\"
  ON CONFLICT (dataset_id, ts) DO NOTHING"

FO_STAGE="CREATE TEMP TABLE stg (underlying text, date date, expiry date, kind text, strike real, open real,
  high real, low real, close real, settle real, contracts int, oi int, chg_oi int, undl real)"
FO_INSERT="INSERT INTO backtest_fo_eod (underlying, date, expiry, kind, strike, open, high, low, close, settle,
  contracts, oi, chg_oi, undl)
  SELECT underlying, date, expiry, kind, strike, open, high, low, close, settle,
         coalesce(contracts, 0), coalesce(oi, 0), coalesce(chg_oi, 0), undl FROM stg
  ON CONFLICT (underlying, date, expiry, kind, strike) DO NOTHING"

failed=0; loaded=0; skipped=0
load_file() { # $1 file, then the SQL statements to run around the \copy
  local f="$1"; shift
  if [[ -e "$f.loaded" ]]; then skipped=$(( skipped + 1 )); return; fi
  local stage="$1"; shift
  local args=(-1 -c "$stage" -c "\\copy stg FROM pstdin WITH (FORMAT csv, HEADER true)")
  for s in "$@"; do args+=(-c "$s"); done
  if gzip -dc "$f" | psql_c "${args[@]}"; then
    touch "$f.loaded"; loaded=$(( loaded + 1 )); echo "loaded $(basename "$f")"
  else
    failed=1; echo "FAILED $(basename "$f") (nothing from it was kept; re-run to retry)" >&2
  fi
}

shopt -s nullglob
for f in "$dir"/bars/*.csv.gz; do load_file "$f" "$BARS_STAGE" "$BARS_DATASETS" "$BARS_INSERT"; done
for f in "$dir"/fo/*.csv.gz; do load_file "$f" "$FO_STAGE" "$FO_INSERT"; done
echo "files: loaded=$loaded skipped(already loaded)=$skipped failed=$failed"

# Catalogue stats from the bars themselves (the app keeps them current after its own fetches).
psql_c -c "UPDATE backtest_datasets d SET from_ts = s.f, to_ts = s.t, rows = s.n, updated_at = now()
  FROM (SELECT dataset_id, min(ts) AS f, max(ts) AS t, count(*)::int AS n FROM backtest_bars GROUP BY 1) s
  WHERE s.dataset_id = d.id"

psql_c <<'SQL'
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'timescaledb') THEN
    RETURN;
  END IF;
  IF EXISTS (
    SELECT 1 FROM timescaledb_information.hypertables WHERE hypertable_name = 'backtest_bars' AND compression_enabled
  ) THEN
    PERFORM compress_chunk(c, if_not_compressed => TRUE)
      FROM show_chunks('backtest_bars', older_than => INTERVAL '30 days') AS c;
  END IF;
EXCEPTION WHEN OTHERS THEN
  RAISE WARNING 'backtest_bars compression skipped (%)', SQLERRM;
END
$$;
SQL

psql_c -c "SELECT count(*) AS datasets, sum(rows) AS bars FROM backtest_datasets"
is_ht=0
if [[ "$(psql_c -tA -c "SELECT count(*) FROM pg_extension WHERE extname = 'timescaledb'")" == "1" ]]; then
  is_ht=$(psql_c -tA -c "SELECT count(*) FROM timescaledb_information.hypertables WHERE hypertable_name = 'backtest_bars'")
fi
if [[ "$is_ht" == "1" ]]; then bars_size="hypertable_size('backtest_bars')"; else bars_size="pg_total_relation_size('backtest_bars')"; fi
psql_c -c "SELECT 'backtest_bars' AS rel, pg_size_pretty($bars_size) AS size
  UNION ALL SELECT 'backtest_fo_eod', pg_size_pretty(pg_total_relation_size('backtest_fo_eod'))"
exit "$failed"
