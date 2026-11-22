# AI agents — enable, watch, roll back (VPS)

Design: `docs/superpowers/specs/2026-11-22-ai-agents-design.md`. Three containers from the API's own
image — `grw-agents-trading`, `grw-agents-reading`, `grw-agents-background` — each serving a group of
AI jobs to Claude on Vertex. Defined in `deploy/docker-compose.prod.yml` under compose profile
`agents`, so a bare `up -d` never starts them. Each step below needs the owner's go, markets closed.

All commands on the VPS, from `/opt/grw/app`, as the deploy user:

```bash
C="docker compose -f deploy/docker-compose.prod.yml --env-file /opt/grw/env/compose.env"
TAG="$(cat /opt/grw/state/current_sha)"   # always the tag the API runs; never rely on :current
```

## 1. Start the containers (agents still unused: AI_AGENTS=off)

```bash
GRW_API_TAG=$TAG $C --profile agents up -d --no-deps grw-agents-trading grw-agents-reading grw-agents-background
docker ps --filter name=grw-agents- --format '{{.Names}} {{.Status}}'     # all "(healthy)" after ~30 s
docker stats --no-stream --format '{{.Name}} {{.MemUsage}}' | grep agents  # target ≤ 100 MB each (limit 160m)
```

## 2. Switch the API onto them

In `/opt/grw/env/api.env`: `AI_AGENTS=on` (needs `SENTINEL_JUDGE=vertex`; with `cli` agents are
ignored). Rollout is per group through the registry (`config/ai-agents.json`, or env
`AGENT_<JOB>_AGENT=in-process` to keep a job in the API). Then recreate the API:

Design §4.8 steps 4–5 (background only, then add reading) — keep the trading jobs in the API:

```
AGENT_SENTINEL_JUDGE_AGENT=in-process
AGENT_SENTINEL_THESIS_AGENT=in-process
AGENT_ENTRY_JUDGE_AGENT=in-process
AGENT_SIGNAL_JUDGE_AGENT=in-process
# step 4 only (reading still in the API):
AGENT_SIGNAL_VISION_AGENT=in-process
AGENT_SIGNAL_PARSE_AGENT=in-process
AGENT_SIGNAL_INFO_AGENT=in-process
AGENT_SIGNAL_IMAGE_SETUP_AGENT=in-process
AGENT_NEWS_IMPACT_AGENT=in-process
```

A job routed `in-process` keeps today's shared-slot gate, and while `sentinel.judge` is in-process the
sentinel cap stays 2. Step 6 = delete the four trading lines; the cap then becomes the registry's 6.
Every agent container reads the same `api.env`, so routing cannot drift between API and agents (a job
an agent does not own is answered `WrongAgent` and the API serves it in-process).

```bash
GRW_API_TAG=$TAG $C up -d --no-deps api
```

From then on the API polls each agent's `/health` every 60 s and Telegrams the owner when one fails
3 checks in a row (and when it recovers), when an agent goes above 140 MB, on the first in-process
fallback per agent per market session, and on the first Vertex 429 per session. With `AI_AGENTS=off`
it sends none of these.

## 3. Deploys

`scripts/deploy/deploy.sh` notes which agent containers are RUNNING before the swap, and after the API
is healthy recreates exactly those with the API's tag (same image, so pruning is unchanged). Agents
that were never started are left off. If that recreate fails, the deploy still succeeds and the owner
gets a WARNING (the API serves those jobs in-process). If the API is unhealthy, the API is rolled
back and the agents are put back on the old tag with it.

## 4. Roll back (any step, ~1 min)

```bash
sed -i 's/^AI_AGENTS=.*/AI_AGENTS=off/' /opt/grw/env/api.env
GRW_API_TAG=$TAG $C up -d --no-deps api
```

That is the whole rollback: with `AI_AGENTS=off` the API never calls an agent and runs exactly the
pre-agents code path. The containers can stay up. To stop them as well (deploys then skip them):

```bash
$C --profile agents stop grw-agents-trading grw-agents-reading grw-agents-background
```

## 5. Checks

- Kill test: `docker stop grw-agents-trading` while calls run → calls continue in-process
  (`ai_calls.agent = 'in-process'`), the down alert arrives after ~3 min; `docker start` → recovery alert.
- Logs: `docker logs --tail 50 grw-agents-trading` (one line per start with its jobs and RSS).
