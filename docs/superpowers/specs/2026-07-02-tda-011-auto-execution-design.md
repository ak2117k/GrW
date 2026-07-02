# TDA-011 — Opt-In Auto-Execution — Design Spec

**Doc ID:** TDA-011
**Date:** 2026-07-02
**Sprint:** S5 (Signals & Auto-Execution) — MVP
**Depends on:** TDA-010 (the `execute-user` job + `AUTO_EXECUTION_PORT` seam + per-user rate gate + DLQ), TDA-009 (versioned consent — `hasAcceptedCurrentConsent`), TDA-005 (per-tenant credential decrypt seam), TDA-008 (audit `append` + taxonomy), TDA-003 (RBAC + tenant scoping), TDA-001 (`AutoTradeConsent`, `Trade`, `BrokerCredential`)
**Blocks:** TDA-012 (DB transactions + durable idempotency store harden this pipeline), TDA-016 (mobile positions view)
**Owner:** development@panamoure.com

---

## 1. Goal

Fill each `execute-user` job (from TDA-010) with the **per-user execution
pipeline**, in this exact order, so that a real-money order is placed on a user's
own Angel One account **only** when every gate passes — and **exactly once** per
signal per user:

```
subscription gate → consent + kill-switch (per-user) + global LIVE_TRADING_ENABLED
  → risk sizing (to THIS user's capital) → idempotency guard (claim)
  → decrypt THIS user's creds (KMS, in-memory, zeroized) → place order (broker + tag)
  → append tamper-evident audit
```

This is the **one deliberate seam** in the roadmap: the credential-decryption +
order-placement path is an internally isolated module (`AutoExecutionModule`) with
the sole call into TDA-005's decrypt primitive, so it can later lift into a
hardened service/VPC without a rewrite. It reuses the existing
`RiskManagerService` backstops and the `LIVE_TRADING_ENABLED` chokepoint; it adds
the per-user `AutoTradeConsent.killSwitch` and a local **idempotency guard** so a
retried job (TDA-010 retries with backoff) or a duplicate signal can never place a
second real order.

## 2. Background — what exists today (corrected after code map)

- **The execution job arrives from TDA-010.** `ExecuteUserWorker` acquires the
  per-user rate token, then calls `AUTO_EXECUTION_PORT.execute(job)`. TDA-011
  provides that implementation (`AutoExecutionService`). Failure classification
  (retryable vs. terminal) and DLQ are TDA-010's; TDA-011 throws the right error
  type so TDA-010 routes it correctly.
- **Per-user consent + risk knobs already exist (TDA-001).** `AutoTradeConsent {
  userId, segment, enabled, killSwitch, riskPerTrade, maxCapital, enabledAt }`.
  `enabled` = opted in; `killSwitch` = per-user hard stop; `riskPerTrade` /
  `maxCapital` = per-user sizing inputs. **No new column needed** for consent/kill
  switch/sizing.
- **The risk backstops exist but are engine-global.** `RiskManagerService`
  (`apps/api/src/modules/trade-engine/services/risk-manager.service.ts`) enforces
  kill switch, max daily loss, max concurrent positions, max capital/trade, market
  hours, duplicate position — but its state (kill switch, deployed capital) is
  **in-memory and single-account**, and `SettingsService.getSettings()` is a single
  global settings row. TDA-011 sizes to the **per-user** `AutoTradeConsent` knobs
  and treats `RiskManagerService` as the shared **backstop** (hard ceilings the
  engine applies regardless), not the per-user sizer.
- **`TradeExecutionService.executeTrade` is the single execution entry point** and
  already: runs risk validation, routes paper vs. live, hard-gates live behind
  `isLiveTradingEnabled()` (`LIVE_TRADING_ENABLED === 'true'`), surfaces broker
  rejects, persists a `Trade` row (with `userId` NOT NULL, `signalId?`, `orderId?`,
  `source`), and emits events. It takes an `ExecuteTradeDto`. **It does not yet
  accept a per-user broker session or an idempotency key** — TDA-011 extends the
  path (see §7).
- **The broker adapter is a single global env session.** `AngelOneAuthService`
  logs in once from env creds; `BROKER_ADAPTER_TOKEN` resolves that one adapter.
  There is **no per-user broker session today.** TDA-011 introduces a per-user
  broker session built from the decrypted creds inside the isolated module (§6).
  This is the largest net-new piece and the reason the seam is isolated.
- **Audit exists (TDA-008).** `AuditService.append({ action, userId, target, meta })`
  is the only writer; the taxonomy already reserves `ORDER_PLACED`, `ORDER_REJECTED`,
  `AUTOTRADE_ENABLED/DISABLED`, `KILL_SWITCH_TRIGGERED`, and `CREDENTIAL_DECRYPT`
  (emitted by TDA-005). Orders are **fatal/transactional** audit events (TDA-008
  §4.1): an order must never be placed without its audit row.
- **`Trade` has no idempotency column.** TDA-011 adds a minimal local idempotency
  store (§5); the durable/transactional hardening is TDA-012.

## 3. The isolated execution module

**`AutoExecutionModule`** (`apps/api/src/modules/auto-execution/`) provides
`AutoExecutionService implements AutoExecutionPort` (the TDA-010 token) and holds:
- `AutoExecutionService` — the pipeline orchestrator (§4).
- `PerUserBrokerSessionFactory` — builds a short-lived per-user `BrokerAdapter`
  from decrypted creds (§6); the **only** consumer of TDA-005's decrypt seam.
- `IdempotencyGuard` — the local claim/settle store (§5).

It imports `TradeEngineModule` (to reuse `RiskManagerService` + the `Trade`
persistence path), `SubscriptionModule`, the TDA-009 consent module, and the
TDA-005 credential-vault module. It is the module that, in production, will carry
the sole KMS grant (TDA-004/005) — so keeping decrypt physically inside it is a
security invariant, not a style choice.

## 4. The per-user pipeline (order is load-bearing)

`AutoExecutionService.execute(job: ExecuteUserJob)`:

1. **Subscription gate (authoritative re-check).** `SubscriptionService.hasActive(
   userId, segment)` — the TDA-010 pre-filter can be stale. Not active → **terminal**
   (audit `ORDER_REJECTED {reason:'NOT_SUBSCRIBED'}`, no retry).
2. **Consent + kill-switch + global gate.**
   - `consentGate.hasAcceptedCurrentConsent(userId)` (TDA-009) — not accepted (or a
     new version published since acceptance) → **terminal** (`ORDER_REJECTED
     {reason:'CONSENT_NOT_CURRENT'}`).
   - `AutoTradeConsent` for `(userId, segment)`: `enabled === true` and
     `killSwitch === false` — either fails → **terminal** (`{reason:'AUTOTRADE_OFF'}`
     / `{reason:'USER_KILL_SWITCH'}`).
   - **Global** `isLiveTradingEnabled()` (`LIVE_TRADING_ENABLED === 'true'`) — false
     → **terminal** (`{reason:'LIVE_TRADING_DISABLED'}`). This is the master switch;
     with it off, the whole product runs but no real order is placed.
3. **Risk sizing (to this user's capital).** `PositionSizer.size(signal, consent)`
   → quantity from `riskPerTrade` (risk-per-trade % of capital ÷ per-unit stop
   distance) capped by `maxCapital` (notional ceiling) and lot-size rounding
   (reuse the option lot-size logic from the legacy `AutoTradeService`). A
   non-positive quantity → **terminal** (`{reason:'RISK_SIZE_ZERO'}`). Absolute
   `stoploss`/`target` prices are derived from `entryPrice ± stopPct/targetPct`.
4. **Idempotency claim (§5).** `idempotencyGuard.claim(job.idempotencyKey, userId,
   signal.entryId)`. Already-claimed → **terminal, success-shaped** (log "duplicate,
   skipping"; no second order; no error) — this is what makes a TDA-010 retry safe.
5. **Decrypt creds + build session (§6).** `brokerSession.withUserAdapter(userId,
   { reason:'AUTO_EXEC', signalId: signal.entryId }, async (adapter) => { … })` —
   TDA-005 decrypts inside the callback, plaintext is used to build the SmartAPI
   session, and is **zeroized in `finally`**; the decrypt is audited
   (`CREDENTIAL_DECRYPT`, TDA-005-owned).
6. **Place order.** Inside the session callback, build the `ExecuteTradeDto`
   (`isPaper:false`, `source:'AUTO'`, `userId`, `signalId:entryId`,
   `idempotencyKey`, per-user `adapter`) and call the (extended) execution path
   (§7). The order carries the idempotency key as a **broker order tag** for
   best-effort broker-side dedupe (§5). Broker hard-reject → **terminal**
   (`ORDER_REJECTED {reason:'BROKER_REJECT', message}`); broker 5xx/timeout →
   **retryable** (throw a transient error so TDA-010 retries with backoff).
7. **Settle idempotency + audit.** On a placed order: `idempotencyGuard.settle(key,
   orderId, tradeId)` and `AuditService.append({ action:'ORDER_PLACED', userId,
   target: orderId, meta:{ entryId, segment, qty, idempotencyKey } })` — in the same
   transaction as the `Trade` write where feasible (TDA-008 §4.1 fatal/transactional;
   full multi-step transactionality is TDA-012). A failure to persist the audit
   **fails the order path** (unlike best-effort auth audit).

**Ordering rationale:** gates (cheap, no side effects) run before the idempotency
claim; the claim runs **before** decrypt/place so a duplicate never decrypts creds
or touches the broker; decrypt runs immediately before placement so plaintext
lifetime is minimal.

## 5. Idempotency — local guard + broker-side dedupe

**Idempotency key** = `sha256(entryId + ':' + userId)` — computed in TDA-010 and
carried on the job, so it is identical across a Bull retry and unique per
(signal, user).

**Local guard (authoritative).** A minimal store — schema delta owned by THIS spec:

```prisma
model ExecutionClaim {
  id            String   @id @default(cuid())
  idempotencyKey String  @unique          // sha256(entryId:userId) — the race backstop
  userId        String
  entryId       String
  status        String   @default("CLAIMED") // CLAIMED | PLACED | FAILED
  orderId       String?
  tradeId       String?
  createdAt     DateTime @default(now())
  settledAt     DateTime?
  @@index([userId, entryId])
  @@map("execution_claims")
}
```

- `claim(key,…)` = `INSERT … ON CONFLICT DO NOTHING` (or a `create` catching P2002).
  **The `@unique` constraint is the concurrency backstop:** two concurrent jobs with
  the same key → exactly one wins the insert; the loser sees the conflict and
  **skips** (success-shaped terminal, no order). This makes placement at-most-once
  even if TDA-010 somehow double-delivers.
- `settle(key, orderId, tradeId)` flips `status → PLACED` after the order lands.
- A claim stuck in `CLAIMED` (crash between claim and place) is **not** auto-retried
  into a second order — a retried job re-hits the unique claim and skips. Reconciling
  a `CLAIMED`-but-never-`PLACED` claim (did the order actually reach the broker?) is
  a TDA-012 concern (order-status reconciliation); TDA-011 errs toward
  **at-most-once** (never place twice), accepting the small risk of a missed order
  on a crash-in-window as the safer failure mode for real money.

**Broker-side dedupe (best-effort).** Angel One SmartAPI has no first-class
idempotency key. TDA-011 passes the `idempotencyKey` in the order's tag/remarks
field (`ordertag`, if the adapter forwards it) so a duplicate is *detectable* in
the broker order book and post-hoc reconciliation can match on it. This is a
**secondary** guard; the local `ExecutionClaim` unique constraint is the guarantee.
(§10 open item: confirm the SmartAPI field that survives round-trip.)

## 6. Where decrypt happens — the isolated seam (TDA-005 dependency)

- Decrypt happens **only** inside `PerUserBrokerSessionFactory.withUserAdapter`, in
  `AutoExecutionModule` — the module that will hold the sole KMS grant. No other
  module ever sees plaintext broker creds.
- **Assumed TDA-005 interface (stated explicitly for the parallel spec to align):**

  ```ts
  // TDA-005 provides this. Callback form so plaintext lifetime is bounded and
  // zeroization is guaranteed in a finally, and so the decrypt is audited
  // (CREDENTIAL_DECRYPT) by TDA-005 with { userId, reason, signalId }.
  interface CredentialVault {
    useDecryptedCredential<T>(
      userId: string,
      ctx: { reason: string; signalId?: string },
      fn: (creds: AngelOneCreds) => Promise<T>,
    ): Promise<T>;
  }
  interface AngelOneCreds {
    apiKey: string; apiSecret: string; clientId: string;
    password: string; totpSecret: string;   // zeroized by the vault after fn resolves
  }
  ```

  Keep this seam **minimal**: TDA-011 needs exactly one method (`useDecryptedCredential`).
  If TDA-005 lands a plain `decrypt(userId): Promise<AngelOneCreds>` + explicit
  `zeroize`, TDA-011 wraps it in the callback shape locally; the callback contract is
  what the pipeline codes against.
- `PerUserBrokerSessionFactory` uses `AngelOneCreds` to construct a **short-lived**
  SmartAPI session (login → JWT/feed token) scoped to that one order, mirroring
  `AngelOneAuthService`'s login but per-user and disposable — it is **not** the
  shared global session. Session objects are dropped when the callback returns.
- Never log creds, tokens, or the session (TDA-006 redactor + TDA-008 "no secrets in
  meta"). `CREDENTIAL_DECRYPT` audit records *that* a decrypt occurred (who, which
  credentialId, `signalId`), never plaintext.

## 7. Extending the execution path (reusing the backstops)

TDA-011 does **not** duplicate order placement. It extends the existing single
entry point so a per-user session + idempotency key flow through:

- Add optional fields to `ExecuteTradeDto` (or an internal execute-options object):
  `userId` (already persisted on `Trade`), `idempotencyKey`, and an injected
  per-order `adapter` override (the per-user session) — when present,
  `TradeExecutionService` places via **that** adapter instead of the global
  `BROKER_ADAPTER_TOKEN` one.
- `RiskManagerService.validateTrade` still runs as the **hard backstop** (kill
  switch, daily-loss ceiling, max concurrent, market hours, duplicate). Per-user
  sizing (§4.3) happens **before** and produces the quantity; the backstop can still
  veto. (The engine-global daily-loss/concurrent limits are shared backstops in MVP;
  per-user risk ledgers are a TDA-012/harden concern — flagged §10.)
- `LIVE_TRADING_ENABLED` remains the master chokepoint in `executeTrade` (§4.2 also
  checks it early to fail fast before decrypt).
- The `Trade` row is written with `userId`, `signalId=entryId`, `source='AUTO'`,
  `isPaperTrade=false`, `orderId`; the idempotency `settle` + `ORDER_PLACED` audit
  are tied to that write.

## 8. Kill switches (per-user + global)

- **Per-user:** `AutoTradeConsent.killSwitch` (already in schema). Checked in §4.2;
  the user toggles it via a `me`-scoped endpoint (an `AUTOTRADE_DISABLED` /
  `KILL_SWITCH_TRIGGERED` audit row on flip). When on, no new order is placed for
  that user's segment; **exiting existing positions is never gated** (mirrors
  `live-trading.ts`: risk-reducing writes are always allowed).
- **Global:** `LIVE_TRADING_ENABLED` env flag — the platform-wide master switch
  (already exists). Off → the product runs (signals, sizing, gating all execute) but
  the placement step is refused for everyone. This is the safe default for launch.
- **Engine backstop:** `RiskManagerService`'s in-memory kill switch (the existing
  square-off-all path) remains the last-resort stop for the shared execution path.

## 9. Out of scope (deferred / owned elsewhere)

- **The fan-out topology, per-user rate gate, retry/backoff, DLQ** — TDA-010.
- **Consent model + `hasAcceptedCurrentConsent` implementation** — TDA-009 (this
  spec only *calls* it and states the assumed interface).
- **Credential vault + decrypt/zeroize + `CREDENTIAL_DECRYPT` audit** — TDA-005 (this
  spec only *calls* `useDecryptedCredential` and states the assumed interface).
- **DB transactionality across the multi-step trade + durable idempotency/order-status
  reconciliation + per-user risk ledgers** — TDA-012. TDA-011 ships an at-most-once
  local claim; the "was a `CLAIMED` order actually placed?" reconciliation is TDA-012.
- **Retiring the legacy single-account `AutoTradeService` cron** — roadmap follow-up.
- **A per-user positions/P&L UI** — TDA-016 (mobile) / a later web surface.

## 10. Open decisions (for the human)

1. **At-most-once vs. at-least-once.** Chosen: **at-most-once** — a crash between
   `claim` and `place` errs toward a *missed* order, never a *duplicate* real-money
   order. Confirm this is the right bias for a public auto-trading product (the
   alternative needs TDA-012 order-status reconciliation to be safe).
2. **Per-user vs. shared risk backstops.** Chosen for MVP: per-user **sizing**
   (`AutoTradeConsent.riskPerTrade/maxCapital`) + **shared** engine backstops
   (`RiskManagerService` global daily-loss/concurrent). Per-user daily-loss ledgers
   are deferred to TDA-012. Confirm the shared backstop is acceptable while the
   engine account and user accounts still share `RiskManagerService` state.
3. **Broker dedupe field.** Confirm the SmartAPI order field (`ordertag`?) that
   round-trips so the `idempotencyKey` is visible in the broker order book. If none
   survives, the local `ExecutionClaim` is the sole guard (still correct).
4. **Consent granularity.** Assumed `hasAcceptedCurrentConsent(userId)` is
   platform-wide (one disclaimer). If TDA-009 makes consent per-segment, this spec
   passes `segment` too — a one-line seam change. Confirm with TDA-009.

## 11. Acceptance criteria

1. `AutoExecutionService implements AutoExecutionPort`; bound to the TDA-010
   `AUTO_EXECUTION_PORT` token; `execute(job)` runs the §4 pipeline **in order**.
2. Each gate rejects with the correct **terminal** reason and audits `ORDER_REJECTED`
   without retrying: not-subscribed, consent-not-current, auto-off, user kill switch,
   global `LIVE_TRADING_ENABLED` off, zero risk size. Transient broker faults throw a
   **retryable** error (TDA-010 retries).
3. Risk sizing produces a per-user quantity from `AutoTradeConsent.riskPerTrade`
   capped by `maxCapital` and lot-rounded; `RiskManagerService.validateTrade` still
   runs as the hard backstop and can veto.
4. **Idempotency:** a second `execute` with the same `idempotencyKey` (a TDA-010
   retry or a duplicate signal) places **no** second order and returns success-shaped
   (proven by a test: two calls → one `Trade`, one `ORDER_PLACED` audit, one
   `ExecutionClaim`). The `@unique(idempotencyKey)` backstops a concurrent double.
5. Decrypt happens **only** inside `AutoExecutionModule` via
   `CredentialVault.useDecryptedCredential`; plaintext is confined to the callback;
   no cred/token is logged or placed in audit `meta`.
6. A placed order writes a `Trade` (`userId`, `signalId`, `source:'AUTO'`,
   `isPaperTrade:false`, `orderId`) and a coupled `ORDER_PLACED` audit; the audit
   write failing fails the order path (fatal, not best-effort).
7. Both kill switches work: per-user `AutoTradeConsent.killSwitch` and global
   `LIVE_TRADING_ENABLED=false` each block placement while leaving position **exit**
   ungated.
8. The `ExecutionClaim` migration is forward-only (no `migrate reset`);
   `prisma migrate status` clean; `AutoExecutionModule` registered in `app.module.ts`
   (additive).

## 12. Test plan

- **Unit:**
  - `PositionSizer` — quantity from `riskPerTrade`/`maxCapital`/stop distance;
    lot-size rounding; zero/negative → 0.
  - Pipeline gate ordering — a stubbed pipeline with each gate flipped asserts the
    **first** failing gate's reason and that no downstream step (decrypt/place) runs.
- **Integration (DB-backed, `td_saas_test`):**
  - `IdempotencyGuard.claim` — concurrent `Promise.all` of the same key → exactly one
    `CLAIMED` row (unique constraint), the rest skip.
  - Full pipeline with fakes: fake `CredentialVault` (returns dummy creds, asserts
    `useDecryptedCredential` called once, callback-scoped), fake per-user adapter
    (records `placeOrder`), fake `consentGate`. Assert a happy path → one `Trade`,
    one `ORDER_PLACED` audit, `ExecutionClaim` PLACED; a retry (same key) → no second
    order.
  - Global gate: `LIVE_TRADING_ENABLED` unset → placement refused, `ORDER_REJECTED`
    audited, no decrypt.
- **Isolation (with TDA-010):** two `execute` calls (user A fake-throws transiently,
  user B passes) → B places, A throws retryable; no cross-effect.
- **HTTP:** the `me`-scoped auto-trade enable/kill-switch toggle (audit on flip) —
  USER can toggle own, cannot toggle another's (TDA-003 tenant scoping).
- Jest 29.7 — run with `--verbose`; reuse the tda003 focused-boot harness; per-user
  broker session + `CredentialVault` are faked (no real broker/KMS in tests).
