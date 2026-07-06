# GrW — Free-Tier Deploy Runbook (paper mode)

Deploy the GrW monorepo for **₹0** from GitHub (`github.com/ak2117k/GrW`, branch `main`):

| Piece            | Free service        | What runs there                          |
| ---------------- | ------------------- | ---------------------------------------- |
| Web (static SPA) | Cloudflare Pages    | React build (`apps/web/dist`)            |
| API              | Render (free web)   | NestJS in Docker (`apps/api/Dockerfile`) |
| Postgres         | Neon                | Prisma DB (migrations applied on boot)   |
| Redis            | Upstash             | Bull queues + rate-limit store           |

Everything runs in **paper mode** (`LIVE_TRADING_ENABLED=false`, `PAPER_TRADING=true`). No real orders, no live market feed.

> Follow the steps in order. Copy-paste is intentional. Do each step fully before the next — later steps need URLs the earlier ones produce.

---

## Prerequisites

- The repo is pushed to `github.com/ak2117k/GrW` (branch `main`) and includes the artifacts committed alongside this runbook: `apps/api/Dockerfile`, `.dockerignore`, `render.yaml`, `apps/web/public/_redirects`, `.env.production.example`.
- Free accounts: [Neon](https://neon.tech), [Upstash](https://upstash.com), [Render](https://render.com), [Cloudflare](https://dash.cloudflare.com) (Pages).
- Generate two secrets now (keep them handy):
  ```bash
  node -e "console.log(require('crypto').randomBytes(48).toString('base64'))"   # JWT_SECRET
  node -e "console.log(require('crypto').randomBytes(48).toString('base64'))"   # ENCRYPTION_KEY (>= 32 chars)
  ```

---

## Step 1 — Neon (Postgres)

1. Neon Console → **New Project** (pick the region closest to your Render region, e.g. AWS `ap-south-1` / Mumbai or `us-east-1`).
2. After it provisions, open **Connection Details** → toggle **Pooled connection** ON → copy the string. It looks like:
   ```
   postgresql://<user>:<pass>@ep-xxxx-pooler.<region>.aws.neon.tech/neondb?sslmode=require
   ```
3. Confirm it ends with `?sslmode=require` — the API **refuses to boot in production** without TLS on the DB URL. Save this as your `DATABASE_URL`.
4. Also grab the **direct (unpooled)** string for migrations: it is the same URL with the host **minus `-pooler`** (toggle Pooled connection **OFF** to see it, or just delete `-pooler` from the host). Save this as your `DIRECT_URL`:
   ```
   postgresql://<user>:<pass>@ep-xxxx.<region>.aws.neon.tech/neondb?sslmode=require
   ```
   Prisma Migrate uses `DIRECT_URL`; the running app uses the pooled `DATABASE_URL`. Strip `channel_binding=require` from both if Neon appended it — Prisma's engine can choke on it.

> **Migrations run OUT-OF-BAND, from your machine — not on container boot.** Render's network reaches Neon's *pooled* endpoint (the app uses it at runtime) but cannot complete a connection to Neon's *direct* compute endpoint that Prisma Migrate needs, and `migrate deploy` hangs on the pooled PgBouncer endpoint. So you apply migrations once from a machine that reaches the direct endpoint (your laptop), then the container just starts the API. Re-run this whenever the schema changes:
>
> ```powershell
> # from the repo root, using the Neon DIRECT (unpooled) URL:
> $env:DIRECT_URL   = "postgresql://<user>:<pass>@ep-xxxx.<region>.aws.neon.tech/neondb?sslmode=require"
> $env:DATABASE_URL = $env:DIRECT_URL
> npx prisma migrate deploy --schema prisma/schema.prisma
> ```
>
> Expect `All migrations have been successfully applied.` The container's `DATABASE_URL` stays the **pooled** URL for runtime.

---

## Step 2 — Upstash (Redis)

1. Upstash Console → **Create Database** → Redis → pick a region near Render → Create.
2. On the database page, from **Details / Connect**, copy these three values:
   - **Endpoint** (host, e.g. `apn1-xxxx.upstash.io`) → `REDIS_HOST`
   - **Port** (usually `6379`) → `REDIS_PORT`
   - **Password** → `REDIS_PASSWORD`

> The app reads `REDIS_HOST` / `REDIS_PORT` / `REDIS_PASSWORD` (three vars), **not** a single `REDIS_URL`. Keep `REDIS_TLS=true` (the Blueprint default): all Redis clients attach a TLS socket when it is set, which Upstash (TLS-only) requires.

---

## Step 3 — Render (API, Docker)

Option A — Blueprint (uses the committed `render.yaml`, recommended):

1. Render Dashboard → **New** → **Blueprint** → connect `github.com/ak2117k/GrW` → branch `main`.
2. Render detects `render.yaml` and proposes the `grw-api` web service (Docker, free plan). Apply it.
3. When prompted, fill the `sync:false` secrets:
   | Var              | Value                                                    |
   | ---------------- | -------------------------------------------------------- |
   | `JWT_SECRET`     | the first generated secret                               |
   | `ENCRYPTION_KEY` | the second generated secret (**≥ 32 chars**)             |
   | `DATABASE_URL`   | Neon **pooled** URL from Step 1 (host has `-pooler`, `sslmode=require`) |
   | `DIRECT_URL`     | Neon **direct** URL from Step 1 (host **without** `-pooler`, `sslmode=require`) — used by Prisma Migrate |
   | `REDIS_HOST`     | Upstash endpoint from Step 2                             |
   | `REDIS_PASSWORD` | Upstash password from Step 2                             |
   | `WEB_ORIGIN`     | **leave as a placeholder for now** (e.g. `https://example.pages.dev`) — you set the real Pages URL in Step 5 |
4. Deploy. First build takes several minutes (installs the workspace, generates Prisma, `nest build`). Watch the logs for `GrW API running on http://0.0.0.0:<port>`.
5. Copy the service URL, e.g. `https://grw-api.onrender.com`. This is your **Render API origin**.

Option B — Web Service (manual, if you skip the Blueprint):
New → **Web Service** → the repo → Runtime **Docker**, Dockerfile path `./apps/api/Dockerfile`, Docker context `.`, plan **Free**. Then add every env var from `.env.production.example` (plus `REDIS_TLS=true`, `REDIS_THROTTLER=true`, `AI_ENGINE_URL=https://ai-engine.invalid`) and deploy.

> Health check: the Blueprint uses `GET /api/docs` (Swagger UI, returns 200). There is no dedicated `/health` route.

---

## Step 4 — Cloudflare Worker + static assets (Web)

The frontend deploys as a **Cloudflare Worker with static assets** (NOT plain Pages):
the Worker serves the SPA and **proxies `/api` + `/auth` to Render server-side**.
This is required because Cloudflare Pages `_redirects` **cannot proxy (200) to an
external origin** — so a static-only Pages site can't forward API calls to Render.
The proxy keeps every browser call same-origin (no CORS). Config lives in
`wrangler.jsonc` + `worker/index.js` (committed); the Render origin is hard-coded
in `worker/index.js` (`API_ORIGIN`) — update it there if the API URL changes.

1. Cloudflare Dashboard → **Workers & Pages** → **Create** → **Workers** → **Connect to Git** (a.k.a. "Import a repository") → select the repo → branch `main`.
2. Build settings:
   - **Build command**: `corepack enable && pnpm install --frozen-lockfile && pnpm --filter @td/shared build && pnpm --filter @td/web build`
   - **Deploy command**: `npx wrangler deploy` (the default; it reads `wrangler.jsonc`)
   - **Root directory**: `/` (repo root — the build needs the workspace + `@td/shared`, and `wrangler.jsonc` is at the root)
3. Set env var `NODE_VERSION=22` so the build uses a Node matching the lockfile.
4. Deploy. Copy the Worker URL, e.g. `https://grw-web.<subdomain>.workers.dev`.

> Why a Worker and not Pages `_redirects`? The React client (`apps/web/src/services/api.ts`) uses a **relative** axios `baseURL: '/api'` and a bare `'/auth/refresh'` — no env-driven base URL to override without a code change. Pages `_redirects` 200-rewrites are **same-site only** (they cannot proxy to Render). A Worker CAN proxy externally, so `worker/index.js` forwards `/api` + `/auth` to Render while `run_worker_first` scopes the Worker to just those paths; all other paths serve the static SPA directly, with `not_found_handling: single-page-application` giving the client-route fallback.

---

## Step 5 — Point CORS at the Worker URL, redeploy API

1. Render → `grw-api` → **Environment** → set `WEB_ORIGIN` to the exact Worker URL from Step 4 (e.g. `https://grw-web.<subdomain>.workers.dev`), **no trailing slash**.
2. Save → Render redeploys automatically.

> `WEB_ORIGIN` is a **fail-closed** CORS allowlist. The browser talks to the Worker (same-origin), but the Worker forwards the browser's `Origin` header to Render on `/api`+`/auth` calls, so it must exactly match the Worker URL or authenticated calls are rejected.

---

## Step 6 — Smoke test

Open the Pages URL and walk the paper-mode flow:

1. **Sign up / Log in** — succeeds → CORS + JWT + DB are wired correctly. (A login 500 usually means `WEB_ORIGIN` is wrong — see Troubleshooting.)
2. **Subscribe** — pick a plan (fake billing provider, no payment).
3. **Connect Angel One** — enter broker creds (stored encrypted; paper mode never places real orders).
4. **Dashboard** — loads. Note: no live socket feed in this free stack (WebSocket isn't proxied), which is expected in paper mode.

---

## Free-tier caveats

- **Render free sleeps after ~15 min idle.** The first request after sleep cold-starts (10–50s). While asleep, **cron/scheduled jobs and Bull queue workers do not run** — signal scans, OI tracking, and housekeeping pause until traffic wakes the service. Fine for paper/demo use; not for a live trading loop.
- **No background worker dyno.** Everything (API + schedulers + queues) runs in the single free web service. When it sleeps, they sleep.
- **Upstash free** caps total commands/day and connections. The rate-limit store and Bull queues share that budget; heavy polling can exhaust it.
- **Neon free autosuspends** the compute after inactivity; the first query after suspend adds a short cold-start (the pooled URL handles reconnection).
- **No live market feed.** `socket.io` is not proxied through Cloudflare `_redirects`, and paper mode has no Angel One streaming feed, so real-time charts won't stream. Acceptable by design here.

---

## Troubleshooting

- **Login / any API call returns 500 or is CORS-blocked** → `WEB_ORIGIN` on Render doesn't match the Pages origin. It must be the exact scheme+host, no trailing slash, comma-separated if multiple. Fix it and redeploy (Step 5).
- **API 404 / calls not reaching Render from the browser** → the `_redirects` host still points at the placeholder. Update both `/api/*` and `/auth/*` lines to your Render origin, commit, and let Pages rebuild (Step 4.1).
- **Deploy hangs after "N migrations found" then "no open ports detected"** → boot-time migration over the **pooled** endpoint hangs (PgBouncer advisory lock). Fixed: the container no longer migrates on boot; run migrations out-of-band (see Step 1).
- **Intermittent `P1001: Can't reach database server` (migrations OR first request after idle)** → Neon free-tier compute autosuspends; the first connection after suspend needs longer than Prisma's default 5s to wake it. `Test-NetConnection <host> -Port 5432` succeeding (TCP) while Prisma still P1001s (TLS/Postgres layer) is the tell. Fix: append **`&connect_timeout=30`** to the URL (both `DATABASE_URL` and, when migrating, `DIRECT_URL`), and optionally "warm" the compute first with a trivial query over the pooler (`echo "SELECT 1;" | npx prisma db execute --stdin --url "<pooled-url>"`).
- **Boot-time migration fails `P1001: Can't reach database server` at the direct host** → Render can reach Neon's pooled endpoint but not the direct compute endpoint. This is why migrations run out-of-band from your machine (Step 1) and the container `CMD` only starts the API. Your laptop reaching the host (`Test-NetConnection <direct-host> -Port 5432` → `TcpTestSucceeded : True`) while Render cannot is the signature of this.
- **App refuses to boot with "Refusing to start — invalid configuration"** → a required prod var is missing/invalid. Common ones: `ENCRYPTION_KEY` shorter than 32 chars, `DATABASE_URL` missing `sslmode=require`, `AI_ENGINE_URL` not `https`, or `REDIS_TLS`/`REDIS_THROTTLER` not exactly `"true"`. The log lists every failure.
- **Docker build fails on `pnpm install --frozen-lockfile`** → the committed `pnpm-lock.yaml` is out of sync with `package.json`. Regenerate the lockfile locally (`pnpm install`) and commit it, or temporarily switch the Dockerfile install line to `--no-frozen-lockfile`.
- **Prisma "engine" / "libssl" error at runtime** → OpenSSL missing from the image. The Dockerfile installs `openssl ca-certificates`; confirm that layer built. The Prisma client is generated inside the linux image (no custom `binaryTargets`), which yields the correct engine.
- **Redis connection errors / login hangs** → confirm `REDIS_TLS=true` is set (the Blueprint sets it by default). When it is, every ioredis client — Bull queues (`app.module.ts`), the rate-limit store (`auth.module.ts`), and the feed pub/sub pair (`market-feed.service.ts`) — attaches a `tls: {}` socket via the shared `redis.tls` config, which Upstash (TLS-only) requires. If you switch to a plain (non-TLS) Redis, set `REDIS_TLS` to anything other than `true` so the clients connect over plain TCP. Double-check `REDIS_HOST` is the bare Upstash endpoint (no `rediss://` scheme, no port suffix) and `REDIS_PASSWORD` is correct.
- **Port binding / "no open ports detected" on Render** → the app now binds `process.env.PORT` on `0.0.0.0` (main.ts). Don't set `PORT` yourself; let Render inject it.
