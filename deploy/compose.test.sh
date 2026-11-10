#!/usr/bin/env bash
# Checks the production compose stack as docker compose resolves it, plus the
# Caddyfile with the real Caddy binary. Run: bash deploy/compose.test.sh
set -uo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."
failures=0
expect() { if eval "$2"; then echo "ok   $1"; else echo "FAIL $1"; failures=$((failures + 1)); fi; }

export API_ENV_FILE=env/api.env.example PG_USER=u PG_PASSWORD=p PG_DB=d REDIS_PASSWORD=r \
  API_HOST=203-0-113-7.sslip.io
cfg="$(docker compose -f deploy/docker-compose.prod.yml config 2>&1)"; cfg_rc=$?

expect "compose config is valid"            '[[ $cfg_rc -eq 0 ]] && grep -q "^services:" <<<"$cfg"'
expect "no cloudflared (no domain/tunnel)"  '! grep -q "cloudflared" <<<"$cfg"'
expect "caddy publishes 443"                'grep -A40 "^  caddy:" <<<"$cfg" | grep -q "published: \"443\""'
expect "caddy publishes 80 (ACME + redirect)" 'grep -A40 "^  caddy:" <<<"$cfg" | grep -q "published: \"80\""'
expect "api not published publicly"        'grep -A60 "^  api:" <<<"$cfg" | grep -q "host_ip: 127.0.0.1"'
expect "postgres sized for 2 GB"           'grep -q "shared_buffers=256MB" <<<"$cfg"'
expect "redis capped at 128mb"             'grep -q -- "- 128mb" <<<"$cfg"'

MSYS_NO_PATHCONV=1 docker run --rm -e API_HOST="$API_HOST" \
  -v "$(pwd -W 2>/dev/null || pwd)/deploy/Caddyfile:/etc/caddy/Caddyfile:ro" \
  caddy:2-alpine caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile >/tmp/caddy-validate.log 2>&1
expect "Caddyfile validates" '[[ $? -eq 0 ]] || { tail -3 /tmp/caddy-validate.log; false; }'

# The API answers 426 unless X-Forwarded-Proto is https (EnforceHttpsMiddleware).
# Run the real Caddyfile (API_HOST=localhost → Caddy's internal CA) in front of a
# stand-in API with that exact rule, and require a 200 through the proxy.
CADDYFILE="${CADDYFILE:-$(pwd -W 2>/dev/null || pwd)/deploy/Caddyfile}"
N=grw-caddy-check
docker rm -f grw-check-api grw-check-caddy >/dev/null 2>&1; docker network create $N >/dev/null 2>&1
docker run -d --name grw-check-api --network $N --network-alias api node:22-alpine node -e \
  "require('http').createServer((q,s)=>{s.statusCode=q.headers['x-forwarded-proto']==='https'?200:426;s.end()}).listen(3001)" >/dev/null
MSYS_NO_PATHCONV=1 docker run -d --name grw-check-caddy --network $N -e API_HOST=localhost -p 18443:443 \
  -v "$CADDYFILE:/etc/caddy/Caddyfile:ro" caddy:2-alpine >/dev/null
code=000; for _ in $(seq 15); do code="$(curl -sk -o /dev/null -w '%{http_code}' https://localhost:18443/healthz/live)"; [[ "$code" != 000 ]] && break; sleep 1; done
docker rm -f grw-check-api grw-check-caddy >/dev/null; docker network rm $N >/dev/null
expect "API behind Caddy passes the HTTPS gate (got $code)" '[[ "$code" == 200 ]]'

if (( failures > 0 )); then echo "$failures test(s) failed"; exit 1; fi
echo "all compose tests passed"
