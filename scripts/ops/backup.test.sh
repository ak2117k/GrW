#!/usr/bin/env bash
# Hermetic tests for backup.sh's off-site copy and remote pruning. `docker` and
# `rclone` are stubbed on PATH, so no database, container or bucket is touched.
# (ops.test.sh covers the dump checks against a real local Postgres.)
# Run: bash scripts/ops/backup.test.sh
set -uo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
failures=0
expect() { if [[ "$2" == "$3" ]]; then echo "ok   $1"; else echo "FAIL $1: got [$2] want [$3]"; failures=$((failures+1)); fi; }

work="$(mktemp -d)"; bin="$work/bin"; mkdir -p "$bin"
cat > "$bin/docker" <<'EOF'
#!/usr/bin/env bash
# pg_dump → a big enough fake archive; pg_restore --list → readable.
if [[ " $* " == *" pg_dump "* ]]; then head -c 200000 /dev/zero | tr '\0' 'x'; exit 0; fi
if [[ " $* " == *" pg_restore "* ]]; then cat > /dev/null; exit 0; fi
exit 0
EOF
cat > "$bin/rclone" <<'EOF'
#!/usr/bin/env bash
echo "$*" >> "$RCLONE_LOG"
[[ "$1" == copy && -n "${RCLONE_FAIL_COPY:-}" ]] && exit 1
[[ "$1" == delete && -n "${RCLONE_FAIL_DELETE:-}" ]] && exit 1
exit 0
EOF
chmod +x "$bin/docker" "$bin/rclone"

run() { # extra env assignments as args; prints exit code
  local dir="$work/out-$RANDOM"; mkdir -p "$dir"; : > "$work/rclone.log"
  env PATH="$bin:$PATH" RCLONE_LOG="$work/rclone.log" BACKUP_DIR="$dir" MIN_BYTES=1 "$@" \
    bash "$here/backup.sh" > "$work/stdout" 2> "$work/stderr"
  echo $?
}
log() { cat "$work/rclone.log"; }

rc=$(run BACKUP_REMOTES="r2:bucket")
expect "backup succeeds" "$rc" 0
expect "copies first, then prunes backups older than 30 days" \
  "$(log | sed -E 's#/[^ ]*/grw-[0-9TZ]+\.dump#DUMP#')" \
  "$(printf 'copy DUMP r2:bucket\ndelete --min-age 30d --include grw-*.dump r2:bucket')"

rc=$(run BACKUP_REMOTES="r2:a other:b" KEEP_REMOTE_DAYS=10)
expect "every remote is pruned with the configured age" \
  "$(log | grep '^delete' | tr '\n' ';')" \
  "delete --min-age 10d --include grw-*.dump r2:a;delete --min-age 10d --include grw-*.dump other:b;"

rc=$(run BACKUP_REMOTES="r2:bucket" RCLONE_FAIL_COPY=1)
expect "a failed copy is a failure" "$rc" 3
expect "a failed copy never prunes the remote" "$(log | grep -c '^delete')" 0

rc=$(run BACKUP_REMOTES="r2:bucket" RCLONE_FAIL_DELETE=1)
expect "a failed prune does not fail the backup" "$rc" 0
expect "a failed prune is reported" "$(grep -c 'prun' "$work/stderr")" 1

rm -rf "$work"
if (( failures > 0 )); then echo "$failures test(s) failed"; exit 1; fi
echo "all backup tests passed"
