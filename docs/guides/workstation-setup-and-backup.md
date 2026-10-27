# Workstation setup and backup

How the GrW work is spread across GitHub, the VPS and the developer machine. It covers what to back up before a machine is reset, and how to rebuild the machine afterwards.

Written 2026-10-27, before the owner's machine was reset. **No secret values appear in this file.**

---

## 1. Where everything lives

| What | Where | In git? |
|---|---|---|
| App code: `apps/api`, `apps/web`, `packages/shared`, `ai-engine`, `prisma`, `scripts`, `docs` | this repo, `github.com/ak2117k/GrW` | yes |
| Production app and database | VPS `157.10.98.70` (Docker: `grw-api`, `grw-postgres`); env at `/opt/grw/env/api.env` | no; it lives on the server |
| Web app | Cloudflare Workers. It builds from **any** pushed branch, so push only `main` | built from git |
| Research spikes and MBM data | `C:\Users\<you>\grw-mbm\` | **no** |
| Local env files | `.env`, `apps/api/.env`, `ai-engine/.env` | **no** (gitignored) |
| SSH keys | `~/.ssh/grw_oracle` (VPS), `~/.ssh/id_ed25519` | **no** |
| Claude Code memory | `~/.claude/projects/C--Users-<you>-Desktop-GrW/memory/` | **no** |
| Claude Code settings and skills | `~/.claude/settings.json`, `~/.claude/skills/`, and `GrW/.claude/settings.local.json` | **no** |
| ML model artefacts | `ai-engine/data/` (pattern model and training JSON) | **no** (gitignored) |
| Session handoffs | `docs/handoffs/` | yes |

### 1.1 Repo layout

```
GrW/
├── apps/api/        NestJS backend. Modules under src/modules/: signal-intake, signal-trader,
│                    telegram, trade-sentinel, self-review, overnight-scorecard, news-impact, ...
├── apps/web/        React + Vite frontend (deployed by Cloudflare)
├── packages/shared/ shared types and constants
├── ai-engine/       Python. scripts/mbm_data.py builds the MBM dataset from the VPS
├── prisma/          schema.prisma and migrations (applied by deploy.sh on the VPS)
├── scripts/deploy/  deploy.sh, run by the grw-deploy timer on the VPS
├── scripts/ops/     ops helpers (mbm-export, ...)
├── worker/          Cloudflare worker entry
├── mcp-server/      local MCP server (td-trading)
└── docs/            architecture, guides, handoffs, superpowers specs and plans
```

Tooling: Node ≥ 20 and pnpm 10.33 (`packageManager` in `package.json`).

### 1.2 Research folder (`grw-mbm`, about 2.6 GB, not a git repo)

```
grw-mbm/
├── _meta/        manifest, scrip_master, weekly-build.cmd + log
├── bars/         1m / 5m / 60m / 1d candles exported from the VPS
├── exports/      backtest-data, oi_snapshots, oi_wall_snapshots, option_chain_snapshots
├── models/       m1, m4, stock-move
├── reports/      forward / m1 / m4 NIFTY reports
├── stock-move/   prices
└── research/     one folder per spike: chart-image, chart-oi, level-break, near-zones,
                  nse-oi, oi-pattern, stock-daily, trend-reversal, zone-draw-a..d, zone-engine
```

The spike verdicts are recorded in Claude's memory. Most are NO-GO. `zone-engine` is the owner's ongoing method, started 2026-10-26.

### 1.3 Local scheduled task

Windows Task Scheduler runs **`GrW-MBM-build`** weekly, on Saturday at 10:00, using `grw-mbm\_meta\weekly-build.cmd`. It runs `ai-engine/scripts/mbm_data.py build --vps root@157.10.98.70 --ssh-key ~/.ssh/grw_oracle` using Git's ssh, because Windows OpenSSH rejects the key's file permissions. After a reset, this task must be **re-created by hand**.

---

## 2. Backing up before a reset

1. **Code.** Check that nothing is left only on the machine:
   ```bash
   git status --short                                 # empty
   git stash list                                     # empty
   git log --branches --not --remotes --oneline       # empty = every commit is on GitHub
   git worktree list                                  # check each worktree with git status
   ```
2. **Non-secret files** go to OneDrive. A work OneDrive is fine for these:
   - `grw-mbm\` (skip the `__pycache__` folders)
   - the Claude memory folder
   - `~/.claude` settings and skills
   - `ai-engine/data/`
   - `.claude/settings.local.json`
3. **Secrets** must NOT go to a work or shared drive, because company admins can read it:
   - the `.ssh` keys
   - every `.env` file
   - `Desktop\render.env`
   - the Angel One client key note

   Use a USB drive, a password-protected 7-Zip archive (AES-256) on personal storage, or OneDrive Personal Vault. Keep the archive password somewhere else.

### Backup made on 2026-10-27

- Non-secret files: `OneDrive - Panamoure\GrW-backup-2026-10-27\`, with these subfolders:
  - `grw-mbm\`
  - `claude-memory\`
  - `claude-user-config\`
  - `GrW-local\ai-engine-data\`
  - `GrW-local\dot-claude\`
  - `GrW-local\news-events-eval-data\`
- Secrets: staged at `Desktop\GrW-SECRETS-backup-2026-10-27\` (`ssh\`, `env\`). **The Desktop is wiped by the reset**, so the owner must move this folder to safe storage first.

---

## 3. Rebuilding after a reset

1. Install Git for Windows, Node 20+, pnpm (`corepack enable`), Python 3.14, Docker Desktop (for local Postgres and Redis), and Claude Code.
2. Clone the repo and install:
   ```bash
   git clone https://github.com/ak2117k/GrW.git C:/Users/<you>/Desktop/GrW
   cd C:/Users/<you>/Desktop/GrW && pnpm install
   ```
3. Restore the secrets:
   - Put the `.ssh` files in `C:\Users\<you>\.ssh\`.
   - Put `root.env` → `GrW/.env`, `apps-api.env` → `apps/api/.env` and `ai-engine.env` → `ai-engine/.env`.
   - `ENCRYPTION_KEY` is 65 characters and **starts with a space**. Copy the files whole, keep the value quoted, and never trim it.
4. Check server access:
   ```bash
   ssh -i ~/.ssh/grw_oracle root@157.10.98.70 "docker ps --format '{{.Names}} {{.Status}}'"
   ```
5. Copy the non-secret folders back:
   - `grw-mbm` → `C:\Users\<you>\grw-mbm\`
   - `claude-memory` → `~/.claude/projects/C--Users-<you>-Desktop-GrW/memory/`. The folder name is derived from the repo path, so clone to the same path to keep the memory linked.
   - `claude-user-config` → `~/.claude/`
   - `ai-engine-data` → `ai-engine/data/`
   - `dot-claude/settings.local.json` → `GrW/.claude/`
6. Re-create the `GrW-MBM-build` scheduled task: weekly, Saturday 10:00, running `grw-mbm\_meta\weekly-build.cmd`. Fix the Python path in the `.cmd` if the new install differs.
7. Re-authenticate GitHub as `ak2117k` so that `git push` works, and reconnect Claude's MCP connectors.

Production keeps running throughout; nothing on the VPS depends on this machine. The one exception is the weekly MBM build, which pulls data *from* the VPS.

---

## 4. Production quick reference

- Deploy: push to `main` → GHCR image → the `grw-deploy` timer on the VPS pulls it and runs `prisma migrate deploy`. When checking the logs, grep for `rolled back|FAILED`; don't grep for `fail`, because the hostname contains "copyfail".
- Database: `docker exec grw-postgres psql -U grw -d grw`
- Trading flags (as of 2026-10-27):
  - `SIGNAL_TRADING=paper`, `PAPER_TRADING=true`
  - `LIVE_TRADING_ENABLED=false`, `SENTINEL_TRIGGERS_ENABLED=false`
  - **Never** switch on live trading without the owner's explicit yes.
- The latest state of the work is in `docs/handoffs/` (newest file first).
