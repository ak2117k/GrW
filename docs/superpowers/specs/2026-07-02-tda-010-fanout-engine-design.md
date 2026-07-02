# TDA-010 — Central Signal Sanitization + Fan-Out Engine — Design Spec

**Doc ID:** TDA-010
**Date:** 2026-07-02
**Sprint:** S5 (Signals & Auto-Execution) — MVP
**Depends on:** TDA-005 (per-tenant credential vault — "is this user connected?" + the decrypt seam TDA-011 consumes), TDA-006 (the `toPublicEntry()` sanitizer this engine emits through), TDA-003 (RBAC + Prisma tenant scoping + `runWithoutTenant`), TDA-001 (`Subscription`, `AutoTradeConsent`, `BrokerCredential` models)
**Blocks:** TDA-011 (opt-in auto-execution — consumes the `execute.user` jobs this engine produces)
**Owner:** development@panamoure.com

---

## 1. Goal

Turn **one** central signal into **one** sanitized fan-out job, and that into **one
independent execution job per eligible user** — with the guarantee that one user's
failure, throttle, or slow broker **cannot** block, delay, or corrupt any other
user's execution. This spec owns the *topology*: the two Bull queues, the job
shapes, the eligibility computation (subscribed + connected + auto-on), per-user
rate-limit isolation, retry/backoff, and the dead-letter queue. It deliberately
stops **at the boundary** of a user's execution pipeline — decrypt, risk sizing,
order placement, and idempotency are **TDA-011**. TDA-010 delivers the "one signal
→ N isolated jobs" skeleton; TDA-011 fills each job with the actual order pipeline.

The moat constraint from TDA-006 is preserved end-to-end: the signal that leaves
the engine into the fan-out is the **sanitized public shape** (`toPublicEntry`),
never the raw provenance-bearing row. Provenance (scanner, score, lead, exit logic)
**never** enters a fan-out job payload, a queue, or a worker log.

## 2. Background — what exists today (corrected after code map)

- **Bull is already wired app-wide.** `app.module.ts` registers
  `BullModule.forRootAsync` with the Redis connection; feature modules register
  queues with `BullModule.registerQueue({ name })` and process them with
  `@Processor('name')` + `@Process('jobname')` classes (e.g.
  `apps/api/src/modules/chartink/workers/chartink-process.worker.ts`). Default Bull
  concurrency is **1** and the chartink worker documents relying on that. This is
  the exact pattern the fan-out queues follow.
- **The central signal already becomes a tradable entry in one place.**
  `AnandDualTrackService.createEntries()`
  (`apps/api/src/modules/anand-dual-track/services/anand-dual-track.service.ts`)
  is called when a Chartink alert clears scoring; it writes an `IntradayEntry`
  and/or a `SwingEntry` (via `AnandDualTrackRepository.createIntradayEntry` /
  `createSwingEntry`), each guarded (skip if an active TRADED entry exists, target
  already hit today, or a loss already booked today). **This is the natural fan-out
  trigger point** — the moment a central signal becomes a per-segment tradable
  entry.
- **The sanitizer exists (TDA-006).** `toPublicEntry(row, segment)` in
  `apps/api/src/modules/anand-dual-track/dto/public-entry.dto.ts` is the only
  sanctioned outbound serializer; its 14-key allowlist is
  `{ id, symbol, segment, entryPrice, enteredAt, targetPct, stopPct, status,
  exitPrice, exitedAt, currentPrice, pnlPct, targetLeftPct, priceStale }`. Note:
  the roadmap/§4 data-flow calls this `toPublicSignalDto()`; the real symbol is
  `toPublicEntry()` — this spec uses the real symbol (see §9 open item).
- **The eligibility inputs already exist as models (TDA-001):**
  - `Subscription { userId, segment INTRADAY|SWING, status, expiresAt }` — read via
    `SubscriptionService.hasActive(userId, segment)`
    (`apps/api/src/modules/subscription/subscription.service.ts`), which already
    wraps queries in `runWithoutTenant` so it can read across users.
  - `AutoTradeConsent { userId, segment, enabled, killSwitch, riskPerTrade,
    maxCapital, enabledAt }` — the per-user "auto-on" + per-user kill switch +
    per-user risk knobs **already exist in the schema**. `enabled === true` is the
    auto-on flag; `killSwitch === true` disables that segment.
  - `BrokerCredential { userId @unique, enc*, encDataKey, keyVersion, isActive }` —
    "connected" ≈ a row exists with `isActive === true` (TDA-005 owns the connect
    flow + validation).
- **The legacy single-user auto-trade path is the thing being replaced.**
  `AutoTradeService` (`apps/api/src/modules/auto-trade/services/auto-trade.service.ts`)
  runs a `@Cron` scan against **one global engine account** and a single
  `settings.autoTradeMode`, calling `TradeExecutionService.executeTrade`. It has
  **no concept of per-user accounts**. `AngelOneAuthService` is likewise a **single
  global SmartAPI session built from env creds** — there is today no per-user broker
  session. TDA-010/011 introduce the multi-tenant fan-out that supersedes this cron
  for the sanitized Intraday/Swing product (§8 migration note).
- **Rate limiting today is global + historical-only.** The Angel One adapter
  serializes *historical* calls behind a single 350 ms gate
  (`HISTORICAL_MIN_GAP_MS`); there is **no** per-user order-rate bucket. TDA-010
  introduces one (§5).

So TDA-010 is **additive**: a new `SignalFanoutModule` with two queues and two
workers, tapping the existing `createEntries` seam, reusing the existing Bull/Redis
infra, `toPublicEntry`, `SubscriptionService`, and the existing consent/credential
models.

## 3. Topology — two queues, one job per user

```
AnandDualTrackService.createEntries()  (central signal → IntradayEntry / SwingEntry)
        │  (after a successful per-segment insert, best-effort enqueue)
        ▼
   [ signal-fanout ]  ── ONE job per central signal per segment
        │  FanoutJob { entryId, segment, signal: PublicSignal }
        ▼
   SignalFanoutWorker
        │  1. compute eligible users (subscribed + connected + auto-on) for `segment`
        │  2. enqueue ONE execute-user job per eligible user (independent jobs)
        ▼
   [ execute-user ]  ── ONE job PER (signal × user)
        │  ExecuteUserJob { entryId, segment, userId, signal: PublicSignal,
        │                   idempotencyKey }
        ▼
   ExecuteUserWorker   ← TDA-011 fills the pipeline (gate → consent → size →
                          decrypt → place → audit). TDA-010 provides the worker
                          shell, per-user rate gate, retry/backoff, and DLQ.
```

### 3.1 Job shapes (the contract with TDA-011)

```ts
// The sanitized signal that crosses into the fan-out. Derived ONLY from
// toPublicEntry() output + a side. NO provenance field can appear here.
export interface PublicSignal {
  entryId: string;                 // IntradayEntry|SwingEntry id (idempotency input)
  symbol: string;
  segment: 'INTRADAY' | 'SWING';
  side: 'BUY';                     // anand intraday/swing are long-only setups (§9)
  entryPrice: number;
  targetPct: number;               // product param (5 intraday / 10 swing)
  stopPct: number;
  token: string | null;
}

export interface FanoutJob {
  signal: PublicSignal;
}

export interface ExecuteUserJob {
  userId: string;
  signal: PublicSignal;
  // hash(entryId + userId) — the idempotency key. Computed HERE (in fan-out) so
  // it is identical across a retried job and stable for TDA-011's guard + broker tag.
  idempotencyKey: string;
}
```

- `PublicSignal` is built by passing the freshly-created entry row through
  `toPublicEntry(row, segment)` and then projecting to the execution-relevant
  subset **plus** `side` and `token`. Because it is built from the allowlisted DTO,
  a new provenance column on `IntradayEntry`/`SwingEntry` can never leak into a job.
- `idempotencyKey = sha256(`${entryId}:${userId}`)` — computed once in the fan-out
  worker and carried on the job, so a Bull retry of the same job reuses the same
  key. (TDA-008's `sha256` in `common/audit` is reused — one hasher.)

## 4. Eligibility — subscribed + connected + auto-on

`FanoutEligibilityService.eligibleUserIds(segment): Promise<EligibleUser[]>` runs
**unscoped** (it operates across all tenants, like `SubscriptionService`, wrapped
in `TenantContextService.runWithoutTenant`). A user is eligible for `segment` iff
**all** hold:

1. **Subscribed** — an `ACTIVE`, non-expired `Subscription` for `(userId, segment)`
   (identical predicate to `SubscriptionService.hasActive`).
2. **Auto-on** — an `AutoTradeConsent` for `(userId, segment)` with
   `enabled === true` **and** `killSwitch === false`.
3. **Connected** — a `BrokerCredential` with `isActive === true` for the user.

```ts
interface EligibleUser {
  userId: string;
  // carried so TDA-011 sizes to per-user capital without a second query:
  riskPerTrade: number | null;
  maxCapital: number | null;
}
```

Implementation is **one** query: join `AutoTradeConsent` (segment, enabled, not
kill-switched) with an ACTIVE non-expired `Subscription` (same segment) and an
active `BrokerCredential`, selecting `userId, riskPerTrade, maxCapital`. This is a
**coarse pre-filter** for fan-out efficiency (don't enqueue a job for an obviously
ineligible user). TDA-011 **re-checks every gate authoritatively inside the
execute-user job** — the pre-filter is not a security boundary, it is a fan-out
optimization (a subscription can expire, or a kill switch can flip, between the
pre-filter and the job running). **Fail-closed:** any user the query cannot
positively confirm on all three is simply not enqueued.

## 5. Per-user rate-limit isolation

Each user's Angel One key is an **independent 10 req/sec bucket** (Angel One rate
limits per client, not per app). The execute-user worker MUST acquire a per-user
token before any broker call.

- **`PerUserRateLimiter.acquire(userId, weight = 1): Promise<void>`** — a
  Redis-backed token bucket keyed on `ratelimit:angel:{userId}`, refilling at
  **8 tokens/sec** (a deliberate margin under Angel's 10/sec, matching the existing
  adapter's conservative posture). `acquire` waits (with a cap) for a token, so a
  burst for one user self-paces **without** touching another user's bucket.
- Redis (not in-memory) so the bucket holds across API replicas (TDA-013 scales the
  API horizontally; the existing throttler-storage follow-up in the roadmap notes
  the same requirement). At MVP a single replica still works.
- **Isolation guarantee:** the bucket key includes `userId`, so User A saturating
  their 8/sec never consumes User B's tokens. This is the rate-limit half of the
  §6 failure-isolation guarantee.
- **Fan-out concurrency:** the `execute-user` queue runs with worker concurrency
  `EXECUTE_USER_CONCURRENCY` (default 5) so N users' jobs progress in parallel; the
  per-user bucket — not queue concurrency — is what bounds a single user's broker
  call rate. (Order placement per signal is ~1 call/user, so 8/sec is generous;
  the bucket exists to protect a user in both segments or hit by rapid signals.)

## 6. Failure isolation, retry/backoff, dead-letter queue

**One job per user is the isolation primitive.** Because every user's execution is
a separate `execute-user` job, Bull processes them independently: a throw, a
timeout, or a broker reject in one job has **zero** effect on sibling jobs. This is
the structural answer to "one user's failure must not block others."

- **Fan-out worker isolation.** `SignalFanoutWorker` enqueues the N execute-user
  jobs in a loop where **each `queue.add` is individually try/caught** — a failure
  to enqueue user K's job is logged and audited (`FANOUT_ENQUEUE_FAILED`) but the
  loop continues for users K+1…N. The fan-out job itself succeeds if it enumerated
  eligibility; a total eligibility-query failure is the only thing that fails+retries
  the fan-out job.
- **Retry/backoff (per job).** Both queues use Bull job options:
  `attempts: 3`, `backoff: { type: 'exponential', delay: 2000 }` (2s → 4s → 8s),
  `removeOnComplete: true`, `removeOnFail: false` (failed jobs are retained for the
  DLQ move + inspection). Backoff is per-job so a retry of User A's job does not
  delay User B.
- **Non-retryable failures fail fast.** TDA-011 classifies terminal outcomes
  (subscription lapsed, consent not accepted, kill switch on, risk-rejected, broker
  hard-reject) as **non-retryable** — the worker throws an `UnrecoverableError`
  (Bull) / marks the job failed without consuming further attempts, since retrying
  cannot change the outcome. Only transient faults (broker 5xx/timeout, rate-limit
  wait exceeded, DB blip) consume the 3 attempts.
- **Dead-letter queue.** A `execute-user-dead` queue captures any `execute-user`
  job that exhausts its attempts. A global Bull `failed` event handler on
  `execute-user` moves the exhausted job's payload (+ final error, +
  `idempotencyKey`) into `execute-user-dead` and appends an audit row
  (`ORDER_REJECTED` with `reason: DLQ_EXHAUSTED` — taxonomy from TDA-008 §5). The
  DLQ is drained/inspected by an ADMIN; it is never auto-replayed (a replayed order
  is a real-money duplicate — the idempotency guard in TDA-011 is the backstop, but
  auto-replay is deliberately not built).

## 7. Emission — tapping `createEntries` (best-effort, provenance-safe)

- After a **successful** `createIntradayEntry` / `createSwingEntry` insert,
  `AnandDualTrackService.createEntries()` enqueues one `signal-fanout` job for that
  segment, built from the created row via `toPublicEntry` → `PublicSignal`.
- **Best-effort at the producer:** the enqueue is wrapped in try/catch and never
  blocks or fails the entry insert (mirrors the existing `bumpLeadStat` and
  event-log tolerance in that service). A dropped enqueue means a missed auto-trade
  for that one signal, never a corrupted product feed.
- **Provenance safety:** the job is built strictly from `toPublicEntry` output; the
  raw `scoreBreakdown`/`scannerName`/`alertId` on the source row are **not** copied.
  `entryId` (a cuid) is not provenance — it is the idempotency input.
- The fan-out is **only** emitted for the sanitized product signal (anand
  intraday/swing). The ADMIN-only generic `Signal`/scanner machinery (TDA-006 §2)
  is **not** fanned out — it is engine cockpit data, not a user product.

## 8. Migration / coexistence with the legacy auto-trade cron

- The legacy `AutoTradeService` cron (single global account) and TDA-010/011
  (multi-tenant fan-out) address different things: the legacy path executes generic
  `Signal`s on the **engine's own** account; the fan-out executes sanitized product
  signals on **each user's** account. They can coexist during MVP, but the fan-out
  is the sole path for the **user product**. This spec does **not** delete the
  legacy cron; it is flagged for retirement once the fan-out is the only auto-trade
  surface (roadmap follow-up, non-blocking).
- **No global kill switch conflict:** TDA-011 adds the global `LIVE_TRADING_ENABLED`
  gate (already exists in `live-trading.ts`) and honours the per-user
  `AutoTradeConsent.killSwitch`. The engine's in-memory `RiskManagerService`
  kill switch remains the backstop for the shared execution path.

## 9. Out of scope (deferred / owned elsewhere)

- **The execute-user pipeline body** (gate → consent → risk sizing → decrypt →
  place → audit + idempotency guard) — **TDA-011**. TDA-010 provides only the job,
  the per-user rate gate, retry/backoff, and DLQ scaffolding; the worker's
  `process()` delegates to a TDA-011 `AutoExecutionService`.
- **The decrypt seam + broker session per user** — **TDA-005** provides the decrypt
  primitive; TDA-011's isolated execution module calls it. See TDA-011 §for the
  assumed interface.
- **The consent check** — **TDA-009** provides `hasAcceptedCurrentConsent`; TDA-011
  calls it. See TDA-011.
- **DB transactionality of the multi-step trade + a durable idempotency store** —
  hardened in **TDA-012**. TDA-011 ships the minimal local idempotency guard;
  TDA-010 only guarantees the **key is stable across retries**.
- **`side` beyond BUY.** Anand intraday/swing are long-only setups, so
  `PublicSignal.side` is fixed `'BUY'`. If a short product is added later, the
  producer sets `side` and the DTO carries it — flagged in §11.
- Landing/billing enforcement of subscription (TDA-015); mobile (TDA-016).

## 10. Acceptance criteria

1. A new `SignalFanoutModule` registers two queues (`signal-fanout`,
   `execute-user`) plus a `execute-user-dead` DLQ; the module boots inside
   `app.module.ts` (additive) without disturbing existing queues.
2. `createEntries()` enqueues exactly one `signal-fanout` job per successful
   per-segment entry insert, built via `toPublicEntry` → `PublicSignal`; the job
   payload contains **none** of the TDA-006 forbidden provenance keys (asserted by
   a CI guard reusing the TDA-006 sentinel technique).
3. `FanoutEligibilityService.eligibleUserIds(segment)` returns exactly the users who
   are ACTIVE-subscribed to that segment **and** `AutoTradeConsent.enabled &&
   !killSwitch` **and** have an active `BrokerCredential`; it runs unscoped and
   fails closed (unconfirmed → excluded).
4. `SignalFanoutWorker` enqueues one `execute-user` job per eligible user with a
   stable `idempotencyKey = sha256(entryId:userId)`; a failure to enqueue one user's
   job does not prevent the others (per-`add` try/catch, audited).
5. `PerUserRateLimiter.acquire(userId)` gates per user: a burst for one `userId`
   self-paces at ≤ 8/sec while a second `userId` is unaffected (proven by a test
   that saturates one bucket and shows the other acquires immediately).
6. Both queues retry with exponential backoff (`attempts:3`, 2s base); an
   attempts-exhausted `execute-user` job lands in `execute-user-dead` with its
   payload + error + `idempotencyKey`, and is **not** auto-replayed.
7. One `execute-user` job throwing does not fail, delay, or roll back any sibling
   job (proven by a test where user B's job succeeds while user A's throws).

## 11. Open decisions (for the human)

1. **Sanitizer symbol.** The roadmap data-flow names `toPublicSignalDto()`; the
   shipped TDA-006 symbol is `toPublicEntry()`. This spec emits through the real
   `toPublicEntry` and derives `PublicSignal` from it. Confirm we do not rename
   (renaming touches the TDA-006 CI guard).
2. **Long-only assumption.** `PublicSignal.side` is fixed `'BUY'` (anand
   intraday/swing are long setups). Confirm no short product is in MVP scope.
3. **Rate refill target.** 8 tokens/sec (margin under Angel's 10/sec). Confirm the
   margin; raise toward 10 only if order latency under load proves too slow.
4. **Eligibility freshness.** The fan-out pre-filter can go stale before a job runs;
   TDA-011 re-checks authoritatively. Confirm the pre-filter+recheck split (vs. a
   single check at execute time) — chosen for fan-out efficiency at scale.

## 12. Test plan

- **Unit:**
  - `PublicSignal` builder — a raw enriched entry row with provenance sentinels
    (`scannerName:'__LEAK__'`, a `scoreBreakdown`) produces a `PublicSignal` whose
    JSON contains none of the TDA-006 forbidden keys/sentinels (CI guard, reusing
    `ANAND_PROVENANCE_KEYS`).
  - `idempotencyKey` — stable for the same `(entryId,userId)`, distinct across
    users, matches `sha256(entryId:userId)`.
- **Integration (DB-backed, `td_saas_test`):**
  - `FanoutEligibilityService` — seed users in the 8 subscribed/connected/auto-on
    combinations; assert only the fully-eligible ones are returned; kill-switched
    and expired-subscription users are excluded.
- **Queue behaviour (Bull, Redis test instance / in-memory `bull` mock):**
  - fan-out worker enqueues N execute-user jobs for N eligible users, each with the
    right `idempotencyKey`; one `add` rejection → the rest still enqueue.
  - `PerUserRateLimiter` — 12 rapid `acquire(userA)` calls take ≥ ~1s (8/sec) while
    `acquire(userB)` returns immediately.
  - retry/DLQ — a worker stub that always throws exhausts 3 attempts and the payload
    lands in `execute-user-dead`; a sibling job with a passing stub completes.
- **HTTP:** none (no user-facing endpoint in this spec; ADMIN DLQ inspection is a
  TDA-011/ops follow-up).
- Jest 29.7 — run with `--verbose`; reuse the tda003 focused-boot harness for the
  DB-backed eligibility spec.
