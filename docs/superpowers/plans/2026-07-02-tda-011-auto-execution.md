# TDA-011 Opt-In Auto-Execution — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Fill each TDA-010 `execute-user` job with the per-user execution pipeline — subscription gate → consent + per-user kill-switch + global `LIVE_TRADING_ENABLED` → per-user risk sizing → local idempotency claim → decrypt-in-isolated-module → place order (broker tag) → coupled tamper-evident audit — so a real order is placed on a user's own Angel One account only when every gate passes and **exactly at most once** per (signal, user).

**Architecture:** A new isolated `AutoExecutionModule` provides `AutoExecutionService implements AutoExecutionPort` (bound to TDA-010's `AUTO_EXECUTION_PORT`). It orchestrates the ordered pipeline, sizing via `PositionSizer`, claiming via `IdempotencyGuard` (a new `ExecutionClaim` table with a `@unique(idempotencyKey)` backstop), decrypting **only** inside `PerUserBrokerSessionFactory.withUserAdapter` (the sole caller of TDA-005's `CredentialVault.useDecryptedCredential`), and placing through the existing `TradeExecutionService` entry point (extended to accept a per-user adapter + idempotency key). `RiskManagerService` + `LIVE_TRADING_ENABLED` remain the hard backstops. Orders are fatal/transactional audit events (`ORDER_PLACED`/`ORDER_REJECTED`).

**Tech Stack:** NestJS 11, Prisma 6 (Postgres `td_saas`/`td_saas_test`), `@nestjs/bull` (job from TDA-010), Node `crypto` (reuse TDA-008 `sha256`), Jest 29.7 + ts-jest. Reuses TradeEngine (`TradeExecutionService`, `RiskManagerService`), `SubscriptionService` (TDA-007), `AuditService` (TDA-008), `live-trading.ts`.

## Global Constraints

- **THIS lane OWNS the `ExecutionClaim` schema delta + one forward migration.** Forward-only — **never `prisma migrate reset`**, never edit a prior migration. DB: dev `td_saas`, tests `td_saas_test` (`DATABASE_URL_TEST`). `docker exec td-postgres psql -U postgres`.
- **Shared seam `app.module.ts`** — register `AutoExecutionModule` (additive import only).
- **Commit prefix:** `TDA-011:`. No `.env`. Stage only changed files (no `git add -A`).
- **Pipeline order is load-bearing** (spec §4): gates → risk size → **claim** → decrypt → place → settle+audit. The claim MUST precede decrypt/place so a duplicate never decrypts creds or hits the broker.
- **At-most-once** (spec §10.1): a crash-in-window errs toward a missed order, never a duplicate real order. `@unique(idempotencyKey)` is the concurrency backstop.
- **Decrypt containment:** plaintext creds exist ONLY inside `withUserAdapter`'s callback; zeroized by TDA-005's vault in `finally`; never logged, never in audit `meta`.
- **Orders are fatal audit events** (TDA-008 §4.1): unlike auth's best-effort swallow, a failed `ORDER_PLACED` audit fails the order path.
- **Parallel-spec seams (assume, don't build):** TDA-005 `CredentialVault.useDecryptedCredential(userId, ctx, fn)`; TDA-009 `ConsentGate.hasAcceptedCurrentConsent(userId)`. Inject both via DI tokens with a local fake in tests; if the parallel spec lands a different shape, adapt only the thin adapter, not the pipeline.
- **Reuse, don't fork, placement:** extend `TradeExecutionService`'s single entry point to accept a per-order `adapter` + `idempotencyKey`; do not write a second order path.
- **Test harness:** reuse TDA-003 Style-A focused-boot. New tests in `apps/api/test/tda011/` with a `jest.config.js` mirroring tda003 (`roots`→`test/tda011`, otplib stub). Run from `apps/api` with Jest 29.7 `--verbose`: `npx jest --config test/tda011/jest.config.js --verbose` (prefix `DATABASE_URL_TEST=…` for DB specs). Broker + KMS are faked — no real broker/KMS in tests.

---

## File Structure

- `prisma/schema.prisma` — **modify.** Add `model ExecutionClaim` (spec §5).
- `prisma/migrations/<ts>_tda011_execution_claim/migration.sql` — **create** (forward).
- `apps/api/src/modules/auto-execution/auto-execution.module.ts` — **create.**
- `apps/api/src/modules/auto-execution/services/auto-execution.service.ts` — **create.** The pipeline; `implements AutoExecutionPort`; bound to `AUTO_EXECUTION_PORT`.
- `apps/api/src/modules/auto-execution/services/position-sizer.ts` — **create.** Per-user sizing.
- `apps/api/src/modules/auto-execution/services/idempotency-guard.service.ts` — **create.** `claim`/`settle` over `ExecutionClaim`.
- `apps/api/src/modules/auto-execution/services/per-user-broker-session.factory.ts` — **create.** `withUserAdapter(userId, ctx, fn)`; sole caller of `CredentialVault`.
- `apps/api/src/modules/auto-execution/ports.ts` — **create.** DI tokens + interfaces for `CredentialVault` (TDA-005), `ConsentGate` (TDA-009); re-export `AutoExecutionPort`/`AUTO_EXECUTION_PORT` from TDA-010.
- `apps/api/src/modules/trade-engine/services/trade-execution.service.ts` — **modify.** Accept optional per-order `adapter` + `idempotencyKey`; place via the override adapter when present.
- `apps/api/src/modules/trade-engine/dto/trade.dto.ts` — **modify.** Add optional `idempotencyKey` to `ExecuteTradeDto` (userId already persisted via repo).
- `apps/api/src/app.module.ts` — **modify.** Import `AutoExecutionModule` (additive).
- `apps/api/test/tda011/` — **create.** `jest.config.js`, `otplib.stub.js`, `position-sizer.spec.ts`, `idempotency-guard.spec.ts` (DB), `pipeline.spec.ts` (DB, fakes), `kill-switch.spec.ts`.

---

### Task 1: `ExecutionClaim` schema delta + forward migration

**Files:**
- Modify: `prisma/schema.prisma` (add `model ExecutionClaim` per spec §5).
- Create: `prisma/migrations/<ts>_tda011_execution_claim/migration.sql`.

**Context:** Single additive table with `idempotencyKey @unique`, `status`, `orderId?`, `tradeId?`, `settledAt?`, `@@index([userId, entryId])`. No change to existing tables in this task.

- [ ] **Step 1: Edit `schema.prisma`** — add the §5 `ExecutionClaim` block (`@@map("execution_claims")`).
- [ ] **Step 2: Generate the migration** — from repo root: `npx prisma migrate dev --name tda011_execution_claim --create-only`, inspect the SQL (a single `CREATE TABLE` + unique index + `@@index`), then apply: `npx prisma migrate dev` and `npx prisma generate`.
- [ ] **Step 3: Verify** `npx prisma migrate status` clean; `docker exec td-postgres psql -U postgres -d td_saas -c '\d execution_claims'` shows the unique index on `idempotencyKey`. Do NOT touch `td_saas_test` here (DB tests apply migrations via their own setup / `migrate deploy` against `DATABASE_URL_TEST`).
- [ ] **Step 4: Commit** `TDA-011: ExecutionClaim idempotency table + forward migration`.

---

### Task 2: `PositionSizer` — per-user risk sizing

**Files:**
- Create: `apps/api/src/modules/auto-execution/services/position-sizer.ts`
- Test: `apps/api/test/tda011/position-sizer.spec.ts`.

**Interfaces — Produces:** `size(signal: PublicSignal, consent: { riskPerTrade: number|null; maxCapital: number|null }): { quantity: number; stoploss: number; target: number }` — quantity from risk-per-trade ÷ per-unit stop distance, capped by `maxCapital` notional and lot-rounded; derives absolute `stoploss = entryPrice*(1 - stopPct/100)`, `target = entryPrice*(1 + targetPct/100)` for a BUY.

**Interfaces — Consumes:** `PublicSignal` (TDA-010), option lot-size helper (port the `getOptionLotSize` logic from `auto-trade.service.ts`).

- [ ] **Step 1: Write the failing test** — cases: (a) `riskPerTrade`+`maxCapital` set → quantity = min(risk-based, capital-based), lot-rounded; (b) `maxCapital` binding → capped; (c) zero stop distance or null knobs → quantity 0 (terminal upstream); (d) stoploss/target derived correctly from pct.
- [ ] **Step 2: Run → FAIL** (no sizer).
- [ ] **Step 3: Implement** `PositionSizer` (pure, no I/O). Risk-based qty = `floor((capitalBase * riskPerTrade%) / (entryPrice - stoploss))`; capital-based cap = `floor(maxCapital / entryPrice)`; take the min, lot-round, `max(0, …)`.
- [ ] **Step 4: Run → PASS.**
- [ ] **Step 5: Commit** `TDA-011: per-user position sizer`.

---

### Task 3: `IdempotencyGuard` — claim/settle over `ExecutionClaim`

**Files:**
- Create: `apps/api/src/modules/auto-execution/services/idempotency-guard.service.ts`
- Test: `apps/api/test/tda011/idempotency-guard.spec.ts` (DB-backed).

**Interfaces — Produces:**
- `claim(key: string, userId: string, entryId: string): Promise<'CLAIMED' | 'DUPLICATE'>` — `create` catching P2002 → `'DUPLICATE'`.
- `settle(key: string, orderId: string, tradeId: string): Promise<void>` — status → `PLACED`.
- `fail(key: string): Promise<void>` — status → `FAILED` (optional; a failed placement may leave `CLAIMED` under at-most-once — see spec §5).

**Interfaces — Consumes:** `PrismaService`.

- [ ] **Step 1: Write the failing test** — (a) first `claim` → `'CLAIMED'` + a row; (b) second `claim` same key → `'DUPLICATE'`, still one row; (c) **concurrency:** `Promise.all` of 10 identical `claim`s → exactly one `'CLAIMED'`, nine `'DUPLICATE'`, one row (proves the `@unique` backstop); (d) `settle` flips status → `PLACED` with `orderId`/`tradeId`.
- [ ] **Step 2: Run → FAIL** (no guard).
- [ ] **Step 3: Implement** — `claim` = `try { await prisma.executionClaim.create({ data: { idempotencyKey:key, userId, entryId } }); return 'CLAIMED'; } catch (e) { if P2002 return 'DUPLICATE'; throw }`. `ExecutionClaim` is NOT a tenant model (system/cross-user write from the worker) — confirm it is not added to `TENANT_MODELS`, or write inside `runWithoutTenant`.
- [ ] **Step 4: Run → PASS.**
- [ ] **Step 5: Commit** `TDA-011: idempotency guard (ExecutionClaim claim/settle)`.

---

### Task 4: Ports + `PerUserBrokerSessionFactory` (the decrypt seam)

**Files:**
- Create: `apps/api/src/modules/auto-execution/ports.ts`, `services/per-user-broker-session.factory.ts`
- Test: `apps/api/test/tda011/pipeline.spec.ts` (factory portion, with a fake vault).

**Interfaces — Produces:**
- `ports.ts`: `CREDENTIAL_VAULT` token + `interface CredentialVault { useDecryptedCredential<T>(userId, ctx:{reason;signalId?}, fn:(creds:AngelOneCreds)=>Promise<T>):Promise<T> }`; `CONSENT_GATE` token + `interface ConsentGate { hasAcceptedCurrentConsent(userId:string):Promise<boolean> }`. Re-export `AUTO_EXECUTION_PORT`/`AutoExecutionPort`/`ExecuteUserJob` from the TDA-010 barrel.
- `PerUserBrokerSessionFactory.withUserAdapter<T>(userId, ctx, fn:(adapter:BrokerAdapter)=>Promise<T>):Promise<T>` — calls `vault.useDecryptedCredential(userId, ctx, creds => { build a short-lived per-user SmartAPI adapter from creds; return fn(adapter); })`. Session is disposed when the callback returns; the vault zeroizes plaintext.

**Interfaces — Consumes:** `CREDENTIAL_VAULT` (TDA-005, faked in tests), `BrokerAdapter` interface, a per-user SmartAPI construction path (mirror `AngelOneAuthService.login` but per-user + disposable — a thin wrapper is acceptable for MVP; the real per-user session build may be minimal if the broker adapter can be constructed from creds).

- [ ] **Step 1: Write the failing test** — fake `CredentialVault` that invokes `fn` with dummy creds and asserts it was called exactly once with the right `ctx.reason='AUTO_EXEC'`/`signalId`. `withUserAdapter` returns the callback's value; asserts the adapter passed to `fn` exposes `placeOrder`. Assert nothing logs creds (spy the logger).
- [ ] **Step 2: Run → FAIL** (no factory/ports).
- [ ] **Step 3: Implement** ports + factory. Keep the per-user SmartAPI build minimal and isolated; the factory's only external dependency is `CREDENTIAL_VAULT`.
- [ ] **Step 4: Run → PASS.**
- [ ] **Step 5: Commit** `TDA-011: credential/consent ports + per-user broker session factory`.

---

### Task 5: Extend `TradeExecutionService` for per-user adapter + idempotency key

**Files:**
- Modify: `apps/api/src/modules/trade-engine/services/trade-execution.service.ts`
- Modify: `apps/api/src/modules/trade-engine/dto/trade.dto.ts` (add optional `idempotencyKey?: string`).
- Test: reuse the existing `trade-execution.service.spec.ts` patterns; add a case in `apps/api/test/tda011/pipeline.spec.ts`.

**Context:** `executeTrade(request)` currently places live orders via the injected global `BROKER_ADAPTER_TOKEN` adapter. Add an **optional** per-order adapter override so an auto-exec order places on the per-user session. `LIVE_TRADING_ENABLED` + `RiskManagerService.validateTrade` stay exactly as the backstops. Do not change paper-trade behaviour or manual-trade call sites (the new params are optional).

- [ ] **Step 1: Write the failing test** — call `executeTrade` with a per-order `adapter` override + `isPaper:false` + `LIVE_TRADING_ENABLED=true`: assert the **override** adapter's `placeOrder` is called (not the global one) and the `Trade` row persists `userId`/`signalId`/`source:'AUTO'`/`orderId`. With `LIVE_TRADING_ENABLED` unset → refused (existing behaviour preserved).
- [ ] **Step 2: Run → FAIL** (override not honoured).
- [ ] **Step 3: Implement** — thread an optional `adapter?: BrokerAdapter` through the internal execute options; in the live branch, `const broker = adapter ?? this.brokerAdapter;` and place via `broker`. Persist `idempotencyKey` context where the repo supports it (or pass through for the caller's settle/audit). Keep the diff minimal; do not alter risk/live gates.
- [ ] **Step 4: Run → PASS.** Re-run existing trade-engine specs to confirm no regression.
- [ ] **Step 5: Commit** `TDA-011: per-user adapter override + idempotency key on execution path`.

---

### Task 6: `AutoExecutionService` pipeline + module wiring

**Files:**
- Create: `apps/api/src/modules/auto-execution/services/auto-execution.service.ts`, `auto-execution.module.ts`
- Modify: `apps/api/src/app.module.ts` (import `AutoExecutionModule`).
- Test: `apps/api/test/tda011/pipeline.spec.ts` (full pipeline, DB + fakes), `apps/api/test/tda011/kill-switch.spec.ts`.

**Interfaces — Produces:** `AutoExecutionService implements AutoExecutionPort { execute(job: ExecuteUserJob): Promise<void> }` bound to `AUTO_EXECUTION_PORT` (so TDA-010's `ExecuteUserWorker` resolves it). Runs the §4 pipeline in order, throwing `UnrecoverableError` (terminal) vs. a plain `Error` (retryable) per §6-classification, and auditing `ORDER_PLACED`/`ORDER_REJECTED`.

**Interfaces — Consumes:** `SubscriptionService`, `CONSENT_GATE`, `AutoTradeConsent` (Prisma), `LIVE_TRADING_ENABLED` (`isLiveTradingEnabled`), `PositionSizer` (T2), `IdempotencyGuard` (T3), `PerUserBrokerSessionFactory` (T4), `TradeExecutionService` (T5), `AuditService` (TDA-008).

- [ ] **Step 1: Write the failing test** — happy path with fakes (fake consent=true, fake vault, fake per-user adapter recording `placeOrder`, seeded ACTIVE subscription + `AutoTradeConsent{enabled:true,killSwitch:false}`, `LIVE_TRADING_ENABLED=true`): one `Trade`, one `ORDER_PLACED` audit, `ExecutionClaim` PLACED. Then: **retry** (call `execute` twice, same `idempotencyKey`) → still one `Trade`/one order (DUPLICATE skip). Each gate off (subscription/consent/enabled/killSwitch/global/zero-size) → `ORDER_REJECTED` with the right reason, terminal, **no decrypt/place** (assert the fake vault was NOT called).
- [ ] **Step 2: Run → FAIL** (no service).
- [ ] **Step 3: Implement** the pipeline exactly per spec §4 order. Terminal gates → audit `ORDER_REJECTED{reason}` + throw `UnrecoverableError`. Claim before decrypt. Decrypt/place inside `withUserAdapter`. Settle + `ORDER_PLACED` audit coupled to the `Trade` write (fatal). Wire `AutoExecutionModule` (import TradeEngine/Subscription/Audit + TDA-005/009 modules; bind `AUTO_EXECUTION_PORT` → `AutoExecutionService`, `CREDENTIAL_VAULT`/`CONSENT_GATE` → the real providers). Add to `app.module.ts` (additive, after `SignalFanoutModule`).
- [ ] **Step 4: Run → PASS.**
- [ ] **Step 5: Commit** `TDA-011: auto-execution pipeline + module wiring`.

---

### Task 7: Per-user + global kill switch (toggle endpoint + gating proof)

**Files:**
- Create/modify: a `me`-scoped auto-trade toggle on the existing auto-trade or subscription controller (enable/disable + kill-switch flip on `AutoTradeConsent`), audited (`AUTOTRADE_ENABLED`/`AUTOTRADE_DISABLED`/`KILL_SWITCH_TRIGGERED`).
- Test: `apps/api/test/tda011/kill-switch.spec.ts`.

**Context:** `AutoTradeConsent.enabled`/`killSwitch` already exist. The toggle is `me`-scoped (TDA-003 tenant scoping: a USER edits only their own row). Position **exit** is never gated (mirror `live-trading.ts`).

- [ ] **Step 1: Write the failing test** — (a) per-user: with `killSwitch:true`, `AutoExecutionService.execute` rejects `USER_KILL_SWITCH` (terminal) and places nothing; (b) global: `LIVE_TRADING_ENABLED` unset → `LIVE_TRADING_DISABLED` reject, no decrypt; (c) HTTP: USER toggles own consent (audited), 200; toggling another user's row is impossible (scoped/404).
- [ ] **Step 2: Run → FAIL.**
- [ ] **Step 3: Implement** the `me`-scoped toggle (audit on flip) and confirm both gates in the pipeline. Exit path stays ungated.
- [ ] **Step 4: Run → PASS.**
- [ ] **Step 5: Commit** `TDA-011: per-user + global kill switches with audit`.

---

## Self-Review

- Spec coverage: §3 (isolated module) → T4/T6; §4 (ordered pipeline) → T6; §5 (idempotency local + broker tag) → T1/T3/T5; §6 (decrypt seam) → T4; §7 (extend placement) → T5; §8 (kill switches) → T7; §11 acceptance: AC1→T6, AC2→T6, AC3→T2/T6, AC4→T3/T6, AC5→T4/T6, AC6→T5/T6, AC7→T7, AC8→T1/T6. ✅
- **Forward-migration discipline:** one additive `ExecutionClaim` table via `--create-only` + apply; never `migrate reset`. This lane owns the schema delta for its wave. ✅
- **At-most-once proof:** T3 concurrency test (10 identical claims → 1 CLAIMED) + T6 retry test (same key → one order). The `@unique(idempotencyKey)` is the backstop; claim precedes decrypt/place. ✅
- **Decrypt containment:** T4 asserts `CredentialVault.useDecryptedCredential` is the only decrypt call and creds never log; T6 asserts a rejected gate never reaches decrypt. ✅
- **Backstop reuse:** T5 keeps `RiskManagerService.validateTrade` + `LIVE_TRADING_ENABLED` unchanged as hard gates; sizing (T2) is additive per-user, not a replacement. ✅
- **Fatal audit:** T6 couples `ORDER_PLACED` to the `Trade` write (order audit is fatal per TDA-008 §4.1), unlike best-effort auth audit. ✅
- **Risk — order status after crash-in-window:** a `CLAIMED`-but-not-`PLACED` claim is deliberately NOT auto-retried into a second order (at-most-once); reconciliation ("did it actually place?") is TDA-012. Flagged, not silently dropped. ✅
- **Risk — engine-global vs per-user risk state:** `RiskManagerService` daily-loss/concurrent limits are shared across the engine + user accounts in MVP; per-user ledgers deferred to TDA-012 (spec §10.2). ✅

## Dependencies & Spec Coverage

- **Consumes from TDA-010:** the `execute-user` job (`ExecuteUserJob` with a stable `idempotencyKey`), the `AUTO_EXECUTION_PORT` token (this spec binds `AutoExecutionService` to it), the per-user rate gate (runs before `execute`), and the DLQ (terminal vs. retryable errors route there).
- **Assumed parallel seams (stated in spec §6/§10, faked in tests, thin local adapter if the real shape differs):**
  - **TDA-005 decrypt:** `CredentialVault.useDecryptedCredential(userId, {reason:'AUTO_EXEC', signalId}, fn)` → callback receives in-memory `AngelOneCreds`, zeroized after; decrypt is audited `CREDENTIAL_DECRYPT` by TDA-005. TDA-011 also relies on `BrokerCredential.isActive` (TDA-010 eligibility) for "connected".
  - **TDA-009 consent:** `ConsentGate.hasAcceptedCurrentConsent(userId): Promise<boolean>` — platform-wide assumed; per-segment is a one-line seam change if TDA-009 chooses that granularity.
- **Consumes existing:** `TradeExecutionService` (extended, not forked), `RiskManagerService`, `SubscriptionService`, `AuditService` (TDA-008 taxonomy: `ORDER_PLACED`/`ORDER_REJECTED`/`AUTOTRADE_*`/`KILL_SWITCH_TRIGGERED`), `isLiveTradingEnabled` (`live-trading.ts`), `AutoTradeConsent` model (per-user consent/kill-switch/sizing — no new column).
- **Owns:** the `ExecutionClaim` table + migration; the `AutoExecutionModule` (the isolated seam that will carry the sole KMS grant in production).
- **Blocks / hands to TDA-012:** durable idempotency + order-status reconciliation of `CLAIMED`-but-unsettled claims, DB transactionality across the multi-step trade, and per-user risk ledgers.
