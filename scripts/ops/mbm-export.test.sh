#!/usr/bin/env bash
# Hermetic tests for mbm-export.sh. `docker` is stubbed on PATH: it prints a CSV
# header plus $STUB_ROWS rows, logs its args to $DOCKER_LOG, and fails when the
# query names $STUB_FAIL_TABLE. No database or container is touched.
# Run: bash scripts/ops/mbm-export.test.sh
set -uo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
failures=0
expect() { if [[ "$2" == "$3" ]]; then echo "ok   $1"; else echo "FAIL $1: got [$2] want [$3]"; failures=$((failures+1)); fi; }

work="$(mktemp -d)"; bin="$work/bin"; mkdir -p "$bin"
cat > "$bin/docker" <<'EOF'
#!/usr/bin/env bash
printf '%s\n' "$*" >> "$DOCKER_LOG"
if [[ -n "${STUB_FAIL_TABLE:-}" && "$*" == *"FROM ${STUB_FAIL_TABLE} "* ]]; then
  echo "ERROR: stub failure" >&2; exit 1
fi
echo "id,col"
for ((i = 0; i < ${STUB_ROWS:-2}; i++)); do echo "row$i,x"; done
EOF
chmod +x "$bin/docker"

out=""
run() { # $1 = export dir; rest = script args; env via the caller. Prints exit code.
  local dir="$1"; shift
  : > "$work/docker.log"
  env PATH="$bin:$PATH" DOCKER_LOG="$work/docker.log" EXPORT_DIR="$dir" \
    PG_CONTAINER=pg PG_USER=u PG_DB=d \
    bash "$here/mbm-export.sh" "$@" > "$work/stdout" 2> "$work/stderr"
  echo $?
}
files() { (cd "$1" && find . -name '*.csv.gz' | sed 's#^\./##' | sort | tr '\n' ' '); }
TABLES="oi_snapshots oi_wall_snapshots option_chain_snapshots mbm_chain_snapshots"

d="$work/a"
rc=$(EXPORT_CATCHUP_DAYS=1 run "$d" --today 2026-10-20)
expect "exports each table for yesterday: exit" "$rc" 0
expect "exports each table for yesterday: files" "$(files "$d")" \
  "mbm_chain_snapshots/mbm_chain_snapshots-2026-10-19.csv.gz oi_snapshots/oi_snapshots-2026-10-19.csv.gz oi_wall_snapshots/oi_wall_snapshots-2026-10-19.csv.gz option_chain_snapshots/option_chain_snapshots-2026-10-19.csv.gz "
ok=0; for t in $TABLES; do gzip -t "$d/$t/$t-2026-10-19.csv.gz" && ok=$((ok+1)); done
expect "exported files are valid gzip" "$ok" 4
expect "summary line per new file" "$(grep -c 'rows=2' "$work/stdout")" 4
expect "window is IST day in UTC" \
  "$(grep 'FROM oi_snapshots ' "$work/docker.log" | grep -c "'2026-10-18 18:30:00'.*'2026-10-19 18:30:00'")" 1
expect "mbm chain window is pinned to UTC (timestamptz)" \
  "$(grep 'FROM mbm_chain_snapshots ' "$work/docker.log" | grep -c "captured_at >= '2026-10-18 18:30:00+00' AND captured_at < '2026-10-19 18:30:00+00'")" 1
expect "mbm chain export carries the strikes json" "$(grep 'FROM mbm_chain_snapshots ' "$work/docker.log" | grep -c 'pcr, max_pain, call_wall, put_wall, strikes')" 1
expect "queries stream with COPY TO STDOUT" "$(grep -c 'COPY (' "$work/docker.log")" 4

rc=$(EXPORT_CATCHUP_DAYS=1 run "$d" --today 2026-10-20)
expect "skips existing files: exit" "$rc" 0
expect "skips existing files: no docker call" "$(wc -l < "$work/docker.log" | tr -d ' ')" 0

d="$work/b"
rc=$(EXPORT_CATCHUP_DAYS=3 run "$d" --today 2026-10-20)
expect "catch-up covers missed nights" "$(files "$d" | tr ' ' '\n' | grep -o '2026-10-[0-9]*' | sort -u | tr '\n' ' ')" \
  "2026-10-17 2026-10-18 2026-10-19 "

d="$work/c"
rc=$(run "$d" --since 2026-10-10 --today 2026-10-20)
expect "--since backfills 10 days x 4 tables" "$(files "$d" | wc -w | tr -d ' ')" 40

d="$work/d"   # a server that already exported the three older tables: only the new one is backfilled
for t in oi_snapshots oi_wall_snapshots option_chain_snapshots; do
  mkdir -p "$d/$t"; printf 'id\n' | gzip > "$d/$t/$t-2026-10-19.csv.gz"
done
rc=$(EXPORT_CATCHUP_DAYS=1 run "$d" --today 2026-10-20)
expect "new table backfills beside existing files: exit" "$rc" 0
expect "new table backfills beside existing files: one query" "$(grep -c 'FROM mbm_chain_snapshots ' "$work/docker.log")" 1
expect "new table backfills beside existing files: only it queried" "$(wc -l < "$work/docker.log" | tr -d ' ')" 1

d="$work/e"
rc=$(STUB_FAIL_TABLE=option_chain_snapshots EXPORT_CATCHUP_DAYS=1 run "$d" --today 2026-10-20)
expect "failed table exits 1" "$rc" 1
expect "failed table leaves no partial" "$(find "$d" -name '*.partial' | wc -l | tr -d ' ')" 0
expect "failed table: other three written" "$(files "$d" | wc -w | tr -d ' ')" 3
expect "failed table is named on stderr" "$(grep -c 'option_chain_snapshots' "$work/stderr")" 1

d="$work/f"   # 2026-10-19 is a Monday
rc=$(STUB_ROWS=0 EXPORT_CATCHUP_DAYS=1 run "$d" --today 2026-10-20)
expect "empty weekday exits 4" "$rc" 4
expect "empty weekday message" "$(grep -c 'no OI/chain rows for 2026-10-19' "$work/stderr")" 1
d="$work/g"   # 2026-10-18 is a Sunday
rc=$(STUB_ROWS=0 EXPORT_CATCHUP_DAYS=1 run "$d" --today 2026-10-19)
expect "empty Sunday exits 0" "$rc" 0

d="$work/h"; mkdir -p "$d/oi_snapshots"
touch -d '40 days ago' "$d/oi_snapshots/oi_snapshots-2026-09-01.csv.gz"
touch -d '10 days ago' "$d/oi_snapshots/oi_snapshots-2026-10-09.csv.gz"
rc=$(EXPORT_CATCHUP_DAYS=1 run "$d" --today 2026-10-20)
expect "retention prunes 40-day-old file" "$([[ -e "$d/oi_snapshots/oi_snapshots-2026-09-01.csv.gz" ]] && echo kept || echo gone)" gone
expect "retention keeps 10-day-old file" "$([[ -e "$d/oi_snapshots/oi_snapshots-2026-10-09.csv.gz" ]] && echo kept || echo gone)" kept

rm -rf "$work"
if (( failures > 0 )); then echo "$failures test(s) failed"; exit 1; fi
echo "all mbm-export tests passed"
