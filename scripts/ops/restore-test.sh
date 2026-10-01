#!/usr/bin/env bash
# Monthly proof that backups restore: newest dump → scratch DB → same tables and
# migrations as live, and real data present. (Exact counts are proven at cutover.)
set -euo pipefail
PG_CONTAINER="${PG_CONTAINER:-grw-postgres}"
PG_USER="${PG_USER:-grw}"
PG_DB="${PG_DB:-grw}"
BACKUP_DIR="${BACKUP_DIR:-/opt/grw/backups}"

dump="$(ls -1t "$BACKUP_DIR"/grw-*.dump | head -1)"
[[ -n "$dump" ]] || { echo "restore-test: no dump in $BACKUP_DIR" >&2; exit 1; }

psqlc() { docker exec -i "$PG_CONTAINER" psql -U "$PG_USER" -d postgres -v ON_ERROR_STOP=1 -qc "$1"; }
q() { docker exec -i "$PG_CONTAINER" psql -U "$PG_USER" -d "$1" -qAt -v ON_ERROR_STOP=1 -c "$2"; }
tables_sql="SELECT table_name FROM information_schema.tables WHERE table_schema='public' AND table_type='BASE TABLE' ORDER BY 1"

psqlc "DROP DATABASE IF EXISTS grw_restore_test"
psqlc "CREATE DATABASE grw_restore_test"
rc=0
# --exit-on-error: our own dumps have no foreign roles, so ANY restore error is a failure.
docker exec -i "$PG_CONTAINER" pg_restore -U "$PG_USER" -d grw_restore_test \
  --no-owner --no-privileges --exit-on-error < "$dump" || { echo "restore-test: pg_restore failed" >&2; rc=1; }

if (( rc == 0 )); then
  # Row counts legitimately drift after the dump, so the proof is structural plus two anchors:
  #   same set of tables as live · same applied migrations as live · real data present.
  [[ "$(q grw_restore_test "$tables_sql")" == "$(q "$PG_DB" "$tables_sql")" ]] \
    || { echo "restore-test: table set differs from live" >&2; rc=1; }
  [[ "$(q grw_restore_test 'SELECT count(*) FROM _prisma_migrations')" == "$(q "$PG_DB" 'SELECT count(*) FROM _prisma_migrations')" ]] \
    || { echo "restore-test: applied migrations differ from live" >&2; rc=1; }
  (( "$(q grw_restore_test 'SELECT count(*) FROM users')" > 0 )) \
    || { echo "restore-test: users table is empty in the restore" >&2; rc=1; }
fi

psqlc "DROP DATABASE grw_restore_test"
(( rc == 0 )) && echo "restore-test: $dump restored OK"
exit $rc
