# MBM M2 — serving + logging (observe) · build contract

Design: `docs/superpowers/specs/2026-10-18-market-behaviour-model-design.md` (§5.6–5.9, §10).
M1 (merged): `ai-engine/src/mbm/` — `features.py`, `labels.py`, `model_a.py`, `predict.py` (`HorizonModel`).
Goal of M2: NIFTY 30m/60m Model A predictions computed live in prod every 5 min, logged, outcomes
filled, served at `GET /behaviour/{instrument}`. **Observe only — no trade path reads it in M2.**

Three parallel streams (A, B, C) build against THIS contract. Do not change a contract item without
the orchestrator; if one is wrong, say so in your final report.

## 1. Database (owned by stream B — Prisma migration, expand-only)

```sql
-- broker 1m bars for MBM inputs (never tick-built candles: training/serving skew)
CREATE TABLE mbm_bars_1m (
  series  TEXT        NOT NULL,          -- store series id: NIFTY, BANKNIFTY, INDIAVIX, EQ_RELIANCE, ...
  ts      TIMESTAMPTZ NOT NULL,          -- bar START, UTC (Angel candle timestamp)
  open DOUBLE PRECISION NOT NULL, high DOUBLE PRECISION NOT NULL,
  low  DOUBLE PRECISION NOT NULL, close DOUBLE PRECISION NOT NULL,
  volume DOUBLE PRECISION NOT NULL DEFAULT 0,
  PRIMARY KEY (series, ts)
);

CREATE TABLE mbm_predictions (
  id            BIGSERIAL PRIMARY KEY,
  instrument    TEXT        NOT NULL,    -- NIFTY
  horizon       TEXT        NOT NULL,    -- 30m | 60m
  as_of         TIMESTAMPTZ NOT NULL,    -- decision time = END of the last 5m bar used, UTC
  p             DOUBLE PRECISION NOT NULL,
  regime        TEXT        NOT NULL,    -- QUIET | NORMAL | ACTIVE
  q25_bp DOUBLE PRECISION, q50_bp DOUBLE PRECISION, q75_bp DOUBLE PRECISION,
  model_id      TEXT        NOT NULL,    -- ai_models.id
  feature_set   TEXT        NOT NULL,    -- mbm-fs2
  data_quality  TEXT        NOT NULL DEFAULT 'ok',  -- ok | gap | drivers_missing
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  outcome_range_bp DOUBLE PRECISION,     -- filled after the window closes
  outcome_threshold_bp DOUBLE PRECISION, -- trailing-median threshold used for `outcome_big`
  outcome_big   BOOLEAN,
  outcome_quality TEXT,                  -- ok | gap (gap ⇒ excluded from live accuracy)
  outcome_at    TIMESTAMPTZ,
  UNIQUE (instrument, horizon, as_of)
);
CREATE INDEX ON mbm_predictions (instrument, as_of DESC);

ALTER TABLE ai_models ADD COLUMN instrument TEXT, ADD COLUMN horizon TEXT;
CREATE INDEX ON ai_models (kind, instrument, horizon, active);
```
Grants for the existing `grw_ai` role (follow the SP3 grant pattern — find it in `prisma/migrations`
or `deploy/sql`): SELECT on `mbm_bars_1m`, `ai_models`; SELECT, INSERT, UPDATE on `mbm_predictions`
(+ its sequence). Prisma models: `MbmBar1m`, `MbmPrediction`; `AiModel` gains `instrument String?`,
`horizon String?`.

## 2. Registry rows (stream C writes, stream A reads)
`ai_models`: `kind='mbm-move'`, `instrument='NIFTY'`, `horizon in ('30m','60m')`, `gate='GO'`,
`active=true`, `featureSet='mbm-fs2'`, `artifactPath` = directory **relative to `/models`**, e.g.
`mbm/nifty/20261019-fs2/30m` containing `classifier.txt q25.txt q50.txt q75.txt meta.json`
(exactly what M1 `_save_models` writes). `id` = `mbm-move-nifty-30m-20261019`. One active row per
kind × instrument × horizon.

## 3. MBM service (stream A — Python, `ai-engine/`)
- App `src.mbm_main:app` (FastAPI, uvicorn, 1 worker), port **5100**, compose service **`mbm`**,
  container `grw-mbm`, image `grw-mbm:<sha>` built from `ai-engine/Dockerfile.mbm`
  (`requirements-mbm-serve.txt`: fastapi, uvicorn, psycopg, pandas, numpy, lightgbm — no pyarrow/sklearn
  unless needed). `mem_limit: 300m`. No host port, no Caddy route. Volume `/opt/grw/models:/models:ro`.
  DB: same `AI_DB_*` env parts + `src/scorer/db_url.py` as the scorer.
- Startup: load active `mbm-move` rows for `MBM_INSTRUMENTS` (default `NIFTY`) via `HorizonModel.load`.
  No GO row / missing files ⇒ that horizon is absent (logged once), service still healthy.
- Loop (asyncio, IST clock): every 5 min during 09:20–15:30 IST Mon–Fri, ~45 s after each 5m bar end
  (09:20:45, 09:25:45, …): read the last ~420 sessions? NO — read what features need: NIFTY/driver
  1m bars for the last **45 calendar days** from `mbm_bars_1m` + global daily (below); build features
  with **`src.mbm.features.build_features` unchanged** (same code as training); take the newest row;
  if its bar end is not the expected one ⇒ skip (stale); predict 30m + 60m; upsert `mbm_predictions`.
  Global daily (Yahoo ES/NQ/CL/DXY/TNX/INR, daily bars): fetch once at startup and 08:30 IST daily,
  in memory; failure ⇒ those features NaN (model tolerates nulls).
- Data quality: if the last 30 min of NIFTY 1m bars has a gap > 2 min ⇒ `data_quality='gap'`.
- Outcome filler: each loop, for rows whose window has closed (as_of + horizon ≤ newest bar end) and
  `outcome_at IS NULL`: range = max(high) − min(low) of NIFTY 1m bars starting in [as_of, as_of+h) in bp
  of the close at as_of; threshold = median range_bp at the same minute over the previous ≤60 sessions
  available in `mbm_bars_1m` (needs ≥20, else NULL threshold/big); quality `gap` if any minute missing.
  Reuse `src.mbm.labels` logic where it fits; do not re-invent the label.
- `GET /behaviour/{instrument}` →
  ```json
  {"instrument":"NIFTY","status":"ok|stale|absent","asOf":"2026-10-20T04:15:00Z",
   "horizons":{"30m":{"p":0.89,"regime":"ACTIVE","q25Bp":34,"q50Bp":45,"q75Bp":59},
               "60m":{...}},
   "modelIds":{"30m":"mbm-move-nifty-30m-20261019"},"featureSet":"mbm-fs2","dataQuality":"ok"}
  ```
  `ok` = newest prediction ≤ 10 min old; `stale` = older (numbers still returned, flagged);
  `absent` = none today / outside session. Never 5xx for "no data".
- `GET /health` → `{"ok":true,"models":{"NIFTY":["30m","60m"]},"lastRun":"…"}`.
- Tests (pytest, `ai-engine/tests/test_mbm_service*.py`): loop math on a fake bars frame, outcome
  filler, endpoint statuses, models-absent path. Use the existing tests style.

## 4. API side (stream B — NestJS, `apps/api/src/modules/mbm/`)
- Flags (parse in one config fn, log one boot line `[mbm] mode=… instruments=… url=…`):
  `MBM_ENABLED=off|observe|on` (default **off**; M2 deploys `observe`), `MBM_INSTRUMENTS=NIFTY`,
  `MBM_URL=http://mbm:5100`, `MBM_FEED_USER_ID` (default: first of `AI_AUTO_EXIT_USER_IDS`).
- **Bar refresher** (only when not `off`): cron every 5 min Mon–Fri during 09:15–15:35 IST at
  second 20 (09:20:20, …), plus a boot catch-up of the last 3 sessions. For each series of the NIFTY
  universe — `NIFTY 99926000 NSE`, `BANKNIFTY 99926009 NSE`, `INDIAVIX 99926017 NSE`, and the 8
  heavyweights `EQ_<SYMBOL>` (NSE `-EQ` tokens: verify against the instrument master / `instruments`
  table; expected RELIANCE 2885, HDFCBANK 1333, ICICIBANK 4963, INFY 1594, TCS 11536,
  BHARTIARTL 10604, LT 11483, ITC 1660) — fetch ONE_MINUTE candles from the last stored ts (or
  session open) to now via `UserFeedManager.fetchCandleWindow(MBM_FEED_USER_ID, …)` (the owner's own
  session; the per-user historical pacing applies), upsert into `mbm_bars_1m`. Serial, one series at a
  time; a failed series is logged and retried next tick, never throws. Weekends/holidays: no-op.
  This must not open a SECOND Angel login: use only the UserFeedManager path.
- `MbmClient.behaviour(instrument)`: GET `${MBM_URL}/behaviour/${instrument}`, 800 ms timeout,
  60 s in-memory cache, **fail-open**: any error ⇒ `{status:'absent'}`; never throws.
- `GET /api/mbm/behaviour/:instrument` (JWT-guarded like other owner endpoints) proxies the client.
- Unit tests (jest) for config parsing, refresher (window math, upsert, holiday no-op, failure
  isolation), client fail-open. `deploy/env/api.env.example` documents the four vars.

## 5. Ops (stream C — scripts + compose + runbook)
- `ai-engine/scripts/mbm_ship.py ship --instrument NIFTY --version 20261019-fs2 --vps … --ssh-key …`:
  scp `grw-mbm/models/m1/nifty/{30m,60m}/` to `/opt/grw/models/mbm/nifty/<version>/<h>/` and upsert the
  §2 `ai_models` rows over SSH (`docker exec grw-postgres psql`, credentials from
  `/opt/grw/env/compose.env` on the VPS — same pattern as the runbook), deactivating older rows of the
  same kind × instrument × horizon. Metrics JSON = the horizon's gate block from M1 `metrics.json`.
- `ai-engine/scripts/mbm_ship.py seed-bars --days 60`: upload the last N days of 1m bars for every
  universe series from the PC store into `mbm_bars_1m` (CSV over ssh into `psql \copy` + upsert via a
  temp table). Idempotent.
- `scripts/deploy/mbm-deploy.sh` (runs ON the VPS from `/opt/grw/app`): `docker build -f
  ai-engine/Dockerfile.mbm -t grw-mbm:<sha> ai-engine`, then `docker compose … up -d mbm` with
  `GRW_MBM_TAG=<sha>`, wait for health, keep 2 old images. Not wired into the API deploy timer (yet).
- Compose: the `mbm` service block in `deploy/docker-compose.prod.yml` (stream A writes the
  Dockerfile; stream C owns the compose block + deploy script — coordinate only through this contract).
- Runbook section in `docs/guides/mbm-data-runbook.md`: ship, seed, deploy, check, rollback
  (`MBM_ENABLED=off`), RAM check.

## 6. Rules for every stream
- Work only in your own worktree/branch (`feature/mbm-m2-a|b|c`); commit with explicit pathspecs;
  never push, never merge, never touch prod. End commit messages with
  `Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>`.
- Token budget matters (owner's weekly limit): read only what you need (grep, `sed -n` ranges),
  no whole-file dumps, no polling. Aim < 120k tokens. Commit after each working step.
- Final report ≤ 250 words: branch, commits, what's tested, anything in this contract that was wrong.
