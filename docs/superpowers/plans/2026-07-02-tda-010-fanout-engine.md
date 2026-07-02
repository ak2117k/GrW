# TDA-010 Central Signal Fan-Out Engine — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Turn one central signal into one sanitized `signal-fanout` job and then into one independent `execute-user` job per eligible user (subscribed + connected + auto-on), with per-user rate-limit isolation, per-job retry/backoff, and a dead-letter queue — provenance-safe end to end. This spec builds the topology only; TDA-011 fills the per-user execution pipeline.

**Architecture:** A new `@Module SignalFanoutModule` registers two Bull queues (`signal-fanout`, `execute-user`) plus a `execute-user-dead` DLQ. `AnandDualTrackService.createEntries()` best-effort enqueues a `signal-fanout` job (built from `toPublicEntry` → `PublicSignal`) after a successful entry insert. `SignalFanoutWorker` computes eligibility (`FanoutEligibilityService`, unscoped join over `Subscription` + `AutoTradeConsent` + `BrokerCredential`) and enqueues one `execute-user` job per eligible user with a stable `idempotencyKey = sha256(entryId:userId)`. `ExecuteUserWorker` is a shell that acquires a per-user Redis token bucket (`PerUserRateLimiter`) then delegates to a TDA-011 `AutoExecutionService` (injected `@Optional()` so this lane lands before TDA-011). Attempts-exhausted jobs move to the DLQ.

**Tech Stack:** NestJS 11, `@nestjs/bull` + Bull on Redis, Prisma 6 (Postgres `td_saas`/`td_saas_test`), Node `crypto` (reuse TDA-008 `sha256`), Jest 29.7 + ts-jest. RBAC/tenant from TDA-003 (`runWithoutTenant`). Sanitizer from TDA-006 (`toPublicEntry`, `ANAND_PROVENANCE_KEYS`).

## Global Constraints

- **No schema change in this spec.** All eligibility inputs (`Subscription`, `AutoTradeConsent`, `BrokerCredential`) already exist (TDA-001). Idempotency-key *generation* lives here; the durable idempotency *store* is TDA-011/012. Confirm `prisma migrate status` clean before/after (no migration expected).
- **DB:** dev `td_saas`, tests `td_saas_test` (`DATABASE_URL_TEST`). `docker exec td-postgres psql -U postgres`. Never `prisma migrate reset`.
- **Redis:** Bull uses the app-wide connection from `app.module.ts` (`BullModule.forRootAsync`). Queue tests use a Redis test instance (or the `bull` in-memory path where feasible); never point tests at a prod Redis.
- **Commit prefix:** `TDA-010:`. No `.env`. Stage only changed files (no `git add -A`).
- **Provenance rule (inherited from TDA-006):** a fan-out job payload may contain ONLY `PublicSignal` fields. Never copy `scannerName`, `scoreBreakdown`, `leadCount`, `leadDates`, `trailing`, `exitReason`, `alertId` onto a job. A CI guard locks this.
- **Fail-closed eligibility:** any user not positively confirmed subscribed + auto-on (`enabled && !killSwitch`) + connected is excluded. The fan-out pre-filter is an optimization; TDA-011 re-checks authoritatively.
- **Isolation invariant:** every user is a separate `execute-user` job; the fan-out enqueue loop try/catches each `queue.add`; per-user rate buckets are keyed on `userId`. No shared mutable state across users.
- **`AutoExecutionService` seam:** `ExecuteUserWorker` injects the TDA-011 executor `@Optional()` and, when absent (this lane merges first), logs + no-ops after the rate gate so the topology is testable standalone.
- **Test harness:** reuse the TDA-003 Style-A focused-boot pattern for DB-backed specs. New tests in `apps/api/test/tda010/` with a `jest.config.js` mirroring `apps/api/test/tda003/jest.config.js` (`roots`→`test/tda010`, otplib stub mapped). Run from `apps/api` with Jest 29.7 `--verbose`: `npx jest --config test/tda010/jest.config.js --verbose` (prefix `DATABASE_URL_TEST=…` for DB specs).

---

## File Structure

- `apps/api/src/modules/signal-fanout/dto/public-signal.dto.ts` — **create.** `PublicSignal`, `FanoutJob`, `ExecuteUserJob` types + `toPublicSignal(entryRow, segment, side)` builder + `idempotencyKeyFor(entryId, userId)`.
- `apps/api/src/modules/signal-fanout/services/fanout-eligibility.service.ts` — **create.** `eligibleUserIds(segment)` (unscoped join).
- `apps/api/src/modules/signal-fanout/services/per-user-rate-limiter.ts` — **create.** Redis token bucket `acquire(userId, weight?)`.
- `apps/api/src/modules/signal-fanout/services/signal-fanout.service.ts` — **create.** `enqueueFanout(signal)` (the producer helper injected into anand).
- `apps/api/src/modules/signal-fanout/workers/signal-fanout.worker.ts` — **create.** `@Processor('signal-fanout')`.
- `apps/api/src/modules/signal-fanout/workers/execute-user.worker.ts` — **create.** `@Processor('execute-user')` shell + rate gate + DLQ-on-failed handler.
- `apps/api/src/modules/signal-fanout/signal-fanout.module.ts` — **create.** Registers the 3 queues, providers, workers; imports `SubscriptionModule`/`PrismaModule`/`TenantModule`; exports `SignalFanoutService`.
- `apps/api/src/modules/signal-fanout/constants.ts` — **create.** Queue names, job names, `ANGEL_REFILL_PER_SEC=8`, `EXECUTE_USER_CONCURRENCY=5`, job options.
- `apps/api/src/modules/signal-fanout/index.ts` — **create.** Barrel (types + `SignalFanoutService` + `AutoExecutionPort` token — see Task 5).
- `apps/api/src/modules/anand-dual-track/services/anand-dual-track.service.ts` — **modify.** Inject `SignalFanoutService`; best-effort enqueue after each successful insert.
- `apps/api/src/modules/anand-dual-track/anand-dual-track.module.ts` — **modify.** Import `SignalFanoutModule`.
- `apps/api/src/app.module.ts` — **modify.** Import `SignalFanoutModule` (additive).
- `apps/api/test/tda010/` — **create.** `jest.config.js`, `otplib.stub.js` (copy from tda003), `public-signal.spec.ts`, `eligibility.spec.ts`, `rate-limiter.spec.ts`, `fanout-queue.spec.ts`.

---

### Task 1: `PublicSignal` builder + idempotency key + provenance CI guard

**Files:**
- Create: `apps/api/src/modules/signal-fanout/dto/public-signal.dto.ts`, `apps/api/src/modules/signal-fanout/constants.ts`
- Create: `apps/api/test/tda010/public-signal.spec.ts`, `apps/api/test/tda010/jest.config.js` (copy of tda003's, `roots`→`<rootDir>/test/tda010`); copy `apps/api/test/tda003/otplib.stub.js`.

**Interfaces — Produces:**
- `interface PublicSignal { entryId, symbol, segment, side:'BUY', entryPrice, targetPct, stopPct, token }`
- `interface FanoutJob { signal: PublicSignal }`, `interface ExecuteUserJob { userId, signal, idempotencyKey }`
- `function toPublicSignal(entryRow, segment, side='BUY'): PublicSignal` — builds via `toPublicEntry(entryRow, segment)` then projects the execution subset + `side` + `token`. Never spreads the row.
- `function idempotencyKeyFor(entryId, userId): string` — `sha256(`${entryId}:${userId}`)` (import `sha256` from `common/audit`).

**Interfaces — Consumes:** `toPublicEntry`, `ANAND_PROVENANCE_KEYS` (TDA-006 `anand-dual-track/dto/public-entry.dto`), `sha256` (TDA-008 `common/audit/canonicalize`).

- [ ] **Step 1: Write the failing test** — `public-signal.spec.ts`:

```ts
import { toPublicSignal, idempotencyKeyFor } from '../../src/modules/signal-fanout/dto/public-signal.dto';
import { ANAND_PROVENANCE_KEYS } from '../../src/modules/anand-dual-track/dto/public-entry.dto';

const rawRow = {
  id: 'e1', symbol: 'TCS', token: '11536', entryPrice: 100,
  enteredAt: '2026-07-02T04:00:00.000Z', targetPct: 5, stopPct: 5, status: 'OPEN',
  scannerName: '__LEAK_scanner__', scoreBreakdown: [{ name: '__LEAK__', points: 3 }],
  leadCount: 4, leadDates: ['2026-06-01'], trailing: true, exitReason: 'TRAIL_ST', alertId: 'al_1',
};

it('builds a PublicSignal with no provenance key/sentinel', () => {
  const sig = toPublicSignal(rawRow as any, 'INTRADAY');
  const json = JSON.stringify(sig);
  for (const k of [...ANAND_PROVENANCE_KEYS, 'alertId']) expect(json).not.toContain(k);
  expect(json).not.toContain('__LEAK_scanner__');
  expect(json).not.toContain('TRAIL_ST');
  expect(sig).toMatchObject({ entryId: 'e1', symbol: 'TCS', segment: 'INTRADAY', side: 'BUY', entryPrice: 100, targetPct: 5, stopPct: 5, token: '11536' });
});

it('idempotency key is stable per (entryId,userId) and distinct across users', () => {
  expect(idempotencyKeyFor('e1', 'u1')).toBe(idempotencyKeyFor('e1', 'u1'));
  expect(idempotencyKeyFor('e1', 'u1')).not.toBe(idempotencyKeyFor('e1', 'u2'));
  expect(idempotencyKeyFor('e1', 'u1')).toMatch(/^[0-9a-f]{64}$/);
});
```

- [ ] **Step 2: Run → FAIL** (module not found). `npx jest --config test/tda010/jest.config.js public-signal --verbose`
- [ ] **Step 3: Implement** `public-signal.dto.ts` (build through `toPublicEntry`, project execution subset, add `side`/`token`; `idempotencyKeyFor` via shared `sha256`) and `constants.ts` (queue/job names, `ANGEL_REFILL_PER_SEC`, `EXECUTE_USER_CONCURRENCY`, `FANOUT_JOB_OPTS = { attempts:3, backoff:{type:'exponential',delay:2000}, removeOnComplete:true, removeOnFail:false }`).
- [ ] **Step 4: Run → PASS.**
- [ ] **Step 5: Commit** `TDA-010: PublicSignal builder + idempotency key + provenance guard`.

---

### Task 2: `FanoutEligibilityService` — subscribed + connected + auto-on

**Files:**
- Create: `apps/api/src/modules/signal-fanout/services/fanout-eligibility.service.ts`
- Test: `apps/api/test/tda010/eligibility.spec.ts` (DB-backed).

**Interfaces — Produces:** `eligibleUserIds(segment: 'INTRADAY'|'SWING'): Promise<EligibleUser[]>` where `EligibleUser = { userId; riskPerTrade: number|null; maxCapital: number|null }`.

**Interfaces — Consumes:** `PrismaService`, `TenantContextService.runWithoutTenant` (TDA-003).

- [ ] **Step 1: Write the failing test** — seed (via a raw `PrismaClient`, unscoped) users covering: (a) fully eligible; (b) subscribed+connected but `enabled:false`; (c) subscribed+connected+enabled but `killSwitch:true`; (d) enabled+connected but subscription `EXPIRED`/expired `expiresAt`; (e) subscribed+enabled but `BrokerCredential.isActive:false`. Assert `eligibleUserIds('INTRADAY')` returns only (a), and carries its `riskPerTrade`/`maxCapital`.
- [ ] **Step 2: Run → FAIL** (no service).
- [ ] **Step 3: Implement** — one query inside `runWithoutTenant`: `autoTradeConsent.findMany({ where: { segment, enabled: true, killSwitch: false, user: { subscriptions: { some: { segment, status:'ACTIVE', OR:[{expiresAt:null},{expiresAt:{gt:new Date()}}] } }, brokerCredential: { isActive: true } } }, select: { userId, riskPerTrade, maxCapital } })`. (Confirm relation names against `schema.prisma` — `user.subscriptions`, `user.brokerCredential`.) Fail-closed by construction (only positive matches returned).
- [ ] **Step 4: Run → PASS.**
- [ ] **Step 5: Commit** `TDA-010: fan-out eligibility (subscribed + connected + auto-on)`.

---

### Task 3: `PerUserRateLimiter` — per-user Redis token bucket

**Files:**
- Create: `apps/api/src/modules/signal-fanout/services/per-user-rate-limiter.ts`
- Test: `apps/api/test/tda010/rate-limiter.spec.ts`.

**Interfaces — Produces:** `acquire(userId: string, weight = 1): Promise<void>` — resolves when a token is available; waits (bounded by `RATE_ACQUIRE_TIMEOUT_MS`, default 5000) otherwise, throwing a typed `RateAcquireTimeoutError` (transient → retryable in TDA-011).

**Interfaces — Consumes:** the Redis client (reuse `common/ratelimit/redis.provider.ts` if it exposes a client; otherwise inject Bull's Redis or a dedicated ioredis provider). Key: `ratelimit:angel:{userId}`, refill `ANGEL_REFILL_PER_SEC` (8/sec).

- [ ] **Step 1: Write the failing test** — 12 rapid `acquire('userA')` calls resolve over ≥ ~1s (8/sec → ~0.5s for the 4 over-budget tokens; assert a lower bound that tolerates CI jitter, e.g. ≥ 300ms), while a single `acquire('userB')` interleaved resolves in < 50ms. (Use a Redis test instance; if unavailable, back the limiter with an injectable store interface and test against an in-memory impl, mirroring `common/ratelimit/memory-rate-limit.store.ts`.)
- [ ] **Step 2: Run → FAIL** (no limiter).
- [ ] **Step 3: Implement** — a token-bucket (Lua-scripted `EVAL` for atomic refill+consume, or the existing rate-limit-store abstraction). Bucket state per `userId`; refill by elapsed-time × rate, cap at burst size (= rate). `acquire` loops with a short sleep until a token is granted or the timeout fires. Isolation is guaranteed by the `userId` in the key.
- [ ] **Step 4: Run → PASS.**
- [ ] **Step 5: Commit** `TDA-010: per-user Angel One rate-limit bucket`.

---

### Task 4: `SignalFanoutModule` + queues + `SignalFanoutService` producer

**Files:**
- Create: `apps/api/src/modules/signal-fanout/signal-fanout.module.ts`, `services/signal-fanout.service.ts`, `workers/signal-fanout.worker.ts`, `index.ts`.
- Modify: `apps/api/src/app.module.ts` (import `SignalFanoutModule`).
- Test: `apps/api/test/tda010/fanout-queue.spec.ts` (fan-out worker portion).

**Interfaces — Produces:**
- `SignalFanoutService.enqueueFanout(signal: PublicSignal): Promise<void>` — best-effort `signal-fanout.add`.
- `SignalFanoutWorker` — `@Processor('signal-fanout') @Process(...)`: reads `job.data.signal`, computes `eligibleUserIds(signal.segment)`, and for each user `try { executeUserQueue.add({ userId, signal, idempotencyKey: idempotencyKeyFor(signal.entryId, userId) }, FANOUT_JOB_OPTS) } catch { log + audit FANOUT_ENQUEUE_FAILED }`.
- `@Global`-free `SignalFanoutModule`: `BullModule.registerQueue({ name:'signal-fanout' }, { name:'execute-user' }, { name:'execute-user-dead' })`; providers `FanoutEligibilityService`, `PerUserRateLimiter`, `SignalFanoutService`, `SignalFanoutWorker`; exports `SignalFanoutService`.

**Interfaces — Consumes:** `@InjectQueue('signal-fanout'|'execute-user')`, `FanoutEligibilityService` (T2), `idempotencyKeyFor` (T1), `AuditService` (TDA-008, `@Optional()` if AuditModule not present in the test boot).

- [ ] **Step 1: Write the failing test** — boot a focused module with `BullModule.forRoot` (Redis test) + `SignalFanoutModule`, a stubbed `FanoutEligibilityService` returning 3 users. Enqueue a `signal-fanout` job; assert 3 `execute-user` jobs appear with the correct distinct `idempotencyKey`s. Second case: stub `executeUserQueue.add` to reject on the 2nd user → assert the 1st and 3rd still enqueue (isolation).
- [ ] **Step 2: Run → FAIL** (no module/worker).
- [ ] **Step 3: Implement** the module, `SignalFanoutService` (best-effort producer), and `SignalFanoutWorker` (eligibility → per-user enqueue loop with per-`add` try/catch). Add `SignalFanoutModule` to `app.module.ts` imports (additive, after `SubscriptionModule`).
- [ ] **Step 4: Run → PASS.**
- [ ] **Step 5: Commit** `TDA-010: signal-fanout module, queues, and fan-out worker`.

---

### Task 5: `ExecuteUserWorker` shell + rate gate + retry/backoff + DLQ

**Files:**
- Create: `apps/api/src/modules/signal-fanout/workers/execute-user.worker.ts`
- Modify: `signal-fanout.module.ts` (register the worker + `AutoExecutionPort` injection token).
- Test: extend `apps/api/test/tda010/fanout-queue.spec.ts` (execute-user + DLQ portion).

**Interfaces — Produces:**
- `ExecuteUserWorker` — `@Processor('execute-user')`: `await rateLimiter.acquire(job.data.userId)`, then `await autoExec?.execute(job.data)` (the TDA-011 port). On `attemptsMade` exhausted (Bull `failed` handler / `@OnQueueFailed`), move payload → `execute-user-dead` + audit `ORDER_REJECTED {reason:'DLQ_EXHAUSTED'}`.
- `export const AUTO_EXECUTION_PORT` DI token + `interface AutoExecutionPort { execute(job: ExecuteUserJob): Promise<void> }` — TDA-011 provides the implementation; this lane binds it `@Optional()`.

**Interfaces — Consumes:** `PerUserRateLimiter` (T3), `@InjectQueue('execute-user-dead')`, `AUTO_EXECUTION_PORT` (`@Optional()`), `AuditService` (`@Optional()`).

- [ ] **Step 1: Write the failing test** — (a) a passing `AutoExecutionPort` stub: assert `execute` is called after a rate token is acquired; (b) an always-throwing stub with `attempts:3`: assert the job retries 3 times then its payload appears in `execute-user-dead`; (c) two jobs (user A throwing, user B passing) → B completes, A dead-lettered, B unaffected (isolation).
- [ ] **Step 2: Run → FAIL** (no worker).
- [ ] **Step 3: Implement** the worker: acquire rate token → delegate to `autoExec?.execute` (no-op + warn when unbound). Add a `@OnQueueFailed` (or global `queue.on('failed')`) handler that, when `job.attemptsMade >= job.opts.attempts`, adds `{ ...job.data, error }` to `execute-user-dead` and audits. Wire `AUTO_EXECUTION_PORT` as `@Optional()` in the module.
- [ ] **Step 4: Run → PASS.**
- [ ] **Step 5: Commit** `TDA-010: execute-user worker shell, per-user rate gate, retry + DLQ`.

---

### Task 6: Tap `createEntries()` — best-effort, provenance-safe emission

**Files:**
- Modify: `apps/api/src/modules/anand-dual-track/services/anand-dual-track.service.ts` (inject `SignalFanoutService`; enqueue after each successful insert).
- Modify: `apps/api/src/modules/anand-dual-track/anand-dual-track.module.ts` (import `SignalFanoutModule`).
- Test: extend `fanout-queue.spec.ts` or a focused `emission.spec.ts` — assert a successful `createIntradayEntry` results in exactly one `signal-fanout` job whose payload has no provenance keys; an insert that throws does NOT enqueue and does NOT propagate (best-effort).

**Interfaces — Consumes:** `SignalFanoutService.enqueueFanout` (T4).

- [ ] **Step 1: Write the failing test** — stub the repo to return a created row; assert `enqueueFanout` is called once per successful segment insert with a provenance-free `PublicSignal`; a repo throw is swallowed (existing behaviour) and no job is enqueued.
- [ ] **Step 2: Run → FAIL** (no enqueue).
- [ ] **Step 3: Implement** — after each successful `createIntradayEntry`/`createSwingEntry`, build `toPublicSignal(createdRow, 'INTRADAY'|'SWING')` and `await this.fanout.enqueueFanout(sig).catch(err => this.logger.warn(...))` inside the existing try/catch, so a fan-out failure never affects the entry insert. Have `createIntradayEntry`/`createSwingEntry` return the created row if they currently return void (minimal change).
- [ ] **Step 4: Run → PASS.**
- [ ] **Step 5: Commit** `TDA-010: emit fan-out job on anand intraday/swing entry creation`.

---

## Self-Review

- Spec coverage: §3 (topology + job shapes) → T1/T4/T5; §4 (eligibility) → T2; §5 (per-user rate isolation) → T3/T5; §6 (failure isolation, retry, DLQ) → T4/T5; §7 (emission tap, provenance-safe) → T6; §10 acceptance: AC1→T4/T5, AC2→T1/T6, AC3→T2, AC4→T4, AC5→T3, AC6→T5, AC7→T5. ✅
- **No schema change** — eligibility inputs pre-exist (TDA-001); idempotency key is computed, not stored (store is TDA-011/012). `prisma migrate status` must be clean. ✅
- **Provenance guarantee:** `PublicSignal` is built only via `toPublicEntry` → projected subset (T1 CI guard reuses `ANAND_PROVENANCE_KEYS` sentinels); no raw row is copied onto a job (T6). ✅
- **Isolation proof:** every user = a separate `execute-user` job; per-`add` try/catch (T4); per-`userId` rate bucket (T3); one job throwing dead-letters without touching siblings (T5). ✅
- **Cross-task type consistency:** `PublicSignal`/`ExecuteUserJob`/`idempotencyKeyFor` defined once (T1) and consumed by the fan-out worker (T4), execute-user worker (T5), and emission (T6). ✅
- **Risk — Redis in tests:** T3/T4/T5 need a Redis test instance for Bull; where unavailable, back `PerUserRateLimiter` with the existing rate-limit-store abstraction and use an in-memory store, and use Bull's test utilities / a mocked queue for enqueue assertions. Do not point tests at a shared Redis.
- **Risk — legacy cron overlap:** the single-account `AutoTradeService` cron is NOT removed here (§8); it executes generic Signals on the engine account, not user accounts. Retirement is a flagged follow-up, non-blocking.

## Dependencies & Spec Coverage

- **Consumes now:** TDA-006 `toPublicEntry`/`ANAND_PROVENANCE_KEYS` (real symbol, not the roadmap's `toPublicSignalDto`); TDA-008 `sha256` (one hasher) + `AuditService` (`@Optional()`); TDA-003 `runWithoutTenant`; TDA-001 `Subscription`/`AutoTradeConsent`/`BrokerCredential` models; the existing app-wide Bull/Redis wiring.
- **Produces for TDA-011:** the `execute-user` job (`ExecuteUserJob` with a stable `idempotencyKey`), the `AUTO_EXECUTION_PORT` DI token + `AutoExecutionPort` interface (TDA-011 implements `execute(job)`), the `PerUserRateLimiter` (TDA-011's pipeline runs behind the same token gate), and the DLQ.
- **Assumed parallel seams (stated, not built here):** TDA-005 provides "connected" via `BrokerCredential.isActive` + the decrypt primitive TDA-011 calls; TDA-009 provides the consent check TDA-011 calls. TDA-010 only needs `BrokerCredential.isActive` for the eligibility pre-filter — a minimal coupling that survives whatever shape TDA-005/009 finalize.
- **Blocks:** TDA-011 (execution pipeline body) and, transitively, TDA-012 (durable idempotency store hardens the key TDA-010 generates + TDA-011 guards).
