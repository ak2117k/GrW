#!/usr/bin/env bash
# GrW MBM service deploy. Run ON the VPS, by hand (not wired into grw-deploy.timer yet):
#
#   sudo /opt/grw/app/scripts/deploy/mbm-deploy.sh [<git-rev>]     # default: HEAD of /opt/grw/app
#
#   build grw-mbm:<sha> on the host → up -d mbm with GRW_MBM_TAG=<sha> → wait healthy → record
#   an unhealthy swap rolls back to the previously recorded sha (or stops mbm on a first deploy).
#
# The build context is `git archive <sha>:ai-engine`, not the working tree: grw-deploy.timer may
# move /opt/grw/app to a new commit mid-build, and the archive pins the exact sha being tagged.
# Only the `mbm` service is touched (--no-deps); the API and Postgres are never recreated.
set -euo pipefail
GRW_ROOT="${GRW_ROOT:-/opt/grw}"
APP_DIR="$GRW_ROOT/app"
STATE_DIR="$GRW_ROOT/state"
HEALTH_TIMEOUT_S="${HEALTH_TIMEOUT_S:-180}"
COMPOSE=(docker compose -f "$APP_DIR/deploy/docker-compose.prod.yml" --env-file "$GRW_ROOT/env/compose.env")

log() { echo "[mbm-deploy $(date -u +%FT%TZ)] $*"; }
target_sha() { git -C "$APP_DIR" rev-parse --verify -q "${1:-HEAD}^{commit}"; }
current_sha() { cat "$STATE_DIR/mbm_sha" 2>/dev/null || true; }
image_exists() { docker image inspect "grw-mbm:$1" >/dev/null 2>&1; }
build_image() {
  git -C "$APP_DIR" archive --format=tar "$1:ai-engine" \
    | docker build -q -f Dockerfile.mbm -t "grw-mbm:$1" - >/dev/null
}
swap_to() { GRW_MBM_TAG="$1" "${COMPOSE[@]}" up -d --no-deps mbm; }
stop_mbm() { "${COMPOSE[@]}" stop mbm; }

# Healthy means: the running container IS the new image AND Docker's healthcheck
# (GET 127.0.0.1:5100/health inside the container) reports healthy.
wait_healthy() {
  local tag="$1" deadline=$((SECONDS + HEALTH_TIMEOUT_S))
  while (( SECONDS < deadline )); do
    if [[ "$(docker inspect -f '{{.Config.Image}}' grw-mbm 2>/dev/null)" == "grw-mbm:$tag" ]] \
      && [[ "$(docker inspect -f '{{.State.Health.Status}}' grw-mbm 2>/dev/null)" == "healthy" ]]; then
      return 0
    fi
    sleep 5
  done
  return 1
}

record_success() {
  mkdir -p "$STATE_DIR"
  echo "$1" > "$STATE_DIR/mbm_sha"
  # :current makes a plain `up -d mbm` (no GRW_MBM_TAG) run the last good build.
  docker tag "grw-mbm:$1" grw-mbm:current
  # Keep the three newest sha images (running + two rollback targets); :current is an alias.
  docker image ls grw-mbm --format '{{.CreatedAt}}\t{{.Tag}}' | grep -v $'\tcurrent$' | sort -r \
    | tail -n +4 | cut -f2 | xargs -r -I{} docker image rm "grw-mbm:{}" >/dev/null 2>&1 || true
}

main() {
  local new cur
  if ! new="$(target_sha "${1:-}")"; then log "unknown revision ${1:-HEAD}"; return 2; fi
  cur="$(current_sha)"
  log "deploying ${new:0:7} (current: ${cur:0:7})"
  if image_exists "$new"; then
    log "grw-mbm:${new:0:7} already built"
  elif ! build_image "$new"; then
    log "build FAILED for ${new:0:7}; mbm untouched"; return 1
  fi
  if swap_to "$new" && wait_healthy "$new"; then
    record_success "$new"; log "mbm healthy on ${new:0:7}"; return 0
  fi
  if [[ -n "$cur" && "$cur" != "$new" ]]; then
    log "${new:0:7} unhealthy; rolling back to ${cur:0:7}"
    swap_to "$cur" || true
  else
    log "${new:0:7} unhealthy and nothing to roll back to; stopping mbm"
    stop_mbm || true
  fi
  return 1
}

if [[ "${BASH_SOURCE[0]}" == "$0" ]]; then main "$@"; fi
