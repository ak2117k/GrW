# AI agents: one independent agent per job (design)

Date: 2026-11-22 · Status: DRAFT, awaiting owner approval · Owner decisions quoted as such.

## 1. Intent

Every AI call in GrW now goes to Claude on Google Vertex AI (`SENTINEL_JUDGE=vertex`, live since
2026-11-22, commit d2a9d03c). Vertex serves calls in parallel, so the reason everything shared one
2-call cap is gone. The owner wants **independent agents, each owning one job** (owner, 2026-11-22:
"independent agents, each owning one job"), deployed as separate processes, on the **current
server** for ₹0 (owner: "switching to 1k cost is a big amount for now").

What the owner should get:

- **Exits are never skipped because something else is thinking.** Today, when 2 AI calls are in
  flight, the sentinel SKIPS a position's judgement (`sentinel-cycle.service.ts`, `JUDGE_CONCURRENCY = 2`).
- **Each job has its own settings** — model, effort, reply ceiling, timeout, how many calls at once —
  in one table instead of a dozen env variables spread over modules.
- **A crash in one agent cannot take another down** (the advisor or a night review cannot stall exits).
- **Each agent can be watched, restarted and later moved** (own machine, own Google project) on its own.

## 2. Goals, non-goals, anti-goals

Goals
1. Three agent containers on the current VPS, each hosting a group of agents; every agent has its
   own concurrency limit and settings.
2. A per-job **agent registry** (config file + env overrides) that is the single place for model,
   effort, max tokens, timeout and concurrency.
3. The sentinel's live judgement cap comes from the registry (target 6), not a hard-coded 2.
4. If an agent container is down, the API makes the call itself, exactly as today. Owner is alerted.
5. Every call still writes one `ai_calls` row, now also saying which agent served it and how long it waited.

Non-goals
- Agents collaborating on one decision (chart + OI + news agents feeding a judge). Owner chose independent.
- Moving data gathering into agents. The API keeps building every prompt: only it holds the broker
  feed (Angel feed slots are scarce), the database and the order path.
- Changing any prompt, schema, trading rule, risk limit, or what any judge decides.
- A new server, a VPS upgrade, or running anything in the friend's Google project beyond model calls.

Anti-goals (would be a failure even if it "works")
- An agent dying silently and calls quietly failing — the app's recurring failure shape
  ([[silent-absence-failure-pattern]]). Every agent must be health-checked and alerted on.
- Any path where an agent problem means a **missed exit or a missed signal** instead of a slower one.
- Memory pressure that pushes the API or Postgres into swap on a market morning.
- Double-acting on one decision (two verdicts used for one judgement).

## 3. Constraints (measured 2026-11-22, Sunday)

- VPS: **1 vCPU, 1.9 GB RAM, 2 GB swap, 20 GB disk (80 % used, 3.8 GB free)**.
  Free memory ~915 MB on a quiet Sunday; API ~245–290 MB, Postgres ~360 MB.
- Redis: `maxmemory 128mb`, `noeviction`, shared with Bull queues. A large payload backlog there
  would make Bull writes fail app-wide → **do not carry prompts/images through Redis.**
- Postgres `max_connections=40`, API pool 10 → agents must not open DB connections.
- Vertex: project avathar-465212, region global; Opus 5.5, Sonnet 5.5 enabled, Haiku 5.5 not
  (Haiku jobs served as Sonnet 5.5). Key file `/opt/grw/env/google-vertex.json`.
- SDK non-streaming limit ≈ 21k max_tokens; keep every profile ≤ 16k.
- Deploy: push `main` → CI builds `grw-api:<sha>` → `grw-deploy.timer` swaps the `api` service only
  (`deploy.sh`, `--no-deps`). Pushing main = deploying prod.

## 4. Design

### 4.1 The seam (why this is small)

Every AI caller already builds its model connection through ONE function,
`directRecordedTransport()` in `apps/api/src/modules/ai-gateway/audit/recorded-transport.ts`
(callers: sentinel judge/thesis/overnight, entry judge, signal judge, signal parse/vision/info/
image-setup, news impact, news ideas, self-review, advisor/assist, backtest assistant). Each caller
passes its job label (`jobOf`). The `RecordedTransport` wrapper writes the `ai_calls` row around a
`ProviderAdapter.send()`.

So the change is a new **`AgentProvider`** adapter that `directRecordedTransport` uses when agents are
on. It looks up the job's agent, sends the already-built request to that agent container, and returns
the same `ProviderResult` the Vertex provider returns today. Callers do not change. The ledger row is
still written in the API (the agents never touch the database).

```
caller (e.g. SignalJudgeService) ── builds prompt + schema (unchanged)
   └─ RecordedTransport (API)  ── writes ai_calls (+ agent, queuedMs)
        └─ AgentProvider (API) ── registry: job → agent, applies profile
             ├─ HTTP POST http://grw-agents-trading:5300/v1/messages   (normal path)
             └─ AnthropicVertexProvider in-process                       (fallback: agent unreachable)
grw-agents-trading (container) ── per-agent semaphore ── AnthropicVertexProvider ── Vertex
```

### 4.2 Agents and containers

| Container | Agents (job labels) | Why together |
|---|---|---|
| `grw-agents-trading` | `sentinel.judge`, `sentinel.thesis`, `entry.judge`, `signal.judge` | Money on the line; kept free of everything else |
| `grw-agents-reading` | `signal.vision`, `signal.parse`, `signal.info`, `signal.image-setup`, `news.impact` | Inputs; bursty, short calls |
| `grw-agents-background` | `sentinel.overnight`, `self-review.diagnose`, `news.ideas`, `assist.advisor`, `assist.news`, `strategy.review`, `strategy.suggest`, `backtest.*` | Slow or user-facing; a crash here must not reach trading |

A job not in the registry goes to `background` (and is logged once), so a new caller is never unrouted.
Moving an agent to another container, or to 9 containers after a RAM upgrade, is a registry edit plus
a compose entry — no code change.

### 4.3 The agent container

- **Same image** as the API (`grw-api:<sha>`), different command: `node apps/api/dist/agents/main.js`.
  No new CI pipeline, no extra disk. Memory is what the process loads, not the image size.
- `agents/main.js` is a plain Node HTTP server (no NestJS, no Prisma, no broker code). It imports only
  the Vertex provider, the model map and the registry reader. Target **≤ 100 MB RSS**; compose sets
  `mem_limit: 160m`, `restart: unless-stopped`, internal network only (no host port, no Caddy route).
- Env: `AGENT_GROUP=trading|reading|background`, the Vertex vars, `GOOGLE_APPLICATION_CREDENTIALS`
  (same read-only key mount as the API), `AI_CONFIG_DIR`.
- Endpoints:
  - `POST /v1/messages` — body `{ job, request, deadlineMs }`; runs the request under that job's
    semaphore; replies `{ message, meta, queuedMs, agent }` or `{ error: { class, message, status } }`
    preserving the Vertex/SDK error class name so caller error classification is unchanged.
  - `GET /health` — `{ group, agents: { job: { inFlight, limit, queued, okLast5m, errLast5m } }, rssMb }`.
- **Per-agent semaphore**: each job has `concurrency` slots and a bounded wait queue. A request that
  cannot start before its `deadlineMs` is rejected with `AgentBusy` (never silently dropped).
- Late results after the API gave up are discarded and counted.
- Why HTTP and not Redis/Bull: request/response matches the existing `await messages.create()` shape,
  keeps prompts and images (up to ~1 MB base64) out of the 128 MB `noeviction` Redis, and needs no
  result-correlation code. The API ↔ agent hop is on the Docker network (~1 ms).

### 4.4 The agent registry

`config/ai-agents.json` (read via the existing `readAiConfig`), one entry per job:

```json
{
  "sentinel.judge": { "agent": "trading", "concurrency": 6, "timeoutMs": 120000,
                      "model": null, "effort": null, "maxTokens": null }
}
```

- `model` / `effort` / `maxTokens` `null` = **keep what the caller sets today** (rollout changes no
  decision). A non-null value overrides the caller. Existing per-job env vars (`SIGNAL_JUDGE_EFFORT`,
  `ENTRY_JUDGE_MODEL`, `AI_ADVISOR_MODEL`, …) keep working exactly as now.
- Env override per field: `AGENT_<JOB>_<FIELD>`, e.g. `AGENT_SENTINEL_JUDGE_CONCURRENCY=8`
  (job dots → underscores, upper-case). Env beats file.
- Read by both the API (routing, overrides, the sentinel cap) and the agents (semaphores).
- Starting values: `sentinel.judge` 6, `signal.judge` 3, `entry.judge` 3, `sentinel.thesis` 3,
  every other job 2. Timeouts: today's per-job values carried over.

### 4.5 The sentinel cap and the API-side slot gates

Today almost every AI caller first waits in the API for a slot of `SentinelCycleService`
(`runShared` / `runInSharedSlot` / the signal lane, `SIGNAL_LANE_SLOTS = 1`), in the same `judging`
map as live exit judgements — the advisor, readers, news, signal judge and entry judge included.
Those gates existed because the CLI was one local process. With agents ON (builder's call, §7):

- **Only the sentinel's own jobs stay on the `SentinelCycleService` gate**: live `sentinel.judge`
  (and its `sentinel.thesis`) and `sentinel.overnight`, because they share the one-in-flight-per-
  position rule and the live reservation. `JUDGE_CONCURRENCY` becomes
  `registry['sentinel.judge'].concurrency` (target 6); `LIVE_RESERVED_SLOTS` (1) keeps live first;
  overnight may use `concurrency − LIVE_RESERVED_SLOTS`. The skip-not-queue rule stays (a stale packet
  is worse than a skipped tick) — it simply triggers far less.
- **Every other job skips `runShared` / `runInSharedSlot` / the signal lane** and is gated only by its
  agent's semaphore (§4.3). The 16-Nov bulkhead goal (one stuck job cannot freeze every caller) is now
  met by separate per-job semaphores with hard deadlines. `AssistBusyError` is raised from the
  agent's `AgentBusy` instead of the shared-slot wait, so the advisor's "busy" message path is kept.
- With agents OFF, or on `cli`, every gate behaves exactly as today.

### 4.5a Project-wide Vertex limit (quota is per Google project, not per container)

All calls pass through the API's `AgentProvider`, so the API is the one place to cap them
(builder's call): a **global in-flight cap** (`AGENTS_GLOBAL_CONCURRENCY`, default 16) with
**`AGENTS_TRADING_RESERVE` (default 6) slots usable only by trading-group jobs**. A non-trading
call that would eat into the reserve waits (within its deadline) or fails `AgentBusy`.
On a Vertex 429 (quota) the API halves the non-trading share for 60 s and alerts once per session.
The project's per-minute quota is not known; the first weeks are watched through 429 alerts and
`ai_calls` errors. No daily spend cap — owner: "costing doesnot matter"; the night report's AI-cost
line keeps spend visible.

### 4.6 Failure behaviour

| What fails | What happens |
|---|---|
| Agent container unreachable (connection refused / DNS / health down) | API calls Vertex in-process for that request (today's path). `ai_calls.agent = 'in-process'`. Agent marked down for 30 s, then retried. |
| Agent reachable but busy past deadline (`AgentBusy`) | Error returned to caller, which degrades exactly as on any AI error today (sentinel: skip this tick; signal judge: its existing timeout path). No in-process retry — that would double-spend and could double-act. |
| Model slow / Vertex error | Same as today: the error class passes through unchanged. |
| Agent crashes mid-call | Connection reset → treated as unreachable → in-process call (the crashed call never returned, so no double use). |
| Vertex quota squeeze | Trading agent's calls keep their slots; other containers are separate processes and cannot take them. |

Alerts (existing owner Telegram adapter, `owner-alert.telegram.adapter.ts`):
- an agent's `/health` fails 3 checks in a row (checked every 60 s by the API) → one alert, one
  recovery message;
- any fallback to in-process during market hours → one alert per agent per session;
- an agent's RSS > 140 MB → one warning per day.

### 4.7 Ledger

`ai_calls` gets one nullable column, `agent` (`trading` | `reading` | `background` | `in-process`),
via a Prisma migration. `queuedMs` (always 0 today on direct paths) is filled from the agent's report.
Provider stays `anthropic-vertex`; model stays the served model.

### 4.7a Deploys (builder's call)

`deploy.sh` today recreates only `api`. It will also recreate the three agent containers **with the
same image tag**, after the API is healthy (agents are stateless; during their few-second restart the
API's in-process fallback serves those jobs, so a deploy during MCX hours cannot miss an exit).
Same tag ⇒ no third image pinned, pruning unchanged (`KEEP_IMAGES=2`). Rollback swaps all four back.
The API ↔ agent body carries `protocol: 1`; an agent answering a different version is treated as
unreachable (fallback + alert), so a half-finished deploy degrades instead of misbehaving.
Containers that are defined but not yet started (step 1 below) are skipped by `deploy.sh`.

### 4.8 Switch and rollout

- `AI_AGENTS=off|on` in `api.env`, default `off`. Off = exactly today's code path.
  Requires `SENTINEL_JUDGE=vertex`; with `cli` agents are ignored (one local process).
- Order (each step needs the owner's go; markets closed for each switch):
  1. Ship dark (code + compose services defined but containers not started). Tests + tsc.
  2. Start the three containers on a weekend; measure RSS; health and alerts verified by stopping one.
  3. Monday: measure the API's market-morning memory with agents idle (`AI_AGENTS=off`).
  4. Turn on for `background` jobs only (registry can route a job to `in-process`); one evening.
  5. Add `reading`; one market day. 6. Add `trading`; raise sentinel concurrency to 6.
- Rollback at any step: `AI_AGENTS=off` + recreate the API (~1 min). Containers can stay up.

## 5. Testing

- Unit: registry parse + env overrides + unknown-job default; `AgentProvider` routing, override
  application, fallback on unreachable, no fallback on `AgentBusy`, error class passthrough;
  semaphore limits/deadline/late-result discard; sentinel cap from registry (on/off/cli);
  non-sentinel jobs bypass `runShared` only when agents are on; global cap + trading reserve +
  429 back-off; protocol-version mismatch → fallback.
- Integration (jest, in-process): start the agent HTTP server on a random port with a fake Vertex
  client; run a real `RecordedTransport` through it; assert the `ai_calls` row (agent, queuedMs).
- Kill test on the server: stop `grw-agents-trading` while calls run → calls continue in-process,
  alert arrives, restart recovers.
- Memory: each agent container ≤ 100 MB RSS idle and under a 10-call burst.
- No replay needed: requests and models are unchanged; verified by comparing `requestHash` of a
  call with agents off vs on for the same input.

## 6. Decided by the owner

- Independent agents, one job each (not collaborating on one decision).
- Separate deployed processes.
- Current server, ₹0 — grouped into 3 containers, moving to 9 after a RAM upgrade.

## 7. Builder's calls (marked, owner may override)

- HTTP between API and agents instead of Redis (reason in 4.3).
- Same Docker image, different command.
- Group membership and starting concurrency values in 4.2 / 4.4.
- `null` profile fields = no change at rollout.
- No in-process retry on `AgentBusy`.
- Unknown jobs route to `background`.
- With agents on, only the sentinel's own jobs keep the API-side slot gate; all others are gated by
  their agent alone (§4.5).
- A global in-flight cap in the API with a trading reserve, and back-off on 429 (§4.5a).
- `deploy.sh` recreates the agents with the API on every deploy, same tag, protocol version check (§4.7a).
- Agents cover the direct path only; the gateway path (`AI_GATEWAY_SENTINEL=true`, off in prod) is
  out of scope.

## 8. Left to the builder

Exact file layout under `apps/api/src/agents/`, health-check scheduling, log format, the bounded
queue length per agent (suggest 2 × concurrency), and the compose details beyond 4.3.
