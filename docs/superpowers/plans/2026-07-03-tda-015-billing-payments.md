# TDA-015 Billing / Subscriptions / Payments (Razorpay) + Plan-Gating Enforcement — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax. Each task is TDD: write the failing test, run → FAIL, implement, run → PASS, commit.

**Goal:** Make the Intraday/Swing plan-gate a **paid, self-service Razorpay
subscription**. A `PaymentProvider` adapter seam fronts Razorpay; a
signature-verified, idempotent webhook maps Razorpay lifecycle events onto the
existing `SubscriptionService.grant`/`revoke` so **payment state authoritatively
drives access** (lapse revokes). Every billing event is audited (TDA-008); all
Razorpay secrets come from the `SecretsProvider` (TDA-004) and are never logged.

**Architecture:** One `PaymentProvider` interface selected by config
(`BILLING_PROVIDER`: `razorpay` prod default / `fake` test), mirroring the
TDA-004 provider-factory and broker-adapter patterns. The gateway is imported by a
`RazorpayProvider` only — plan-gating never touches Razorpay. The webhook
(`@Public()` `POST webhooks/razorpay`, raw-body HMAC verify like the Chartink
webhook) dedupes on the provider event id (`WebhookEvent` `@@unique`, mirroring
`ExecutionClaim`'s at-most-once insert-first backstop) and calls
`SubscriptionService` — the **only** entitlement writer. See spec
`docs/superpowers/specs/2026-07-03-tda-015-billing-payments-design.md`.

**Tech Stack:** NestJS 11 (SWC build, `typeCheck:false`), Prisma 6 (Postgres
`td_saas`), Jest 29.7 + ts-jest. `SecretsProvider`/`SECRETS_PROVIDER` (TDA-004),
`AuditService`/`AUDIT_ACTIONS` (TDA-008), `SubscriptionService` (TDA-001/007),
`@Public()` + global `JwtAuthGuard`. The `razorpay` Node SDK is **NOT installed**
and must NOT be added in this plan — the `RazorpayProvider` uses a **dynamic
import** (`await import('razorpay')`) exactly like TDA-004's gated `@aws-sdk`
adapters, so the offline test build never needs it; the HMAC verify path uses only
Node `crypto` (no SDK). Frontend: React 19 + Vitest (pure-logic) + Razorpay
`checkout.js` (external CDN script, the one allowed self-containment exception).

## Global Constraints

- **Commit prefix:** `TDA-015:`. No `.env` committed. Stage only changed files (no `git add -A`).
- **DB:** dev `td_saas`, tests `td_saas_test` (`DATABASE_URL_TEST`). `docker exec td-postgres psql -U postgres`. **Never `prisma migrate reset`.** This plan **does** own a migration (Task 2) — additive only (new tables + nullable columns), no backfill.
- **Entitlement writers:** `SubscriptionService.grant`/`revoke` are the **only** code that flips `Subscription.status`/`expiresAt` for gating. The webhook DRIVES them; **do not duplicate** the gate logic. `BillingService` persists provider ids/status only.
- **Secrets:** Razorpay key-id/secret, webhook secret, and plan ids resolve via `SecretsProvider.getRequiredSecret` (TDA-004). **No defaults, never logged, never in audit meta.** Missing secret → reject (webhook) / fail the checkout.
- **Provider selection:** `BILLING_PROVIDER` config, `razorpay` (prod default) | `fake` (test). Tests run `fake`. `razorpay` SDK import is **dynamic** so the test build never needs the package.
- **Raw body:** the Razorpay signature is HMAC-SHA256 over the **raw** request bytes. Capture the raw buffer for `/webhooks/razorpay` only (`express.json({ verify })`); do not change any other route's parsing.
- **Audit:** every billing state change and every webhook accept/reject goes through `AuditService.append` with **redacted** meta.
- **Test harness:** reuse the TDA-004/TDA-008 Style-A boot harness (mint JWTs `audience:'td-access'`, `{ sub, role, email }`). New tests in `apps/api/test/tda015/` with a `jest.config.js` mirroring `apps/api/test/tda004/jest.config.js` (roots → `test/tda015`, otplib stub mapped). Run from `apps/api`. **Jest 29.7 rejects `-v`; use `--verbose`.** Prefix DB-backed specs with `DATABASE_URL_TEST=...`.

---

## Parallel-Worktree Seam (READ FIRST)

Shared files edited additively — keep edits self-contained so parallel lanes merge:

- **`prisma/schema.prisma`** — Task 2 adds two new models + three nullable
  `Subscription` columns + one `User` relation field. Additive; no existing field
  changes. (If another lane touches the schema this wave, resolve by keeping both
  additive blocks.)
- **`apps/api/src/common/audit/audit-actions.ts`** — Task 1 appends a `billing`
  group to `AUDIT_ACTIONS`. Additive; the union derives automatically.
- **`apps/api/src/app.module.ts`** — Task 5 adds `BillingModule` to `imports`.
  Additive, next to `SubscriptionModule` (line ~185). Do not reorder existing
  imports.
- **`apps/api/src/main.ts`** — Task 5 adds the raw-body `verify` hook. Additive; a
  single `app.use(...)`/bootstrap edit, does not touch `applyHttpHardening`.
- **`apps/api/src/config/configuration.ts`** — Task 1 adds a `billing` section.
  Additive, alongside `secrets`/`kms`.

TDA-015 does **not** change `SubscriptionService`, the gate reads, `MeSubscriptionController`,
or `AdminSubscriptionController` logic (admin grant/revoke stays the comp path).

---

## File Structure

**Backend — billing module** (`apps/api/src/modules/billing/`)
- `providers/payment-provider.interface.ts` — **create.** `PaymentProvider`, `BillingEvent`, `BillingEventKind`, `CreateSubscriptionResult`, token `PAYMENT_PROVIDER`.
- `providers/fake-payment.provider.ts` — **create.** Deterministic offline impl (test/dev default).
- `providers/razorpay.provider.ts` — **create.** Real impl; dynamic `razorpay` import; HMAC verify via `crypto`; secrets via `SecretsProvider`.
- `billing.service.ts` — **create.** Checkout/cancel orchestration + provider-state persistence (NOT entitlement).
- `billing-webhook.service.ts` — **create.** Verify → dedupe → map kind → `SubscriptionService` → persist → audit.
- `me-billing.controller.ts` — **create.** `POST /api/me/billing/checkout`, `POST /api/me/billing/cancel`, `GET /api/me/billing` (authenticated).
- `razorpay-webhook.controller.ts` — **create.** `@Public()` `POST webhooks/razorpay`.
- `billing.module.ts` — **create.** `@Global`-style module; `paymentProviderFactory`; imports Subscription/Prisma/Tenant.
- `dto/checkout.dto.ts` — **create.** `{ segment }` validation.

**Backend — shared (additive seams)**
- `apps/api/src/common/audit/audit-actions.ts` — **modify.** Add `billing` group.
- `apps/api/src/config/configuration.ts` — **modify.** Add `billing` section.
- `apps/api/src/app.module.ts` — **modify.** Register `BillingModule`.
- `apps/api/src/main.ts` — **modify.** Raw-body capture for the webhook route.
- `prisma/schema.prisma` — **modify.** `BillingProfile`, `WebhookEvent`, `Subscription` columns, `User` relation.
- `apps/api/src/common/tenant/…` (tenant model list) — **modify.** Add `BillingProfile` to the tenant-scoped models (like `Subscription`).

**Frontend** (`apps/web/src/`)
- `components/product/SubscribeCard.tsx` — **modify.** Real checkout launch.
- `hooks/useBilling.ts` (+ `useBilling.spec.ts`) — **create.** Checkout/cancel/status.
- `services/razorpay-checkout.ts` — **create.** `checkout.js` loader + open helper.
- `pages/landing/landingContent.ts` — **modify.** Real INR prices (keeps TDA-014 IP guard green).

**Tests** — `apps/api/test/tda015/` (`jest.config.js`, `otplib.stub.js` copied from tda004, spec files per task).

---

### Task 1: `PaymentProvider` interface + `FakePaymentProvider` + billing config + audit actions

**Files:**
- Create: `apps/api/src/modules/billing/providers/payment-provider.interface.ts`, `fake-payment.provider.ts`
- Modify: `apps/api/src/config/configuration.ts` (add `billing` section), `apps/api/src/common/audit/audit-actions.ts` (add `billing` group)
- Create: `apps/api/test/tda015/jest.config.js` (copy `apps/api/test/tda004/jest.config.js`, `roots` → `<rootDir>/test/tda015`); copy `apps/api/test/tda004/otplib.stub.js` → `apps/api/test/tda015/otplib.stub.js`
- Create: `apps/api/test/tda015/fake-payment-provider.spec.ts`

**Interfaces — Produces:** `PaymentProvider`, `BillingEvent`, `BillingEventKind`, `CreateSubscriptionResult`, token `PAYMENT_PROVIDER`, `FakePaymentProvider`; `AUDIT_ACTIONS.billing`; `configuration.billing`.

- [ ] **Step 1: Write the failing test** — `fake-payment-provider.spec.ts`: `createSubscription` returns a synthetic `providerSubId` + non-secret `checkout`; `verifyWebhookSignature` accepts the fake's canned-HMAC and rejects a tampered signature; `parseWebhookEvent` maps a canned `subscription.charged` payload → `{ kind: 'PAYMENT_CHARGED', eventId, providerSubId, currentPeriodEnd }` and an unknown event → `kind: 'UNHANDLED'`.
- [ ] **Step 2: Run → FAIL** (`npx jest --config test/tda015/jest.config.js fake-payment --verbose`).
- [ ] **Step 3: Implement** the interface (spec §3) + `FakePaymentProvider` (deterministic, in-memory, no network). Add to `configuration.ts`: `billing: { provider: process.env.BILLING_PROVIDER || 'razorpay', graceDays: +(process.env.BILLING_GRACE_DAYS || 3) }`. Append the `billing` group to `AUDIT_ACTIONS` (spec §7).
- [ ] **Step 4: Run → PASS.**
- [ ] **Step 5: Commit** `TDA-015: PaymentProvider seam + FakePaymentProvider + billing audit actions/config`.

---

### Task 2: Schema deltas + additive migration

**Files:**
- Modify: `prisma/schema.prisma` (`BillingProfile`, `WebhookEvent`, `Subscription.providerSubId/providerPlanId/graceUntil`, `User.billingProfile`)
- Modify: the tenant-model registry (add `BillingProfile` to the auto-scoped list, like `Subscription`)
- Create: `prisma/migrations/<timestamp>_tda015_billing/migration.sql` (via `prisma migrate dev --name tda015_billing`)
- Create: `apps/api/test/tda015/schema-billing.spec.ts`

**Interfaces — Produces:** `BillingProfile`, `WebhookEvent` Prisma models; `Subscription` billing columns.

- [ ] **Step 1: Write the failing test** — `schema-billing.spec.ts` (DB-backed, `DATABASE_URL_TEST`): create a `User`, a `BillingProfile` (unique `providerCustomerId`), a `Subscription` with `providerSubId`, and two `WebhookEvent` rows with the **same** `(provider, eventId)` → assert the second insert throws `P2002` (dedupe constraint). Assert a `Subscription` upsert can set `providerSubId`/`graceUntil`.
- [ ] **Step 2: Run → FAIL** (models/columns missing).
- [ ] **Step 3: Implement** the schema per spec §8 (all additions nullable / new tables — additive, no backfill). Add `BillingProfile` to the TENANT_MODELS list so the Prisma scoper auto-filters it by `userId` (billing-webhook cross-user access uses `runWithoutTenant`, like `SubscriptionService`). Generate the migration: `npx prisma migrate dev --name tda015_billing` (against `td_saas`); confirm the SQL is `CREATE TABLE` + `ALTER TABLE … ADD COLUMN` only. `npx prisma generate`.
- [ ] **Step 4: Run → PASS.** `npx prisma migrate status` clean.
- [ ] **Step 5: Commit** `TDA-015: additive schema — BillingProfile, WebhookEvent, Subscription provider columns`.

---

### Task 3: `RazorpayProvider` (dynamic SDK import + HMAC webhook verify)

**Files:**
- Create: `apps/api/src/modules/billing/providers/razorpay.provider.ts`
- Create: `apps/api/test/tda015/razorpay-provider.spec.ts`

**Interfaces — Produces:** `RazorpayProvider implements PaymentProvider`. **Consumes:** `SecretsProvider` (TDA-004), Node `crypto`.

- [ ] **Step 1: Write the failing test** — `razorpay-provider.spec.ts`: with `RAZORPAY_WEBHOOK_SECRET` set on a stub `SecretsProvider`, assert `verifyWebhookSignature(rawBody, sig)` returns **true** for `sig = HMAC_SHA256(rawBody, secret)` (hex) and **false** for a tampered sig / tampered body — using constant-time compare (`timingSafeEqual`). Assert `parseWebhookEvent` maps a realistic Razorpay `subscription.charged` JSON → `PAYMENT_CHARGED` with `providerSubId` from `payload.subscription.entity.id` and `currentPeriodEnd` from `current_end`. (No network; SDK not touched by these paths.)
- [ ] **Step 2: Run → FAIL.**
- [ ] **Step 3: Implement** `RazorpayProvider`:
  - `verifyWebhookSignature` — `crypto.createHmac('sha256', secret).update(rawBody).digest()` vs the header, `timingSafeEqual` (length-guarded, like `ChartinkWebhookController.constantTimeEqual`).
  - `parseWebhookEvent` — normalize the Razorpay event envelope → `BillingEvent` (map every event name in spec §3 to a `BillingEventKind`; unknown → `UNHANDLED`).
  - `createCustomer`/`createSubscription`/`cancelSubscription` — `const Razorpay = (await import('razorpay')).default; const rzp = new Razorpay({ key_id, key_secret });` (secrets via `SecretsProvider`). `createSubscription` picks the plan id by segment (`RAZORPAY_PLAN_INTRADAY`/`_SWING`) and returns `{ providerSubId, providerPlanId, checkout: { keyId, subscriptionId, shortUrl } }` — **keyId only, never key_secret**.
- [ ] **Step 4: Run → PASS.**
- [ ] **Step 5: Commit** `TDA-015: RazorpayProvider (dynamic SDK import, constant-time webhook HMAC)`.

---

### Task 4: `BillingWebhookService` — verify → dedupe → map → audit

**Files:**
- Create: `apps/api/src/modules/billing/billing-webhook.service.ts`, `billing.service.ts`
- Create: `apps/api/test/tda015/billing-webhook.spec.ts`

**Interfaces — Produces:** `BillingWebhookService.handle(rawBody, signature)`; `BillingService` (persist provider status, resolve `(userId, segment)` from `providerSubId`). **Consumes:** `PAYMENT_PROVIDER`, `SubscriptionService`, `AuditService`, `PrismaService`, `TenantContextService`.

- [ ] **Step 1: Write the failing tests** — `billing-webhook.spec.ts` (bind `FakePaymentProvider` + a `Memoryless` real `SubscriptionService` against `td_saas_test`):
  - Forged signature → throws `UnauthorizedException`, audits `BILLING_WEBHOOK_REJECTED`, **no** grant.
  - Valid `subscription.charged` for a known `providerSubId` → `SubscriptionService.hasActive(userId, segment)` becomes true with `expiresAt ≈ currentPeriodEnd + graceDays`; audits `BILLING_PAYMENT_CHARGED`.
  - **Idempotency:** delivering the **same** `eventId` twice → `grant` called once (spy), second delivery returns `{ deduped: true }` and does not re-grant (`WebhookEvent` `P2002`).
  - `subscription.halted` → `revoke` → `hasActive` false; audits `BILLING_SUBSCRIPTION_HALTED` + `BILLING_ACCESS_REVOKED_LAPSE`.
  - `payment.failed` → `graceUntil` set, `hasActive` still true (until `expiresAt`), no revoke.
  - **Redaction:** the audit meta + any logger output for a processed event contain no webhook secret / signature / customer PII.
- [ ] **Step 2: Run → FAIL.**
- [ ] **Step 3: Implement** the §5 algorithm: verify → parse → **insert `WebhookEvent` (RECEIVED) first** (catch `P2002` → return deduped) → resolve `(userId, segment)` via an unscoped `providerSubId` lookup (`runWithoutTenant`) → map kind → `SubscriptionService.grant`/`revoke` (+ `graceUntil` on pending/failed) → `BillingService` persists provider status/`currentPeriodEnd` → `AuditService.append` (redacted meta) → mark `WebhookEvent` `PROCESSED`. Only `PROCESSED` short-circuits redeliveries.
- [ ] **Step 4: Run → PASS.**
- [ ] **Step 5: Commit** `TDA-015: idempotent, signature-verified webhook → SubscriptionService grant/revoke + audit`.

---

### Task 5: Controllers + module wiring + raw-body capture

**Files:**
- Create: `apps/api/src/modules/billing/me-billing.controller.ts`, `razorpay-webhook.controller.ts`, `billing.module.ts`, `dto/checkout.dto.ts`
- Modify: `apps/api/src/app.module.ts` (register `BillingModule`), `apps/api/src/main.ts` (raw-body `verify` for `/webhooks/razorpay`)
- Create: `apps/api/test/tda015/billing-routes.spec.ts`

**Interfaces — Produces:** `POST /api/me/billing/checkout`, `POST /api/me/billing/cancel`, `GET /api/me/billing` (authenticated); `@Public() POST webhooks/razorpay`; `paymentProviderFactory` (`billing.provider` → `RazorpayProvider`/`FakePaymentProvider`).

- [ ] **Step 1: Write the failing tests** — `billing-routes.spec.ts` (Style-A, real `AuthModule`+guards, `BILLING_PROVIDER=fake`):
  - Anonymous `POST /api/me/billing/checkout` → `401` (guarded).
  - Authed `POST /api/me/billing/checkout { segment: 'INTRADAY' }` → `201` with a `checkout` payload; the `(userId,'INTRADAY')` `Subscription` row now has `providerSubId` and status `PAST_DUE` (**not** ACTIVE — no access yet); `GET /api/me/subscriptions` still `INTRADAY:false`.
  - `POST webhooks/razorpay` with a **valid** fake signature for that sub's `charged` event → `200`; `GET /api/me/subscriptions` now `INTRADAY:true`.
  - `POST webhooks/razorpay` with a **forged** signature → `401`.
  - Webhook route bypasses `JwtAuthGuard` (no bearer needed to reach the handler).
- [ ] **Step 2: Run → FAIL.**
- [ ] **Step 3: Implement.**
  - `MeBillingController` (`@Controller('api/me/billing')`) — `checkout`/`cancel`/`status` via `@CurrentUser()` + `BillingService`; `CheckoutDto { segment: 'INTRADAY'|'SWING' }` (class-validator enum).
  - `RazorpayWebhookController` (`@Public()` `@Controller('webhooks/razorpay')`, `@HttpCode(200)`) — reads `req.rawBody` + `x-razorpay-signature`, delegates to `BillingWebhookService.handle`. Mirror the Chartink controller's shape.
  - `BillingModule` — `paymentProviderFactory` on `PAYMENT_PROVIDER` (dynamic-import `RazorpayProvider` when `billing.provider==='razorpay'`); imports `SubscriptionModule` (for `SubscriptionService`), Prisma, Tenant; providers include `BillingService`, `BillingWebhookService`.
  - `app.module.ts` — add `BillingModule` to `imports` (additive, near `SubscriptionModule`).
  - `main.ts` — add raw-body capture: `NestFactory.create(AppModule, { rawBody: true })` (Nest built-in) **or** `app.use(json({ verify: (req,_r,buf)=>{ (req as any).rawBody = buf; }}))` scoped so only the webhook needs it. Do not alter `applyHttpHardening`.
- [ ] **Step 4: Run → PASS.** Confirm boot: `cd apps/api && npx nest build` (SWC).
- [ ] **Step 5: Commit** `TDA-015: billing + webhook controllers, module wiring, raw-body capture`.

---

### Task 6: Daily lapse sweep (missed-webhook safety)

**Files:**
- Create: `apps/api/src/modules/billing/billing-sweep.service.ts` (a cron, or a hook into the existing `daily-housekeeping` worker)
- Create: `apps/api/test/tda015/billing-sweep.spec.ts`

**Interfaces — Produces:** `expireLapsedSubscriptions()` — flips any `ACTIVE` `Subscription` with `expiresAt < now` (beyond grace) to `EXPIRED`, audits `BILLING_ACCESS_REVOKED_LAPSE`.

- [ ] **Step 1: Write the failing test** — seed an `ACTIVE` row with `expiresAt` in the past → run `expireLapsedSubscriptions()` → row is `EXPIRED`, `hasActive` false, audit row present; a not-yet-expired `ACTIVE` row is untouched.
- [ ] **Step 2: Run → FAIL.**
- [ ] **Step 3: Implement** the sweep (unscoped `updateMany` via `runWithoutTenant`; audit per affected user). Register on the existing daily-housekeeping cron (check `apps/api/src/**` for the housekeeping queue/worker; add a step, do not create a new scheduler if one exists).
- [ ] **Step 4: Run → PASS.**
- [ ] **Step 5: Commit** `TDA-015: daily lapse sweep — expiresAt is authoritative for gating`.

---

### Task 7: Frontend — real Razorpay checkout replaces the stub

**Files:**
- Modify: `apps/web/src/components/product/SubscribeCard.tsx`
- Create: `apps/web/src/hooks/useBilling.ts`, `apps/web/src/hooks/useBilling.spec.ts`
- Create: `apps/web/src/services/razorpay-checkout.ts`
- Modify: `apps/web/src/pages/landing/landingContent.ts` (real INR prices)

**Interfaces — Produces:** `useBilling()` (`startCheckout(segment)`, `cancel(segment)`, status), `loadRazorpayCheckout()` + `openCheckout(opts)`.

- [ ] **Step 1: Write the failing test** — `useBilling.spec.ts` (Vitest, pure-logic): the request builder posts `{ segment }` to `/me/billing/checkout` and returns the `checkout` payload; an error path surfaces a message. Also assert `landingContent` **still passes the TDA-014 forbidden-term guard** with the new price strings present (re-run `apps/web/src/pages/landing/landingContent.spec.ts`).
- [ ] **Step 2: Run → FAIL.**
- [ ] **Step 3: Implement.**
  - `razorpay-checkout.ts` — inject the Razorpay `checkout.js` `<script>` once (external CDN — the allowed exception), `openCheckout({ keyId, subscriptionId, onSuccess, onDismiss })`.
  - `useBilling.ts` — checkout/cancel/status over the shared `api` axios instance.
  - `SubscribeCard.tsx` — button → `useBilling().startCheckout(segment)` → `openCheckout(...)`; on success show "activating…" and re-poll `/me/subscriptions`; replace the `toast('Checkout coming soon')` stub.
  - `landingContent.ts` — set real INR monthly prices on the Intraday/Swing/Both tiers (no provenance terms).
- [ ] **Step 4: Verify** — `cd apps/web && npx tsc -b --noEmit`; `npx vitest run src/hooks/useBilling.spec.ts src/pages/landing/landingContent.spec.ts`.
- [ ] **Step 5: Commit** `TDA-015: real Razorpay checkout in SubscribeCard + useBilling + real pricing`.

---

### Task 8: Env template + Razorpay setup runbook + redaction regression guard

**Files:**
- Modify: `.env.example` (additive — document the new vars; no real secrets)
- Create: `apps/api/test/tda015/no-secret-leak.spec.ts` (regression guard)
- Create: `docs/superpowers/specs/2026-07-03-tda-015-razorpay-setup-notes.md` (dashboard/plan runbook stub — NOT executed here)

**Note:** documentation + a CI lock; no app-behaviour change.

- [ ] **Step 1: Write the guard** — `no-secret-leak.spec.ts`: run a representative webhook + checkout through the services with a spy on the logger and on `AuditService.append`; assert no captured string contains the webhook secret, key secret, or `x-razorpay-signature` value. (Locks spec §7/§AC6.)
- [ ] **Step 2: Run → PASS** (implementation already redacts; this locks it). If FAIL, a leak remains — fix it.
- [ ] **Step 3: Document.**
  - `.env.example`: add `BILLING_PROVIDER=fake`, `BILLING_GRACE_DAYS=3`, `RAZORPAY_KEY_ID=`, `RAZORPAY_KEY_SECRET=`, `RAZORPAY_WEBHOOK_SECRET=`, `RAZORPAY_PLAN_INTRADAY=`, `RAZORPAY_PLAN_SWING=`, `LIVE_BILLING_ENABLED=false` — each marked REQUIRED-in-prod / no-default (secrets resolve via `SecretsProvider`).
  - `razorpay-setup-notes.md`: dashboard runbook — (a) create the two monthly INR **Plans** (Intraday/Swing) with the per-txn mandate max ≥ price; (b) enable **Subscriptions** + **UPI Autopay**; (c) configure the **webhook** endpoint `https://<api-origin>/webhooks/razorpay` with the events in spec §3 and set `RAZORPAY_WEBHOOK_SECRET`; (d) **GST** business config + HSN/SAC for SaaS (spec §10.1); (e) the **merchant-category / SaaS-not-investment** positioning caveat (spec §10.7) to confirm at KYB; (f) keep `LIVE_BILLING_ENABLED=false` until the SEBI/legal review (roadmap §7) lands. Mark the doc **deployment-gated — not part of the MVP test loop**.
- [ ] **Step 4: Run the full tda015 suite** → PASS: `cd apps/api && npx jest --config test/tda015/jest.config.js --verbose`.
- [ ] **Step 5: Commit** `TDA-015: env template + Razorpay setup runbook + no-secret-leak regression guard`.

---

## Self-Review

- **Spec coverage:** §3 (PaymentProvider seam) → T1 (interface+fake) + T3 (Razorpay); §4 (checkout lifecycle) → T3/T5 + T7 (frontend); §5 (webhook verify/dedupe/map) → T4 + T5 (route); §6 (lapse authoritative) → T4 (revoke) + T6 (sweep) + `expiresAt` in `grant`; §7 (audit) → T1 (actions) + T4/T8 (redaction); §8 (data model) → T2; §9 (frontend) → T7; §10 open decisions → carried as notes (grace=3d in T1 config, "Both"=two subs in T3/T7, merchant caveat in T8 runbook); §11 (legal) → `LIVE_BILLING_ENABLED=false` in T8.
- **Acceptance mapping:** AC1→T1/T3/T5(factory), AC2→T4/T5, AC3→T3/T4/T5, AC4→T4, AC5→T4/T6, AC6→T4/T8, AC7→T2.
- **Do-not-duplicate discipline:** entitlement is flipped ONLY by `SubscriptionService.grant`/`revoke` (T4 drives them; `expiresAt` carries period-end+grace). `BillingService` persists provider ids/status; it never re-implements the gate. ✅
- **Idempotency:** `WebhookEvent @@unique([provider,eventId])` insert-first (T2 constraint, T4 dedupe) mirrors `ExecutionClaim`; redeliveries are no-ops; only `PROCESSED` short-circuits. ✅
- **Secrets/offline:** all Razorpay secrets via `SecretsProvider`; `razorpay` SDK is a **dynamic import** (never in the test build); HMAC verify uses only `crypto`; `BILLING_PROVIDER=fake` makes the whole path CI-testable with no network/account. ✅
- **Additive-migration discipline:** T2 is new tables + nullable columns + one relation — no backfill, no `NOT NULL` on existing rows; `prisma migrate status` clean before+after; the gate's existing reads are unchanged. ✅
- **Raw-body risk:** T5 captures raw bytes only for `/webhooks/razorpay` (the signature needs exact bytes); no other route's parsing changes — flagged. ✅
- **Redaction:** T8's `no-secret-leak.spec.ts` locks that no key/secret/signature/PII reaches logs or audit meta. ✅
- **Shared-seam discipline:** `audit-actions.ts` / `configuration.ts` / `app.module.ts` / `main.ts` / `schema.prisma` edits are all additive and self-contained. ✅
- **Jest 29.7:** all run commands use `--verbose`, never `-v`. ✅
- **Legal gate:** billing is built behind `LIVE_BILLING_ENABLED=false` / `BILLING_PROVIDER=fake`; public launch waits on the SEBI/legal review (roadmap §7) with TDA-009 consent as the first mitigation — non-blocking for this build. ✅
