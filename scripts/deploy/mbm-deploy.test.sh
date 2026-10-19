#!/usr/bin/env bash
# Unit tests for mbm-deploy.sh. Stubs every side-effecting function and asserts the
# exact sequence of calls main() makes. Run: bash scripts/deploy/mbm-deploy.test.sh
set -uo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
failures=0

stub() {
  # shellcheck source=/dev/null
  source "$here/mbm-deploy.sh"
  set +e
  CALLS=()
  log() { :; }
  target_sha() { echo new; }
  current_sha() { echo old; }
  image_exists() { return 1; }
  build_image() { CALLS+=("build:$1"); }
  swap_to() { CALLS+=("swap:$1"); }
  stop_mbm() { CALLS+=("stop"); }
  wait_healthy() { CALLS+=("health:$1"); }
  record_success() { CALLS+=("record:$1"); }
}

check() { # name want_exit want_calls got_exit
  local got="${CALLS[*]:-}"
  if [[ "$4" == "$2" && "$got" == "$3" ]]; then echo "ok   $1"; return 0; fi
  echo "FAIL $1: exit $4 (want $2), calls [$got] (want [$3])"; return 1
}

( stub; main; check "normal deploy" 0 "build:new swap:new health:new record:new" $? ) || failures=$((failures+1))
( stub; image_exists() { return 0; }; main
  check "existing image is not rebuilt" 0 "swap:new health:new record:new" $? ) || failures=$((failures+1))
( stub; build_image() { CALLS+=("build:$1"); return 1; }; main
  check "build failure leaves mbm untouched" 1 "build:new" $? ) || failures=$((failures+1))
( stub; wait_healthy() { CALLS+=("health:$1"); [[ "$1" != new ]]; }; main
  check "unhealthy rolls back" 1 "build:new swap:new health:new swap:old" $? ) || failures=$((failures+1))
( stub; current_sha() { echo ""; }; wait_healthy() { CALLS+=("health:$1"); return 1; }; main
  check "unhealthy first deploy stops mbm" 1 "build:new swap:new health:new stop" $? ) || failures=$((failures+1))
( stub; target_sha() { return 1; }; main nope
  check "unknown revision refused" 2 "" $? ) || failures=$((failures+1))

(( failures == 0 )) && echo "all mbm-deploy tests passed" || { echo "$failures failed"; exit 1; }
