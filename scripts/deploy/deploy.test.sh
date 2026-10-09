#!/usr/bin/env bash
# Unit tests for deploy.sh. Stubs every side-effecting function and asserts the
# exact sequence of calls main() makes. Run: bash scripts/deploy/deploy.test.sh
set -uo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
failures=0

# Default stubs: a normal deploy from "old" to "new" outside market hours.
stub() {
  # shellcheck source=/dev/null
  source "$here/deploy.sh"
  # deploy.sh sets -e; inherited here it would kill the subshell on main's
  # non-zero return before check() runs, silently skipping every failure case.
  set +e
  CALLS=()
  log() { :; }
  notify() { :; }
  notify_once() { :; }
  current_sha() { echo old; }
  remote_sha() { echo new; }
  failed_sha() { echo ""; }
  in_market_hours() { return 1; }
  mark_failed() { CALLS+=("mark_failed:$1"); }
  fetch_image() { CALLS+=("fetch:$1"); }
  image_published() { return 0; }
  note_waiting() { CALLS+=("waiting:$1"); }
  run_migrations() { CALLS+=("migrate:$1"); }
  apply_timescale() { :; }   # its own cases below record it
  swap_to() { CALLS+=("swap:$1"); }
  wait_healthy() { CALLS+=("health:$1"); }
  checkout() { CALLS+=("checkout:$1"); }
  record_success() { CALLS+=("record:$1"); }
}

check() { # name want_exit want_calls got_exit — runs in a subshell, so it RETURNS its verdict
  local got="${CALLS[*]:-}"
  if [[ "$4" == "$2" && "$got" == "$3" ]]; then echo "ok   $1"; return 0; fi
  echo "FAIL $1: exit $4 (want $2), calls [$got] (want [$3])"; return 1
}

( stub; main; check "happy path" 0 "fetch:new migrate:new swap:new health:new record:new" $? ) || failures=$((failures + 1))
( stub; run_migrations() { CALLS+=("migrate:$1"); return 1; }
  main; check "migration fails: no swap" 1 "fetch:new migrate:new mark_failed:new" $? ) || failures=$((failures + 1))
( stub; fetch_image() { CALLS+=("fetch:$1"); return 1; }
  main; check "image pull fails: no migrate, no swap" 1 "fetch:new mark_failed:new" $? ) || failures=$((failures + 1))
( stub; wait_healthy() { CALLS+=("health:$1"); return 1; }
  main; check "unhealthy rolls back" 1 "fetch:new migrate:new swap:new health:new swap:old checkout:old mark_failed:new" $? ) || failures=$((failures + 1))
( stub; current_sha() { echo ""; }; wait_healthy() { CALLS+=("health:$1"); return 1; }
  main; check "first deploy unhealthy: nothing to roll back to" 1 "fetch:new migrate:new swap:new health:new mark_failed:new" $? ) || failures=$((failures + 1))
( stub; in_market_hours() { return 0; }
  main; check "market hours defers" 0 "" $? ) || failures=$((failures + 1))
( stub; in_market_hours() { return 0; }; FORCE=1
  main; check "FORCE=1 overrides market hours" 0 "fetch:new migrate:new swap:new health:new record:new" $? ) || failures=$((failures + 1))
( stub; remote_sha() { echo old; }
  main; check "up to date does nothing" 0 "" $? ) || failures=$((failures + 1))
( stub; failed_sha() { echo new; }
  main; check "known-bad sha is not retried" 0 "" $? ) || failures=$((failures + 1))

# Review I2: the window can open during a slow pull; re-check before migrate/swap.
( stub; n=0; in_market_hours() { n=$((n + 1)); (( n > 1 )); }
  main; check "window opens mid-pull: fetched, not migrated, not failed" 0 "fetch:new" $? ) || failures=$((failures + 1))
# Review I3: a failed swap must roll back and be remembered, not abort silently.
( stub; swap_to() { CALLS+=("swap:$1"); [[ "$1" != new ]]; }
  main; check "swap fails: roll back" 1 "fetch:new migrate:new swap:new swap:old checkout:old mark_failed:new" $? ) || failures=$((failures + 1))
# Review I3: a fetch failure alerts (rate-limited) instead of killing the unit silently.
( stub; remote_sha() { return 1; }; notify_once() { CALLS+=("notify_once:$1"); }
  main; check "fetch fails: alert once, no deploy" 0 "notify_once:fetch" $? ) || failures=$((failures + 1))

# SP1 M2 F1: TimescaleDB setup runs on every deploy, after migrations and before the swap,
# and never blocks a deploy.
( stub; apply_timescale() { CALLS+=("timescale:$1"); }
  main; check "timescale setup runs after migrate, before swap" 0 "fetch:new migrate:new timescale:new swap:new health:new record:new" $? ) || failures=$((failures + 1))
( stub; apply_timescale() { CALLS+=("timescale:$1"); return 1; }
  notify() { [[ "$*" == WARNING* ]] && CALLS+=("warn"); return 0; }
  main; check "timescale setup fails: warn and deploy anyway" 0 "fetch:new migrate:new timescale:new warn swap:new health:new record:new" $? ) || failures=$((failures + 1))
( stub; apply_timescale() { CALLS+=("timescale:$1"); }; run_migrations() { CALLS+=("migrate:$1"); return 1; }
  main; check "migration fails: no timescale setup" 1 "fetch:new migrate:new mark_failed:new" $? ) || failures=$((failures + 1))

# run_timescale_sql feeds the checked-out SQL file to psql inside the postgres service.
( source "$here/deploy.sh"; set +e
  APP_DIR="$here/../.."; COMPOSE=(docker compose -f x.yml)
  tmpcalls="$(mktemp)"; tmpin="$(mktemp)"
  docker() { echo "$*" >> "$tmpcalls"; cat > "$tmpin"; }
  run_timescale_sql; rc=$?
  if [[ $rc -eq 0 ]] && grep -q "^compose -f x.yml exec -T postgres sh -c psql -v ON_ERROR_STOP=0" "$tmpcalls" \
     && cmp -s "$tmpin" "$APP_DIR/deploy/sql/candles-timescale.sql"; then echo "ok   run_timescale_sql pipes deploy/sql/candles-timescale.sql into the postgres service"
  else echo "FAIL run_timescale_sql pipes deploy/sql/candles-timescale.sql into the postgres service: rc=$rc calls: $(tr '\n' ';' < "$tmpcalls")"; exit 1; fi
) || failures=$((failures + 1))

# timescale_state asks a FRESH psql session (separate from the setup run) via the check SQL.
( source "$here/deploy.sh"; set +e
  APP_DIR="$here/../.."; COMPOSE=(docker compose -f x.yml)
  tmpin="$(mktemp)"; docker() { cat > "$tmpin"; printf ' ok\n'; }
  got="$(timescale_state)"
  if [[ "$got" == ok ]] && cmp -s "$tmpin" "$APP_DIR/deploy/sql/candles-timescale-check.sql"; then echo "ok   timescale_state reads the check SQL's verdict"
  else echo "FAIL timescale_state reads the check SQL's verdict: got [$got]"; exit 1; fi
) || failures=$((failures + 1))

# apply_timescale verifies the result and retries once: a freshly created database needs
# a second session (CREATE EXTENSION, then the hypertable) — the 2026-10-09 VPS case.
ts_case() { # name want_rc want_runs states...
  local name="$1" want_rc="$2" want_runs="$3"; shift 3
  ( source "$here/deploy.sh"; set +e; log() { :; }
    runs=0; states=("$@"); seen="$(mktemp)"
    run_timescale_sql() { runs=$((runs + 1)); }
    # Called via $(...) — a subshell — so the call count lives in a file, not a variable.
    timescale_state() { local i; i=$(wc -l < "$seen"); echo x >> "$seen"; echo "${states[$i]}"; }
    apply_timescale new; rc=$?
    if [[ $rc -eq $want_rc && $runs -eq $want_runs ]]; then echo "ok   apply_timescale: $name"
    else echo "FAIL apply_timescale: $name: rc=$rc (want $want_rc), runs=$runs (want $want_runs)"; exit 1; fi )
}
ts_case "complete after one run" 0 1 ok || failures=$((failures + 1))
ts_case "not applicable here (plain Postgres / Apache) after one run" 0 1 skip || failures=$((failures + 1))
ts_case "fresh database: incomplete, then complete on the retry" 0 2 missing ok || failures=$((failures + 1))
ts_case "still incomplete after the retry fails loudly" 1 2 missing missing || failures=$((failures + 1))
ts_case "unreadable state counts as incomplete" 1 2 "" "" || failures=$((failures + 1))

# CI publishes the image a few minutes after the push: until then, wait quietly.
( stub; image_published() { return 1; }
  main; check "image not published yet: wait, not failed" 0 "waiting:new" $? ) || failures=$((failures + 1))

# note_waiting alerts only once the image has been missing for 30+ minutes.
( source "$here/deploy.sh"; set +e
  STATE_DIR="$(mktemp -d)"; log() { :; }; alerts=""
  notify_once() { alerts="$alerts $1"; }
  note_waiting abc; first="$alerts"
  touch -d '40 minutes ago' "$STATE_DIR/waiting-abc"
  note_waiting abc
  if [[ -z "$first" && "$alerts" == " image" ]]; then echo "ok   note_waiting is silent at first, alerts after 30 min"
  else echo "FAIL note_waiting is silent at first, alerts after 30 min: first=[$first] then=[$alerts]"; exit 1; fi
) || failures=$((failures + 1))

# fetch_image pulls the CI-built image and tags it grw-api:<sha>, the name compose
# and wait_healthy use.
( source "$here/deploy.sh"; set +e
  IMAGE_REPO=ghcr.io/x/grw-api; checkout() { :; }
  tmpcalls="$(mktemp)"; docker() { echo "$*" >> "$tmpcalls"; }
  fetch_image abc; rc=$?
  if [[ $rc -eq 0 ]] && grep -q "^pull -q ghcr.io/x/grw-api:abc" "$tmpcalls" \
     && grep -q "^tag ghcr.io/x/grw-api:abc grw-api:abc" "$tmpcalls"; then echo "ok   fetch_image pulls and tags grw-api:<sha>"
  else echo "FAIL fetch_image pulls and tags grw-api:<sha>: rc=$rc calls: $(tr '\n' ';' < "$tmpcalls")"; exit 1; fi
) || failures=$((failures + 1))

# Storage: the registry tag is dropped after the retag (the grw-api:<sha> tag keeps the
# image, so record_success's keep-3 pruning really frees space). Untag failure is harmless.
( source "$here/deploy.sh"; set +e
  IMAGE_REPO=ghcr.io/x/grw-api; checkout() { :; }
  tmpcalls="$(mktemp)"; docker() { echo "$*" >> "$tmpcalls"; [[ "$1" == image ]] && return 1; return 0; }
  fetch_image abc; rc=$?
  if [[ $rc -eq 0 ]] && [[ "$(tail -1 "$tmpcalls")" == "image rm ghcr.io/x/grw-api:abc" ]]; then echo "ok   fetch_image drops the registry tag after retagging, and its failure is harmless"
  else echo "FAIL fetch_image drops the registry tag after retagging: rc=$rc calls: $(tr '\n' ';' < "$tmpcalls")"; exit 1; fi
) || failures=$((failures + 1))

# Review I1: fetch_image must not pull when checkout fails (would tag OLD scripts with a new sha).
( source "$here/deploy.sh"; set +e
  checkout() { return 1; }; docker() { echo "docker $*" >> "$tmpcalls"; }
  tmpcalls="$(mktemp)"; fetch_image new; rc=$?
  if [[ $rc -ne 0 && ! -s "$tmpcalls" ]]; then echo "ok   fetch_image stops when checkout fails"
  else echo "FAIL fetch_image stops when checkout fails: rc=$rc, docker calls: $(cat "$tmpcalls")"; exit 1; fi
) || failures=$((failures + 1))

# Review C1: the API answers 426 to any request without X-Forwarded-Proto: https
# (EnforceHttpsMiddleware, NODE_ENV=production). wait_healthy must still see it healthy.
( source "$here/deploy.sh"; set +e
  port=$((20000 + RANDOM % 20000))
  node -e "require('http').createServer((q,s)=>{s.statusCode=q.headers['x-forwarded-proto']==='https'?200:426;s.end()}).listen($port)" &
  srv=$!; sleep 1
  docker() { echo "grw-api:new"; }   # docker inspect → the new image is running
  HEALTH_URL="http://127.0.0.1:$port/healthz/live" HEALTH_TIMEOUT_S=3 wait_healthy new; rc=$?
  kill $srv 2>/dev/null
  if [[ $rc -eq 0 ]]; then echo "ok   wait_healthy passes the HTTPS-enforcing middleware"
  else echo "FAIL wait_healthy passes the HTTPS-enforcing middleware: rc=$rc"; exit 1; fi
) || failures=$((failures + 1))

# in_market_hours takes explicit (dow, HHMM) so it is testable without a clock.
( source "$here/deploy.sh"
  t() { if in_market_hours "$1" "$2"; then r=0; else r=1; fi
        if [[ $r == "$3" ]]; then echo "ok   in_market_hours $1 $2"; else echo "FAIL in_market_hours $1 $2 -> $r (want $3)"; exit 1; fi; }
  t 3 1000 0; t 3 0859 1; t 3 0900 0; t 5 1535 0; t 5 1536 1; t 6 1000 1; t 7 1000 1 ) || failures=$((failures + 1))

if (( failures > 0 )); then echo "$failures test(s) failed"; exit 1; fi
echo "all deploy tests passed"
