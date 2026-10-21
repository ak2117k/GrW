# Research backup (grw-mbm → VPS → R2)

`C:\Users\AryanKumar\grw-mbm` (bars, research, models, exports) exists only on the owner's PC.
This backs it up every night:

1. **PC, 23:30 IST**: `backup-research.ps1` copies files that are new or changed since its last
   successful run (size + mtime, tracked in `_meta\research-backup.state.json`) to
   `root@157.10.98.70:/opt/grw/research-backup/`, as one tar.gz unpacked in place. It uses Git's
   `ssh`/`scp` (Windows OpenSSH rejects the key ACL, as in `_meta\weekly-build.cmd`) and
   Windows' `tar`. There is no rsync in Git's usr\bin. Files deleted on the PC are kept on the VPS.
   It refuses to upload if the VPS disk would pass 85%.
2. **VPS, 00:15 IST**: the existing `grw-backup.service` (`scripts/ops/backup.sh`) dumps Postgres
   and, when `RESEARCH_BACKUP_DIR` is set, copies that folder to every `BACKUP_REMOTES` remote under
   `research-backup/` (`rclone copy`, never `sync`; the 30-day dump prune does not touch it). A
   failed research copy exits 4, which sends the usual Telegram alert.

## What is backed up

Measured 2026-10-21:

| Folder | Size | Backed up? |
|---|---|---|
| `research\chart-image\data` (rendered `.npy`) | 675 MB | no: re-render from bars (`render.py`) |
| `research\stock-daily\data` (fetched daily data) | 282 MB | no: re-fetch (`fetch*.py`) |
| `bars\` (Angel 1m/1d/60m since 2016) | 255 MB | no by default: re-download with `mbm_data.py build`; `-IncludeBars` adds it |
| `models\` (m1 160.8 MB, m4 6.7 MB) | 168 MB | yes |
| `research\` other (scripts, results, preds, models) | ~105 MB | yes |
| `exports\` + `exports_raw\` | 29 MB | yes |
| `_meta\` (manifest, scrip master, probes) | 4.6 MB | yes |
| `__pycache__`, `*.pyc` | <1 MB | no |

So about **270 MB in scope (226 MB compressed)** for the first run. Later runs send only what
changed. The whole store (1.5 GB) does not fit: the VPS has 20 GB at about 71% used, and about
2.8 GB of room before 85%.

## Enable it (owner)

The scripts are inert until these steps are run.

**1. On the VPS**, opt the nightly R2 backup in. This takes effect once a commit with the new
`backup.sh` has deployed:

```bash
ssh -i ~/.ssh/grw_oracle root@157.10.98.70 \
  'mkdir -p /opt/grw/research-backup && chmod 755 /opt/grw/research-backup &&
   grep -q "^RESEARCH_BACKUP_DIR=" /opt/grw/env/ops.env ||
   echo "RESEARCH_BACKUP_DIR=/opt/grw/research-backup" >> /opt/grw/env/ops.env'
```

**2. On the PC** (PowerShell), test with a dry run, then run once for real (about 226 MB), then
register the nightly task:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File C:\Users\AryanKumar\Desktop\GrW\scripts\research-backup\backup-research.ps1 -DryRun
powershell -NoProfile -ExecutionPolicy Bypass -File C:\Users\AryanKumar\Desktop\GrW\scripts\research-backup\backup-research.ps1
powershell -NoProfile -ExecutionPolicy Bypass -File C:\Users\AryanKumar\Desktop\GrW\scripts\research-backup\register-research-backup-task.ps1
```

**3. Check it** the next morning:

```powershell
Get-Content C:\Users\AryanKumar\grw-mbm\_meta\research-backup.log -Tail 5
```
```bash
ssh -i ~/.ssh/grw_oracle root@157.10.98.70 'du -sh /opt/grw/research-backup; journalctl -u grw-backup --since yesterday | grep research'
```

## Disable it

```powershell
Unregister-ScheduledTask -TaskName GrW-Research-Backup -Confirm:$false
```
Then remove the `RESEARCH_BACKUP_DIR=` line from `/opt/grw/env/ops.env`.
