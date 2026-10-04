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
