# SP0 — Foundation Move Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move GrW's API, database and Redis from Render (Oregon) + Neon (Singapore) + Render Key Value onto one Oracle Always Free ARM server in India, reached through a Cloudflare Tunnel, with nightly verified backups, a self-deploying pipeline that rolls back on failure, a static egress IP registered with Angel One, and the Claude CLI authenticated for the sentinel.

**Architecture:** One `docker compose` stack on the server — `postgres` (TimescaleDB image), `redis`, `api` (the existing NestJS image), `cloudflared`. No public ports except key-only SSH; HTTPS enters through the tunnel at `api.<your-domain>`, and the existing Cloudflare Worker proxies to it. A systemd timer pulls `main` every 2 minutes, builds on the server, migrates, swaps, health-checks and rolls back. Repo-side work (Tasks 1–5) is testable locally; server-side work (Tasks 6–12) is done by the owner with the exact commands given.

**Tech Stack:** Docker Compose v2, `timescale/timescaledb:latest-pg17`, `redis:7-alpine`, `cloudflare/cloudflared`, systemd timers, bash, rclone, Node 22 (`node:test`), Oracle Cloud A1 (Ubuntu 24.04 aarch64).

**Spec:** `docs/superpowers/specs/2026-09-30-ai-trading-core-architecture-design.md` (§10 Infrastructure, §11 SP0 row, §13 Regulatory constraints)

## Global Constraints

- Server: Oracle Always Free **A1, 2 OCPU / 12 GB**, home region **India West (Mumbai) `ap-mumbai-1`**, fallback **India South (Hyderabad) `ap-hyderabad-1`**. The home region cannot be changed after signup.
- **No public ports except SSH (key-only).** All HTTPS enters through Cloudflare Tunnel.
- Trading mode is unchanged throughout SP0: `PAPER_TRADING=true`, `LIVE_TRADING_ENABLED=false`.
- **Migrations must be expand-only** (add columns/tables, never drop/rename in the same release) — rollback swaps code, not schema.
- `ENCRYPTION_KEY` and `JWT_SECRET` on the server must be **byte-identical** to Render's, or stored broker credentials cannot be decrypted and every session is invalidated.
- Secrets never enter git. Server env files are mode `600`, owned by the deploy user.
- Angel One order endpoints accept calls only from a **registered static IP** (since 2026-04-01).
- Commits use explicit pathspecs (`git commit -- <paths>`), never bare `git commit` or `-a`.
- Deploys never restart the API during the NSE session (Mon–Fri 09:00–15:35 IST) unless `FORCE=1`.

## Review Focus

1. **A migration that fails** must leave the old API running untouched — no swap. (Task 3, test case "migration fails")
2. **A health check that passes against the OLD container** must not count as success — health requires the running container's image to be the new tag. (Task 3, `wait_healthy` checks the image; test case "unhealthy rolls back")
3. **A deploy landing mid-session** must be deferred, not executed. (Task 3, `in_market_hours` tests)
4. **A backup that is empty, unreadable, or never left the box** must fail loudly, not report success. (Task 4, backup tests for tiny dump and missing remotes)
5. **Writes landing on Neon after the dump** must be impossible during cutover — Render is suspended before the dump is taken, and row counts are compared after restore. (Task 8 steps 1 and 5)

---

## File Structure

| Path | Responsibility |
|---|---|
| `deploy/docker-compose.prod.yml` | The production stack: postgres, redis, api, cloudflared |
| `deploy/env/compose.env.example` | Template for compose-level secrets (DB/Redis passwords, tunnel token) |
| `deploy/env/api.env.example` | Template for the API's environment (copied from Render + new keys) |
| `deploy/env/ops.env.example` | Template for ops scripts (Telegram alerts, backup remotes) |
| `deploy/rclone.conf.example` | Template for Oracle Object Storage + Cloudflare R2 remotes |
| `deploy/systemd/grw-deploy.{service,timer}` | Pull-and-deploy every 2 min |
| `deploy/systemd/grw-backup.{service,timer}` | Nightly backup |
| `deploy/systemd/grw-restore-test.{service,timer}` | Monthly restore test |
| `scripts/deploy/deploy.sh` | Build → migrate → swap → health → rollback |
| `scripts/deploy/deploy.test.sh` | Unit tests for `deploy.sh` via function stubs |
| `scripts/ops/compare-counts.sh` | Exact per-table row counts of two databases, diffed |
| `scripts/ops/backup.sh` | Dump → verify → rotate → copy off-site |
| `scripts/ops/restore-test.sh` | Restore newest dump into a scratch DB and compare counts |
| `scripts/ops/ops.test.sh` | Tests for compare-counts and backup against local Docker Postgres |
| `scripts/ops/latency-probe.sh` | p50/p95 of an endpoint, for the before/after record |
| `apps/api/Dockerfile` | Adds the pinned Claude Code CLI |
| `worker/index.js`, `worker/package.json`, `worker/index.test.mjs` | Worker origin from `env.API_ORIGIN`, tested |
| `wrangler.jsonc` | `vars.API_ORIGIN` |
| `.github/workflows/{ml,telegram}-heartbeat.yml` | API URL from repo variable |
| `docs/deploy/ORACLE-RUNBOOK.md` | Operating the new host; replaces Render/Neon runbooks |

---

### Task 1: Production compose stack and env templates

**Files:**
- Create: `deploy/docker-compose.prod.yml`
- Create: `deploy/env/compose.env.example`
- Create: `deploy/env/api.env.example`
- Create: `deploy/env/ops.env.example`

**Interfaces:**
- Produces: compose project `grw`; container names `grw-postgres`, `grw-redis`, `grw-api`, `grw-cloudflared`; service `api` image `grw-api:${GRW_API_TAG}`; API reachable on host at `127.0.0.1:3001`; env files expected at `/opt/grw/env/{compose,api,ops}.env`.

- [ ] **Step 1: Write `deploy/docker-compose.prod.yml`**

```yaml
# GrW production stack — one Oracle A1 host (see docs/deploy/ORACLE-RUNBOOK.md).
# Run from the repo root on the server:
#   docker compose -f deploy/docker-compose.prod.yml --env-file /opt/grw/env/compose.env up -d
# No service publishes a public port. The API binds 127.0.0.1 only, for the deploy
# health check; the internet reaches it through cloudflared.
name: grw

services:
  postgres:
    image: timescale/timescaledb:latest-pg17
    container_name: grw-postgres
    restart: unless-stopped
    environment:
      POSTGRES_USER: ${PG_USER}
      POSTGRES_PASSWORD: ${PG_PASSWORD}
      POSTGRES_DB: ${PG_DB}
    # Sized for a 12 GB host that also runs the API and Redis (~3 GB for Postgres).
    command: >
      postgres
      -c shared_buffers=2GB
      -c effective_cache_size=6GB
      -c work_mem=16MB
      -c maintenance_work_mem=256MB
      -c max_connections=100
      -c timescaledb.telemetry_level=off
    volumes:
      - pgdata:/var/lib/postgresql/data
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U ${PG_USER} -d ${PG_DB}"]
      interval: 10s
      timeout: 5s
      retries: 10

  redis:
    image: redis:7-alpine
    container_name: grw-redis
    restart: unless-stopped
    # noeviction: Bull queues must never have keys evicted under memory pressure.
    command:
      - redis-server
      - --requirepass
      - ${REDIS_PASSWORD}
      - --appendonly
      - "yes"
      - --maxmemory
      - 512mb
      - --maxmemory-policy
      - noeviction
    volumes:
      - redisdata:/data
    healthcheck:
      test: ["CMD", "redis-cli", "-a", "${REDIS_PASSWORD}", "--no-auth-warning", "ping"]
      interval: 10s
      timeout: 5s
      retries: 10

  api:
    image: grw-api:${GRW_API_TAG:-current}
    container_name: grw-api
    restart: unless-stopped
    env_file:
      - /opt/grw/env/api.env
    environment:
      PORT: "3001"
      DATABASE_URL: postgresql://${PG_USER}:${PG_PASSWORD}@postgres:5432/${PG_DB}?connection_limit=20
      DIRECT_URL: postgresql://${PG_USER}:${PG_PASSWORD}@postgres:5432/${PG_DB}
      REDIS_HOST: redis
      REDIS_PORT: "6379"
      REDIS_PASSWORD: ${REDIS_PASSWORD}
      REDIS_TLS: "false"
      REDIS_ALLOW_PLAINTEXT: "true"
    ports:
      - "127.0.0.1:3001:3001"
    depends_on:
      postgres:
        condition: service_healthy
      redis:
        condition: service_healthy

  cloudflared:
    image: cloudflare/cloudflared:latest
    container_name: grw-cloudflared
    restart: unless-stopped
    command: tunnel --no-autoupdate run
    environment:
      TUNNEL_TOKEN: ${TUNNEL_TOKEN}

volumes:
  pgdata: {}
  redisdata: {}
```

- [ ] **Step 2: Write `deploy/env/compose.env.example`**

```bash
# Copy to /opt/grw/env/compose.env on the server, chmod 600. Never commit the real file.
# Generate passwords with: openssl rand -base64 32 | tr -d '/+=' | cut -c1-32
PG_USER=grw
PG_PASSWORD=
PG_DB=grw
REDIS_PASSWORD=
# From Cloudflare Zero Trust → Networks → Tunnels → grw → install connector (the long token)
TUNNEL_TOKEN=
```

- [ ] **Step 3: Write `deploy/env/api.env.example`**

```bash
# Copy to /opt/grw/env/api.env on the server, chmod 600. Never commit the real file.
# RULE: copy EVERY key from Render → grw-api → Environment first, then apply the
# overrides below. DATABASE_URL / DIRECT_URL / REDIS_* are set by the compose file
# and must NOT appear here.

NODE_ENV=production
PAPER_TRADING=true
LIVE_TRADING_ENABLED=false
BILLING_PROVIDER=fake
LIVE_BILLING_ENABLED=false
REDIS_THROTTLER=true
CRON_LEASE_ENABLED=true

# MUST be byte-identical to Render's values (encrypted broker credentials, live sessions).
JWT_SECRET=
ENCRYPTION_KEY=

WEB_ORIGIN=https://grw.ak-2117k.workers.dev
CHARTINK_WEBHOOK_SECRET=
ML_TRIGGER_SECRET=
TELEGRAM_INGEST_SECRET=
AI_ENGINE_URL=https://ai-engine.invalid

# Sentinel on the owner's Claude subscription (personal MVP only — see spec §9.4).
SENTINEL_SHADOW_ENABLED=true
SENTINEL_JUDGE=cli
CLAUDE_CODE_OAUTH_TOKEN=
SENTINEL_MODEL_TRIGGERED=claude-opus-5-5
SENTINEL_EFFORT_TRIGGERED=high
SENTINEL_MODEL_ROUTINE=claude-sonnet-5-5
SENTINEL_EFFORT_ROUTINE=medium
```

- [ ] **Step 4: Write `deploy/env/ops.env.example`**

```bash
# Copy to /opt/grw/env/ops.env on the server, chmod 600. Read by the systemd units.
PG_CONTAINER=grw-postgres
PG_USER=grw
PG_DB=grw
BACKUP_DIR=/opt/grw/backups
# Space-separated rclone remotes (see deploy/rclone.conf.example)
BACKUP_REMOTES="oci:grw-backups r2:grw-backups"
# Telegram bot for deploy/backup alerts (optional but strongly recommended)
TELEGRAM_ALERT_BOT_TOKEN=
TELEGRAM_ALERT_CHAT_ID=
```

- [ ] **Step 5: Validate the compose file**

Run (repo root, any machine with Docker):
```bash
PG_USER=u PG_PASSWORD=p PG_DB=d REDIS_PASSWORD=r TUNNEL_TOKEN=t \
  docker compose -f deploy/docker-compose.prod.yml config --quiet && echo VALID
```
Expected: `VALID` (a warning that `/opt/grw/env/api.env` is missing is acceptable locally; an error about YAML or unknown keys is not).

- [ ] **Step 6: Commit**

```bash
git add deploy/docker-compose.prod.yml deploy/env/compose.env.example deploy/env/api.env.example deploy/env/ops.env.example
git commit -m "feat(deploy): production compose stack and env templates for the Oracle host" -- deploy/docker-compose.prod.yml deploy/env/compose.env.example deploy/env/api.env.example deploy/env/ops.env.example
```

---

### Task 2: Claude Code CLI inside the API image

**Files:**
- Modify: `apps/api/Dockerfile` (after the `corepack` line, before `WORKDIR /app`)

**Interfaces:**
- Produces: a `claude` executable on `PATH` inside `grw-api:*` images, version pinned by build arg `CLAUDE_CODE_VERSION` (default `2.1.285`). The sentinel's `ClaudeCliTransport` spawns `claude` and passes `CLAUDE_CODE_OAUTH_TOKEN` through unchanged.

- [ ] **Step 1: Write the failing check**

Run: `docker build -f apps/api/Dockerfile -t grw-api:cli-check . && docker run --rm grw-api:cli-check claude --version`
Expected: FAIL — `exec: "claude": executable file not found in $PATH`.

- [ ] **Step 2: Add the CLI to the Dockerfile**

Insert after `RUN corepack enable && corepack prepare pnpm@10.33.0 --activate`:

```dockerfile
# Claude Code CLI for the sentinel's `cli` judge transport (SENTINEL_JUDGE=cli).
# Pinned: an unpinned CLI can change its JSON envelope or flags under a running
# system. Authenticates headlessly via CLAUDE_CODE_OAUTH_TOKEN (from
# `claude setup-token`); the transport strips ANTHROPIC_API_KEY so it can never
# silently bill the API instead.
ARG CLAUDE_CODE_VERSION=2.1.285
RUN npm install -g @anthropic-ai/claude-code@${CLAUDE_CODE_VERSION} \
  && npm cache clean --force
```

- [ ] **Step 3: Run the check again**

Run: `docker build -f apps/api/Dockerfile -t grw-api:cli-check . && docker run --rm grw-api:cli-check claude --version`
Expected: PASS — prints `2.1.285 (Claude Code)`.

- [ ] **Step 4: Confirm the API still boots in the image**

Run: `docker run --rm grw-api:cli-check node -e "require('/app/apps/api/dist/main.js')" 2>&1 | head -5`
Expected: boot log lines (it will then fail to reach a database — that is fine); no `MODULE_NOT_FOUND`.

- [ ] **Step 5: Commit**

```bash
git add apps/api/Dockerfile
git commit -m "feat(deploy): ship a pinned Claude Code CLI in the API image for the cli judge" -- apps/api/Dockerfile
```

---

### Task 3: Deploy script with health check and rollback

**Files:**
- Create: `scripts/deploy/deploy.sh`
- Create: `scripts/deploy/deploy.test.sh`
- Create: `deploy/systemd/grw-deploy.service`
- Create: `deploy/systemd/grw-deploy.timer`

**Interfaces:**
- Consumes: `deploy/docker-compose.prod.yml` (Task 1), `/opt/grw/env/{compose,ops}.env`.
- Produces: `deploy.sh` functions `main`, `in_market_hours [dow hm]`, `current_sha`, `remote_sha`, `failed_sha`, `mark_failed <sha>`, `build_image <sha>`, `run_migrations <sha>`, `swap_to <sha>`, `wait_healthy <sha>`, `checkout <sha>`, `record_success <sha>`, `notify <text>`. State files `/opt/grw/state/current_sha` and `/opt/grw/state/failed_sha`.

- [ ] **Step 1: Write the failing tests**

`scripts/deploy/deploy.test.sh`:

```bash
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

check() { # name want_exit want_calls got_exit
  local got="${CALLS[*]:-}"
  if [[ "$4" == "$2" && "$got" == "$3" ]]; then echo "ok   $1"
  else echo "FAIL $1: exit $4 (want $2), calls [$got] (want [$3])"; failures=$((failures + 1)); fi
}

( stub; main; check "happy path" 0 "build:new migrate:new swap:new health:new record:new" $? )
( stub; run_migrations() { CALLS+=("migrate:$1"); return 1; }
  main; check "migration fails: no swap" 1 "build:new migrate:new mark_failed:new" $? )
( stub; build_image() { CALLS+=("build:$1"); return 1; }
  main; check "build fails: no migrate, no swap" 1 "build:new mark_failed:new" $? )
( stub; wait_healthy() { CALLS+=("health:$1"); return 1; }
  main; check "unhealthy rolls back" 1 "build:new migrate:new swap:new health:new swap:old checkout:old mark_failed:new" $? )
( stub; current_sha() { echo ""; }; wait_healthy() { CALLS+=("health:$1"); return 1; }
  main; check "first deploy unhealthy: nothing to roll back to" 1 "build:new migrate:new swap:new health:new mark_failed:new" $? )
( stub; in_market_hours() { return 0; }
  main; check "market hours defers" 0 "" $? )
( stub; in_market_hours() { return 0; }; FORCE=1
  main; check "FORCE=1 overrides market hours" 0 "build:new migrate:new swap:new health:new record:new" $? )
( stub; remote_sha() { echo old; }
  main; check "up to date does nothing" 0 "" $? )
( stub; failed_sha() { echo new; }
  main; check "known-bad sha is not retried" 0 "" $? )

# in_market_hours takes explicit (dow, HHMM) so it is testable without a clock.
( source "$here/deploy.sh"
  t() { if in_market_hours "$1" "$2"; then r=0; else r=1; fi
        if [[ $r == "$3" ]]; then echo "ok   in_market_hours $1 $2"; else echo "FAIL in_market_hours $1 $2 -> $r (want $3)"; exit 1; fi; }
  t 3 1000 0; t 3 0859 1; t 3 0900 0; t 5 1535 0; t 5 1536 1; t 6 1000 1; t 7 1000 1 ) || failures=$((failures + 1))

if (( failures > 0 )); then echo "$failures test(s) failed"; exit 1; fi
echo "all deploy tests passed"
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `bash scripts/deploy/deploy.test.sh`
Expected: FAIL — `deploy.sh: No such file or directory`.

- [ ] **Step 3: Write `scripts/deploy/deploy.sh`**

```bash
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
checkout()    { git -C "$APP_DIR" checkout -q --detach "$1"; }

build_image() {
  checkout "$1"
  docker build -q -f "$APP_DIR/apps/api/Dockerfile" -t "grw-api:$1" "$APP_DIR" >/dev/null
}

run_migrations() {
  GRW_API_TAG="$1" "${COMPOSE[@]}" run --rm --no-deps api \
    npx prisma migrate deploy --schema prisma/schema.prisma
}

swap_to() { GRW_API_TAG="$1" "${COMPOSE[@]}" up -d --no-deps api; }

# Healthy means: the running container IS the new image AND it answers. Checking
# only the URL would pass against the old container during a failed swap.
wait_healthy() {
  local tag="$1" deadline=$((SECONDS + HEALTH_TIMEOUT_S))
  while (( SECONDS < deadline )); do
    if [[ "$(docker inspect -f '{{.Config.Image}}' grw-api 2>/dev/null)" == "grw-api:$tag" ]] \
      && curl -fsS -m 5 "$HEALTH_URL" >/dev/null 2>&1; then
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
  new="$(remote_sha)"

  if [[ "$new" == "$cur" ]]; then log "up to date (${cur:0:7})"; return 0; fi
  if [[ "$new" == "$(failed_sha)" ]]; then log "${new:0:7} failed before; waiting for a new commit"; return 0; fi
  if in_market_hours && [[ "${FORCE:-0}" != 1 ]]; then log "market hours: deferring ${new:0:7}"; return 0; fi

  log "deploying ${new:0:7} (current: ${cur:0:7})"
  if ! build_image "$new"; then
    mark_failed "$new"; notify "build FAILED for ${new:0:7}; still on ${cur:0:7}"; return 1
  fi
  if ! run_migrations "$new"; then
    mark_failed "$new"; notify "migration FAILED for ${new:0:7}; still on ${cur:0:7}"; return 1
  fi
  swap_to "$new"
  if wait_healthy "$new"; then
    record_success "$new"; notify "deployed ${new:0:7}"; return 0
  fi

  log "${new:0:7} unhealthy; rolling back to ${cur:0:7}"
  if [[ -n "$cur" ]]; then swap_to "$cur"; checkout "$cur"; fi
  mark_failed "$new"
  notify "deploy of ${new:0:7} UNHEALTHY; rolled back to ${cur:-nothing}"
  return 1
}

if [[ "${BASH_SOURCE[0]}" == "$0" ]]; then main "$@"; fi
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `bash scripts/deploy/deploy.test.sh`
Expected: every line `ok ...`, final line `all deploy tests passed`, exit 0.

- [ ] **Step 5: Write the systemd units**

`deploy/systemd/grw-deploy.service`:
```ini
[Unit]
Description=GrW pull-and-deploy
After=docker.service network-online.target
Wants=network-online.target

[Service]
Type=oneshot
User=grw
EnvironmentFile=/opt/grw/env/ops.env
# Copy first: deploy.sh checks out new commits, which rewrites the file bash is reading.
ExecStart=/bin/bash -c 'cp /opt/grw/app/scripts/deploy/deploy.sh /tmp/grw-deploy.sh && exec /bin/bash /tmp/grw-deploy.sh'
```

`deploy/systemd/grw-deploy.timer`:
```ini
[Unit]
Description=Run GrW deploy every 2 minutes

[Timer]
OnBootSec=2min
OnUnitActiveSec=2min

[Install]
WantedBy=timers.target
```

- [ ] **Step 6: Commit**

```bash
git add scripts/deploy/deploy.sh scripts/deploy/deploy.test.sh deploy/systemd/grw-deploy.service deploy/systemd/grw-deploy.timer
git commit -m "feat(deploy): pull-and-deploy with migrate-before-swap, image-verified health and rollback" -- scripts/deploy/deploy.sh scripts/deploy/deploy.test.sh deploy/systemd/grw-deploy.service deploy/systemd/grw-deploy.timer
```

---

### Task 4: Backup, restore test and row-count comparison

**Files:**
- Create: `scripts/ops/compare-counts.sh`
- Create: `scripts/ops/backup.sh`
- Create: `scripts/ops/restore-test.sh`
- Create: `scripts/ops/ops.test.sh`
- Create: `deploy/rclone.conf.example`
- Create: `deploy/systemd/grw-backup.service`, `deploy/systemd/grw-backup.timer`
- Create: `deploy/systemd/grw-restore-test.service`, `deploy/systemd/grw-restore-test.timer`

**Interfaces:**
- Produces: `compare-counts.sh <src_url> <dst_url>` → exit 0 if every `public` base table has identical exact row counts, 1 otherwise (diff printed). `backup.sh` → exit 0 success, 1 dump too small/unreadable, 2 no remotes configured, 3 remote copy failed. `restore-test.sh` → exit 0 when the newest dump restores with identical counts. All use `PSQL` (default `docker exec -i $PG_CONTAINER psql`) so they run against local Docker Postgres or the server.

- [ ] **Step 1: Write the failing tests**

`scripts/ops/ops.test.sh` (needs the dev Postgres: `docker compose up -d postgres` from the repo root):

```bash
#!/usr/bin/env bash
# Tests compare-counts.sh and backup.sh against the local dev Postgres (td-postgres).
set -uo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
export PG_CONTAINER=td-postgres PG_USER=postgres PG_DB=td_automation
psqlc() { docker exec -i td-postgres psql -U postgres -v ON_ERROR_STOP=1 -qAt "$@"; }
failures=0
expect() { if [[ "$2" == "$3" ]]; then echo "ok   $1"; else echo "FAIL $1: got $2 want $3"; failures=$((failures+1)); fi; }

psqlc -d postgres -c "DROP DATABASE IF EXISTS ops_a" -c "DROP DATABASE IF EXISTS ops_b" \
      -c "CREATE DATABASE ops_a" -c "CREATE DATABASE ops_b"
for db in ops_a ops_b; do psqlc -d $db -c "CREATE TABLE t (id int); INSERT INTO t SELECT generate_series(1,5)"; done
A=postgresql://postgres:password@localhost:5432/ops_a
B=postgresql://postgres:password@localhost:5432/ops_b

bash "$here/compare-counts.sh" "$A" "$B" >/dev/null; expect "equal counts pass" $? 0
psqlc -d ops_b -c "INSERT INTO t VALUES (6)"
bash "$here/compare-counts.sh" "$A" "$B" >/dev/null; expect "differing counts fail" $? 1
psqlc -d ops_b -c "CREATE TABLE extra (id int)"
bash "$here/compare-counts.sh" "$A" "$A" >/dev/null; expect "same db passes" $? 0

tmp="$(mktemp -d)"
BACKUP_DIR="$tmp" MIN_BYTES=999999999 BACKUP_REMOTES="" bash "$here/backup.sh" 2>/dev/null
expect "tiny dump refused" $? 1
expect "refused dump not kept" "$(ls "$tmp" | wc -l | tr -d ' ')" 0
BACKUP_DIR="$tmp" MIN_BYTES=1 BACKUP_REMOTES="" bash "$here/backup.sh" 2>/dev/null
expect "no remotes is a failure" $? 2
expect "local dump still written" "$(ls "$tmp"/grw-*.dump | wc -l | tr -d ' ')" 1

psqlc -d postgres -c "DROP DATABASE ops_a" -c "DROP DATABASE ops_b"; rm -rf "$tmp"
if (( failures > 0 )); then echo "$failures test(s) failed"; exit 1; fi
echo "all ops tests passed"
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `docker compose up -d postgres && bash scripts/ops/ops.test.sh`
Expected: FAIL — `compare-counts.sh: No such file or directory`.

- [ ] **Step 3: Write `scripts/ops/compare-counts.sh`**

```bash
#!/usr/bin/env bash
# Exact row counts for every base table in `public`, for two databases, diffed.
# Usage: compare-counts.sh <src_url> <dst_url>     exit 0 = identical, 1 = differ
set -euo pipefail
PSQL="${PSQL:-docker exec -i ${PG_CONTAINER:-grw-postgres} psql}"

counts() {
  # \gexec runs each generated SELECT; exact count(*), not planner estimates.
  $PSQL "$1" -qAt -F $'\t' -v ON_ERROR_STOP=1 <<'SQL' | sort
SELECT format('SELECT %L, count(*) FROM %I.%I', table_name, table_schema, table_name)
FROM information_schema.tables
WHERE table_schema = 'public' AND table_type = 'BASE TABLE'
ORDER BY table_name
\gexec
SQL
}

src="$(counts "$1")"
dst="$(counts "$2")"
if [[ "$src" == "$dst" ]]; then
  echo "counts match ($(wc -l <<<"$src" | tr -d ' ') tables)"
  exit 0
fi
diff <(echo "$src") <(echo "$dst") || true
exit 1
```

- [ ] **Step 4: Write `scripts/ops/backup.sh`**

```bash
#!/usr/bin/env bash
# Nightly backup: dump → verify readable and non-trivial → keep 7 locally → copy
# to every configured rclone remote. Exit codes: 1 bad dump, 2 no remotes, 3 copy failed.
# A backup that never left the box is reported as a failure, not a success.
set -euo pipefail
PG_CONTAINER="${PG_CONTAINER:-grw-postgres}"
PG_USER="${PG_USER:-grw}"
PG_DB="${PG_DB:-grw}"
BACKUP_DIR="${BACKUP_DIR:-/opt/grw/backups}"
KEEP_LOCAL="${KEEP_LOCAL:-7}"
MIN_BYTES="${MIN_BYTES:-100000}"
REMOTES="${BACKUP_REMOTES:-}"

mkdir -p "$BACKUP_DIR"
file="$BACKUP_DIR/grw-$(date -u +%Y%m%dT%H%M%SZ).dump"
docker exec "$PG_CONTAINER" pg_dump -U "$PG_USER" -d "$PG_DB" -Fc > "$file.partial"

size=$(stat -c %s "$file.partial")
if (( size < MIN_BYTES )); then
  echo "backup: dump is $size bytes (< $MIN_BYTES) — refusing it" >&2
  rm -f "$file.partial"; exit 1
fi
if ! docker exec -i "$PG_CONTAINER" pg_restore --list < "$file.partial" > /dev/null; then
  echo "backup: dump is not a readable archive" >&2
  rm -f "$file.partial"; exit 1
fi
mv "$file.partial" "$file"
ls -1t "$BACKUP_DIR"/grw-*.dump | tail -n +$((KEEP_LOCAL + 1)) | xargs -r rm -f

if [[ -z "$REMOTES" ]]; then
  echo "backup: BACKUP_REMOTES is empty — $file exists only on this host" >&2; exit 2
fi
for r in $REMOTES; do
  rclone copy "$file" "$r" || { echo "backup: copy to $r FAILED" >&2; exit 3; }
done
echo "backup: $file ($size bytes) → $REMOTES"
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `bash scripts/ops/ops.test.sh`
Expected: all `ok ...` lines, final `all ops tests passed`, exit 0.

- [ ] **Step 6: Write `scripts/ops/restore-test.sh`**

```bash
#!/usr/bin/env bash
# Monthly proof that backups restore: newest dump → scratch DB → identical row counts.
set -euo pipefail
PG_CONTAINER="${PG_CONTAINER:-grw-postgres}"
PG_USER="${PG_USER:-grw}"
PG_DB="${PG_DB:-grw}"
BACKUP_DIR="${BACKUP_DIR:-/opt/grw/backups}"

dump="$(ls -1t "$BACKUP_DIR"/grw-*.dump | head -1)"
[[ -n "$dump" ]] || { echo "restore-test: no dump in $BACKUP_DIR" >&2; exit 1; }

psqlc() { docker exec -i "$PG_CONTAINER" psql -U "$PG_USER" -d postgres -v ON_ERROR_STOP=1 -qc "$1"; }
q() { docker exec -i "$PG_CONTAINER" psql -U "$PG_USER" -d "$1" -qAt -v ON_ERROR_STOP=1 -c "$2"; }
tables_sql="SELECT table_name FROM information_schema.tables WHERE table_schema='public' AND table_type='BASE TABLE' ORDER BY 1"

psqlc "DROP DATABASE IF EXISTS grw_restore_test"
psqlc "CREATE DATABASE grw_restore_test"
rc=0
# --exit-on-error: our own dumps have no foreign roles, so ANY restore error is a failure.
docker exec -i "$PG_CONTAINER" pg_restore -U "$PG_USER" -d grw_restore_test \
  --no-owner --no-privileges --exit-on-error < "$dump" || { echo "restore-test: pg_restore failed" >&2; rc=1; }

if (( rc == 0 )); then
  # Row counts legitimately drift after the dump, so the proof is structural plus two anchors:
  #   same set of tables as live · same applied migrations as live · real data present.
  [[ "$(q grw_restore_test "$tables_sql")" == "$(q "$PG_DB" "$tables_sql")" ]] \
    || { echo "restore-test: table set differs from live" >&2; rc=1; }
  [[ "$(q grw_restore_test 'SELECT count(*) FROM _prisma_migrations')" == "$(q "$PG_DB" 'SELECT count(*) FROM _prisma_migrations')" ]] \
    || { echo "restore-test: applied migrations differ from live" >&2; rc=1; }
  (( "$(q grw_restore_test 'SELECT count(*) FROM users')" > 0 )) \
    || { echo "restore-test: users table is empty in the restore" >&2; rc=1; }
fi

psqlc "DROP DATABASE grw_restore_test"
(( rc == 0 )) && echo "restore-test: $dump restored OK"
exit $rc
```

Note for the implementer: the live database keeps changing after the dump, so exact row counts cannot be compared here. Exact-count equality against a frozen source is proven once, at cutover (Task 8 Step 5). A migration deployed between the dump and the test makes the `_prisma_migrations` anchor fail — rerun the backup, then the test.

- [ ] **Step 7: Write the rclone template and systemd units**

`deploy/rclone.conf.example` (copy to `~grw/.config/rclone/rclone.conf`, mode 600):
```ini
# Oracle Object Storage via its S3-compatible API.
# Keys: OCI Console → Profile → Customer secret keys. Namespace: Tenancy details.
[oci]
type = s3
provider = Other
access_key_id =
secret_access_key =
endpoint = https://<namespace>.compat.objectstorage.ap-mumbai-1.oraclecloud.com
region = ap-mumbai-1

# Cloudflare R2 (10 GB free). Keys: R2 → Manage API tokens.
[r2]
type = s3
provider = Cloudflare
access_key_id =
secret_access_key =
endpoint = https://<account-id>.r2.cloudflarestorage.com
```

`deploy/systemd/grw-backup.service`:
```ini
[Unit]
Description=GrW nightly Postgres backup
After=docker.service

[Service]
Type=oneshot
User=grw
EnvironmentFile=/opt/grw/env/ops.env
ExecStart=/bin/bash /opt/grw/app/scripts/ops/backup.sh
ExecStopPost=/bin/bash -c '[ "$SERVICE_RESULT" = success ] || curl -sS -m 10 "https://api.telegram.org/bot${TELEGRAM_ALERT_BOT_TOKEN}/sendMessage" --data-urlencode "chat_id=${TELEGRAM_ALERT_CHAT_ID}" --data-urlencode "text=GrW BACKUP FAILED ($EXIT_STATUS)" >/dev/null || true'
```

`deploy/systemd/grw-backup.timer` (00:15 IST, after MCX close):
```ini
[Unit]
Description=GrW nightly backup at 00:15 IST

[Timer]
OnCalendar=*-*-* 18:45:00 UTC
Persistent=true

[Install]
WantedBy=timers.target
```

`deploy/systemd/grw-restore-test.service`:
```ini
[Unit]
Description=GrW monthly restore test
After=docker.service

[Service]
Type=oneshot
User=grw
EnvironmentFile=/opt/grw/env/ops.env
EnvironmentFile=/opt/grw/env/compose.env
ExecStart=/bin/bash /opt/grw/app/scripts/ops/restore-test.sh
ExecStopPost=/bin/bash -c 'curl -sS -m 10 "https://api.telegram.org/bot${TELEGRAM_ALERT_BOT_TOKEN}/sendMessage" --data-urlencode "chat_id=${TELEGRAM_ALERT_CHAT_ID}" --data-urlencode "text=GrW restore test: $SERVICE_RESULT" >/dev/null || true'
```

`deploy/systemd/grw-restore-test.timer`:
```ini
[Unit]
Description=GrW restore test on the 1st of each month

[Timer]
OnCalendar=*-*-01 19:30:00 UTC
Persistent=true

[Install]
WantedBy=timers.target
```

- [ ] **Step 8: Commit**

```bash
git add scripts/ops/compare-counts.sh scripts/ops/backup.sh scripts/ops/restore-test.sh scripts/ops/ops.test.sh deploy/rclone.conf.example deploy/systemd/grw-backup.service deploy/systemd/grw-backup.timer deploy/systemd/grw-restore-test.service deploy/systemd/grw-restore-test.timer
git commit -m "feat(ops): verified nightly backups, off-site copies, monthly restore test, row-count diff" -- scripts/ops/compare-counts.sh scripts/ops/backup.sh scripts/ops/restore-test.sh scripts/ops/ops.test.sh deploy/rclone.conf.example deploy/systemd/grw-backup.service deploy/systemd/grw-backup.timer deploy/systemd/grw-restore-test.service deploy/systemd/grw-restore-test.timer
```

---

### Task 5: Worker origin and workflow URLs become configuration

**Files:**
- Modify: `worker/index.js`
- Create: `worker/package.json`
- Create: `worker/index.test.mjs`
- Modify: `wrangler.jsonc` (add `vars`)
- Modify: `.github/workflows/ml-heartbeat.yml:37`, `.github/workflows/telegram-heartbeat.yml:35`
- Create: `scripts/ops/latency-probe.sh`

**Interfaces:**
- Produces: `apiOrigin(env)` exported from `worker/index.js`, returning `env.API_ORIGIN` or the Render fallback; `wrangler.jsonc` `vars.API_ORIGIN`; workflows read `vars.API_BASE_URL`. No behaviour change until Task 9 sets the values.

- [ ] **Step 1: Write the failing test**

`worker/package.json`:
```json
{ "type": "module", "private": true }
```

`worker/index.test.mjs`:
```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import worker, { apiOrigin } from './index.js';

test('apiOrigin prefers env.API_ORIGIN', () => {
  assert.equal(apiOrigin({ API_ORIGIN: 'https://api.example.in' }), 'https://api.example.in');
});

test('apiOrigin falls back to the Render origin when unset', () => {
  assert.equal(apiOrigin({}), 'https://grw-api.onrender.com');
});

test('API paths are proxied to the configured origin with path and query intact', async () => {
  let seen;
  globalThis.fetch = async (url) => { seen = url; return new Response('ok'); };
  const env = { API_ORIGIN: 'https://api.example.in', ASSETS: { fetch: () => new Response('asset') } };
  await worker.fetch(new Request('https://grw.example.dev/api/market?x=1'), env);
  assert.equal(seen, 'https://api.example.in/api/market?x=1');
});

test('non-API paths are served from assets', async () => {
  const env = { ASSETS: { fetch: () => new Response('asset') } };
  const res = await worker.fetch(new Request('https://grw.example.dev/dashboard'), env);
  assert.equal(await res.text(), 'asset');
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test worker/`
Expected: FAIL — `does not provide an export named 'apiOrigin'`.

- [ ] **Step 3: Implement in `worker/index.js`**

Replace the `const API_ORIGIN = ...` line and the proxy `return` with:

```js
// The API origin comes from wrangler.jsonc `vars.API_ORIGIN` (the Oracle host's
// tunnel hostname). The Render URL remains only as a fallback so a missing var
// fails over to the old host instead of to nothing.
const FALLBACK_API_ORIGIN = 'https://grw-api.onrender.com';

export function apiOrigin(env) {
  return env.API_ORIGIN || FALLBACK_API_ORIGIN;
}
```

and inside `fetch`:

```js
      return fetch(apiOrigin(env) + url.pathname + url.search, request);
```

Update the header comment's "Render backend" wording to "the API host (vars.API_ORIGIN)".

- [ ] **Step 4: Run the test to verify it passes**

Run: `node --test worker/`
Expected: PASS, 4 tests.

- [ ] **Step 5: Add the var to `wrangler.jsonc`** (after `"main"`):

```jsonc
  // API host the Worker proxies to. Set to the Oracle tunnel hostname at cutover
  // (SP0 Task 9); until then it points at Render.
  "vars": { "API_ORIGIN": "https://grw-api.onrender.com" },
```

- [ ] **Step 6: Workflows read a repo variable**

In both `.github/workflows/ml-heartbeat.yml` and `.github/workflows/telegram-heartbeat.yml` replace
`API: https://grw-api.onrender.com` with:
```yaml
      API: ${{ vars.API_BASE_URL || 'https://grw-api.onrender.com' }}
```

- [ ] **Step 7: Write `scripts/ops/latency-probe.sh`**

```bash
#!/usr/bin/env bash
# p50/p95 total time of N GETs to a URL. Usage: latency-probe.sh <url> [n=20]
set -euo pipefail
url="$1"; n="${2:-20}"
for _ in $(seq "$n"); do curl -s -o /dev/null -w '%{time_total}\n' "$url"; done | sort -n \
  | awk '{a[NR]=$1} END {printf "n=%d p50=%.0fms p95=%.0fms max=%.0fms\n", NR, a[int(NR*0.5)]*1000, a[int(NR*0.95)]*1000, a[NR]*1000}'
```

Run: `bash scripts/ops/latency-probe.sh https://grw-api.onrender.com/healthz/live 20`
Expected: one line `n=20 p50=…ms p95=…ms max=…ms`. **Record this line** — it is the "before" number for Task 12.

- [ ] **Step 8: Commit**

```bash
git add worker/index.js worker/package.json worker/index.test.mjs wrangler.jsonc .github/workflows/ml-heartbeat.yml .github/workflows/telegram-heartbeat.yml scripts/ops/latency-probe.sh
git commit -m "feat(deploy): API origin and heartbeat URLs become configuration, not constants" -- worker/index.js worker/package.json worker/index.test.mjs wrangler.jsonc .github/workflows/ml-heartbeat.yml .github/workflows/telegram-heartbeat.yml scripts/ops/latency-probe.sh
```

Then push `main` (the Cloudflare build redeploys the Worker; behaviour is unchanged because the var equals the old constant). Verify the site still logs in.

---

### Task 6: Provision and harden the Oracle server (owner)

**Owner:** you (Oracle console + SSH). No repo changes.

- [ ] **Step 1: Sign up** at cloud.oracle.com. Home region: **India West (Mumbai)**; if unavailable, **India South (Hyderabad)**. Then upgrade the account to **Pay As You Go** (Billing → Upgrade) — Always Free resources stay free, and PAYG accounts are not subject to idle reclamation. Set a budget alert at ₹1.

- [ ] **Step 2: Create the instance.** Compute → Instances → Create: shape `VM.Standard.A1.Flex`, **2 OCPU, 12 GB**; image **Canonical Ubuntu 24.04 (aarch64)**; boot volume **100 GB**; assign a public IPv4; upload your SSH public key. If you get "Out of host capacity", retry in another availability domain or later in the day.

- [ ] **Step 3: Reserve the public IP** so it survives instance re-creation: Networking → IP Management → Reserved Public IPs → reserve, then attach it to the instance's VNIC (replacing the ephemeral IP). **Write this IP down** — it is registered with Angel One in Task 10.

- [ ] **Step 4: Confirm only SSH is open.** VCN → Security List: ingress rule for TCP 22 only (delete any others). Ubuntu images on OCI ship an iptables ruleset that already blocks other ports — **do not enable ufw** (it conflicts with that ruleset).

- [ ] **Step 5: Harden and install Docker** (SSH in as `ubuntu`):

```bash
sudo apt-get update && sudo apt-get -y upgrade
sudo apt-get -y install fail2ban unattended-upgrades git rclone postgresql-client
sudo dpkg-reconfigure -f noninteractive unattended-upgrades
sudo sed -i 's/^#\?PasswordAuthentication.*/PasswordAuthentication no/' /etc/ssh/sshd_config
sudo systemctl restart ssh
curl -fsSL https://get.docker.com | sudo sh
sudo fallocate -l 4G /swapfile && sudo chmod 600 /swapfile && sudo mkswap /swapfile && sudo swapon /swapfile
echo '/swapfile none swap sw 0 0' | sudo tee -a /etc/fstab
sudo timedatectl set-timezone UTC
sudo useradd -m -s /bin/bash -G docker grw
sudo mkdir -p /opt/grw/{app,env,state,backups} && sudo chown -R grw:grw /opt/grw
sudo chmod 700 /opt/grw/env
```

- [ ] **Step 6: Verify**

Run: `sudo -u grw docker run --rm hello-world | head -2; free -g | head -2; nproc; curl -s ifconfig.me`
Expected: `Hello from Docker!`; ~11 GB total memory; `2`; the reserved IP from Step 3.

- [ ] **Step 7: Clone the repo** as `grw` (read-only deploy key: GitHub → repo → Settings → Deploy keys, generated with `ssh-keygen -t ed25519` as `grw`):

```bash
sudo -iu grw git clone git@github.com:ak2117k/GrW.git /opt/grw/app
```

---

### Task 7: Domain and Cloudflare Tunnel (owner)

**Owner:** you (Cloudflare dashboard + server).

- [ ] **Step 1: Buy a domain** in Cloudflare → Domain Registration → Register Domains (a `.in`/`.xyz`/`.com`, whichever is cheapest). It is on Cloudflare DNS automatically. Below, `<domain>` means this domain; the API host is **`api.<domain>`**.

- [ ] **Step 2: Create the tunnel.** Zero Trust → Networks → Tunnels → Create → Cloudflared → name `grw` → choose Docker → copy the token from the shown `docker run ... --token <TOKEN>` command.

- [ ] **Step 3: Route the hostname.** In the tunnel → Public Hostname → Add: subdomain `api`, domain `<domain>`, service **HTTP** `api:3001`. Under Additional settings → Connection, enable **WebSocket**.

- [ ] **Step 4: Write the compose env** on the server as `grw`, from `deploy/env/compose.env.example`, with fresh passwords and the tunnel token:

```bash
cd /opt/grw/app
cp deploy/env/compose.env.example /opt/grw/env/compose.env && chmod 600 /opt/grw/env/compose.env
nano /opt/grw/env/compose.env
```

- [ ] **Step 5: Start the infrastructure** (no API yet):

```bash
docker compose -f deploy/docker-compose.prod.yml --env-file /opt/grw/env/compose.env up -d postgres redis cloudflared
docker compose -f deploy/docker-compose.prod.yml --env-file /opt/grw/env/compose.env ps
```
Expected: `grw-postgres` and `grw-redis` **healthy**, `grw-cloudflared` running; Zero Trust shows the tunnel **Healthy**.

---

### Task 8: Migrate the data from Neon (owner, after market close)

**Owner:** you. Do this on a weekday **after 23:30 IST** (MCX closed) or on a weekend.

- [ ] **Step 1: Stop writes to Neon.** Render → `grw-api` → **Suspend** the service. From now until Task 9 the app is offline; nothing can write to Neon after the dump.

- [ ] **Step 2: Check the Neon Postgres version** (use Neon's **direct**, non-pooler URL from the Neon console):

```bash
export NEON_DIRECT='postgresql://…@ep-….ap-southeast-1.aws.neon.tech/neondb?sslmode=require&connect_timeout=30'
docker exec grw-postgres psql "$NEON_DIRECT" -qAt -c 'show server_version'
```
Expected: a version ≤ 17 (restore into the pg17 server is supported).

- [ ] **Step 3: Dump Neon from the server**

```bash
docker exec grw-postgres pg_dump "$NEON_DIRECT" -Fc --no-owner --no-privileges > /opt/grw/backups/neon-final.dump
ls -lh /opt/grw/backups/neon-final.dump
```
Expected: a non-trivial file size (MBs, not bytes).

- [ ] **Step 4: Restore into the server's Postgres**

```bash
source /opt/grw/env/compose.env
docker exec -i grw-postgres pg_restore -U "$PG_USER" -d "$PG_DB" --no-owner --no-privileges < /opt/grw/backups/neon-final.dump
```
Expected: completes; errors mentioning Neon-only roles or extensions (e.g. `neon_superuser`) are acceptable, any error mentioning a `public` table is not.

- [ ] **Step 5: Prove nothing was lost**

```bash
LOCAL="postgresql://$PG_USER:$PG_PASSWORD@localhost:5432/$PG_DB"
bash scripts/ops/compare-counts.sh "$NEON_DIRECT" "$LOCAL"
```
Expected: `counts match (N tables)`, exit 0. **Do not continue on a mismatch.**

- [ ] **Step 6: Keep the final Neon dump off-site** (it is the rollback point until Task 12). Run as `grw` (`sudo -iu grw`) — the backup timer runs as `grw` and reads this rclone config:

```bash
mkdir -p ~/.config/rclone && cp /opt/grw/app/deploy/rclone.conf.example ~/.config/rclone/rclone.conf && chmod 600 ~/.config/rclone/rclone.conf && nano ~/.config/rclone/rclone.conf
rclone copy /opt/grw/backups/neon-final.dump r2:grw-backups/cutover/
rclone ls r2:grw-backups/cutover/
```
Expected: the dump is listed.

---

### Task 9: Cut over to the Oracle host (owner + agent)

- [ ] **Step 1: Write the API env** as `grw`: copy every key from Render → `grw-api` → Environment into `/opt/grw/env/api.env`, then apply `deploy/env/api.env.example` on top (it lists the overrides). Leave `CLAUDE_CODE_OAUTH_TOKEN` empty for now (Task 10). `chmod 600 /opt/grw/env/api.env`.

- [ ] **Step 2: Write the ops env** from `deploy/env/ops.env.example` into `/opt/grw/env/ops.env` (Telegram bot token + chat id; remotes `oci:grw-backups r2:grw-backups`). `chmod 600`.

- [ ] **Step 3: First deploy** (applies the two previously-unapplied migrations as part of `run_migrations`):

```bash
cd /opt/grw/app && FORCE=1 bash scripts/deploy/deploy.sh
curl -s -H 'X-Forwarded-Proto: https' http://127.0.0.1:3001/healthz | head -c 600; echo
curl -s https://api.<domain>/healthz/live
```
Expected: deploy log ends `deployed <sha>`; `/healthz` JSON shows the database and Redis reachable; the public tunnel URL answers.

- [ ] **Step 4: Install the timers**

```bash
sudo cp /opt/grw/app/deploy/systemd/grw-*.service /opt/grw/app/deploy/systemd/grw-*.timer /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now grw-deploy.timer grw-backup.timer grw-restore-test.timer
systemctl list-timers 'grw-*'
```
Expected: three timers listed with next run times.

- [ ] **Step 5: Point the Worker and workflows at the new host** (agent, in the repo): set `wrangler.jsonc` `vars.API_ORIGIN` to `https://api.<domain>`; set GitHub repo variable `API_BASE_URL=https://api.<domain>` (Settings → Secrets and variables → Actions → Variables).

```bash
git commit -m "feat(deploy): cut the Worker over to the Oracle host" -- wrangler.jsonc
git push
```
Expected: within ~3 minutes the Cloudflare build redeploys the Worker, and the server's deploy timer picks up the same commit (no API change — it redeploys harmlessly outside market hours).

- [ ] **Step 6: Smoke test as a user**

Log in at `https://grw.ak-2117k.workers.dev`; open the dashboard, a chart, Settings → broker credentials.
Expected: login works (JWT_SECRET matches); broker credentials show as configured and an Angel One session connects (ENCRYPTION_KEY matches); the connection badge reaches **Live** during market hours.

---

### Task 10: Static IP with Angel One, and the Claude CLI token (owner)

- [ ] **Step 1: Prove the egress IP from inside the API container**

```bash
docker exec grw-api node -e "fetch('https://ifconfig.me/ip').then(r=>r.text()).then(console.log)"
```
Expected: exactly the reserved IP from Task 6 Step 3.

- [ ] **Step 2: Register it with Angel One.** smartapi.angelone.in → My Apps → create (or edit) the trading app with **Primary Static IP** = the reserved IP. Put the new API key into GrW via Settings → broker credentials (it is stored encrypted, per user).

- [ ] **Step 3: Verify the credential works** by reconnecting the broker session in GrW (Settings) and confirming live ticks on a chart during market hours. Order placement stays disabled (`LIVE_TRADING_ENABLED=false`) — registering the IP now removes it as a blocker for SP7.

- [ ] **Step 4: Create the Claude token** on your laptop: `claude setup-token` → approve in the browser → copy the `sk-ant-oat01-…` token. Put it in `/opt/grw/env/api.env` as `CLAUDE_CODE_OAUTH_TOKEN=…`, then restart the API outside market hours:

```bash
cd /opt/grw/app && GRW_API_TAG=$(cat /opt/grw/state/current_sha) docker compose -f deploy/docker-compose.prod.yml --env-file /opt/grw/env/compose.env up -d --no-deps --force-recreate api
```

- [ ] **Step 5: Verify the CLI authenticates exactly as the transport calls it**

```bash
docker exec -i grw-api sh -c 'unset ANTHROPIC_API_KEY; echo "Reply with {\"ok\":true}" | claude -p --output-format json --model claude-sonnet-5-5 --tools "" --strict-mcp-config --setting-sources ""'
```
Expected: JSON with `"is_error":false` and a `result` containing `{"ok":true}`.

- [ ] **Step 6: Calendar reminder** for 11 months from today: "Rotate CLAUDE_CODE_OAUTH_TOKEN (claude setup-token) on the GrW server."

---

### Task 11: Monitoring and the first real backup (owner)

- [ ] **Step 1: External uptime monitor.** uptimerobot.com (free) → HTTP(s) monitor on `https://api.<domain>/healthz/live`, 5-minute interval → alert contact **Telegram**.

- [ ] **Step 2: Run a backup now**

```bash
sudo systemctl start grw-backup.service; systemctl status grw-backup.service --no-pager | tail -5
rclone ls oci:grw-backups; rclone ls r2:grw-backups
```
Expected: service `status=0/SUCCESS`; the new `grw-*.dump` is listed on **both** remotes.

- [ ] **Step 3: Run the restore test now** (this is SP0's "a backup restored" gate):

```bash
sudo systemctl start grw-restore-test.service; journalctl -u grw-restore-test.service --no-pager | tail -3
```
Expected: `restore-test: … restored OK`; Telegram message `GrW restore test: success`.

- [ ] **Step 4: Prove rollback works once, on purpose** (outside market hours): temporarily add `HEALTH_URL=http://127.0.0.1:3001/does-not-exist` to `/opt/grw/env/ops.env`, push any docs-only commit to `main`, and wait for the timer (≤ 2 min).
Expected: Telegram `deploy of <sha> UNHEALTHY; rolled back to <prev>`; `docker inspect -f '{{.Config.Image}}' grw-api` shows the previous tag; the site keeps working. Then remove the override and push another commit; expect `deployed <sha>`.

---

### Task 12: Measure, document, retire the old hosts (owner + agent)

- [ ] **Step 1: Measure "after"** from your laptop:

```bash
bash scripts/ops/latency-probe.sh https://api.<domain>/healthz/live 20
docker exec grw-postgres psql -U grw -d grw -c '\timing on' -c 'select 1' | grep Time   # on the server
```
Expected: record both lines next to the Task 5 "before" line.

- [ ] **Step 2: Write `docs/deploy/ORACLE-RUNBOOK.md`** (agent) containing: the architecture block from the compose file; where every env file lives and what it holds (names only, never values); deploy flow and how to force/rollback (`FORCE=1`, `/opt/grw/state/failed_sha`); backup/restore commands; token rotation (Claude, tunnel); the before/after latency numbers; and a "server lost" recovery procedure (new A1 instance → Task 6 steps → restore newest dump from R2 → Task 9). Add a banner to `docs/deploy/HANDOFF.md` and `docs/deploy/FREE-DEPLOY-RUNBOOK.md`: "Superseded by ORACLE-RUNBOOK.md (2026-10); Render/Neon retired."

```bash
git commit -m "docs(deploy): Oracle host runbook; mark Render/Neon runbooks superseded" -- docs/deploy/ORACLE-RUNBOOK.md docs/deploy/HANDOFF.md docs/deploy/FREE-DEPLOY-RUNBOOK.md
```

- [ ] **Step 3: Wait 14 days** of normal use with no rollback to Render needed.

- [ ] **Step 4: Retire** (owner): delete the Render `grw-api` service and Render Key Value; in Neon, delete the project (the final dump is in R2 `cutover/`). Agent removes `render.yaml` and `.github/workflows/keep-warm.yml`, and the Render fallback constant in `worker/index.js` + its test:

```bash
git rm render.yaml .github/workflows/keep-warm.yml
git commit -m "chore(deploy): retire Render and Neon after 14 days on the Oracle host" -- render.yaml .github/workflows/keep-warm.yml worker/index.js worker/index.test.mjs
```

- [ ] **Step 5: SP0 done-when check** — all true, verified in production:
  - App serves from India through the tunnel (Task 9 Step 6)
  - Latency measured before and after (Task 12 Step 1)
  - A backup restored (Task 11 Step 3)
  - Rollback proven (Task 11 Step 4)
  - Egress IP registered with Angel One (Task 10)
