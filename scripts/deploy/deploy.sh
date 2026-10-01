#!/usr/bin/env bash
# GrW pull-and-deploy (run by grw-deploy.timer every 2 min).
#
#   fetch main → build image → migrate → swap → health-check → record
#   any failure before the swap leaves the running API untouched;
#   an unhealthy swap rolls back to the previous image.
#
# A sha that failed is remembered and not retried, so a broken commit does not
# rebuild every two minutes. Pushing a new commit clears it.
set -euo pipefail

GRW_ROOT="${GRW_ROOT:-/opt/grw}"
APP_DIR="$GRW_ROOT/app"
STATE_DIR="$GRW_ROOT/state"
HEALTH_URL="${HEALTH_URL:-http://127.0.0.1:3001/healthz/live}"
HEALTH_TIMEOUT_S="${HEALTH_TIMEOUT_S:-180}"
COMPOSE=(docker compose -f "$APP_DIR/deploy/docker-compose.prod.yml" --env-file "$GRW_ROOT/env/compose.env")

log() { echo "[deploy $(date -u +%FT%TZ)] $*"; }

notify() {
  [[ -n "${TELEGRAM_ALERT_BOT_TOKEN:-}" && -n "${TELEGRAM_ALERT_CHAT_ID:-}" ]] || return 0
  curl -sS -m 10 "https://api.telegram.org/bot${TELEGRAM_ALERT_BOT_TOKEN}/sendMessage" \
    --data-urlencode "chat_id=${TELEGRAM_ALERT_CHAT_ID}" \
    --data-urlencode "text=GrW deploy: $*" >/dev/null || true
}

# Alert at most once an hour per key, for conditions that persist across timer
# runs (e.g. git fetch failing), where notify() every 2 minutes would be spam.
notify_once() {
  local stamp="$STATE_DIR/notified-$1"
  mkdir -p "$STATE_DIR"
  if [[ -z "$(find "$stamp" -mmin -60 2>/dev/null)" ]]; then touch "$stamp"; notify "$2"; fi
}

# NSE session guard. Args are optional (day-of-week 1-7, HHMM) so tests need no clock.
in_market_hours() {
  local dow="${1:-$(TZ=Asia/Kolkata date +%u)}" hm="${2:-$(TZ=Asia/Kolkata date +%H%M)}"
  local start="${DEPLOY_BLOCK_START:-0900}" end="${DEPLOY_BLOCK_END:-1535}"
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

# `|| return 1` is load-bearing: this runs inside `if !`, where errexit is off, so a
# failed checkout would otherwise build the OLD tree and tag it as the new sha.
build_image() {
  checkout "$1" || return 1
  docker build -q -f "$APP_DIR/apps/api/Dockerfile" -t "grw-api:$1" "$APP_DIR" >/dev/null
}

run_migrations() {
  GRW_API_TAG="$1" "${COMPOSE[@]}" run --rm --no-deps api \
    npx prisma migrate deploy --schema prisma/schema.prisma
}

swap_to() { GRW_API_TAG="$1" "${COMPOSE[@]}" up -d --no-deps api; }

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

record_success() {
  mkdir -p "$STATE_DIR"
  echo "$1" > "$STATE_DIR/current_sha"
  rm -f "$STATE_DIR/failed_sha"
  # Keep the three newest images (current + two rollback targets).
  docker image ls grw-api --format '{{.CreatedAt}}\t{{.Tag}}' | sort -r | tail -n +4 | cut -f2 \
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

  log "deploying ${new:0:7} (current: ${cur:0:7})"
  if ! build_image "$new"; then
    mark_failed "$new"; notify "build FAILED for ${new:0:7}; still on ${cur:0:7}"; return 1
  fi
  # Re-check: a long build can start before 09:00 and finish inside the session.
  if [[ "${FORCE:-0}" != 1 ]] && in_market_hours; then
    log "built ${new:0:7}, but the session has opened; migrate and swap deferred"; return 0
  fi
  if ! run_migrations "$new"; then
    mark_failed "$new"; notify "migration FAILED for ${new:0:7}; still on ${cur:0:7}"; return 1
  fi
  # A failed swap takes the rollback path too; under bare `set -e` it would exit
  # with the old container possibly stopped, no rollback and no alert.
  if swap_to "$new" && wait_healthy "$new"; then
    record_success "$new"; notify "deployed ${new:0:7}"; return 0
  fi

  log "${new:0:7} failed to start or is unhealthy; rolling back to ${cur:0:7}"
  if [[ -n "$cur" ]]; then swap_to "$cur"; checkout "$cur"; fi
  mark_failed "$new"
  notify "deploy of ${new:0:7} FAILED to start or UNHEALTHY; rolled back to ${cur:-nothing}"
  return 1
}

if [[ "${BASH_SOURCE[0]}" == "$0" ]]; then main "$@"; fi
