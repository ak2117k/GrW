#!/usr/bin/env bash
# GrW pull-and-deploy (run by grw-deploy.timer every 2 min).
#
#   fetch main → build image → migrate → timescale setup → swap → health-check → AI agents → record
#   any failure before the swap leaves the running API untouched;
#   an unhealthy swap rolls back to the previous image.
#
# A sha that failed is remembered and not retried, so a broken commit does not
# rebuild every two minutes. Pushing a new commit clears it.
set -euo pipefail

GRW_ROOT="${GRW_ROOT:-/opt/grw}"
APP_DIR="$GRW_ROOT/app"
STATE_DIR="$GRW_ROOT/state"
IMAGE_REPO="${IMAGE_REPO:-ghcr.io/ak2117k/grw-api}"
HEALTH_URL="${HEALTH_URL:-http://127.0.0.1:3001/healthz/live}"
HEALTH_TIMEOUT_S="${HEALTH_TIMEOUT_S:-180}"
COMPOSE=(docker compose -f "$APP_DIR/deploy/docker-compose.prod.yml" --env-file "$GRW_ROOT/env/compose.env")

log() { echo "[deploy $(date -u +%FT%TZ)] $*"; }

# The alert bot's keys. The unit's ops.env has TELEGRAM_ALERT_BOT_TOKEN / _CHAT_ID EMPTY on prod; the
# real values live in the app's api.env (audit 2026-11-28: every "deployed <sha>" and deploy-failure
# alert was silently dropped). So when ops.env lacks either key, read exactly those two from api.env.
# api.env is the app's file, not shell: it is grep'ed, never sourced, and the values are never echoed.
API_ENV="${API_ENV:-$GRW_ROOT/env/api.env}"
env_file_value() { # KEY FILE -> value on stdout (surrounding quotes and a trailing CR stripped); 1 if absent/empty
  local line q
  [[ -r "$2" ]] || return 1
  line="$(grep -m1 -E "^$1=" "$2" 2>/dev/null)" || return 1
  line="${line#*=}"; line="${line%$'\r'}"
  q="${line:0:1}"
  if [[ ${#line} -ge 2 && ( "$q" == '"' || "$q" == "'" ) && "${line: -1}" == "$q" ]]; then line="${line:1:${#line}-2}"; fi
  [[ -n "$line" ]] || return 1
  printf '%s' "$line"
}
# Both keys from ops.env, or both from api.env (never a token from one file with a chat from the other).
# Sets the CALLER's locals `tok` / `chat` (bash dynamic scope): the api.env values are never assigned to
# the exported TELEGRAM_ALERT_* globals, so later children (docker, prisma, git) never inherit them.
load_alert_keys() {
  tok="${TELEGRAM_ALERT_BOT_TOKEN:-}"; chat="${TELEGRAM_ALERT_CHAT_ID:-}"
  [[ -n "$tok" && -n "$chat" ]] && return 0
  local t c
  if t="$(env_file_value TELEGRAM_ALERT_BOT_TOKEN "$API_ENV")" && c="$(env_file_value TELEGRAM_ALERT_CHAT_ID "$API_ENV")"; then
    tok="$t"; chat="$c"
  fi
  return 0
}

notify() {
  # xtrace off while the token is in play: a `bash -x` debug run must not print it. Restored after.
  local had_x=0 tok="" chat=""
  { [[ $- == *x* ]] && had_x=1; set +x; } 2>/dev/null
  load_alert_keys
  if [[ -n "$tok" && -n "$chat" ]]; then
    # The URL (it carries the token) goes in curl's config on stdin, never in argv: argv is world-readable
    # via ps / /proc/<pid>/cmdline. A here-string is not argv.
    curl -sS -m 10 -K - \
      --data-urlencode "chat_id=${chat}" \
      --data-urlencode "text=GrW deploy: $*" >/dev/null <<<"url = \"https://api.telegram.org/bot${tok}/sendMessage\"" || true
  else
    log "alert NOT SENT (no TELEGRAM_ALERT_BOT_TOKEN / TELEGRAM_ALERT_CHAT_ID in ops.env or api.env): $*"
  fi
  if (( had_x )); then set -x; fi
  return 0
}

# Alert at most once an hour per key, for conditions that persist across timer
# runs (e.g. git fetch failing), where notify() every 2 minutes would be spam.
# Never aborts the unit over its stamp: prod's state/notified-fetch was root-owned (unit runs as grw),
# so `touch` failed under set -e and the fetch-failure alert died with it. An unwritable stamp is
# replaced (state/ is grw's, so grw may unlink it), else a /tmp stamp keeps the throttle, else the
# alert goes out unthrottled: better every run than never.
NOTIFY_STAMP_FALLBACK_DIR="${NOTIFY_STAMP_FALLBACK_DIR:-${TMPDIR:-/tmp}}"
notify_once() {
  local stamp="$STATE_DIR/notified-$1" fallback="$NOTIFY_STAMP_FALLBACK_DIR/grw-deploy-notified-$1"
  mkdir -p "$STATE_DIR" 2>/dev/null || true
  if [[ -n "$(find "$stamp" -mmin -60 2>/dev/null)" || -n "$(find "$fallback" -mmin -60 2>/dev/null)" ]]; then return 0; fi
  if ! touch "$stamp" 2>/dev/null; then
    rm -f "$stamp" 2>/dev/null || true
    if ! touch "$stamp" 2>/dev/null; then
      log "cannot write $stamp (owner?); throttling via $fallback"
      touch "$fallback" 2>/dev/null || log "cannot write $fallback either; alert unthrottled"
    fi
  fi
  notify "$2"
}

# NSE session guard. Args are optional (day-of-week 1-7, HHMM) so tests need no clock.
# NSE holidays come from the app's own calendar (one source of truth): a line like
#   { date: '2026-10-20', name: 'Dussehra', exchanges: ['NSE', 'BSE', 'NFO'] },
# 2026-10-20 (Dussehra) deferred every deploy all day because this check did not know it.
HOLIDAYS_TS="${HOLIDAYS_TS:-$APP_DIR/apps/api/src/modules/market-data/services/market-holidays.service.ts}"
is_nse_holiday() {
  local day="${1:-$(TZ=Asia/Kolkata date +%F)}"
  [[ -f "$HOLIDAYS_TS" ]] && grep -qE "date: '${day}'.*'NSE'" "$HOLIDAYS_TS"
}

in_market_hours() {
  local dow="${1:-$(TZ=Asia/Kolkata date +%u)}" hm="${2:-$(TZ=Asia/Kolkata date +%H%M)}" day="${3:-$(TZ=Asia/Kolkata date +%F)}"
  local start="${DEPLOY_BLOCK_START:-0900}" end="${DEPLOY_BLOCK_END:-1535}"
  is_nse_holiday "$day" && return 1
  (( dow <= 5 )) && (( 10#$hm >= 10#$start && 10#$hm <= 10#$end ))
}

current_sha() { cat "$STATE_DIR/current_sha" 2>/dev/null || true; }
failed_sha()  { cat "$STATE_DIR/failed_sha" 2>/dev/null || true; }
mark_failed() { mkdir -p "$STATE_DIR"; echo "$1" > "$STATE_DIR/failed_sha"; }
remote_sha()  { git -C "$APP_DIR" fetch -q origin main && git -C "$APP_DIR" rev-parse origin/main; }
# Refuses a dirty tree: a checkout that half-applies would build the wrong code.
checkout() {
  [[ -z "$(git -C "$APP_DIR" status --porcelain)" ]] || { log "working tree is dirty; refusing"; return 1; }
  git -C "$APP_DIR" checkout -q --detach "$1"
}

# The image is built by GitHub Actions (.github/workflows/api-image.yml) and pushed
# to GHCR as $IMAGE_REPO:<sha>. The host only pulls: a 2 GB VPS cannot run the
# pnpm install + nest build without swapping itself to a standstill.
image_published() { docker manifest inspect "$IMAGE_REPO:$1" >/dev/null 2>&1; }

# CI takes a few minutes after a push, so "not published yet" is normal and quiet.
# Still missing after IMAGE_WAIT_ALERT_MIN means the CI build probably failed.
note_waiting() {
  local marker="$STATE_DIR/waiting-$1" limit="${IMAGE_WAIT_ALERT_MIN:-30}"
  mkdir -p "$STATE_DIR"
  [[ -e "$marker" ]] || touch "$marker"
  log "image for ${1:0:7} not published yet (CI still building?)"
  if [[ -n "$(find "$marker" -mmin +"$limit" 2>/dev/null)" ]]; then
    notify_once image "image for ${1:0:7} still not published after ${limit} min; did the GitHub build fail?"
  fi
}

# `|| return 1` is load-bearing: this runs inside `if !`, where errexit is off, so a
# failed checkout would otherwise leave the OLD compose file and scripts in place
# under the new sha. The pulled image is retagged grw-api:<sha>, the name compose
# and wait_healthy use.
fetch_image() {
  checkout "$1" || return 1
  docker pull -q "$IMAGE_REPO:$1" >/dev/null && docker tag "$IMAGE_REPO:$1" "grw-api:$1" || return 1
  # Drop the registry tag: grw-api:<sha> keeps the image, so record_success's keep-3
  # pruning actually frees disk (each version is ~2 GB on a 20 GB host).
  docker image rm "$IMAGE_REPO:$1" >/dev/null 2>&1 || true
}

run_migrations() {
  GRW_API_TAG="$1" "${COMPOSE[@]}" run --rm --no-deps api \
    npx prisma migrate deploy --schema prisma/schema.prisma
}

# TimescaleDB setup for candles_1m (hypertable, compression, retention). Idempotent and
# applied on EVERY deploy, never by a migration: a pg_restore cutover carries
# _prisma_migrations, so a one-shot migration step would never reach the restored DB.
# The SQL is from the new checkout; it runs inside the postgres container as its own
# superuser/DB (POSTGRES_USER/POSTGRES_DB), so this script needs no DB credentials.
run_timescale_sql() {
  "${COMPOSE[@]}" exec -T postgres sh -c 'psql -v ON_ERROR_STOP=0 -q -U "$POSTGRES_USER" -d "$POSTGRES_DB"' \
    < "$APP_DIR/deploy/sql/candles-timescale.sql"
}

# skip | ok | missing (see the SQL file), asked in a new psql session.
timescale_state() {
  "${COMPOSE[@]}" exec -T postgres sh -c 'psql -qtAX -U "$POSTGRES_USER" -d "$POSTGRES_DB"' \
    < "$APP_DIR/deploy/sql/candles-timescale-check.sql" 2>/dev/null | tr -d '[:space:]'
}

# The setup SQL turns its own errors into WARNINGs, so its exit code says nothing:
# verify the RESULT instead. A freshly created database needs two sessions (CREATE
# EXTENSION, then the hypertable) — the 2026-10-09 VPS cutover hit exactly that — so
# one retry, then a non-zero return for main() to alert on.
apply_timescale() {
  local state="" attempt
  for attempt in 1 2; do
    run_timescale_sql || true
    state="$(timescale_state)"
    if [[ "$state" == ok || "$state" == skip ]]; then return 0; fi
  done
  log "candles_1m TimescaleDB setup incomplete after $attempt runs (state: ${state:-unreadable})"
  return 1
}

swap_to() { GRW_API_TAG="$1" "${COMPOSE[@]}" up -d --no-deps api; }

# AI AGENTS (docs/superpowers/specs/2026-11-22-ai-agents-design.md §4.7a). Three stateless containers
# on the API's image (compose profile "agents"). Only the ones RUNNING right now are recreated, with
# the API's tag, AFTER the API is healthy: a service defined but never started (rollout step 1) stays
# off. Same tag as the API => no third image pinned, pruning unchanged. While an agent restarts the
# API serves its jobs in-process, so a deploy cannot miss an exit.
AGENT_SERVICES=(grw-agents-trading grw-agents-reading grw-agents-background)
running_agents() {
  local svc
  for svc in "${AGENT_SERVICES[@]}"; do
    [[ "$(docker inspect -f '{{.State.Running}}' "$svc" 2>/dev/null)" == true ]] && echo "$svc"
  done
  return 0
}
# Args: tag service... ; no services => nothing to do.
recreate_agents() {
  local tag="$1"; shift
  (( $# > 0 )) || return 0
  GRW_API_TAG="$tag" "${COMPOSE[@]}" --profile agents up -d --no-deps "$@"
}

# Healthy means: the running container IS the new image AND it answers. Checking
# only the URL would pass against the old container during a failed swap.
# X-Forwarded-Proto: EnforceHttpsMiddleware answers 426 to any request without it
# when NODE_ENV=production. Through the tunnel Cloudflare sets it; here we must.
wait_healthy() {
  local tag="$1" deadline=$((SECONDS + HEALTH_TIMEOUT_S))
  while (( SECONDS < deadline )); do
    if [[ "$(docker inspect -f '{{.Config.Image}}' grw-api 2>/dev/null)" == "grw-api:$tag" ]] \
      && curl -fsS -m 5 -H 'X-Forwarded-Proto: https' "$HEALTH_URL" >/dev/null 2>&1; then
      return 0
    fi
    sleep 5
  done
  return 1
}

# DISK GUARD. Each grw-api image is large and three are kept; the 20 GB host reached 88 % on
# 2026-10-19 (a full disk stops Postgres writes). Before pulling a new image: if free space on /
# is under MIN_FREE_GB, drop every grw-api image except the running one, the build cache and
# dangling layers. Still under HARD_MIN_FREE_GB afterwards => refuse the pull (not marked failed,
# so the next timer run retries once space exists).
MIN_FREE_GB="${MIN_FREE_GB:-3}"
HARD_MIN_FREE_GB="${HARD_MIN_FREE_GB:-2}"
free_gb() { df --output=avail -BG / | tail -1 | tr -dc '0-9'; }
ensure_disk_headroom() {
  local cur="$1" before after
  before="$(free_gb)"
  if (( before >= MIN_FREE_GB )); then return 0; fi
  log "disk: ${before} GB free (< ${MIN_FREE_GB}); pruning old images before the pull"
  docker image ls grw-api --format '{{.Tag}}' | grep -vx "$cur"     | xargs -r -I{} docker image rm "grw-api:{}" >/dev/null 2>&1 || true
  docker builder prune -f >/dev/null 2>&1 || true
  docker image prune -f >/dev/null 2>&1 || true
  after="$(free_gb)"
  log "disk: ${after} GB free after pruning"
  if (( after < HARD_MIN_FREE_GB )); then
    notify_once disk "server disk has only ${after} GB free even after pruning images; deploys paused"
    return 1
  fi
  return 0
}

record_success() {
  mkdir -p "$STATE_DIR"
  echo "$1" > "$STATE_DIR/current_sha"
  rm -f "$STATE_DIR/failed_sha" "$STATE_DIR"/waiting-*
  # Keep the KEEP_IMAGES newest images (default 2: current + one rollback target; each is ~1.6 GB
  # on a 20 GB disk).
  docker image ls grw-api --format '{{.CreatedAt}}\t{{.Tag}}' | sort -r | tail -n +"$(( ${KEEP_IMAGES:-2} + 1 ))" | cut -f2 \
    | xargs -r -I{} docker image rm "grw-api:{}" >/dev/null 2>&1 || true
}

main() {
  local cur new
  cur="$(current_sha)"
  if ! new="$(remote_sha)"; then
    log "git fetch failed"
    notify_once fetch "git fetch of main is FAILING on the server (deploy key? network?); no deploys until it works"
    return 0
  fi

  if [[ "$new" == "$cur" ]]; then log "up to date (${cur:0:7})"; return 0; fi
  if [[ "$new" == "$(failed_sha)" ]]; then log "${new:0:7} failed before; waiting for a new commit"; return 0; fi
  if in_market_hours && [[ "${FORCE:-0}" != 1 ]]; then log "market hours: deferring ${new:0:7}"; return 0; fi

  if ! image_published "$new"; then note_waiting "$new"; return 0; fi

  log "deploying ${new:0:7} (current: ${cur:0:7})"
  if ! ensure_disk_headroom "$cur"; then log "not enough disk to pull ${new:0:7}; will retry"; return 1; fi
  if ! fetch_image "$new"; then
    mark_failed "$new"; notify "image pull FAILED for ${new:0:7}; still on ${cur:0:7}"; return 1
  fi
  # Re-check: a slow pull can start before 09:00 and finish inside the session.
  if [[ "${FORCE:-0}" != 1 ]] && in_market_hours; then
    log "fetched ${new:0:7}, but the session has opened; migrate and swap deferred"; return 0
  fi
  if ! run_migrations "$new"; then
    mark_failed "$new"; notify "migration FAILED for ${new:0:7}; still on ${cur:0:7}"; return 1
  fi
  # Non-fatal by design: candles_1m works as a plain table, so a failed Timescale step
  # must never block a deploy. Warn and alert; the next deploy retries it.
  if ! apply_timescale "$new"; then
    log "WARNING: TimescaleDB setup for candles_1m failed for ${new:0:7}; deploying anyway"
    notify "WARNING: TimescaleDB setup (deploy/sql/candles-timescale.sql) failed for ${new:0:7}; deploy continues"
  fi
  # Which agent containers to carry along: decided BEFORE the swap, from what is running now.
  # Unquoted below on purpose: service names have no spaces, and an empty list means none.
  local agents
  agents="$(running_agents | tr '\n' ' ')"
  # A failed swap takes the rollback path too; under bare `set -e` it would exit
  # with the old container possibly stopped, no rollback and no alert.
  if swap_to "$new" && wait_healthy "$new"; then
    # Non-fatal: the API is healthy and serves any agent's jobs in-process (and alerts on the
    # fallback), so a failed agent recreate must not roll back a good API.
    # shellcheck disable=SC2086
    if ! recreate_agents "$new" $agents; then
      log "WARNING: recreating AI agents (${agents% }) on ${new:0:7} failed; the API serves their jobs in-process"
      notify "WARNING: AI agents (${agents% }) failed to recreate on ${new:0:7}; API serving their jobs in-process"
    fi
    record_success "$new"; notify "deployed ${new:0:7}"; return 0
  fi

  log "${new:0:7} failed to start or is unhealthy; rolling back to ${cur:0:7}"
  # Agents are only recreated after a healthy swap, so here they normally still run $cur and compose
  # leaves them as they are; recreating them on $cur keeps all four on one tag whatever happened.
  # shellcheck disable=SC2086
  if [[ -n "$cur" ]]; then swap_to "$cur"; recreate_agents "$cur" $agents || true; checkout "$cur"; fi
  mark_failed "$new"
  notify "deploy of ${new:0:7} FAILED to start or UNHEALTHY; rolled back to ${cur:-nothing}"
  return 1
}

if [[ "${BASH_SOURCE[0]}" == "$0" ]]; then main "$@"; fi
