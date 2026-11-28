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
  ensure_disk_headroom() { :; }
  # No AI agent container running (rollout step 1: defined, not started). Records only real work.
  running_agents() { :; }
  recreate_agents() { (( $# > 1 )) && CALLS+=("agents:$*"); return 0; }
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

# AI agents (design 2026-11-22 §4.7a): the RUNNING agent containers follow the API's tag, after the
# API is healthy; never-started ones stay off; a failed agent recreate warns but keeps the good API.
( stub; running_agents() { echo grw-agents-trading; echo grw-agents-background; }
  main; check "running agents recreated on the new tag after a healthy swap" 0 "fetch:new migrate:new swap:new health:new agents:new grw-agents-trading grw-agents-background record:new" $? ) || failures=$((failures + 1))
( stub; running_agents() { echo grw-agents-reading; }
  recreate_agents() { (( $# > 1 )) && CALLS+=("agents:$*"); return 1; }
  notify() { [[ "$*" == WARNING* ]] && CALLS+=("warn"); return 0; }
  main; check "agent recreate fails: warn, API deploy still recorded" 0 "fetch:new migrate:new swap:new health:new agents:new grw-agents-reading warn record:new" $? ) || failures=$((failures + 1))
( stub; running_agents() { echo grw-agents-trading; }; wait_healthy() { CALLS+=("health:$1"); return 1; }
  main; check "unhealthy API: agents not moved to new, rolled back with the API" 1 "fetch:new migrate:new swap:new health:new swap:old agents:old grw-agents-trading checkout:old mark_failed:new" $? ) || failures=$((failures + 1))
( stub; n="$(mktemp)"; running_agents() { echo x >> "$n"; echo grw-agents-trading; }
  in_market_hours() { return 0; }
  main; check "market hours: agents untouched" 0 "" $? ; r=$?; [[ ! -s "$n" ]] || { echo "FAIL running_agents asked during a deferred deploy"; r=1; }; exit $r ) || failures=$((failures + 1))

# running_agents lists only containers docker reports as running; recreate_agents targets just those
# services with the given tag under the "agents" profile, and does nothing for an empty list.
( source "$here/deploy.sh"; set +e
  docker() { [[ "$1 $2" == "inspect -f" && "$4" == grw-agents-reading ]] && { echo true; return 0; }
             [[ "$4" == grw-agents-trading ]] && { echo false; return 0; }; return 1; }
  got="$(running_agents | tr '\n' ' ')"
  if [[ "$got" == "grw-agents-reading " ]]; then echo "ok   running_agents lists only running agent containers"
  else echo "FAIL running_agents lists only running agent containers: got [$got]"; exit 1; fi
) || failures=$((failures + 1))
( source "$here/deploy.sh"; set +e
  COMPOSE=(docker compose -f x.yml); tmpcalls="$(mktemp)"
  docker() { echo "GRW_API_TAG=${GRW_API_TAG:-} $*" >> "$tmpcalls"; }
  recreate_agents abc; rc0=$?; empty="$(cat "$tmpcalls")"
  recreate_agents abc grw-agents-trading grw-agents-reading; rc=$?
  if [[ $rc0 -eq 0 && -z "$empty" && $rc -eq 0 ]] \
     && grep -qx "GRW_API_TAG=abc compose -f x.yml --profile agents up -d --no-deps grw-agents-trading grw-agents-reading" "$tmpcalls"; then
    echo "ok   recreate_agents: no-op when none run, else up -d --no-deps on the given tag"
  else echo "FAIL recreate_agents: rc0=$rc0 rc=$rc calls: $(tr '\n' ';' < "$tmpcalls")"; exit 1; fi
) || failures=$((failures + 1))

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

# Disk guard: refusing to pull is a retryable stop (no mark_failed, no fetch).
( stub; ensure_disk_headroom() { CALLS+=("disk:$1"); return 1; }
  main; check "disk guard refuses the pull when space cannot be freed" 1 "disk:old" $? ) || failures=$((failures + 1))

# ensure_disk_headroom itself, with df and docker stubbed.
( stub; unset -f ensure_disk_headroom; source <(sed -n '/^ensure_disk_headroom() {/,/^}/p' "$here/deploy.sh")
  FREE=(10); free_gb() { echo "${FREE[0]}"; FREE=("${FREE[@]:1}" "${FREE[-1]}"); }
  docker() { CALLS+=("docker:$1:$2"); }
  ensure_disk_headroom cur; check "enough space: nothing pruned" 0 "" $? ) || failures=$((failures + 1))
( stub; unset -f ensure_disk_headroom; source <(sed -n '/^ensure_disk_headroom() {/,/^}/p' "$here/deploy.sh")
  n="$(mktemp)"; echo 0 > "$n"   # call counter in a file: free_gb runs inside $(...), a subshell
  free_gb() { local c; c=$(( $(cat "$n") + 1 )); echo "$c" > "$n"; (( c == 1 )) && echo 1 || echo 5; }
  docker() { CALLS+=("docker:$1:$2"); }
  ensure_disk_headroom cur; check "low space: prunes, then proceeds" 0 "docker:builder:prune docker:image:prune" $? ) || failures=$((failures + 1))
( stub; unset -f ensure_disk_headroom; source <(sed -n '/^ensure_disk_headroom() {/,/^}/p' "$here/deploy.sh")
  free_gb() { echo 1; }
  docker() { CALLS+=("docker:$1:$2"); }
  ensure_disk_headroom cur; check "still no space after pruning: refuses" 1 "docker:builder:prune docker:image:prune" $? ) || failures=$((failures + 1))

# NSE holidays from the app's calendar are not market hours (2026-10-20 Dussehra deferred all day).
( source "$here/deploy.sh"; set +e
  HOLIDAYS_TS="$(mktemp)"; printf "  { date: '2026-10-20', name: 'Dussehra', exchanges: ['NSE', 'BSE', 'NFO'] },
" > "$HOLIDAYS_TS"
  in_market_hours 2 1200 2026-10-20; r1=$?
  in_market_hours 3 1200 2026-10-21; r2=$?
  rm -f "$HOLIDAYS_TS"
  if [[ $r1 -ne 0 && $r2 -eq 0 ]]; then echo "ok   holiday is not market hours; next session is"; else echo "FAIL holiday check ($r1,$r2)"; exit 1; fi ) || failures=$((failures + 1))

# Fix 5 (2026-11-28 audit): the unit's ops.env has the TELEGRAM_ALERT_* keys EMPTY; the values live in
# api.env. notify() reads just those two keys from api.env when ops.env lacks them, never echoes them,
# and keeps xtrace off while they are in play.
tg_case() { # name body — body runs with a fake api.env ($API_ENV) and curl's args recorded to $tgcalls
  ( source "$here/deploy.sh"; set +e; log() { echo "LOG $*" >> "$tglog"; }
    tgcalls="$(mktemp)"; tglog="$(mktemp)"; API_ENV="$(mktemp)"
    curl() { printf '%s\n' "$@" >> "$tgcalls"; }
    TELEGRAM_ALERT_BOT_TOKEN=""; TELEGRAM_ALERT_CHAT_ID=""
    eval "$2" )
}
tg_case "notify falls back to api.env when ops.env keys are empty" '
  printf "FOO=1\nTELEGRAM_ALERT_BOT_TOKEN=123:abcTOKEN\nTELEGRAM_ALERT_CHAT_ID=-1009\n" > "$API_ENV"
  notify "deployed abc1234"; rc=$?
  if [[ $rc -eq 0 ]] && grep -qx "https://api.telegram.org/bot123:abcTOKEN/sendMessage" "$tgcalls" \
     && grep -qx "chat_id=-1009" "$tgcalls" && grep -qx "text=GrW deploy: deployed abc1234" "$tgcalls"; then echo "ok   notify falls back to api.env when ops.env keys are empty"
  else echo "FAIL notify falls back to api.env: rc=$rc calls: $(tr "\n" ";" < "$tgcalls")"; exit 1; fi' || failures=$((failures + 1))
tg_case "api.env values may be quoted or CRLF-terminated" '
  printf "TELEGRAM_ALERT_BOT_TOKEN=\"123:q\"\r\nTELEGRAM_ALERT_CHAT_ID='"'"'77'"'"'\r\n" > "$API_ENV"
  notify x
  if grep -qx "https://api.telegram.org/bot123:q/sendMessage" "$tgcalls" && grep -qx "chat_id=77" "$tgcalls"; then echo "ok   api.env values may be quoted or CRLF-terminated"
  else echo "FAIL api.env quoted/CRLF: calls: $(tr "\n" ";" < "$tgcalls" | cat -v)"; exit 1; fi' || failures=$((failures + 1))
tg_case "ops.env keys win over api.env" '
  printf "TELEGRAM_ALERT_BOT_TOKEN=fromapi\nTELEGRAM_ALERT_CHAT_ID=2\n" > "$API_ENV"
  TELEGRAM_ALERT_BOT_TOKEN=fromops; TELEGRAM_ALERT_CHAT_ID=1
  notify x
  if grep -qx "https://api.telegram.org/botfromops/sendMessage" "$tgcalls" && grep -qx "chat_id=1" "$tgcalls"; then echo "ok   ops.env keys win over api.env"
  else echo "FAIL ops.env keys win: calls: $(tr "\n" ";" < "$tgcalls")"; exit 1; fi' || failures=$((failures + 1))
tg_case "no keys anywhere: nothing sent, logged as NOT SENT, rc 0" '
  rm -f "$API_ENV"; notify "deployed abc"; rc=$?
  API_ENV="$(mktemp)"; printf "TELEGRAM_ALERT_BOT_TOKEN=only-token\n" > "$API_ENV"; notify "half"; rc2=$?
  if [[ $rc -eq 0 && $rc2 -eq 0 && ! -s "$tgcalls" ]] && grep -q "NOT SENT.*deployed abc" "$tglog" && ! grep -q only-token "$tglog"; then echo "ok   no keys anywhere: nothing sent, logged as NOT SENT, rc 0"
  else echo "FAIL no keys: rc=$rc/$rc2 calls=[$(cat "$tgcalls")] log=[$(cat "$tglog")]"; exit 1; fi' || failures=$((failures + 1))
tg_case "xtrace never prints the token" '
  printf "TELEGRAM_ALERT_BOT_TOKEN=123:SECRETTOK\nTELEGRAM_ALERT_CHAT_ID=5\n" > "$API_ENV"
  trace="$(mktemp)"
  ( set -x; notify x; notify y ) 2> "$trace"
  if grep -q SECRETTOK "$tgcalls" && ! grep -q SECRETTOK "$trace"; then echo "ok   xtrace never prints the token"
  else echo "FAIL xtrace prints the token: $(grep -c SECRETTOK "$trace") trace lines"; exit 1; fi' || failures=$((failures + 1))

# notify_once must never abort the unit when its stamp cannot be written (prod 2026-11-28: state/notified-fetch
# was root-owned, `touch` failed under set -e and the fetch-failure alert died with the unit).
( source "$here/deploy.sh"; set +e; log() { :; }
  STATE_DIR="$(mktemp -d)"; sent=""; notify() { sent="$sent|$*"; }
  n=0; touch() { n=$((n + 1)); (( n > 1 )) && command touch "$@"; }   # first touch fails (root-owned file)
  out="$( set -e; notify_once fetch "git fetch FAILING"; echo "alive:$sent" )"
  if [[ "$out" == "alive:|git fetch FAILING" && -e "$STATE_DIR/notified-fetch" ]]; then echo "ok   notify_once replaces an unwritable stamp and still alerts"
  else echo "FAIL notify_once with an unwritable stamp: out=[$out]"; exit 1; fi
) || failures=$((failures + 1))
( source "$here/deploy.sh"; set +e; log() { :; }
  STATE_DIR="$(mktemp -d)"; NOTIFY_STAMP_FALLBACK_DIR="$(mktemp -d)"; sent=""; notify() { sent="$sent|$*"; }
  # The state-dir stamp can be neither written nor replaced: the fallback stamp keeps the hourly throttle.
  touch() { [[ "$1" == "$STATE_DIR"/* ]] && return 1; command touch "$@"; }; rm() { return 1; }
  out="$( set -e; notify_once fetch "a"; notify_once fetch "b"; echo "alive:$sent" )"
  if [[ "$out" == "alive:|a" && -e "$NOTIFY_STAMP_FALLBACK_DIR/grw-deploy-notified-fetch" ]]; then echo "ok   notify_once falls back to a /tmp stamp, stays throttled and never aborts"
  else echo "FAIL notify_once with no writable state stamp: out=[$out]"; exit 1; fi
) || failures=$((failures + 1))
( source "$here/deploy.sh"; set +e; log() { :; }
  STATE_DIR="$(mktemp -d)"; NOTIFY_STAMP_FALLBACK_DIR="$(mktemp -d)"; sent=""; notify() { sent="$sent|$*"; }
  touch() { return 1; }; rm() { return 1; }   # nothing writable at all: alert every run rather than never
  out="$( set -e; notify_once fetch "a"; notify_once fetch "b"; echo "alive:$sent" )"
  if [[ "$out" == "alive:|a|b" ]]; then echo "ok   notify_once with no writable stamp anywhere still alerts and never aborts"
  else echo "FAIL notify_once with nothing writable: out=[$out]"; exit 1; fi
) || failures=$((failures + 1))
( source "$here/deploy.sh"; set +e; log() { :; }
  STATE_DIR="$(mktemp -d)"; sent=""; notify() { sent="$sent|$*"; }
  notify_once fetch "a"; notify_once fetch "b"
  if [[ "$sent" == "|a" ]]; then echo "ok   notify_once still alerts at most once an hour per key"
  else echo "FAIL notify_once throttle: sent=[$sent]"; exit 1; fi
) || failures=$((failures + 1))

if (( failures > 0 )); then echo "$failures test(s) failed"; exit 1; fi
echo "all deploy tests passed"
