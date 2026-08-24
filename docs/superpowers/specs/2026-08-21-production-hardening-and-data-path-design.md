# Production Hardening and the Realtime Data Path — Design

**Date:** 2026-08-21
**Status:** Approved design; implementation plan not yet written
**Scope:** P1 (production grade) and P2 (data sync), in one program. P3 (AI/agent pipeline) is deferred.
**Predecessor:** `docs/handoffs/2026-08-18-sentinel-blindness-and-production-hardening.md`

---

## 1. The problem, stated precisely

Three complaints opened this work: the platform is not production grade; data is late at
start and stops refreshing until a manual reload; and the AI pipeline is not integrated.
They are three programs, not one, and they are ordered by dependency — the AI pipeline
cannot be verified until the plumbing beneath it can be observed. P3 is therefore deferred
in full.

What remains is not primarily a code-quality problem. This codebase's dominant failure is
**correct code that never runs, and says nothing about it**:

- Five `onModuleDestroy` hooks: written, unit-tested, never invoked.
- A trade sentinel: complete, green, and never once executed in production.
- An option price 21 hours stale: finite, positive, and therefore invisible.
- An out-of-memory restart loop: reported as a healthy service.

Every one was silent. None was found by a test. Each was found only by someone asking a
question nobody had thought to ask.

That is why this design is organised around **evidence** before repair. "Production grade"
here means far less "write better code" than "prove each path has actually executed in
production."

---

## 2. Structure

**Phase 0 — the evidence spine.** Sequential, blocks everything. Its acceptance test is not
that the code works but that querying production told us something we did not already know.

**Then two parallel tracks**, sharing no files:

| | Track B — Backend | Track F — Frontend data path |
|---|---|---|
| Owns | env + migrations, cron strategy, memory ceiling, feed-slot pressure, security verification, candle persistence | refresh policy, tab-return recovery, honest connection badge, terminal-socket recovery |
| Touches | `apps/api/src/modules/**`, `apps/api/src/common/**`, `prisma/` | `apps/web/src/hooks/**`, `services/websocket.ts`, `components/trading/**` |

**Track B Phase 2** — the tick-poller consolidation — runs last, alone, one module at a time.

### 2.1 Why candle persistence is a backend item

The 8–12 second cold chart load is the browser waiting on roughly five serial broker calls
at 350 ms pacing (`apps/web/src/hooks/useChartData.ts:115-140`, where the cost is documented
in a comment). It presents as a chart symptom, so the instinct is to assign it to the
frontend, where it cannot be fixed. Assigned to Track B, the two tracks become genuinely
disjoint and Track F may assume candles arrive quickly.

### 2.2 Memory: a rule, not a contradiction

The instance must stay as memory-free as possible on Render's 512 MB. Candle persistence
stores more. These reconcile as one rule:

> **Less in RAM. More on disk, always with an expiry.**

Persistence moves data out of process memory into Postgres with a retention window. Any new
table introduced here — `JobRun`, intraday candles — carries a retention policy in the same
change that creates it.

### 2.3 Out of scope

Sentinel behaviour, AI verdicts in the UI, close authority, the dedicated security
remediation pass, and horizontal scaling. Track B's security work is **verification only**.

---

## 3. Phase 0 — the evidence spine

Half of this exists already, and is well built. `apps/api/src/modules/health/health.types.ts`
implements the necessary discipline:

- `Signal<T>` — present with provenance, or absent with a reason. No third state, no silent zero.
- `Freshness` — a never-run path reports `at: null`. Reporting `ageSec: 0` would assert "it
  ran this instant", the precise opposite of the truth.
- `SessionContext` — published beside every age, so a 40,000-second-old candle can be read as
  correct at 02:00 IST instead of firing an alarm every night.
- `/healthz` always returns HTTP 200, denying Render a reason to restart a healthy container
  over a judgement call.

Phase 0 extends this pattern. It does not invent a new one.

### 3.1 Cron execution registry

There are 41 `@Cron()` declarations and `/healthz` reports on none of them. "Has this job
ever run in production?" is currently unanswerable — the exact question that went unanswered
about the sentinel for weeks.

A `JobRun` table (`jobName`, `startedAt`, `finishedAt`, `outcome`, `error`) written by a
single wrapper applied at the scheduler boundary, surfaced as
`jobs: Signal<Record<string, Freshness & { lastOutcome: string }>>`. A job that has never run
reports `at: null`, by name, visibly.

A job that fails to acquire its lease must record `outcome: 'skipped-lease-held'` rather than
vanish. Otherwise a correctly-leasing job is indistinguishable from a dead one.

Retention: 30 days.

### 3.2 Memory reporting

`uptimeSec` reveals that a restart happened, not why. Adding `rss`, `heapUsed`, and
`heapTotal` makes Track B's memory work measurable: fix `toUpsertInputs`, then watch RSS at
refresh time actually fall. Without this, those fixes are unverifiable.

### 3.3 Feed slot pressure over time

`feed.primarySubscriptions` is a point reading — 29 of 30 when last observed. What is needed
is whether it *saturates*: a high-water mark plus a rejection counter, so "we hit the cap and
refused a subscription" becomes a recorded fact instead of a silently missing price.

### 3.4 Client-side feed health

The browser is the only party that knows the badge said "Live" while ticks were dead. Today
that knowledge lives in a `console.warn` nobody reads
(`apps/web/src/services/websocket.ts:296-308`). Promote it to a structured signal the client
POSTs on stall, carrying: `/ws` up or down, seconds since last tick, negotiated transport,
subscribed token count, and whether recovery succeeded without a reload.

This is what settles, from real sessions, why a stall sometimes clears on tab-return and
sometimes requires F5.

### 3.5 Access surface

`/healthz` stays public, unauthenticated, always 200, and cheap — Render probes it. Per-job
detail and memory figures go behind an authenticated `/healthz/detail` (admin JWT), so job
names and subscription counts are not public. A read-only Neon role covers ad-hoc queries
neither endpoint anticipates.

`HealthService` already caches its snapshot and de-duplicates in-flight checks; new signals
join that cache.

---

## 4. Track B — Backend

### B1. Switch on the environment

Set in the Render dashboard (not settable from the repo):

| Variable | Effect while unset |
|---|---|
| `ANTHROPIC_API_KEY` | Sentinel writes "thesis could not be inferred" for every position. The client is built eagerly at boot and fails only on first request, so the service looks healthy. |
| `CRON_LEASE_ENABLED=true` | Lease inert; jobs double-run on overlapping deploys. Logs at ERROR every production boot. |
| `DIRECT_URL` | `prisma migrate deploy` hangs on the pooled PgBouncer endpoint. **Two migrations are written and unapplied.** |

`SENTINEL_SHADOW_ENABLED=true` and `SENTINEL_JUDGE=api` are already committed in
`render.yaml`.

This is first because everything after it is otherwise unverifiable. Verification: the lease
ERROR disappears from boot, and both migrations report as applied.

### B2. Cron strategy — 41 down to roughly 3 clocks

The inventory shows the 41 are not 41 distinct needs.

**Six pollers do the same job.** `adaptive-stop`, `anand`, `breakout-swing`, `sell-futures`,
`ungated`, and `watch-backstop` each run `*/30 * 9-15 * * 1-5` — every 30 seconds through the
session, each independently fetching quotes to price open positions. Six clocks, six quote
paths, one actual job. This is where the compute goes, and a large part of why the 30-slot
feed cap saturates.

**Three timers run around the clock for no reason.**
`trade-engine/services/paper-trade.service.ts:552` refreshes open positions every 15 seconds,
`trade-engine/workers/open-paper-trade-refresher.worker.ts:47` every 30 seconds, and
`signal-generator/services/setup-tracker.service.ts:676` sweeps every 30 seconds — none
market-hours gated. On a 512 MB free instance that is the container kept busy at 03:00 on a
Sunday refreshing positions in a closed market.

**Eleven more are session phase transitions wearing wall-clock hats.** Four EOD square-offs
at 15:15, 15:25, 15:25 and 15:15 across `adaptive-stop`, `sell-futures`, `ungated` and
`risk-guard` are four clocks for one event: the market closed. A morning sequence — 08:00
master refresh, 08:30 commodity roll, 08:45 premarket, 09:15 level-book seed, 09:16 MCX
opening-range lock, 09:30 NSE opening-range lock — is six clocks for one event: the trading
day is starting, in order.

**The design:**

1. A **market-session orchestrator** owns the calendar and per-venue hours and emits phase
   transitions (`PRE_OPEN → REGULAR → OPENING_RANGE_LOCKED → CLOSING → CLOSED`). Modules
   subscribe instead of setting their own alarms.
2. **Position pricing becomes tick-driven** — one monitor on the feed already running, rather
   than six timers firing 720 times a session hoping something changed.
3. **Housekeeping becomes lazy** — prune on write or read; no clock.
4. Beneath the orchestrator, only a few genuinely scheduled entries survive: a daily
   pre-market anchor, a nightly housekeeping anchor, and safety backstops.

A single owner of venue hours has a second payoff. The sentinel's session gate was NSE-only,
leaving an MCX position structurally unwatched for eight hours of its own trading day —
because venue hours were reimplemented per module. The orchestrator makes them one fact.

**Where clocks are retained, deliberately.** Eliminating a cron does not remove the risk of
not-running; it moves it. Tick-driven work fails when the feed dies, and feed death is a
recurring documented event here. For a weekly report, failing at the point of use is
acceptable. For an EOD square-off it is not — "the feed was down so nobody closed the
position" loses money, and CLAUDE.md §9 treats square-off as non-negotiable.

Safety-critical paths therefore use **tick-driven primary + a rare cron backstop + spine
evidence on both**. `watch-monitor/services/watch-backstop-poller.service.ts` is already
named for this idea; the concept is kept and the redundancy removed.

#### B2.1 The backstop is load-bearing, not prudence (traced 2026-08-21)

An investigation into five failing `hard loss-cut` specs established the following, and it
constrains Phase 2 directly.

The stop is **two-strike**: `watch.service.ts:783-799` requires two consecutive breaching
ticks before exiting, incrementing a persisted `slBreachCount` on the first. The same guard
exists in `adaptive-stop-track`, `sell-futures-track` and `ungated-track`. The stop therefore
does not fire on a price fact — it fires on **two ticks**, which makes tick continuity part
of the stop's correctness.

Today nothing is exposed, because every track has a REST path that advances the counter
without the WebSocket:

- `watch-monitor` is WS-driven, and `watch-backstop-poller.service.ts` re-drives WS-starved
  TRADED entries through the same `watch.onTick` every 30 s.
- `ungated`, `sell-futures` and `adaptive-stop` are REST pollers already — they resolve
  prices via `ExitPriceService` and never consult the feed.

**Three of the six pollers Phase 2 proposes to eliminate are the sole reason the stop
survives a feed stall.** Consolidating them onto the tick stream without an equivalent REST
backstop would convert a feed outage — a documented recurring event — into an uncut loss.
The backstop is not a nicety attached to "safety-critical paths"; it is the mechanism that
makes a two-strike stop safe. Phase 2 must deliver the backstop **before** removing any
poller, not alongside it.

#### B2.2 A stop that was not evaluated must be evidence, not a log line

Both the backstop (`watch-backstop-poller.service.ts:62-66`) and the pollers
(`ungated-tick-poller.service.ts:69-71`) skip an entry when the resolved price is not fresh:

```
this.logger.warn(`... unmonitored — no fresh price, onTick skipped`);
continue;
```

A stop that was **not evaluated** produces a warning and nothing else — no counter, no
health signal, no record. This is the platform's signature failure sitting on the stop path.
Phase 0 gains a counter for it, and it is read as part of the Phase 2 baseline: a
consolidation cannot be judged safe against a baseline that does not count the ticks it
never evaluated.

**Wrapping.** Surviving jobs get lease and `JobRun` recording from **one wrapper in one
pass** — `apps/api/src/common/cron-lease/` already exists, and the lease boundary and the
recording boundary are the same seam. Two passes would guarantee drift: some jobs leased but
unrecorded, others the reverse. Each TTL is chosen against that job's measured runtime; a TTL
shorter than the job lets a second instance start it, which is worse than no lease.

#### B2.3 The exit path sleeps 800 ms exactly when the feed is starved

`transitionLossCut` re-confirms the loss with an independent quote before exiting
(`watch.service.ts:955`), which is correct — a glitch tick must not trigger a real exit, and
the abort logic was verified working. But that confirmation runs through `fetchLivePrice`,
which tries the WS cache first and otherwise retries REST `QUOTE_FETCH_ATTEMPTS = 3` times
with `QUOTE_RETRY_MS = 400` between attempts. When no quote resolves, that is **800 ms of
real sleep**, and `transitionLossCut` is awaited inside `applyTick`, which `onTick` awaits
per entry in a serial loop (`watch.service.ts:719-722`). The backstop poller likewise loops
its starved positions serially.

On the WS-driven path this rarely bites: the tick that triggered the breach is usually still
fresh in the cache, so `fetchLivePrice` returns without a round-trip. It bites on the
**REST-driven paths** — the backstop and the three track pollers — which have no WS cache to
hit. Those are exactly the feed-starved conditions the backstop exists to cover, so the
latency arrives precisely when the system is already degraded, and it compounds with the
30 feed slots and the 350 ms historical gate already recorded as scarce-resource ceilings.

Consequence for Phase 2: the consolidation's baseline must record **exit latency**, not only
how often positions are priced. A design that prices positions more often but serialises
800 ms per exit during a broad market drop — when many positions breach at once — is not an
improvement. Not fixed here; recorded so the consolidation is judged against it.

### B3. Memory ceiling

`toUpsertInputs` materialises roughly 52,000 derivative objects in one array, and
`bulkUpsertInstruments` performs roughly 74,000 individual upserts per refresh
(`market-data/repositories/market-data.repository.ts`,
`market-data/services/instrument.service.ts`). These are two bounds on one operation — peak
RSS and round-trip count.

Fix both with a batched generator: yield chunks of about 2,000, upsert each chunk in one
statement, never hold the full set. Verified against the spine's `rss` at refresh time. If
RSS does not fall, the fix did not work, and we will know rather than assume.

### B4. Cold-start candles

Extend the daily-candle persistence from `ae4d691` to intraday timeframes. Serve `/candles`
from Postgres; fall back to the broker only for genuine gaps; backfill asynchronously. The
cold chart load becomes a database read. Retention window applies (§2.2).

### B5. Feed slot pressure

Instrument the 30-slot cap: high-water mark and rejection counter. **Measurement only in this
program.** Smarter eviction or pooling is a real design problem and deserves the actual
saturation pattern as input. If the data shows the cap is rarely reached, this closes for
free — and the tick-poller consolidation in Phase 2 is expected to reduce pressure
substantially on its own.

### B6. Security verification pass

Confirm what is believed already true rather than assume it: no secrets in logs, an auth
guard on every route, rate limits present, credential-vault decryption zeroized. Output is a
findings list. Only critical items are fixed here; the rest are logged for a later dedicated
pass.

This is included precisely because "we already follow most of it" is the same class of claim
that the five never-invoked shutdown hooks also satisfied.

**Named item, found during Phase 0 (2026-08-21): seven tenant-owned models are not enrolled
in tenant scoping.**

`apps/api/src/common/tenant/tenant.constants.ts` defines `TENANT_MODELS`, the set the Prisma
scoping extension auto-scopes by `userId`, and its own docblock states: *"Keep verbatim in
sync with the schema; a missing name here is a silent isolation hole."* Twenty models carry
a `userId` scalar. Thirteen are listed. **Seven are not:** `TradeTracker`, `StockMonitor`,
`SentinelThesis`, `SentinelVerdict`, `Payment`, `AuditLog`, `ExecutionClaim`.

**This is not currently a data leak, and the verification pass should not report it as one.**
Every user-facing read was checked: `TradeTrackerService.listOpen/list/listSold/listSoldOhlc`
each scope by `userId` explicitly, with `listSoldOhlc` throwing `NotFoundException` on a
miss; `StockMonitor`'s call sites pass `userId` on every read, update and delete. The only
unscoped `TradeTracker` reads are the two documented cross-tenant engine paths
(`distinctOpenTokens`, and the per-user grouping that allocates feed slots).

What is missing is enforcement. Correctness rests on every author remembering, in perpetuity,
to write `where: { userId }`. An endpoint added next month that forgets it would serve one
user another's open positions, and would pass every test in the suite — the same silent-
absence shape as everything else in this program, with a tenancy boundary instead of a cron.

Two things the pass must establish, neither of which can be read off the file:

1. **Which absences are deliberate.** `AuditLog` (admin-read, hash-chained) and
   `ExecutionClaim` (engine-internal idempotency) are plausibly intentional. Plausibly
   intentional and recorded as intentional are different states, and the file cannot
   currently distinguish them. Whatever the answer, it belongs in that docblock.
2. **Whether enrolling the rest is safe.** Likely yes — the extension scopes only when a
   tenant context is active, and engine/cron code runs with none, which is precisely what the
   `SYSTEM_USER_ID` docblock describes. That must be verified against the cross-tenant engine
   paths before any name is added, not assumed.

Found by a subagent working on the job registry, which had no reason to be looking at tenancy.

**Named item, found during Phase 0 (2026-08-21): truncation is not redaction.**
`health.service.ts:100` renders errors through a `describe()` that whitespace-collapses and
caps at 200 characters, justified in its own comment by the fact that Prisma connection
errors carry the full `DATABASE_URL`. `JobRunRepository` adopted the same helper. But a
length cap only removes a credential that appears *after* the first 200 characters, and a
connection error puts the URL near the front. The strings reach two surfaces that matter:
the `job_runs.error` column, readable via `/healthz/detail`, and `logger.warn` — which
CLAUDE.md §9 says credentials must never reach.

Deferred here rather than fixed inline because at least two `describe()` implementations
share the flaw and they deserve one consistent redaction pass, not a local patch that leaves
the other lying. The verification pass should establish whether Prisma error messages in
this version actually embed credentials before deciding the shape of the fix — the existing
comment asserts they do, and that assertion has not itself been verified.

### B-Phase 2. Tick-poller consolidation

Last, and alone. It touches six modules that manage real money.

The reason to separate it is attribution. Changing six trading modules at the same time as
flipping three environment variables, applying two migrations and rewriting the instrument
upsert path means that a stop which stops triggering next week cannot be traced to a cause.

**Gates:** spine live; a baseline recorded across at least two full sessions covering how
often positions are actually priced and what fires.

**Method:** one module at a time, `ungated-track` first. The old poller stays behind a
disabled-by-default flag for one session per module, so a regression is a config flip rather
than a redeploy.

---

## 5. Track F — Frontend data path

### 5.1 What the code shows

- **49 `setInterval` loops across 36 files.**
- **Zero `visibilitychange` listeners. Zero `online` listeners.**
- **No data-fetching library** — no TanStack Query, no `QueryClient`. Every loop is hand-rolled
  `useEffect` + `setInterval` + axios.
- Exactly **one** reference to `document.hidden`, at `useChartData.ts:428`, which *skips* the
  refresh while hidden and has nothing to catch it up on return.

This explains the reported symptom that a stall sometimes clears on tab-return and sometimes
does not. There is no tab-return recovery anywhere. Apparent recovery is coincidence — the
user returned shortly before a 5, 20 or 30-second interval happened to fire. Otherwise they
wait out a browser-throttled background timer and reach for F5.

### F1. An honest connection badge

"Live" currently means `connectedCount > 0` across four namespaces, so `/ws/telegram` being
up renders "Live" with a dead tick feed. Only `/ws` carries ticks.

Replace with three states derived from `/ws` **tick freshness**: `Live` (a tick within the
threshold), `Stale` (socket up, ticks stopped), `Offline`. Highest-value change in this
track, because the UI currently asserts something false.

### F2. One refresh primitive

Adopt **TanStack Query**. A shared configuration owns: interval, refetch on tab return,
refetch on network reconnect, market-hours gating, and backoff on error. The market-hours
gate mirrors the backend rule — no polling a closed market at 03:00.

The alternative considered was a small in-house hook with no new dependency. It was rejected
because the 49 hand-rolled loops *are* the defect, and the one that handles `document.hidden`
handles it wrongly. Writing a fiftieth loop — even a good one — repeats the bet that produced
the first 49. A library makes correct behaviour the default rather than something each call
site must remember. Cost is roughly 13 kB gzipped; migration is incremental and existing
loops keep working until their site is migrated.

### F3. Terminal-socket recovery

`websocket.ts:249-260` stops retrying after a capped number of `io server disconnect`
events and then stays down for the remainder of the session — the F5-only case. Add recovery
triggers on tab-return and on `online`, which are exactly the moments a previously hopeless
retry is likely to succeed. The existing cap stays, so a genuinely invalid token cannot spin
a hot loop.

### F4. Cold start

Depends on B4. During priming the UI shows an honest skeleton rather than stale numbers that
later snap to correct.

### F5. Retire the temporary diagnostics

`websocket.ts:119-125` and `296-308` are marked temporary pending confirmation of a tick-feed
stall. That stall is now confirmed. They are replaced by the structured client-health signal
of §3.4.

---

## 6. Testing and verification

### 6.1 Unit level

Follow the pattern this repo already applies well: logic pure and unit-tested, I/O thin at the
edges. `seriesReducer`, `computeSubscriptionDelta`, `ws-retry.ts` and `feedState.ts` are
tested without booting a socket; `health.types.ts` depends on a narrow structural interface so
its spec runs in milliseconds without a broker. New units take the same shape. TDD applies at
implementation.

### 6.2 Verification level — the binding gate

Unit tests are **not** the acceptance criterion. Five unit-tested `onModuleDestroy` hooks were
never invoked in production. Every phase therefore carries a production-observable gate:

| Phase | Gate, checked against production |
|---|---|
| Phase 0 | `/healthz/detail` names a job that has never run |
| B1 | Lease ERROR gone from boot; both migrations applied |
| B2 | Every surviving job reports a real `lastRunAt`; eliminated jobs absent from the registry |
| B3 | `rss` at refresh time measurably below baseline |
| B4 | Cold chart load served from the database, sub-second |
| B5 | A recorded high-water mark and rejection count across a full session |
| B6 | A written findings list, with criticals either fixed or explicitly accepted |
| B-Phase 2 | Per module: positions priced at least as often as the poller baseline |
| F1–F3 | A recorded client-health report showing a stall that recovered without a reload |

> **No phase is complete on a green test suite. Complete means the spine showed the change
> taking effect in production.**

---

## 7. Rollout

1. **Phase 0** — sequential, single worker.
2. **Track B (B3, B4, B5, B6) and Track F (F1, F2, F3, F5)** — parallel across agents. Disjoint
   files, no shared state.
3. **Track B Phase 2** — last, one module at a time, behind flags.

B1 is a prerequisite of everything and depends on dashboard access outside the repo. If it
slips, say so immediately rather than proceeding onto unverifiable ground.

**Agents share one working tree.** Every commit must use explicit pathspecs. A bare
`git commit` or `git commit -a` sweeps a sibling agent's staged files into the wrong commit.

---

## 8. Risks

| Risk | Mitigation |
|---|---|
| **Consolidation makes a two-strike stop feed-dependent** (§B2.1) — three of the six pollers are today the only thing advancing `slBreachCount` without the WebSocket | REST backstop ships **before** any poller is removed, never alongside; per-module gate in Phase 2 |
| Tick-driven monitoring makes the feed a single point of failure | Cron backstop retained for safety-critical paths; spine alarms on tick staleness |
| A stop skipped for want of a fresh price is invisible (§B2.2) | Counter in Phase 0; read as part of the Phase 2 baseline |
| The exit path sleeps up to 800 ms per position, serially, on the REST paths (§B2.3) — worst during a broad drop, when many positions breach at once | Phase 2's baseline records exit latency, not only pricing frequency; not fixed in this program |
| Candle persistence grows the database | Retention window in the same change; disk with expiry, never RAM |
| TanStack migration touches 36 files | Incremental; existing loops keep working until each site is migrated |
| Session orchestrator centralises timing logic | Per-venue hours unit-tested against known holiday and DST edges before any module subscribes |
| B1 depends on the user | First gate; blocks the rest; escalate early |
| Phase 2 touches live money paths | Baseline first, one module at a time, old poller behind a flag for one session |

---

## 9. Decisions recorded

| Decision | Choice | Reason |
|---|---|---|
| P3 (AI pipeline) | Deferred until P1 and P2 land | Unverifiable without the plumbing beneath it |
| Security | Verification pass inside this program; remediation later | Confidence in existing controls, worth confirming cheaply |
| Memory items | In scope, treated as reliability not scalability | OOM and a full feed cap both present as "data silently stopped" |
| Production access | Read path — `/healthz`, `/healthz/detail`, read-only Neon role | Turns three open unknowns into measured facts |
| Structure | Evidence spine first, then two parallel tracks | Each fix gets proof; tracks are genuinely disjoint |
| Crons | 41 reduced to roughly 3 clocks plus a session orchestrator | Most are phase transitions or duplicated pollers, not scheduled work |
| Refresh policy | TanStack Query | The hand-rolled loops are the defect |
| Phase 2 placement | Inside this program, sequenced last | Deferring leaves the symptoms in place; interleaving destroys attribution |

---

## 10. Open items carried forward

- Connection string must reach the repo through a git-ignored env file, never chat. A prior
  Neon password was pasted in chat and rotating it remains outstanding.
- Two commits (`5e01e63`, `6f72d0d`) are local and unpushed; `git push` was failing
  authentication at the end of the previous session.
- `KEI29SEP265800CE` — entry 271.85, last seen 200.70. Unrelated to this program but still
  needs eyes on it.
