#!/usr/bin/env bash
# Nightly backup: dump → verify readable and non-trivial → keep 7 locally → copy
# to every configured rclone remote. Exit codes: 1 bad dump, 2 no remotes, 3 copy failed.
# A backup that never left the box is reported as a failure, not a success.
set -euo pipefail
PG_CONTAINER="${PG_CONTAINER:-grw-postgres}"
PG_USER="${PG_USER:-grw}"
PG_DB="${PG_DB:-grw}"
BACKUP_DIR="${BACKUP_DIR:-/opt/grw/backups}"
KEEP_LOCAL="${KEEP_LOCAL:-7}"
MIN_BYTES="${MIN_BYTES:-100000}"
REMOTES="${BACKUP_REMOTES:-}"

mkdir -p "$BACKUP_DIR"
file="$BACKUP_DIR/grw-$(date -u +%Y%m%dT%H%M%SZ).dump"
docker exec "$PG_CONTAINER" pg_dump -U "$PG_USER" -d "$PG_DB" -Fc > "$file.partial"

size=$(stat -c %s "$file.partial")
if (( size < MIN_BYTES )); then
  echo "backup: dump is $size bytes (< $MIN_BYTES) — refusing it" >&2
  rm -f "$file.partial"; exit 1
fi
if ! docker exec -i "$PG_CONTAINER" pg_restore --list < "$file.partial" > /dev/null; then
  echo "backup: dump is not a readable archive" >&2
  rm -f "$file.partial"; exit 1
fi
mv "$file.partial" "$file"
ls -1t "$BACKUP_DIR"/grw-*.dump | tail -n +$((KEEP_LOCAL + 1)) | xargs -r rm -f

if [[ -z "$REMOTES" ]]; then
  echo "backup: BACKUP_REMOTES is empty — $file exists only on this host" >&2; exit 2
fi
for r in $REMOTES; do
  rclone copy "$file" "$r" || { echo "backup: copy to $r FAILED" >&2; exit 3; }
done
echo "backup: $file ($size bytes) → $REMOTES"
