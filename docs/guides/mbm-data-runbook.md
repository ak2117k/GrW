# MBM data runbook (M0)

The Market Behaviour Model trains on a parquet store on the owner's PC, built by one
command, plus nightly prod exports of OI / OI-wall / option-chain snapshots that prod
would otherwise prune after 30 days. Design: `docs/superpowers/specs/2026-10-18-market-behaviour-model-design.md`.

## Store

- Default root `C:\Users\AryanKumar\grw-mbm` (`~/grw-mbm`); override with `--store` or env `MBM_STORE`. Outside the repo, never committed.
- `bars/<interval>/<series>/<YYYY-MM>.parquet` (IST month) — broker bars only (Angel 1m + derived 1d; Yahoo 1m/5m/60m/1d for global cues).
- `exports_raw/<table>/*.csv.gz` — the raw prod exports. **The only long-term copy of OI/chain history** (the VPS keeps 30 days). Back this folder up.
- `exports/<table>/<YYYY-MM>.parquet` — the same, imported.
- `_meta/manifest.json` (per series/interval: rows, first, last, depth, failed_chunks), `_meta/scrip_master/<date>.json.gz` (kept forever: the record of contract tokens), `_meta/probes-<date>.{md,json}`.

## One command

```powershell
pip install -r ai-engine/requirements-mbm.txt
python ai-engine/scripts/mbm_data.py build --vps root@157.10.98.70 --ssh-key ~/.ssh/grw_oracle
python ai-engine/scripts/mbm_data.py status
```

`build` = market-hours guard → Angel login → today's scrip-master snapshot → resolve the
NIFTY driver universe (`ai-engine/src/mbm/universe.json`) → depth probe for any Angel
series without one → incremental backfill of every series (re-requests last run's failed
chunks) → pull + import prod exports → summary table. Re-running is safe: it only fetches
after the last stored bar and never duplicates rows.

Flags / env: `--store` (`MBM_STORE`), `--env` (default `apps/api/.env`; a worktree has no
`.env`, so pass the main checkout's), `--instrument NIFTY`, `--allow-market-hours`,
`--vps` (`MBM_VPS`), `--ssh-key` (`MBM_SSH_KEY`).

Angel pulls are refused Mon–Fri 09:00–15:45 IST: the PC logs in as the same Angel user
prod trades with. Credentials are read from `ANGEL_ONE_*` and never printed or stored.

### Exit codes

| code | meaning |
|---|---|
| 0 | everything fetched |
| 1 | a chunk, series, probe or export failed — named in the summary; re-run `build` (it retries them) |
| 2 | refused (market hours) or bad usage |

## Probes

```powershell
python ai-engine/scripts/mbm_data.py probe --db-url <local TD_Automation url>
# or, without a DB password, export the old contract tokens to CSV first:
#   docker exec td-postgres psql -U postgres -d td_automation -Atc "copy (select symbol, token, exchange as exch_seg, to_char(expiry,'YYYY-MM-DD') as expiry from instruments where expiry < now() and symbol ~ '^(NIFTY|CRUDEOIL)[0-9]{2}[A-Z]{3}[0-9]{2}FUT$') to stdout with csv header" > expired.csv
python ai-engine/scripts/mbm_data.py probe --expired-tokens expired.csv
```

Writes `_meta/probes-<date>.md`: the earliest month each series serves (Angel 1m;
Yahoo per interval) and whether expired NIFTY / CRUDEOIL futures still return candles.
`unknown` = the probe hit an API error (never read as "no data"); re-run. The `--db-url`
is read-only and meant for the local DB only — never prod.

## Prod nightly export

`scripts/ops/mbm-export.sh`, run by `grw-mbm-export.timer` at 19:45 UTC (01:15 IST,
before the 02:00 IST chain prune). Writes `/opt/grw/exports/<table>/<table>-<IST date>.csv.gz`
for `oi_snapshots` (joined to the contract identity), `oi_wall_snapshots`,
`option_chain_snapshots`; streams `COPY … TO STDOUT | gzip` into a `.partial`, `gzip -t`,
then renames. Catches up the last `EXPORT_CATCHUP_DAYS` (7) nights, skips files already
written, keeps `EXPORT_KEEP_DAYS` (30) days. Exit 1 = a table failed; exit 4 = a weekday
with zero rows in all three tables (feed down or holiday). Any non-zero exit sends
`GrW MBM EXPORT FAILED (<code>)` to Telegram — **only if `TELEGRAM_ALERT_BOT_TOKEN` /
`TELEGRAM_ALERT_CHAT_ID` are set in `/opt/grw/env/ops.env`** (empty as of 2026-10-18).

Install (done 2026-10-18):

```bash
sudo cp /opt/grw/app/deploy/systemd/grw-mbm-export.{service,timer} /etc/systemd/system/
# add to /opt/grw/env/ops.env:  EXPORT_DIR=/opt/grw/exports  EXPORT_KEEP_DAYS=30  EXPORT_CATCHUP_DAYS=7
sudo install -d -o grw -g grw -m 750 /opt/grw/exports
sudo systemctl daemon-reload && sudo systemctl enable --now grw-mbm-export.timer
# one-time catch-up of everything still retained (walls 45 d, chain/OI 30 d):
sudo systemd-run --wait --pipe -p User=grw -p EnvironmentFile=/opt/grw/env/ops.env \
  /bin/bash /opt/grw/app/scripts/ops/mbm-export.sh --since $(date -d '45 days ago' +%F)
systemctl list-timers grw-mbm-export.timer
```

**Interim install (until `feature/mbm-m0` is merged and deployed):** the script is at
`/opt/grw/bin/mbm-export.sh` and the drop-in
`/etc/systemd/system/grw-mbm-export.service.d/interim-path.conf` points `ExecStart` at it.
It must not be copied into `/opt/grw/app`: `deploy.sh` refuses a dirty tree, so an
untracked file there would stop every deploy. After the merge has deployed:

```bash
sudo rm -r /etc/systemd/system/grw-mbm-export.service.d /opt/grw/bin/mbm-export.sh
sudo systemctl daemon-reload
```

Check a run: `journalctl -u grw-mbm-export.service -n 50`; files: `ls -R /opt/grw/exports`.

## Pull to the PC

`build --vps … --ssh-key …` pulls and imports automatically. Separately:

```powershell
python ai-engine/scripts/mbm_data.py pull-exports --vps root@157.10.98.70 --ssh-key ~/.ssh/grw_oracle
python ai-engine/scripts/mbm_data.py import-exports
```

Pull is `ssh`/`scp` with `BatchMode=yes`, skips files already on the PC and `*.partial`,
and verifies each gzip before giving it its final name.

## Weekly build (Windows Task Scheduler)

Live futures contracts and Yahoo 1m/5m (29 / 59 days) only grow forward if `build` runs
before they expire or age out, and the PC must pull exports at least every 30 days.

```powershell
schtasks /Create /SC WEEKLY /D SAT /ST 10:00 /TN GrW-MBM-build /TR "\"C:\Users\AryanKumar\AppData\Local\Python\pythoncore-3.14-64\python.exe\" C:\Users\AryanKumar\Desktop\GrW\ai-engine\scripts\mbm_data.py build --vps root@157.10.98.70 --ssh-key C:\Users\AryanKumar\.ssh\grw_oracle"
schtasks /Query /TN GrW-MBM-build
```

## M1 how-to: train Model A offline

Install the training deps once: `py -3 -m pip install -r ai-engine/requirements-mbm.txt`
(adds `lightgbm`). Then, with the store built:

```powershell
$env:PYTHONIOENCODING="utf-8"
py -3 ai-engine/scripts/mbm_train.py train-a --instrument NIFTY            # full run, ~1 h on a 4-core laptop
py -3 ai-engine/scripts/mbm_train.py train-a --instrument NIFTY --no-ablation --horizons 30m   # quick check
```

- **Features** (`ai-engine/src/mbm/features.py`, featureSet `mbm-fs1`): 5m bars built from
  1m, row at t = bar ending at t. Price features plus driver groups `banknifty`, `vix`,
  `heavyweights`, `global_daily` (Yahoo daily, only trading dates before the NSE session
  date). A missing driver gives null columns. Changing features = new `featureSet`.
- **Decision rows**: every 15 min 09:30–15:15 IST; the `next` horizon uses only 15:15.
- **Labels** (`labels.py`): range over 1m bars starting in [t, t+h); "big" = above the
  trailing 60-session median at the same minute of day (causal).
- **Walk-forward** (`model_a.py`): expanding window, ≥ 12 months (last 2 = isotonic
  calibration), retrained monthly; quantile models refit every 3 months.
- **Outputs**: `grw-mbm\models\m1\nifty\` — `dataset.parquet` (feature cache; pass
  `--rebuild` after new bars or a feature change), `preds_<h>.parquet` (blind predictions),
  `<h>\classifier.txt`, `<h>\q25|q50|q75.txt` (LightGBM boosters), `<h>\meta.json`
  (columns, isotonic table, regime bands), `metrics.json`. Report:
  `grw-mbm\reports\m1-nifty-<date>.md` (gate, ablation, calibration, regimes, monthly AUC).
- **Gate** per horizon: AUC ≥ 0.65 in each of the last 3 blind months, Brier over those
  months below the trailing baseline, ≥ 300 blind observations in total.

## M2: ship, seed, deploy, check, rollback

Contract: `docs/superpowers/plans/2026-10-19-mbm-m2-serving.md`. M2 is **observe only**: no trade
path reads the predictions. Run the steps in order, outside market hours. Every PC-side command
takes `--dry-run`, which prints the SQL and scp plan and touches nothing; run it first.

**Before step 1:** the M2 migration (`mbm_bars_1m`, `mbm_predictions`, `ai_models.instrument/horizon`,
the `grw_ai` grants) must already be deployed by the normal API deploy. Also, `ai_models` has
the SP3 partial unique index `ai_models_one_active_per_kind` on `(kind) WHERE active`. With it in
place, two active `mbm-move` rows (30m and 60m) cannot coexist, and the ship transaction fails
and rolls back. The migration has to widen that index to `kind × instrument × horizon`.

PC side, from `ai-engine/` (`MBM_VPS` / `MBM_SSH_KEY` env vars can replace the flags):

```powershell
# 1. Ship the M1 artefacts (grw-mbm/models/m1/nifty/{30m,60m}) and upsert the GO registry rows.
#    Files go to <h>.partial, are checked with sha256 and then moved into place. Only after that does
#    one transaction deactivate older rows of kind x instrument x horizon and activate the new ones.
#    A horizon whose M1 gate did not pass is refused (exit 2).
py -3 scripts/mbm_ship.py ship --instrument NIFTY --version 20261019-fs2 --vps root@<vps-ip> --ssh-key ~/.ssh/grw_oracle --dry-run
py -3 scripts/mbm_ship.py ship --instrument NIFTY --version 20261019-fs2 --vps root@<vps-ip> --ssh-key ~/.ssh/grw_oracle

# 2. Seed broker 1m bars (NIFTY, BANKNIFTY, INDIAVIX, EQ_*) for the last 60 days from the PC store.
#    Run `mbm_data.py build` first so the store is current. The script loads each series into a
#    temp table with COPY and then upserts. It is idempotent, so a re-run is safe.
py -3 scripts/mbm_ship.py seed-bars --days 60 --vps root@<vps-ip> --ssh-key ~/.ssh/grw_oracle
```

VPS side:

```bash
# 3. Build + start the service. It builds grw-mbm:<sha> from `git archive <sha>:ai-engine`,
#    runs `up -d --no-deps mbm`, waits for the Docker healthcheck, then tags :current and keeps
#    3 images. If the new build is unhealthy, it rolls back to the previous sha, or stops mbm on
#    a first deploy. The API deploy timer never touches mbm.
sudo bash /opt/grw/app/scripts/deploy/mbm-deploy.sh            # HEAD of /opt/grw/app
sudo bash /opt/grw/app/scripts/deploy/mbm-deploy.sh <sha>      # a specific commit (also manual rollback)

# 4. Turn the API side on: in /opt/grw/env/api.env set
#      MBM_ENABLED=observe  MBM_INSTRUMENTS=NIFTY  MBM_URL=http://mbm:5100
#    then recreate the api (next deploy, or: docker compose ... up -d --no-deps api).
```

**Check:**

```powershell
py -3 scripts/mbm_ship.py verify --vps root@<vps-ip> --ssh-key ~/.ssh/grw_oracle   # read-only
```
It prints the model dirs under `/opt/grw/models/mbm`, the `mbm-move` registry rows (exactly one
active row per horizon), the per-series `mbm_bars_1m` counts with first and last bar, and the
`mbm_predictions` counts. On the VPS:
`docker logs --tail 50 grw-mbm`;
`docker exec grw-mbm python -c "import urllib.request;print(urllib.request.urlopen('http://127.0.0.1:5100/health').read())"`.
`/health` should list `{"NIFTY":["30m","60m"]}`. If it lists none, the registry rows or the files
under `/models` are missing, so check `verify`. During a session, `lastRun` should advance every
5 minutes.

**Rollback:**
- API stops reading MBM: set `MBM_ENABLED=off` in `api.env` and recreate the api. Nothing in the
  trade path depends on MBM in M2, so this is always safe.
- Bad service build: run `mbm-deploy.sh <previous-sha>` (`docker image ls grw-mbm` lists the kept shas;
  `/opt/grw/state/mbm_sha` is the running one).
- Stop the service entirely: `docker compose -f /opt/grw/app/deploy/docker-compose.prod.yml --env-file /opt/grw/env/compose.env stop mbm`.
- Bad model: re-ship the previous version, which reactivates its rows, then `docker restart grw-mbm`
  so it reloads the active rows.

**RAM check** (2 GB box, `mem_limit: 300m`): run `docker stats --no-stream grw-mbm grw-api grw-postgres`
and `free -m` after the first full session. If mbm sits above about 250 MiB, or if swap grows
session after session, stop it and report before raising the limit.
