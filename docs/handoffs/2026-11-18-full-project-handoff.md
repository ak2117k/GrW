# GrW: full project handoff (2026-11-18)

> **Start here.** This replaces `docs/deploy/HANDOFF.md`, written in July for the Render/Neon setup, which no longer exists. Use this file to move the project to a new machine. A Claude Code session that reads it, together with the restored memory folder, can continue where the last session stopped.
>
> Snapshot taken **2026-11-18 14:05 IST**. Production was then running commit `ddf5ffb8`, the same commit as `origin/main` and local `main`. **No secret values appear in this file.**

---

## 0. For the Claude session on the new machine

Read these in order before doing anything:

1. This file, all of it.
2. `MEMORY.md` in your memory folder. It indexes about 60 memory files: decisions, spike verdicts, live settings and the owner's working rules. If the folder is empty, the memory restore failed (§5 step 6). Fix that before working.
3. `docs/self-review/fix-queue.md`. The SessionStart hook regenerates it from prod (§7.3). It lists the open fix tickets, and the owner wants them worked first.
4. The newest file in `docs/handoffs/`, which is this one, and `docs/reviews/2026-11-13-correctness-findings.md`. That one is restored from the package, not from git.

Rules that cost real money when broken are in §4 and §8. Read them.

---

## 1. What the project is today

`CLAUDE.md` still describes the March 2026 plan: Angel One, a NestJS API, a React web app and a Python AI engine. That stack is still correct. The direction has changed since then:

- **Personal trading platform first, SaaS later.** The tenant scoping stays, but billing and other SaaS work is frozen. Architecture: `docs/superpowers/specs/2026-09-30-ai-trading-core-architecture-design.md`.
- **The AI runs trades itself.**
  - The **Trade Sentinel** judges every open F&O position. With `SENTINEL_JUDGE=cli` it uses the owner's Claude subscription through the `claude` CLI inside the API container.
  - **AI auto-exit is LIVE.** It places real exit orders on NFO, BFO and MCX.
  - **Signal trading is LIVE.** It takes Telegram channel calls through a judge, 1 lot, options only.
  - The **entry engine** trades on paper only.
  - The **self-review** runs every night. It grades the day's decisions and writes `fix_tickets`.
- **Research runs alongside the app.** Each idea is a "spike" tested against placebo and holdout data, and most have been NO-GO. The verdicts are in memory, and the data is in `C:\Users\<you>\grw-mbm\`.
- **Chart reading** is a new section the owner is teaching (§9.3). It must **not** be wired into the app until the owner says so.

Roadmap names you will see: SP0 (move to the VPS, done), SP1 (market data hub, done), SP2 (core trade lifecycle, M1–M4 live), SP3 (AI gateway, merged but switched off), SP4 (news and stock picks), SP5 (learning loop), SP6 (retire the old silos), SP7 (live). MBM is the market-behaviour model: it predicts how big a move will be, never its direction. It runs in prod in `observe` mode.

---

## 2. Where everything lives

| What | Where | In git? |
|---|---|---|
| App code (`apps/api`, `apps/web`, `packages/shared`, `ai-engine`, `prisma`, `scripts`, `deploy`, `worker`, `mcp-server`, `docs`) | `github.com/ak2117k/GrW`, branch `main` (private) | yes |
| Production API, DB, Redis, MBM, Caddy | VPS **157.10.98.70** (Bharat Datacenter, Noida; sold as "Vyom Cloud Mumbai"), 1 vCPU / 2 GB / 20 GB, Ubuntu, Docker | no |
| Production env | `/opt/grw/env/api.env`, `compose.env`, `ops.env` on the VPS (many dated `.bak-*` copies) | no |
| Web app | Cloudflare Worker `grw` → https://grw.ak-2117k.workers.dev (built from GitHub by Workers Builds) | built from git |
| API public URL | https://157-10-98-70.sslip.io (Caddy, no domain). Swagger is at `/api/docs` and health at `/healthz` | no |
| Backups | Cloudflare R2 bucket **`grwbackus`** (the typo is in the real name, keep it); rclone remote `r2` on the VPS | no |
| Research data and spikes | `C:\Users\<you>\grw-mbm\`: several GB, not a git repo | **no** |
| Untracked repo files | `docs/chart-reading/`, `docs/reviews/`, `research/exit-yardstick/`, `research/oi-zone-spike/` | **no** (the owner said not to commit research) |
| Local env files | `.env`, `apps/api/.env`, `ai-engine/.env` | **no** (gitignored) |
| SSH keys | `~/.ssh/grw_oracle` (VPS root plus the read-only fix-queue pull), `~/.ssh/id_ed25519` | **no** |
| Claude memory | `~/.claude/projects/<repo-path-slug>/memory/` | **no** |
| Claude settings, skills, plugins | `~/.claude/settings.json`, `~/.claude/skills/`, `GrW/.claude/settings.local.json` | **no** |
| ML artefacts | `ai-engine/data/` (15 MB) | **no** |
| Zone Marking Desk (chart-reading page) | claude.ai artifact https://claude.ai/artifact/TPe7hBUby3NMkbvTBvsK62. The owner's marks are stored in its `marks` collection | lives on claude.ai |

### 2.1 Repo map (what matters most)

```
apps/api/src/modules/
  trade-sentinel/     AI exit judge (cycle, packet, thesis, judge, triggers)
  sentinel-executor/  places the real exit orders (AI auto-exit)
  paper-sentinel/     the same judge over paper trades
  signal-intake/ signal-trader/ telegram/   Telegram channel calls → judge → live/paper
  entry-engine/       AI entries (paper)
  self-review/        nightly grading → fix_tickets
  night-report/ overnight-scorecard/ news-impact/ market-cues/ mbm/ ...
  market-data/ (hub, CandleStore, UserFeedSession, per-user Angel feed)
apps/web/             React + Vite; Night Report, Self-review, Telegram Trading, Charts, ...
ai-engine/            Python; scripts/mbm_data.py builds the research dataset from the VPS
prisma/               schema + migrations (deploy.sh applies them on the VPS)
deploy/               docker-compose.prod.yml, Caddyfile, env/*.example, systemd units, sql/
scripts/deploy/       deploy.sh (run by the grw-deploy timer), mbm-deploy.sh
scripts/ops/          bootstrap-server.sh, backup.sh, restore-test.sh, pull-fix-queue.sh, repair SQL
worker/ wrangler.jsonc   Cloudflare Worker (serves the SPA, proxies /api /auth /socket.io to the VPS)
mcp-server/           local MCP server "td-trading" (wired in .mcp.json → http://localhost:4001)
docs/superpowers/specs|plans   every design and plan, dated
docs/handoffs/        session handoffs, newest last
docs/decisions/       decision records
```

Tooling: Node ≥ 20 (24 works), **pnpm 10.33** (`packageManager`), Python 3.14 via `py`, Docker Desktop, Git for Windows. Use Git Bash for the scripts.

---

## 3. Production

### 3.1 Containers on the VPS (`docker ps`)

| Container | What it runs |
|---|---|
| `grw-api` | NestJS API, all crons and pollers, the `claude` CLI for the judge |
| `grw-postgres` | PostgreSQL 17 + TimescaleDB 2.30. About 130 tables. Image pinned by digest |
| `grw-redis` | Bull queues and cache |
| `grw-mbm` | MBM model service, port 5100 |
| `grw-caddy` | TLS for `157-10-98-70.sslip.io` |

Layout: `/opt/grw/{app (repo checkout, detached), env, state (current_sha …), backups, models, exports, backtest-data, bin}`.

### 3.2 How a deploy works

1. Push to `main` → GitHub Actions `api-image.yml` builds the API image and pushes it to ghcr.io (about 3 min). **There is no path filter: a docs-only push also deploys.**
2. `grw-deploy.timer` on the VPS runs `scripts/deploy/deploy.sh` every 2 min. It waits for the image, runs `prisma migrate deploy`, swaps the container and writes `/opt/grw/state/current_sha`.
3. **Market-hours guard:** deploy.sh defers during **NSE** hours only. **MCX evening sessions (until 23:55 IST) are NOT protected.**
4. To force a deploy during market hours (only when the owner asks): `systemd-run --uid=grw ... FORCE=1 deploy.sh`. See the memory files.
5. Web: Cloudflare Workers Builds deploys **every pushed branch to production**. **Push only `main`** (memory `cloudflare-branch-deploys-prod`).
6. When reading deploy logs, grep for `rolled back|FAILED`. Don't grep for `fail`, because the hostname contains "copyfail".

### 3.3 Timers on the VPS (UTC times; IST = UTC + 5:30)

| Timer | Runs at |
|---|---|
| `grw-deploy` | every 2 min |
| `grw-backup` | 00:15 IST, pg_dump → R2, keeps 30 days |
| `grw-mbm-export` | 01:15 IST |
| `grw-restore-test` | monthly; next run 2026-12-01 |

App crons inside the API: self-review 00:30 IST Tue–Sat plus a 09:00 catch-up; auto-apply 01:15 IST; daily candle backfill 23:45 IST; and others. **The VPS runs on UTC, so every `@Cron` needs `timeZone`.** A ratchet spec enforces this.

### 3.4 Everyday commands

```bash
ssh -i ~/.ssh/grw_oracle root@157.10.98.70
TZ=Asia/Kolkata date                                  # ALWAYS take IST from the VPS (Git Bash prints UTC)
docker ps --format '{{.Names}} {{.Status}}'
cat /opt/grw/state/current_sha                        # what is live
docker logs --since 30m grw-api 2>&1 | tail -200
docker exec grw-postgres psql -U grw -d grw           # prod DB (timestamps are UTC without a zone: add 5:30)
docker exec grw-api claude -p "ok" --output-format json   # is the AI judge's CLI alive?
# restart the API on the current image:
cd /opt/grw && GRW_API_TAG=$(cat state/current_sha) docker compose -f app/deploy/docker-compose.prod.yml --env-file env/compose.env up -d --no-deps api
```

Local curl against the API on the server must send `X-Forwarded-Proto: https`, or it gets a 426.

### 3.5 Health on 2026-11-18

- **Disk 92 % (1.6 GB free).** This is above the 85 % trigger in memory `db-hosting-decision`. Prune old images and backups now, and raise the VPS resize (option B) with the owner.
- RAM: 1.9 GB total, about 400 MB available.
- 27 `trade_trackers` rows are OPEN (paper and live together).
- **Telegram ops alerts are NOT configured.** `TELEGRAM_ALERT_BOT_TOKEN` and `TELEGRAM_ALERT_CHAT_ID` are missing, so deploy-failure and incident alerts are silent no-ops.

---

## 4. Live trading state (2026-11-18): read before touching anything

From `/opt/grw/env/api.env`:

| Switch | Value | Meaning |
|---|---|---|
| `SIGNAL_TRADING` | `live` | Telegram calls can place **real** orders |
| `LIVE_TRADING_ENABLED` | `true` | |
| `SIGNAL_MAX_LOTS` / `SIGNAL_MAX_TRADES_PER_DAY` | 1 / 2 | options only (`SIGNAL_LIVE_KINDS`=OPT default), from 09:45 IST |
| `HARD_LOSS_EXIT_RUPEES` | 2000 | real F&O position exits at −₹2k (noise-aware band up to −₹3k) |
| `AI_AUTO_EXIT_ENABLED` / `AI_AUTO_EXIT_MODE` | true / `live` | the sentinel's EXIT_NOW sends **real exit orders** |
| `AI_AUTO_EXIT_HOLD` | 9 symbols | the owner's "don't auto-exit these" list. Remove one only when the owner says |
| `SENTINEL_TRIGGERS_ENABLED` | true | AI price triggers exit real positions |
| `SENTINEL_JUDGE` | `cli` | the owner's Claude subscription token is in `CLAUDE_CODE_OAUTH_TOKEN`; rotate it about yearly |
| `ENTRY_ENGINE` | `paper` | scored against the owner's manual trades before any live use |
| `PAPER_TRADING` | true | |
| `MBM_ENABLED` | `observe` | |
| `NEWS_EVENTS_V2_ENABLED`, `SENTINEL_MARKET_READ` | true | from the 2026-11-16 correctness fixes F1–F3 |

**Rollback:** every env change has a dated backup `api.env.bak-YYYYMMDD-<what>`. Copy it back, then restart the API (§3.4).

**Hard rules:**
- **Never switch on more live trading** (equity exits, entry engine live, more lots) without the owner's explicit yes.
- **Pushing to main = deploying to prod.** Before any push, check the owner's OPEN real positions, MCX until 23:55 IST, and whether the change alters exit behaviour. If an owner decision about a position is pending, settle it first. (A 2026-11-10 push cost the owner their hold-overnight choice.)
- `LIVE_TRADING_ENABLED=false` would **not** make exits advisory. AI auto-exit acts on its own switch.
- Broker errors don't throw. The SmartAPI SDK resolves `{}` or `[]` on error, so a missing order id doesn't prove a rejection. Check the order book by `ordertag`.

---

## 5. Setting up the new machine (step by step)

### Step 1: install

Git for Windows; Node 20+ (24 works); `corepack enable` → pnpm 10.33; Python 3.14 (the `py` launcher); Docker Desktop; Claude Code (CLI or desktop app); VS Code (optional).

### Step 2: clone **to the same path if you can**

```bash
git clone https://github.com/ak2117k/GrW.git C:/Users/<you>/Desktop/GrW
cd C:/Users/<you>/Desktop/GrW && pnpm install
```

Claude's memory folder is named after the repo path (`C:\Users\X\Desktop\GrW` → `C--Users-X-Desktop-GrW`). The restore script works this out from wherever you clone.

### Step 3: secrets (from the **secrets** folder, carried by USB or personal vault, never a work drive)

| File in the secrets folder | Goes to |
|---|---|
| `ssh/grw_oracle`, `ssh/grw_oracle.pub`, `ssh/id_ed25519*`, `ssh/known_hosts` | `C:\Users\<you>\.ssh\` |
| `env/root.env` | `GrW/.env` |
| `env/apps-api.env` | `GrW/apps/api/.env` |
| `env/ai-engine.env` | `GrW/ai-engine/.env` |
| `angel-client-key.txt` | keep somewhere private (Angel One client key note) |

- **`ENCRYPTION_KEY` is 65 characters and starts with a SPACE.** Copy the files whole, keep the value quoted, and never trim it (memory `encryption-key-leading-space`).
- Windows OpenSSH may reject the key because of file permissions. Git Bash's `ssh` works. Or fix it with `icacls grw_oracle /inheritance:r /grant:r "%USERNAME%:R"`.

### Step 4: check server access

```bash
ssh -i ~/.ssh/grw_oracle root@157.10.98.70 "TZ=Asia/Kolkata date; docker ps --format '{{.Names}} {{.Status}}'"
```

### Step 5: restore the package

Copy the `GrW-handoff-2026-11-18` folder anywhere, then run:

```powershell
powershell -ExecutionPolicy Bypass -File <package>\restore.ps1 -RepoPath C:\Users\<you>\Desktop\GrW
```

`restore.ps1` does the following:
- copies the memory into the right `~/.claude/projects/<slug>/memory/`
- copies this conversation's transcript, so `claude --resume` can continue it
- restores `settings.local.json` and the untracked docs and research folders into the repo
- copies `ai-engine/data`
- fetches the local-only git branches from `local-branches.bundle`
- copies `~/.claude/settings.json` and skills, **only if you pass `-UserConfig`**, because it overwrites your settings
- imports the `GrW-MBM-build` scheduled task, **only with `-ScheduledTask`**

### Step 6: research data (`grw-mbm`, several GB)

The package does not include it; copy it directly:

```powershell
robocopy \\OLD-PC\c$\Users\AryanKumar\grw-mbm C:\Users\<you>\grw-mbm /E /XD __pycache__
# or from OneDrive / USB
```

Then edit `grw-mbm\_meta\weekly-build.cmd` if the Python or user path differs. The scheduled task runs it on Saturdays at 10:00. It uses **Git's ssh**, because Windows OpenSSH rejects the key ACL. `mbm_data.py` refuses Angel pulls 09:00–15:45 IST on weekdays, because it uses the same Angel login as prod.

### Step 7: Claude Code

1. `claude` → log in with the owner's account. Then `gh auth login` as **ak2117k**, so `git push` works.
2. Plugins: run `/plugin` and enable the list in §7.1. Settings in `~/.claude/settings.json` also turn them on if you restored with `-UserConfig`.
3. Reconnect the claude.ai connectors (Claude Docs, Atlassian, Microsoft 365, Granola …) in claude.ai settings. They follow the account, not the machine.
4. The `.mcp.json` server `td-trading` needs `cd mcp-server && npm install && npm run build`, and an API on `localhost:4001`. It is optional: it failed to connect in the last session too.
5. Check:
   - open Claude in the repo and ask "what's open in the fix queue?"
   - the SessionStart hook should print the queue
   - `/memory` should show the memory folder

### Step 8: local dev (optional; prod does not need this machine)

```bash
docker compose up -d                 # local Postgres (Timescale pg16) + Redis
pnpm db:migrate                      # Prisma migrations against the local DB
pnpm dev                             # web :3000, api :3001, ai :5000
pnpm test                            # about 3,000 jest tests; run the module's spec, not everything, while iterating
```

The old local DB `TD_Automation` (rich trading history, used for R&D) is only on the old machine's Docker volume. Dump it there with `docker exec td-postgres pg_dump -U postgres td_automation > td_automation.sql` if you want it.

**Nothing on the VPS depends on this machine**, except the Saturday MBM build, which pulls *from* the VPS.

---

## 6. Configuration reference (variable NAMES only)

- **Local `.env` / `apps/api/.env`:**
  - Angel One: `ANGEL_ONE_API_KEY`, `ANGEL_ONE_CLIENT_ID`, `ANGEL_ONE_PASSWORD`, `ANGEL_ONE_TOTP_SECRET`
  - `DATABASE_*`, `REDIS_*`, `API_PORT`
  - `JWT_SECRET`, `ENCRYPTION_KEY`, `VITE_API_URL`, `VITE_WS_URL`, `AI_ENGINE_URL`
  - `PAPER_TRADING`, `LIVE_TRADING_ENABLED`, risk limits, `CHARTINK_WEBHOOK_SECRET`, `ML_TRIGGER_SECRET`, `WEB_ORIGIN`
- **`ai-engine/.env`** (Telegram listener): `TELEGRAM_API_ID`, `TELEGRAM_API_HASH`, `TELEGRAM_SESSION`, `TELEGRAM_WATCH_CHANNELS`, `TELEGRAM_INGEST_URL`, `TELEGRAM_INGEST_SECRET`. Runbook: `docs/guides/telegram-listener-runbook.md`.
- **Prod `api.env`:** the full annotated template is `deploy/env/api.env.example`, about 150 switches. The groups are:
  - sentinel, judge, auto-exit
  - exit discipline and floor
  - triggers
  - market hub
  - OI and chain capture
  - live order sync
  - market cues
  - news and events v2
  - MBM
  - scorecard
  - Telegram alerts
- **Prod `compose.env`:** `PG_USER`, `PG_PASSWORD`, `PG_DB`, `REDIS_PASSWORD`, `AI_DB_PASSWORD`, `API_HOST`.
- **Prod `ops.env`:** backup dir and remotes (`r2:grwbackus`), image repo, export settings, Telegram alert vars.
- **Cloudflare Worker:** `API_ORIGIN` is hard-coded in `worker/index.js` (→ the sslip.io URL). The API's `WEB_ORIGIN` must equal the Worker URL exactly, because CORS fails closed.

The owner's Angel One login is per user: there is no shared feed account. Each user's own Angel account serves live data, history and quotes (memory `feed-per-user-not-shared`). Angel needs a **static IP** for orders, which the VPS provides.

---

## 7. Claude Code setup used on this project

### 7.1 Settings

- `~/.claude/settings.json`: model `opus[1m]`, effort `medium`, theme `dark-ansi`.
- Plugins:
  - superpowers, code-review, pr-review-toolkit, commit-commands
  - frontend-design, security-guidance, claude-md-management, hookify, plugin-dev, agent-sdk-dev
  - github, playwright, serena, atlassian, greptile, ralph-loop
  - explanatory-output-style, canvas-apps (marketplace `microsoft/power-platform-skills`)
- The user settings also carry a **timesheet hook** (`skills/logging-monthly-timesheets/scripts/owner_guard.py`) for the owner's other work. It needs that skill folder, which `-UserConfig` restores.

### 7.2 Repo-local `.claude/settings.local.json`

- 47 allowed command patterns
- `enabledMcpjsonServers`
- the **SessionStart hook** (§7.3)

### 7.3 The SessionStart fix-queue hook

At every session start it runs `scripts/ops/pull-fix-queue.sh`. That script runs read-only psql over SSH with `~/.ssh/grw_oracle` and writes the OPEN `fix_tickets` to `docs/self-review/fix-queue.md` (gitignored), then prints the top of that file into the session. If SSH fails, it writes "fix queue unavailable" and the session still starts.

### 7.4 Memory

About 60 files. `MEMORY.md` is the index. Memory types:
- `feedback-*`: the owner's working rules
- `*-spike`: research verdicts
- `*-status`: live state

Keep updating memory as you work, and convert relative dates to absolute ones.

### 7.5 Continuing the last conversation

The package holds the transcript of session `da610cda-b703-4916-8b19-4a5a971d52e3`. After `restore.ps1`, run `claude --resume` in the repo and pick it. It resumes only if the repo path slug matches; the script handles that. If you don't resume, this file plus memory is enough.

---

## 8. How to work with the owner (the rules that matter)

From the `feedback-*` memories. Each has a **why** in its file.

1. **Push = deploy.** Check open positions and pending decisions first (§4). Push only `main` (Cloudflare deploys any branch). Never push the local branch `parked/exit-noise-unit-delay`.
2. **Take IST from the VPS**, not Git Bash (Git Bash prints UTC).
3. **Work the fix queue first.** If the same code rule keeps going wrong, it needs a ticket or a replay, not another self-review "lesson".
4. **Night jobs must be prod crons inside the app** (shadow plus self-review), not manual Claude runs.
5. **Subagents and workflows run on the opus model.**
6. **Don't drive the browser** to screenshot UI. The owner checks the UI themselves unless they ask.
7. **Multi-timeframe reading:** never judge a symbol from 1m bars alone. Use daily + 15m + the option-chain OI.
8. **Parallel agents on one tree must commit with explicit pathspecs**, never `git commit -a`.
9. **Correctness review style:** one topic at a time, cause first, then the fix, and nothing built until the owner agrees.
10. **Research discipline:**
    - placebo or random-line control
    - a locked holdout, judged per year (2024 / 2025 / 2026)
    - net of costs
    - most ideas end NO-GO, so say so plainly
    - don't present any pattern as a direction edge without new evidence
11. **"Silent absence" is the main bug shape here:** the code is correct but never runs, and nothing reports it. Ask "has it EVER run in prod?" Also suspect the three scarce resources: 30 feed slots, the 350 ms historical-call gate, and RAM.
12. **Credentials are never logged**, pasted or committed. A token that appears in chat counts as exposed: rotate it.

---

## 9. Open work (where to pick up)

### 9.1 Fix queue (prod `fix_tickets`, 7 OPEN on 2026-11-17)

- **risk_manager drops approved live calls silently.** It records no limit or exposure numbers and sends no owner alert. Four tickets cover this, costing about ₹9.5k. The fix: persist the limit, exposure and live-vs-paper counts on each rejection, plus one owner alert per session after more than 2 drops.
- **entry_tolerance / sl_side rejections don't store the numbers that caused them** (signal price, live quote, tolerance, SL level).

### 9.2 Correctness review (owner-led, `docs/reviews/2026-11-13-correctness-findings.md`, local only)

- F1–F3 were built and deployed on 2026-11-16: news window, OI read, multi-timeframe indicators.
- **Unresolved:** on 2026-11-16 the sentinel cycle hung from 09:27 to 13:15 IST. No exits ran and no alert was sent. The root cause is still unknown. This is a priority.
- Next topic: news would have made profit on other stocks. The owner wants to continue the review in order.

### 9.3 Chart reading (new section; **do not integrate into the app**)

- Scorecard: `docs/chart-reading/ideas-scorecard.md` (local). Research: `grw-mbm\research\chart-reading\` (v0) and `chart-reading-v1\` (v1).
- v1 (structure zones checked against OI, VIX, expiry, FII, gamma and max pain) got **0 PASS of 192 holdout cells**. Gross ≈ 0R; costs 0.1–0.44R per trade; real zones ≈ random lines. On the owner's two example days it took no trade, because the mechanical zones are 1–7 point micro-zones.
- **Current step:** the owner marks zones and judges patterns on the **Zone Marking Desk** (https://claude.ai/artifact/TPe7hBUby3NMkbvTBvsK62). It has 22 charts of 15m bars: 2 owner days plus 20 random days from 2017–2023. Version 2 adds an automatic pattern reader (swing labels, trend, triangles, wedges, channels, double tops/bottoms, head & shoulders, flags, candle signals), using only the bars shown so far.
- **When the owner has done about 10 charts:**
  1. Read the `marks` collection with the ArtifactData tool (collection `marks`, one doc per chart id).
  2. Compare his zones and pattern verdicts with the model's: width, count, lookback, and when each zone was drawn.
  3. Recalibrate the zone drawer and the pattern reader.
  4. Re-test on a fresh period with the same guard rails.
- The page source and generator (`extract_zm.py`, `template.html`, `patterns.js`) are in the package under `research-scratch/zone-marking-desk/`.
- Part 3 of the owner's pattern course (neutral patterns) is still expected.

### 9.4 Other open threads

- **Exit shadow record:** re-run the exit-floor replay once there are 30 or more live `exit_noise_reads` rows with `read->'shadow'` (memory `exit-shadow-record`).
- **Entry engine (paper):** score it against the owner's manual trades over 2–3 weeks before any live use.
- **Server disk 92 %:** prune now and raise the VPS resize.
- **Telegram ops alerts:** the bot is not configured. The owner deferred it.
- **AI_AUTO_EXIT_HOLD list:** 9 symbols, several of them expired October contracts. Ask the owner before cleaning it up.
- **MBM M3** (entry gate, sentinel packet block): designed, not built.
- **SP3 AI gateway:** merged with its flag off. Fix the cache-token budget undercount and the other items in memory `sp3-ai-gateway-status` before `AI_GATEWAY_SENTINEL=true`.
- **Local-only branches** (in `local-branches.bundle`):
  - `parked/exit-noise-unit-delay`: **never push**
  - `feature/scorecard-ema-20-80`: tested and not deployed
  - three `worktree-agent-*` fixes: check whether main already has them before reusing
- About 45 old worktrees under `.claude/worktrees/` are NOT carried over. Their branches are on GitHub if needed.

---

## 10. Gotchas index (each has a memory file)

| Gotcha | Memory |
|---|---|
| The level book's `atr14` is DAILY even when the interval says 15m | `level-book-atr-is-daily` |
| psql timestamps have no zone; `sentinel_verdicts` and `ai_calls` are in UTC | `ai-cli-outage-2026-11-06` |
| When AI output is missing, read `ai_calls` by day (`errorClass`), not the run status. The CLI's error goes to stdout, so the log says "no stderr" | `ai-cli-outage-2026-11-06` |
| The paper P&L is gross by design | `paper-pnl-repair-skipped` |
| Keep the 11 stale scanner paper trades OPEN; filter on `TELEGRAM_SIGNAL_NO_FUNDS` instead | `stale-paper-trades-left-open` |
| MCX ₹ multipliers (GOLD ×100, base metals ×1000, GOLDM ×0.1) are still unscaled in entry-gate sizing, the paper summary and the self-review | `signal-trading-live` |
| Worktree junctions need absolute paths; rmdir them before removing a worktree | `worktree-junctions-absolute` |
| Angel scrip master ≈ 35 MB; it's filtered to the segments in use | `grw-scarce-resource-ceilings` |

---

## 11. What is in the transfer package

`Desktop\GrW-handoff-2026-11-18\` (non-secret, OK for OneDrive):

```
HANDOFF.md                       this file
restore.ps1                      restore script (see §5 step 5)
claude-memory\                   the memory folder (MEMORY.md + ~60 files)
claude-session\                  this conversation's transcript (.jsonl + its folder)
claude-user-config\              ~/.claude/settings.json + skills\
dot-claude\settings.local.json   repo-local Claude settings + SessionStart hook
repo-untracked\                  docs/chart-reading, docs/reviews, research/exit-yardstick, research/oi-zone-spike, ai-engine/data
local-branches.bundle            git bundle of the local-only branches
research-scratch\zone-marking-desk\   generator, template, pattern engine, built page
GrW-MBM-build.xml                the Windows scheduled task export
```

`Desktop\GrW-SECRETS-2026-11-18\` (**secret**: USB or personal vault only; delete the Desktop copy after moving it):

```
ssh\   env\   angel-client-key.txt
```

`C:\Users\AryanKumar\grw-mbm\`: copy it separately (§5 step 6).

---

## 12. How to move it all (agreed 2026-11-18)

Git carries only the code and this document. The rest moves by two routes, and **secrets never touch GitHub, a cloud drive or chat.**

### 12.1 Non-secret package → a temporary private GitHub repo

1. The owner creates an **empty private** repo `ak2117k/grw-handoff` at github.com/new (no README).
2. On the old machine, `Desktop\GrW-handoff-2026-11-18` is already a git repo with `origin` set (649 files, byte-exact via `.gitattributes * -text`):
   ```bash
   cd ~/Desktop/GrW-handoff-2026-11-18 && git push -u origin main
   ```
   `chain.pkl` (104 MB, over GitHub's 100 MB limit) is split into `chain.pkl.part00/01`, and `restore.ps1` joins them again.
3. On the new machine:
   ```bash
   git clone https://github.com/ak2117k/grw-handoff.git
   powershell -ExecutionPolicy Bypass -File grw-handoff\restore.ps1 -RepoPath <GrW folder> -UserConfig -ScheduledTask
   ```
4. **Delete the repo afterwards** (Settings → Danger Zone → Delete) and the local clone.

**Never push this package into the GrW repo.** A push to main redeploys the API, a push to any other branch replaces the live website, and files deleted later stay in git history.

### 12.2 Secrets → the new machine's own SSH key + the VPS

No private key is copied between machines.

1. **New machine** (Git Bash):
   ```bash
   ssh-keygen -t ed25519 -f ~/.ssh/grw_oracle -N ""
   cat ~/.ssh/grw_oracle.pub
   ```
   The public key is safe to paste anywhere. It is named `grw_oracle` so the fix-queue hook and the scripts work unchanged.
2. **Old machine** (Claude does this): add that public key to `/root/.ssh/authorized_keys` on 157.10.98.70, then stage the secrets in `/root/handoff-2026-11-18/` (`chmod 700`, files `600`): `root.env`, `apps-api.env`, `ai-engine.env`, `angel-client-key.txt`, and a README.
3. **New machine:**
   ```bash
   scp -i ~/.ssh/grw_oracle -r root@157.10.98.70:/root/handoff-2026-11-18 ~/grw-secrets
   ```
   Then place the files:
   - `root.env` → `GrW/.env`
   - `apps-api.env` → `GrW/apps/api/.env`
   - `ai-engine.env` → `GrW/ai-engine/.env`

   `ENCRYPTION_KEY` starts with a space: copy the files whole.
4. **Clean up:**
   - `rm -rf /root/handoff-2026-11-18` on the VPS
   - delete `Desktop\GrW-SECRETS-2026-11-18` on the old machine
   - delete `~/grw-secrets` on the new machine once the files are in place
   - when the old laptop is retired, remove its key line from `authorized_keys`
5. GitHub access on the new machine: sign in to git or GitHub as `ak2117k`. The old `id_ed25519` key is not needed.

Other ways are acceptable: a direct LAN copy between the two PCs, a USB stick, or a OneDrive Personal Vault.

### 12.3 Status of the move

| Item | State on 2026-11-19 |
|---|---|
| Handoff doc | pushed to `main` (`be5ce99c`, plus this section) |
| Package repo `grw-handoff` | committed locally; waiting for the owner to create the empty GitHub repo |
| Secrets via the VPS | waiting for the new machine's public key |
| `grw-mbm` (several GB) | copy separately (LAN, USB or OneDrive) |
