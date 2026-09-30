#!/usr/bin/env bash
# Tests compare-counts.sh and backup.sh against the local dev Postgres (td-postgres).
set -uo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# Backups dump the scratch DB ops_a: hermetic, and small enough for a nearly-full disk.
export PG_CONTAINER=td-postgres PG_USER=postgres PG_DB=ops_a
psqlc() { docker exec -i td-postgres psql -U postgres -v ON_ERROR_STOP=1 -qAt "$@"; }
failures=0
expect() { if [[ "$2" == "$3" ]]; then echo "ok   $1"; else echo "FAIL $1: got $2 want $3"; failures=$((failures+1)); fi; }

psqlc -d postgres -c "DROP DATABASE IF EXISTS ops_a" -c "DROP DATABASE IF EXISTS ops_b" \
      -c "CREATE DATABASE ops_a" -c "CREATE DATABASE ops_b"
for db in ops_a ops_b; do psqlc -d $db -c "CREATE TABLE t (id int); INSERT INTO t SELECT generate_series(1,5)"; done
A=postgresql://postgres:password@localhost:5432/ops_a
B=postgresql://postgres:password@localhost:5432/ops_b

bash "$here/compare-counts.sh" "$A" "$B" >/dev/null; expect "equal counts pass" $? 0
psqlc -d ops_b -c "INSERT INTO t VALUES (6)"
bash "$here/compare-counts.sh" "$A" "$B" >/dev/null; expect "differing counts fail" $? 1
psqlc -d ops_b -c "CREATE TABLE extra (id int)"
bash "$here/compare-counts.sh" "$A" "$A" >/dev/null; expect "same db passes" $? 0

tmp="$(mktemp -d)"
BACKUP_DIR="$tmp" MIN_BYTES=999999999 BACKUP_REMOTES="" bash "$here/backup.sh" 2>/dev/null
expect "tiny dump refused" $? 1
expect "refused dump not kept" "$(ls "$tmp" | wc -l | tr -d ' ')" 0
BACKUP_DIR="$tmp" MIN_BYTES=1 BACKUP_REMOTES="" bash "$here/backup.sh" 2>/dev/null
expect "no remotes is a failure" $? 2
expect "local dump still written" "$(ls "$tmp"/grw-*.dump | wc -l | tr -d ' ')" 1

psqlc -d postgres -c "DROP DATABASE ops_a" -c "DROP DATABASE ops_b"; rm -rf "$tmp"
if (( failures > 0 )); then echo "$failures test(s) failed"; exit 1; fi
echo "all ops tests passed"
