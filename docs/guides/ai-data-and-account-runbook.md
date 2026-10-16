# AI Data & Account Runbook

> One place for: (1) what GrW records that a model can learn from, (2) how to export it,
> (3) how to switch the Claude account/token the trade sentinel uses, (4) the env + deploy
> checklist for the AI features. Keep this file current when a table, flag or step changes.

Last updated: 2026-10-16 · Prod: VPS `157.10.98.70`, app `/opt/grw/app`, env `/opt/grw/env/api.env`,
DB container `grw-postgres`, API container `grw-api`.

---

## 1. What we record (the training corpus)

Every AI decision is stored with the exact input it saw, and outcomes are attached afterwards, so
any later model (fine-tune, classifier, or a different Claude account/prompt) can be trained or
evaluated on real trades.

| Table | One row per | Key fields (input → decision → outcome) |
|---|---|---|
| `sentinel_verdicts` | AI judgement on an open position | `packet` (full context the AI saw), `promptVersion` (e.g. `v7/t1`), `triggeredBy`, `verdict` (HOLD / EXIT_ARMED / EXIT_NOW), `confidence`, `thesisStatus`, `reason`, `evidence`, `invalidationPoint`, `netPnl`, `greenFloor`, `exitTrigger` (proposed price level), `newsShadow` (News & Events v2 would-be blocks, observe mode) |
| `ai_exit_executions` | attempt to act on an EXIT_NOW / manual / price-trigger exit | status (PLACED / FILLED / SKIPPED / FAILED / DRY_RUN), reason, `gate` (exit-discipline decision: which clause passed/failed with numbers), order plan, `orderLtp`, fill price/time, slippage, latency |
| `ai_exit_outcomes` | exit decision (executed **or** gated/skipped) scored ~60 min later | max/min price after, close at +15/+30/+60, **missed P&L**, **saved P&L**, net — the label for "was this exit right?" |
| `sentinel_exit_triggers` | price level the AI pre-agreed (price triggers, currently OFF) | level, side, ARMED → FIRED/EXPIRED |
| `ai_decision_records` | SP3 corpus row (every AI decision incl. sentinel) | `evidence`, `features`, `featureSet`, `decision`, `ruleScore`, `mlScore`, `aiCallIds`, `outcome`, `outcomeAt` |
| `ai_models` | trained model registry (SP3) | `featureSet`, `dataWindow`, `nTrain/nHoldout`, `metrics`, `gate`, `artifactPath`, `active` |
| `ai_calls` | every LLM call through the gateway (when `AI_GATEWAY_SENTINEL=true`) | request/reply audit, tokens, cost |
| `trade_trackers` | tracked position (manual or auto) | entry/exit, qty, holding high/low, P&L |
| `core_positions`, `core_journal` | trade-core lifecycle / journal (SP2) | positions, realised P&L, risk events |
| `candles_1m` | 1-minute bars (hub) | market context to rebuild any moment; **retention 180 days** |
| `news_articles` | headline (with v2 tags: `instruments`, `sectors`, `indices`, `markets`, `tagVersion`, `dateInferred`) | news context |
| `market_events` | company + macro events (results, dividends, RBI, FOMC, CPI, EIA, OPEC) | event context |

**Not recorded / gaps to know:** futures 1-minute bars for MCX underlyings are not stored (only
contracts with a hub feed slot); judge outages leave gaps (e.g. none 2026-10-14 17:04 → 2026-10-16,
see §3). Prompt text itself is versioned in code (`apps/api/src/modules/trade-sentinel/prompts/
sentinel-system-prompt.ts`) — the stamp in `promptVersion` maps to it.

### Prompt versions (stamp → meaning)
| Stamp (cues on / off) | Exit discipline | Price triggers | News & Events v2 |
|---|---|---|---|
| v5 / v2.2 | off | off | off/observe |
| v6 / v2.3 | off | on | off/observe |
| **v7 / v2.4** (live 2026-10-15) | on | off | off/observe |
| v8 / v2.5 | on | on | off/observe |
| v9–v12 / v2.6–v2.9 | combinations | | **on** |

---

## 2. Exporting data for training / evaluation

All reads are read-only; run on the VPS.

```bash
cd /opt/grw && set -a; . env/compose.env; set +a
P="docker exec grw-postgres psql -U $PG_USER -d $PG_DB -At"
```

- **Labelled exit decisions (best starting dataset):**
  ```sql
  SELECT v.id, v."createdAt", v.symbol, v."promptVersion", v.verdict, v.confidence, v.reason,
         v.packet, e.status, e.reason AS exec_reason, e.gate,
         o."missedPnl", o."savedPnl", o."netAtEnd"
  FROM sentinel_verdicts v
  LEFT JOIN ai_exit_executions e ON e."verdictId" = v.id
  LEFT JOIN ai_exit_outcomes  o ON o."verdictId" = v.id
  WHERE v."createdAt" > now() - interval '30 days'
  ORDER BY v."createdAt";
  ```
  Wrap with `COPY (...) TO STDOUT WITH CSV HEADER` or `json_agg` to export.
- **One trade, replayable through the exit-discipline gate:** `apps/api/scripts/sql/export-exit-fixture.sql`
  (emits UTC `Z` timestamps — required), drop the JSON into
  `apps/api/src/modules/exit-discipline/replay/fixtures/<name>.real.json` (git-ignored — prod data never
  enters git), then `npx ts-node apps/api/scripts/exit-replay.ts <file> --verbose` to try settings.
- **SP3 corpus:** `SELECT * FROM ai_decision_records WHERE "outcomeAt" IS NOT NULL` (features + outcome).

**Gotchas:** `timestamp without time zone` columns are stored in UTC but psql prints them without a
zone — always export with `to_char(col,'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`. The level book's `atr14`
is a **daily** ATR despite `interval: '15m'` in the packet.

---

## 3. Switching the Claude account / token (sentinel judge)

The sentinel judge runs Claude Code CLI inside `grw-api` (`SENTINEL_JUDGE=cli`) using
`CLAUDE_CODE_OAUTH_TOKEN` from `api.env`. If that account hits its usage limit, **every judgement
fails** and no AI verdicts or AI exits happen.

**Symptom:** logs show `claude CLI: exited with code 1: no stderr` and no new `sentinel_verdicts` rows.
**Diagnose:**
```bash
docker exec grw-api sh -c 'cd /tmp && claude -p "reply ok" --output-format json' | grep -oE '"(result|api_error_status)":[^,]*'
# e.g. "result":"You've hit your weekly limit · resets ..."  "api_error_status":429
```
**Fix (≈2 minutes):**
1. On a machine logged into the new Claude account: `claude setup-token` → copy the token.
2. On the VPS: back up and replace the token line
   ```bash
   cd /opt/grw && cp env/api.env env/api.env.bak-$(date +%Y%m%d%H%M)
   # edit env/api.env: CLAUDE_CODE_OAUTH_TOKEN=<new token>   (never paste it into git/logs/chat history you keep)
   ```
3. Restart the API (picks up env):
   ```bash
   TAG=$(docker inspect -f "{{.Config.Image}}" grw-api | cut -d: -f2) && \
   GRW_API_TAG=$TAG docker compose -f app/deploy/docker-compose.prod.yml --env-file env/compose.env up -d --no-deps --force-recreate api
   ```
4. Verify: the diagnose command returns `ok`; within ~1 minute new `sentinel_verdicts` rows appear with
   the expected `promptVersion`.

**Alternative:** `SENTINEL_JUDGE=api` with an Anthropic API key (pay-per-use, no weekly cap) — owner
chose CLI for now (2026-10-12).

---

## 4. AI feature flags (current prod values)

| Flag | Value | Effect |
|---|---|---|
| `AI_AUTO_EXIT_ENABLED` / `AI_AUTO_EXIT_MODE` | `true` / `live` | AI EXIT_NOW places real exits (owner only: `AI_AUTO_EXIT_USER_IDS`) |
| `AI_AUTO_EXIT_CANCEL_PROTECTIVE` | `true` | cancels the resting SL before exiting |
| `EXIT_DISCIPLINE_ENABLED` (+ `FLOOR_ARM_N=1.5`, `FLOOR_TRAIL_N=2.0`, `GIVEBACK_N=1.5`, `GATE_CLOSE_MIN=10`, `GATE_UNDERLYING_N=1.0`, `PERSIST_WINDOW_SEC=300`, `PERSIST_MIN_SEC=120`, `EXIT_OUTCOME_WINDOW_MIN=60`) | `true` | noise-aware floor + thesis gate; rollback = `false` + restart |
| `SENTINEL_TRIGGERS_ENABLED` | `false` | price triggers built, off |
| `SENTINEL_TICK_TRIPWIRES` | `false` | tick wake-ups off (default would be ON) |
| `NEWS_EVENTS_V2_ENABLED` | `observe` (from 2026-10-16) | tags/logs news & events, AI does not see them yet; → `true` after 2–3 trading days |
| `MARKET_CUES_ENABLED` | `true` | WTI/Brent/US indices/USDINR in the packet |
| `SENTINEL_JUDGE` | `cli` | judge transport (see §3) |

Backups of every env change: `/opt/grw/env/api.env.bak-<UTC timestamp>`.

---

## 5. Deploy checklist (AI changes)

1. **Write env first**, then push — the deploy timer (`grw-deploy.timer`, ~15 min after the image
   builds) recreates the container and only reads env at start (2026-10-15 it started before the env
   was written and needed a second restart).
2. Deploy outside the session of any open position's exchange (NSE 09:15–15:30, MCX 09:00–23:30 IST).
3. After deploy: check boot lines (`[ai-exit] ENABLED …`, `[exit-discipline] ON …`,
   `[news-events] mode=…`), new tables via `to_regclass`, `/healthz` 200, first verdict's
   `promptVersion`.
4. Git push identity must be `ak2117k` (the `aryankmrpnm` login gets 403). Fix: clear the saved
   credential (`printf "protocol=https\nhost=github.com\n\n" | git credential reject`) and push again to
   sign in.

## 6. Where the design docs live
`docs/superpowers/specs/` and `docs/superpowers/plans/` — exit discipline (2026-10-14/15), price
triggers (2026-10-13), news & events v2 (2026-10-16), sentinel auto-exit (2026-10-12).
