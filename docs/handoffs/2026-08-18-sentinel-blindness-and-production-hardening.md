# Trade sentinel: why it never worked, and the production hardening that followed

**Sessions:** 2026-08-16 → 2026-08-18
**Branch:** `main` — `0b397bb` … `5e01e63`
**Status:** code complete and green; **the sentinel has still never produced a verdict in production**

---

## 1. The one-paragraph version

Two days went into improving a monitor that was never switched on. `SENTINEL_SHADOW_ENABLED`
defaults to `false`, so every verdict ever seen came from a developer laptop. Underneath
that, four separate faults meant the agent could not see the market even when it did run,
and a fifth meant its prices were up to 21 hours stale. All are fixed. None of it has yet
been observed working, because two environment variables remain unset.

The recurring shape, which is worth internalising before touching anything here:

> **Nothing was wrong, so nothing was reported.**

Five services' `onModuleDestroy` hooks were written, unit-tested, and never invoked. A
monitor that had never started returned `200 ok`. A price 21 hours old was finite and
positive. An out-of-memory crash loop presented as a healthy service. Every one of these
was silent, and each was found only by asking a question nobody had thought to ask.

---

## 2. What is blocking, right now

### 2.1 Environment (Render dashboard — cannot be done from the repo)

| Variable | Effect while unset |
|---|---|
| `ANTHROPIC_API_KEY` | The sentinel ticks all session and writes *"thesis could not be inferred"* for every position. The client is built eagerly at boot and only fails on the first **request**, so the service looks perfectly healthy. |
| `CRON_LEASE_ENABLED=true` | The distributed lease is inert; scheduled jobs double-run on any overlapping deploy. Logs at **ERROR** every production boot while off. |
| `DIRECT_URL` | Declared `sync: false` in `render.yaml`. `prisma migrate deploy` hangs on the pooled PgBouncer endpoint (advisory lock). **Two migrations are written and unapplied** — verify before relying on the next deploy. |

`SENTINEL_SHADOW_ENABLED=true` and `SENTINEL_JUDGE=api` are already committed in `render.yaml`.

### 2.2 Git push is failing authentication

`git push` returns `remote: Repository not found` for `github.com/ak2117k/GrW.git` — GitHub's
404-for-unauthorised. Earlier pushes in the same session succeeded, so the credential expired
mid-session. **`5e01e63` is committed locally and unpushed (`main` is 1 ahead of `origin/main`).**
Re-authenticate and push before doing anything else.

---

## 3. The five faults that made the agent blind

Found by reading **stored verdict packets**, not logs. The packet's "absent WITH a reason"
discipline is the only reason they were separable hours after the fact — `unresolvedUnderlying`
wording versus `LEVEL_BOOK_UNBUILT` wording distinguished two faults with identical behaviour.

1. **The spot was a synchronous peek** at `levelBooks.getLevels(token)` — a map seeded only
   for the live feed's fixed universe (indices, five major stocks, five commodities). Nothing
   the user trades is in it, so `underlyingLtp` was null *permanently*, not overnight. One null
   gated four blocks: both nearest levels, `levelBreak`, and the OI capture. Now tiered —
   live tick (≤60 s) → broker quote over the owning user's session → absence naming both tiers.
2. **The `-EQ` suffix was never tried.** The master stores `KEI-EQ`; a derivative's underlying
   arrives as the base name `KEI`, and the two lookups made were *the same string*. Verified
   against production: `KEI` → no match, `KEI-EQ` → token 13310.
3. **Levels were harvested only from `analyze()`'s `setup` arm.** The `no-setup` arm carries a
   full `LevelsSnapshot` whenever a book exists. PDH/PDL/VWAP are facts about market structure
   and do not depend on the engine liking the trade.
4. **`lastLtp` had a null check but no staleness check.** `KEI29SEP265800CE` sat at a price
   stamped 21 hours earlier while cash trackers beside it updated that morning. Now bounded at
   5 minutes, and it **throws** — `ltp` is not a `Block` and the money arithmetic is
   unconditional, so there is no honest way to price a position without a price.
5. **The session gate was NSE-only.** 09:15–15:30 applied to every venue, so an MCX position
   was structurally unwatched for eight hours of its own trading day. Now per-venue and per-user.

---

## 4. Production hardening

| Fix | Commit |
|---|---|
| Scrip-master OOM loop (34.6 MB / 155 k rows; 52 % was unused segments) | `82526b3` |
| **Shutdown hooks never armed** — five services' cleanup had never run | `78d9255` |
| Redis distributed lease for 47 cron jobs | `c950002` |
| Health check reports freshness, not just liveness | `1c5f8ea` |
| Token-queue cache + `@@index([status])` + 2 health indexes | `f45fb05` |
| Daily candles persisted (relieves the 350 ms broker lane) | `ae4d691` |
| Tracker prices via batched quotes (removes the 30-slot ceiling) | `9d3a9eb` |

**Cost control** (`b10e0ab`) — the sentinel's spend scaled with *time* rather than *events*:
~25 of every 30 daily calls were the agent confirming nothing had happened, ≈ ₹8,000/month
per position. Three layers — a free material-change gate, an adaptive 15/60-minute cadence,
and model tiering (Opus on a tripwire fire, Sonnet on a routine heartbeat) — bring that to
≈ ₹840/month, about ₹200 for a five-day trade. Two invariants are pinned by tests: **a FIRE
is never gated, delayed, or downgraded**, and `HEARTBEAT_MAX_MS` (90 min) forces a look
regardless, because the gate reasons only from prices and cannot see an approaching expiry.

---

## 5. Verify first, next session

`/healthz` now answers in one call what previously took a day of database forensics:

```bash
curl -s https://grw-api.onrender.com/healthz
```

| Field | Healthy | Last observed (2026-08-18 16:31 IST) |
|---|---|---|
| `lastCandleAt.ageSec` | < 120 in session | 69 ✅ |
| `lastTrackerUpdateAt.ageSec` | < 60 in session | **22,864** ❌ |
| `lastVerdictAt.ageSec` | minutes | **60,692** ❌ |
| `feed.primarySubscriptions` | — | 29 / 30 cap ⚠️ |

`9d3a9eb` should fix the tracker age; it was pushed after that reading and needs a deploy plus
a live session to confirm.

---

## 6. Open items

- **KEI29SEP265800CE** — entry 271.85, last seen **200.70** (≈ −₹12,450 on 175 qty). First
  real reading after the 21-hour gap; **needs eyes on it.**
- **No open MCX position**, so the commodity path is fixed but unexercised.
- `bulkUpsertInstruments` still does ~74 k individual upserts per refresh.
- `toUpsertInputs` still materialises ~52 k derivative objects in one array.
- **No cron is leased yet** — the infrastructure is in, but each job needs a TTL chosen
  against its own runtime (a TTL shorter than the job lets a second instance start it).
- Render free tier is **512 MB**; Starter is *also* 512 MB. Only Standard (~$25/mo) adds
  memory. The OOM fix may make that unnecessary — watch `uptimeSec` climb past an hour.

---

## 7. Decisions the user has not made

- Whether the agent's judgement is good enough to earn close authority (**Stage 1**). The
  agreed sequence: shadow for a few sessions → compare its calls against the user's own →
  only then wire an executor, with a hard daily-loss cap.
- Which stub factors matter (`fii`, `sector`, `gold`, `crudeOil`, `nasdaq`).
- Their personal exit rules, and whether options are held to expiry or intraday.
- Whether to rotate the Neon password (it was pasted in chat in an earlier session).
