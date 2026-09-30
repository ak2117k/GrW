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
  current_sha() { echo old; }
  remote_sha() { echo new; }
  failed_sha() { echo ""; }
  in_market_hours() { return 1; }
  mark_failed() { CALLS+=("mark_failed:$1"); }
  build_image() { CALLS+=("build:$1"); }
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

( stub; main; check "happy path" 0 "build:new migrate:new swap:new health:new record:new" $? ) || failures=$((failures + 1))
( stub; run_migrations() { CALLS+=("migrate:$1"); return 1; }
  main; check "migration fails: no swap" 1 "build:new migrate:new mark_failed:new" $? ) || failures=$((failures + 1))
( stub; build_image() { CALLS+=("build:$1"); return 1; }
  main; check "build fails: no migrate, no swap" 1 "build:new mark_failed:new" $? ) || failures=$((failures + 1))
( stub; wait_healthy() { CALLS+=("health:$1"); return 1; }
  main; check "unhealthy rolls back" 1 "build:new migrate:new swap:new health:new swap:old checkout:old mark_failed:new" $? ) || failures=$((failures + 1))
( stub; current_sha() { echo ""; }; wait_healthy() { CALLS+=("health:$1"); return 1; }
  main; check "first deploy unhealthy: nothing to roll back to" 1 "build:new migrate:new swap:new health:new mark_failed:new" $? ) || failures=$((failures + 1))
( stub; in_market_hours() { return 0; }
  main; check "market hours defers" 0 "" $? ) || failures=$((failures + 1))
( stub; in_market_hours() { return 0; }; FORCE=1
  main; check "FORCE=1 overrides market hours" 0 "build:new migrate:new swap:new health:new record:new" $? ) || failures=$((failures + 1))
( stub; remote_sha() { echo old; }
  main; check "up to date does nothing" 0 "" $? ) || failures=$((failures + 1))
( stub; failed_sha() { echo new; }
  main; check "known-bad sha is not retried" 0 "" $? ) || failures=$((failures + 1))

# in_market_hours takes explicit (dow, HHMM) so it is testable without a clock.
( source "$here/deploy.sh"
  t() { if in_market_hours "$1" "$2"; then r=0; else r=1; fi
        if [[ $r == "$3" ]]; then echo "ok   in_market_hours $1 $2"; else echo "FAIL in_market_hours $1 $2 -> $r (want $3)"; exit 1; fi; }
  t 3 1000 0; t 3 0859 1; t 3 0900 0; t 5 1535 0; t 5 1536 1; t 6 1000 1; t 7 1000 1 ) || failures=$((failures + 1))

if (( failures > 0 )); then echo "$failures test(s) failed"; exit 1; fi
echo "all deploy tests passed"
