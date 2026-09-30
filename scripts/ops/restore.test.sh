#!/usr/bin/env bash
# restore-test.sh against the image production actually runs
# (timescale/timescaledb:latest-pg17). Its init script installs the timescaledb
# extension into template1 and POSTGRES_DB, which plain-postgres tests cannot see.
# Run: bash scripts/ops/restore.test.sh   (needs Docker; pulls the image once)
set -uo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
C=grw-restore-ci
failures=0
expect() { if [[ "$2" == "$3" ]]; then echo "ok   $1"; else echo "FAIL $1: got $2 want $3"; failures=$((failures+1)); fi; }

docker rm -f "$C" >/dev/null 2>&1
docker run -d --name "$C" -e POSTGRES_USER=grw -e POSTGRES_PASSWORD=pw -e POSTGRES_DB=grw \
  timescale/timescaledb:latest-pg17 >/dev/null
# The image restarts Postgres after its init scripts; wait for the extension, not just a socket.
for _ in $(seq 60); do
  [[ "$(docker exec "$C" psql -U grw -d grw -qAt -c "select 1 from pg_extension where extname='timescaledb'" 2>/dev/null)" == 1 ]] && break
  sleep 2
done
docker exec -i "$C" psql -U grw -d grw -q -v ON_ERROR_STOP=1 <<'SQL'
CREATE TABLE users (id int);            INSERT INTO users VALUES (1), (2);
CREATE TABLE _prisma_migrations (id text); INSERT INTO _prisma_migrations VALUES ('m1');
-- A hypertable like SP1's candle store: its chunks and Timescale catalog rows
-- must come back from a plain pg_restore (verified on this image, 2026-10-01).
CREATE TABLE candles (ts timestamptz NOT NULL, px numeric);
SELECT create_hypertable('candles', 'ts');
INSERT INTO candles SELECT now() - (i || ' hours')::interval, i FROM generate_series(1, 500) i;
SQL

tmp="$(mktemp -d)"
export PG_CONTAINER="$C" PG_USER=grw PG_DB=grw BACKUP_DIR="$tmp"
BACKUP_REMOTES="" MIN_BYTES=1 bash "$here/backup.sh" >/dev/null 2>&1
expect "backup of a timescale DB is written" "$(ls "$tmp"/grw-*.dump 2>/dev/null | wc -l | tr -d ' ')" 1
bash "$here/restore-test.sh" > "$tmp/restore.log" 2>&1
expect "restore-test passes on the production image" $? 0
# restore-test drops its scratch DB, so prove the hypertable data separately with the same dump.
docker exec -i "$C" psql -U grw -d postgres -qc "CREATE DATABASE ht_check" >/dev/null
docker exec -i "$C" pg_restore -U grw -d ht_check --no-owner --no-privileges --exit-on-error < "$(ls "$tmp"/grw-*.dump)"
expect "hypertable rows survive a restore" "$(docker exec "$C" psql -U grw -d ht_check -qAt -c "select count(*) from candles")" 500
expect "candles is still a hypertable" "$(docker exec "$C" psql -U grw -d ht_check -qAt -c "select count(*) from timescaledb_information.hypertables where hypertable_name = 'candles'")" 1
grep -iE "error" "$tmp/restore.log" | head -3

head -c 4000 "$(ls "$tmp"/grw-*.dump)" > "$tmp/grw-29990101T000000Z.dump"
bash "$here/restore-test.sh" >/dev/null 2>&1
expect "restore-test fails on a truncated dump" $? 1

docker rm -f "$C" >/dev/null; rm -rf "$tmp"
if (( failures > 0 )); then echo "$failures test(s) failed"; exit 1; fi
echo "all restore tests passed"
