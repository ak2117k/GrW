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
