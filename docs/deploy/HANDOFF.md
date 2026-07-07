# GrW — Deployment & Session Handoff

> Snapshot of the free-tier production deploy as of **2026-07-07**. The app is
> **live end-to-end in paper mode**. This doc is the pick-up point for the next
> session. Detailed setup steps live in [`FREE-DEPLOY-RUNBOOK.md`](./FREE-DEPLOY-RUNBOOK.md).

---

## 1. TL;DR — current state

| | |
|---|---|
| **Status** | ✅ Live, paper mode. Signup → login → JWT verified working end-to-end. |
| **Frontend** | https://grw.ak-2117k.workers.dev (Cloudflare Worker) |
| **API** | https://grw-api.onrender.com (Swagger at `/api/docs`) |
| **Mode** | `PAPER_TRADING=true`, `LIVE_TRADING_ENABLED=false`, `BILLING_PROVIDER=fake`. No real orders, no live feed. |
| **Repo** | `github.com/ak2117k/GrW`, branch `main`, autoDeploy on. |

---

## 2. Deployed architecture

```
Browser
  │  (same-origin; /api + /auth proxied by the Worker)
  ▼
Cloudflare Worker  "grw"  (wrangler.jsonc + worker/index.js)
  ├── serves the SPA (static assets from apps/web/dist)
  └── proxies /api/* and /auth/* ──► Render API
                                       │
                                       ├──► Neon Postgres  (Singapore, pooled)
                                       └──► Render Key Value / Redis (Oregon, internal)
```

| Piece | Service | Region | Notes |
|---|---|---|---|
| Web | Cloudflare **Worker** (not Pages) | edge | Pages `_redirects` can't proxy to an external origin, so the Worker does it. |
| API | Render web service (Docker) | **Oregon** | Free tier — **sleeps after ~15 min idle** (first request cold-starts 10–50s). |
| DB | Neon Postgres | Singapore | Free tier autosuspends. Cross-region to Render (tolerated). |
| Redis | Render Key Value | Oregon | Internal/private endpoint, plaintext. Free = 25 MB, 50 connections, no persistence. |

---

## 3. Access & config

- **Secrets** live in the **Render dashboard** (`grw-api` → Environment) and are **not** committed. Templates: `render.yaml`, `.env.production.example`.
- **Neon / Cloudflare / Render** dashboards are under the owner's accounts.
- **Login accounts** (activated during the session — email verification is bypassed, see §5):
  - `anandmarks@gmail.com`
  - `smoketest+deploy@example.com`
  - Temporary passwords were shared in-session — **change them on first login**. To create/activate more, see §5.

> ⚠️ **Rotate exposed secrets.** The Neon DB password and the (now-unused) Upstash
> password passed through the setup chat. Rotate them if this becomes more than a
> personal demo, and keep the repo private.

---

## 4. How to deploy changes

- **API or web code** → commit + push to `main`. Render (API) and Cloudflare (web) both **auto-deploy** on push. Web build ≈ 2–3 min; API build ≈ 4–8 min.
- **DB migrations** are **NOT** run on container boot. Run them **from a machine that can reach Neon's direct endpoint** (see §5 / runbook Step 1), then deploy the code.
- **Env changes** → edit in the Render dashboard; saving triggers a redeploy.
- Frontend→API origin is hard-coded in `worker/index.js` (`API_ORIGIN`); `WEB_ORIGIN` on Render must equal the Worker URL exactly (fail-closed CORS).

---

## 5. Key gotchas (all resolved — don't re-discover them)

1. **Migrations run out-of-band.** `prisma migrate deploy` hangs on Neon's pooled `-pooler` endpoint (PgBouncer advisory lock) and Render can't reach Neon's *direct* endpoint. Container CMD only starts the API. Apply migrations from a machine reaching Neon direct; schema has `directUrl = env("DIRECT_URL")`.
2. **Neon autosuspend → P1001.** First connection after idle needs `&connect_timeout=30` on the URL (and warming the compute with a trivial query helps). Applies to `DATABASE_URL` and migration `DIRECT_URL`.
3. **Upstash is unreachable from Render** (`getaddrinfo ENOTFOUND`, even IPv4-forced). Redis is now **Render Key Value** (internal endpoint): `REDIS_TLS=false` + `REDIS_ALLOW_PLAINTEXT=true`, `REDIS_FAMILY` unset. Don't switch back to an external Redis without testing reachability from Render.
4. **Optional config must not `getOrThrow` at boot** (Angel One creds were crashing paper-mode boot). The login rate-limit guard **fails open** if Redis is down.
5. **Cloudflare Pages can't proxy to an external origin.** The frontend is a **Worker** (`wrangler.jsonc` + `worker/index.js`), not a static Pages site.
6. **CORS is fail-closed.** `WEB_ORIGIN` must equal the Worker URL exactly, or browser logins 500.
7. **Email is the `console` transport** (default; SES transport is stubbed/non-functional). Verification/reset links are **logged to Render, not emailed**. Login requires a verified account, so new signups can't self-verify. To make an account usable:
   ```
   # 1. sign up via the API (creates a valid password hash)
   POST https://grw-api.onrender.com/auth/signup  {"email","password","displayName"}
   # 2. activate it in the DB (over the Neon POOLED url, from a machine reaching Neon):
   UPDATE users SET "emailVerifiedAt" = now(), status = 'ACTIVE' WHERE email = '<email>';
   ```
   (Alternatively, grab the `[email] … Verify your email address … <link>` line from the Render logs and open it.)
8. **No live socket feed.** `socket.io` (WebSocket) is not proxied by the Worker; paper mode has no live Angel One stream anyway. Real-time charts won't stream — expected on this stack.

---

## 6. Pending / next steps

- [ ] **Responsive pages.** The app **shell** (sidebar drawer + header) is now mobile-responsive (commit `f83979e`). Individual **pages** (dashboard cards, wide tables, charts) may still overflow on narrow screens — needs a per-page pass. Report specific screens.
- [ ] **Real email** (optional). Implement the SES transport (`apps/api/src/modules/auth/services/email/ses.transport.ts`, currently stubbed) or wire a provider (e.g. Resend) + set `EMAIL_TRANSPORT`, so signups self-verify without DB edits.
- [ ] **Rotate secrets** exposed during setup (Neon password; old Upstash password).
- [ ] **Change temporary account passwords** (§3).
- [ ] **(Optional) live feed** — would need a WebSocket-capable proxy (the current Worker only proxies HTTP `/api` + `/auth`) and a live data source; out of scope for paper mode.
- [ ] **(Optional) build chunk size** — `apps/web` emits a >500 kB JS chunk; code-split if it matters.

---

## 7. Reference

- Runbook (full setup): [`docs/deploy/FREE-DEPLOY-RUNBOOK.md`](./FREE-DEPLOY-RUNBOOK.md)
- Deploy config: `render.yaml`, `apps/api/Dockerfile`, `.dockerignore`, `.env.production.example`, `wrangler.jsonc`, `worker/index.js`
- Key commits (this session): `179aa94` deploy artifacts · `4cb9ece` out-of-band migration · `0f77f0d` Angel One boot fix · `5e10fe9` Redis boot resilience · `0237f9b` fail-open rate limit · `3e94bfd` Render Key Value · `bb95d17` Cloudflare Worker · `f83979e` responsive shell
