# TDA-015 — Billing / Subscriptions / Payments (Razorpay) + Plan-Gating Enforcement — Design Spec

**Doc ID:** TDA-015
**Date:** 2026-07-03
**Sprint:** S7 (Landing & Billing) — Harden
**Depends on:** TDA-001 (`Subscription` model + `SubscriptionService`), TDA-014 (landing/pricing CTA + signup funnel). Consumes TDA-004 (`SecretsProvider`), TDA-008 (`AuditService`).
**Blocks:** — (last MVP-adjacent commercial gate; nothing downstream depends on it)
**Owner:** development@panamoure.com

---

## 1. Goal

Turn the free-to-use plan-gate into a **paid, self-service subscription**. Today a
user's access to the Intraday and Swing segments is a boolean read off the
`Subscription` table (TDA-007), and the only way a row becomes `ACTIVE` is an
**ADMIN** `POST /api/admin/subscriptions` grant. The public product surface
(TDA-007) shows an unsubscribed user a `SubscribeCard` whose button is a stub
(`toast('Checkout coming soon')`), and TDA-014's pricing teaser routes to
`/signup` with **placeholder** prices and no checkout.

TDA-015 makes payment real and **self-service**, India-first, via **Razorpay**:

1. A user subscribes to **Intraday and/or Swing** (they are **separate
   subscriptions** — roadmap §1) through a Razorpay checkout.
2. Recurring INR billing via **Razorpay Subscriptions** on **UPI Autopay / RBI
   e-mandate** (cards/net-banking mandate also supported by the same Razorpay
   plan).
3. A **signature-verified, idempotent webhook** turns Razorpay lifecycle events
   into `SubscriptionService.grant` / `revoke` calls — so **payment state is the
   authoritative driver of access**, and a lapsed/halted/cancelled subscription
   **revokes** the segment.
4. Every billing event is written to the tamper-evident audit log (TDA-008); all
   Razorpay keys/secrets come from the secrets seam (TDA-004) and are **never
   logged**.

The **payment gateway is behind an adapter seam** (`PaymentProvider`), mirroring
the broker-adapter and TDA-004 provider-factory patterns, so a later move to
Cashfree/Stripe is an adapter swap that **does not touch plan-gating**.

This spec does **not** change the signal engine, fan-out, or the meaning of a
"subscription" as read by the gate — it only makes money flip the existing
`Subscription.status`/`expiresAt` that `SubscriptionService.hasActive` already
reads.

---

## 2. Current state (from code map) — what exists

- **Entitlement model** (`prisma/schema.prisma`):
  - `Subscription { id, userId, segment (Segment INTRADAY|SWING), status
    (SubscriptionStatus ACTIVE|PAST_DUE|CANCELLED|EXPIRED), startedAt, expiresAt?,
    … }`, `@@unique([userId, segment])`, `@@index([status, expiresAt])`. **One row
    per (user, segment).** This is the single source of truth for the gate.
  - `User` (= tenant), `BillingProfile` does **not** exist yet.
- **`SubscriptionService`** (`apps/api/src/modules/subscription/subscription.service.ts`):
  - `hasActive(userId, seg)` / `listForUser(userId)` — "active" = `status ===
    'ACTIVE'` AND (`expiresAt == null` OR `expiresAt > now`).
  - `grant(userId, seg, expiresAt = null)` — upserts the `(userId, segment)` row to
    `status: 'ACTIVE', expiresAt`.
  - `revoke(userId, seg)` — `updateMany` sets `status: 'CANCELLED'`.
  - Every method wraps its query in `TenantContextService.runWithoutTenant` because
    `Subscription` is a TENANT_MODEL but billing operates **across users** (the
    webhook worker has no request/tenant context). **The webhook handler DRIVES
    these methods — TDA-015 does not duplicate them.**
- **Subscription endpoints:**
  - `MeSubscriptionController` `GET /api/me/subscriptions` → `{ INTRADAY, SWING }`
    booleans (authenticated).
  - `AdminSubscriptionController` `POST`/`DELETE /api/admin/subscriptions` →
    grant/revoke (ADMIN-only). **Kept** — admin comps/refund overrides still route
    through it.
- **Webhook precedent** (`apps/api/src/modules/chartink/controllers/chartink-webhook.controller.ts`):
  `@Public()` controller at `webhooks/chartink` (no `/api` prefix), constant-time
  secret check via `timingSafeEqual`, `@HttpCode(200)`. **This is the template**
  for the Razorpay webhook's auth/opt-out shape — but Razorpay signs the **raw
  body** (HMAC-SHA256), not a path secret, so §5 adds raw-body capture.
- **`@Public()`** (`apps/api/src/common/decorators/public.decorator.ts`) sets
  `IS_PUBLIC_KEY`; the global `JwtAuthGuard` reads it to skip auth. Applied
  class-wide on the webhook controller.
- **Secrets seam** (TDA-004, merged): `SecretsProvider` (`SECRETS_PROVIDER` DI
  token, `getSecret`/`getRequiredSecret`) with `EnvSecretsProvider` default;
  `SecretsModule` is `@Global`. Razorpay key-id/secret + webhook secret resolve
  through it — **no defaults, never logged**.
- **Audit** (TDA-008, merged): `AuditService.append(event)` is the sole writer of
  the hash-chained `audit_logs`; `AUDIT_ACTIONS` is a grouped string union
  (`auth`/`credential`/`consent`/`execution`). `AuditModule` is `@Global`.
  TDA-015 **adds a `billing` group** (§7).
- **Frontend stub** (`apps/web/src/components/product/SubscribeCard.tsx`): the
  `Subscribe` button toasts "Checkout coming soon". Consumed by
  `IntradayPage`/`SwingPage` via `useSubscriptions()` +
  `shouldShowSubscribeCard(isAdmin, loading, subscribed)`
  (`apps/web/src/hooks/useSubscriptions.ts`). TDA-015 **replaces the stub CTA**
  with a real Razorpay checkout launch. TDA-014's pricing teaser (placeholder
  prices) gains real numbers.
- **Config** (`apps/api/src/config/configuration.ts`): keyed sections
  (`secrets.provider`, `kms.provider`, …). TDA-015 adds a `billing` section.
- **Body parsing** (`apps/api/src/main.ts`): default Nest/express JSON parser; **no
  raw-body capture today** — §5.

---

## 3. Key design decision — `PaymentProvider` adapter seam (MUST READ)

Payment gateways are swappable infrastructure, exactly like brokers (roadmap §4
broker-adapter pattern) and exactly like TDA-004's `SecretsProvider`/`KmsProvider`.
The gateway is therefore fronted by **one interface**, so that **plan-gating (the
webhook → `SubscriptionService` mapping) never imports Razorpay** and a later
Cashfree/Stripe move is an adapter swap:

```
              ┌────────────────────────────┐        ┌───────────────────────┐
 app code  ─► │  PaymentProvider           │◄─ factory selects by config
 (billing     │  createCustomer()          │        │ RazorpayProvider  (prod/dev default)
  service)    │  createSubscription()      │        │ FakePaymentProvider (test/offline)
              │  cancelSubscription()      │        └───────────────────────┘
              │  verifyWebhookSignature()  │
              │  parseWebhookEvent()       │
              └────────────────────────────┘
                          │  normalized BillingEvent (provider-agnostic)
                          ▼
              WEBHOOK HANDLER ── idempotent, per-event dedupe ──►
                 maps BillingEvent.kind → SubscriptionService.grant / revoke
                 + BillingService persists provider ids/status + AuditService.append
```

**`PaymentProvider` interface** (`apps/api/src/modules/billing/providers/`):

```ts
export type BillingEventKind =
  | 'SUBSCRIPTION_ACTIVATED'   // subscription.activated / .authenticated
  | 'PAYMENT_CHARGED'          // subscription.charged (a cycle was paid)
  | 'PAYMENT_PENDING'          // subscription.pending (a retry is pending — dunning)
  | 'PAYMENT_FAILED'           // payment.failed on a subscription invoice
  | 'SUBSCRIPTION_HALTED'      // subscription.halted (retries exhausted → lapse)
  | 'SUBSCRIPTION_CANCELLED'   // subscription.cancelled
  | 'SUBSCRIPTION_COMPLETED'   // subscription.completed (fixed-count plan ended)
  | 'UNHANDLED';               // any other event — audited + acked, no state change

export interface BillingEvent {
  kind: BillingEventKind;
  eventId: string;            // provider event id — the idempotency key
  providerSubId?: string;     // razorpay subscription id (maps to a Subscription row)
  currentPeriodEnd?: Date;    // paid-through instant (drives expiresAt)
  raw: unknown;               // opaque provider payload (for audit meta, redacted)
}

export interface CreateSubscriptionResult {
  providerSubId: string;      // store on Subscription.providerSubId
  providerPlanId: string;
  // Handed to the browser to launch checkout (see §4). Never a secret.
  checkout: { keyId: string; subscriptionId: string; shortUrl?: string };
}

export interface PaymentProvider {
  createCustomer(input: { userId: string; email: string; name?: string }): Promise<{ providerCustomerId: string }>;
  createSubscription(input: { providerCustomerId: string; segment: 'INTRADAY' | 'SWING' }): Promise<CreateSubscriptionResult>;
  cancelSubscription(input: { providerSubId: string; atCycleEnd: boolean }): Promise<void>;
  /** Constant-time HMAC verify of the RAW request body against the webhook secret. */
  verifyWebhookSignature(rawBody: Buffer, signature: string): Promise<boolean>;
  /** Normalize a verified provider payload into a BillingEvent. */
  parseWebhookEvent(rawBody: Buffer): BillingEvent;
}
```

- **`RazorpayProvider`** — the concrete impl. Reads `RAZORPAY_KEY_ID`,
  `RAZORPAY_KEY_SECRET`, `RAZORPAY_WEBHOOK_SECRET`, and the two plan ids
  (`RAZORPAY_PLAN_INTRADAY`, `RAZORPAY_PLAN_SWING`) via `SecretsProvider`
  (TDA-004). `verifyWebhookSignature` is `timingSafeEqual(hmacSHA256(rawBody,
  webhookSecret), signature)` — the same constant-time discipline as the Chartink
  webhook. The Razorpay Node SDK (`razorpay`) is a **dynamic import** inside the
  provider (mirrors TDA-004's gated `@aws-sdk` dynamic import) so the offline
  test build never needs the package.
- **`FakePaymentProvider`** — deterministic in-memory impl (default when
  `BILLING_PROVIDER=fake`, used by CI/dev): `createSubscription` returns a
  synthetic id; `verifyWebhookSignature` checks a fixed test HMAC; `parseWebhookEvent`
  reads a canned event shape. Lets the **entire webhook→gating→audit path be
  tested with zero network and zero Razorpay account.**
- **`paymentProviderFactory`** selects on `billing.provider`
  (`razorpay` default in prod, `fake` in test) — a `@Global` `BillingModule`
  provider exporting a `PAYMENT_PROVIDER` DI token.

**Rationale:** the *value* is the webhook→entitlement mapping and its idempotency
+ audit guarantees, all of which are provider-agnostic and testable today.
Razorpay is one adapter; the gate never learns its name.

---

## 4. Subscription lifecycle — Razorpay Subscriptions (recurring INR, e-mandate)

**Model:** one **Razorpay Plan** per segment (`RAZORPAY_PLAN_INTRADAY`,
`RAZORPAY_PLAN_SWING`), monthly period, INR. Subscribing to a segment creates a
**Razorpay Subscription** against that plan → **one Razorpay subscription per
(user, segment)**, exactly matching the "separate subscriptions" product rule.
A user wanting **both** segments holds **two independent Razorpay subscriptions**
(the marketing "Both" tier is just two CTAs / a convenience that starts both — it
is **not** a bundled Razorpay plan; see §10.5).

**Checkout flow (authenticated):**

1. Frontend `SubscribeCard` (Intraday/Swing) → `POST /api/me/billing/checkout
   { segment }`.
2. `BillingService`:
   - Ensures a `BillingProfile` (creates a Razorpay **customer** on first use via
     `PaymentProvider.createCustomer`, stores `providerCustomerId`).
   - `PaymentProvider.createSubscription({ providerCustomerId, segment })` →
     `{ providerSubId, providerPlanId, checkout }`.
   - Upserts the `(userId, segment)` `Subscription` row with `providerSubId` +
     `providerPlanId` and **status `PAST_DUE`** (pending authorization — **not**
     `ACTIVE`; access is only granted when the webhook confirms the first charge).
   - Audits `BILLING_CHECKOUT_CREATED`.
   - Returns `checkout` (`{ keyId, subscriptionId }`) — **no secret**.
3. Frontend launches **Razorpay Checkout** (`checkout.js`, loaded via a `<script>`)
   with `subscription_id`. The user authorizes the **UPI Autopay / e-mandate**
   (AFA — additional factor of authentication — on the first debit).
4. Authorization + first debit → Razorpay fires `subscription.activated` and
   `subscription.charged` → the **webhook** (§5) flips the `Subscription` row to
   `ACTIVE` with `expiresAt = currentPeriodEnd (+ grace)`. **Access is now on.**

**RBI e-mandate / UPI Autopay notes (compliance, informational):**
- First charge requires **AFA**; Razorpay Checkout handles the mandate-registration
  UX. Our code never sees card/UPI details (SAQ-A scope).
- Recurring debits require a **pre-debit notification** (Razorpay sends it per
  mandate rules); **per-transaction mandate cap** is set on the plan/subscription
  (the max debitable amount). Amounts above the cap need fresh AFA — keep plan
  price ≤ cap.
- These are Razorpay-side behaviours; TDA-015 only reacts to the resulting webhook
  events. Documented so the plan prices and mandate max are configured correctly.

**Renewal & lapse (the money→access loop):**
- Each successful cycle → `subscription.charged` → `grant(userId, segment,
  currentPeriodEnd + grace)` (rolls `expiresAt` forward).
- Failed renewal → Razorpay retries (dunning); we receive `subscription.pending`
  / `payment.failed` → **enter grace** (keep `ACTIVE` until `expiresAt`, set
  `graceUntil`), audit the failure.
- Retries exhausted → `subscription.halted` → `revoke` (status `CANCELLED`) →
  **access off**. `subscription.cancelled` (user/admin cancel) → same.
- Belt-and-suspenders: a **daily housekeeping sweep** expires any `ACTIVE` row
  whose `expiresAt < now` (independent of webhook delivery), so a **missed webhook
  cannot leave a lapsed user with access** — `expiresAt` is authoritative (§6).

**Cancellation:** `POST /api/me/billing/cancel { segment }` →
`PaymentProvider.cancelSubscription({ providerSubId, atCycleEnd: true })`. Access
persists until period end; the eventual `subscription.cancelled` webhook revokes.
Immediate cancel + refund is an admin/ops path (§10.4).

---

## 5. Webhook handler — signature-verified, idempotent, entitlement-driving

**Route:** `@Public()` `POST webhooks/razorpay` (no `/api` prefix, mirrors
`webhooks/chartink`), `@HttpCode(200)`. Opted out of `JwtAuthGuard` — webhooks are
unauthenticated but **cryptographically verified**.

**Raw body (critical):** Razorpay's signature is HMAC-SHA256 over the **exact raw
bytes**. The global JSON parser destroys those bytes, so we capture the raw buffer
**only for this route**. In `main.ts`, register `express.json({ verify: (req,
_res, buf) => { req.rawBody = buf } })` (or a scoped `express.raw()` on
`/webhooks/razorpay`) so the controller can read `req.rawBody`. This is the one
`main.ts` edit; it is additive and does not change any other route's parsing.

**Handler algorithm** (`RazorpayWebhookController` → `BillingWebhookService`):

1. **Verify** `PaymentProvider.verifyWebhookSignature(rawBody,
   headers['x-razorpay-signature'])`. On mismatch → audit
   `BILLING_WEBHOOK_REJECTED` (no PII) → **`401`**. (Missing/unconfigured secret →
   reject all, like Chartink.)
2. **Parse** → `BillingEvent { kind, eventId, providerSubId, currentPeriodEnd }`.
3. **Idempotency (dedupe on provider event id):** insert a `WebhookEvent` row keyed
   `@@unique([provider, eventId])` with status `RECEIVED` **before** any side
   effect. On the unique conflict (`P2002`) the event is a **duplicate redelivery**
   → **ack `200` and stop** (no re-processing). This mirrors the `ExecutionClaim`
   insert-first at-most-once backstop (TDA-011). Webhooks *will* be redelivered;
   this makes reprocessing a no-op.
4. **Map kind → entitlement** (resolve `(userId, segment)` from the `Subscription`
   row whose `providerSubId` matches — an **unscoped** lookup via
   `runWithoutTenant`, since the worker has no tenant context):
   - `SUBSCRIPTION_ACTIVATED` / `PAYMENT_CHARGED` → `SubscriptionService.grant(userId,
     segment, currentPeriodEnd + grace)`; clear `graceUntil`.
   - `PAYMENT_PENDING` / `PAYMENT_FAILED` → set `graceUntil = now + gracePeriod`
     (keep `ACTIVE` until `expiresAt`); **no revoke yet** (dunning).
   - `SUBSCRIPTION_HALTED` / `SUBSCRIPTION_CANCELLED` / `SUBSCRIPTION_COMPLETED` →
     `SubscriptionService.revoke(userId, segment)` → **access off**.
   - `UNHANDLED` → audit + ack, no state change.
5. **Persist billing state** (`BillingService`): update the mirrored provider
   status / `currentPeriodEnd` on the `Subscription` row (additive columns, §8).
6. **Audit** the mapped action (§7) with **redacted** meta (event id, sub id,
   segment, kind — **never** keys, signatures, or raw PII).
7. Mark the `WebhookEvent` `PROCESSED`; return `200`.

Ordering (verify → dedupe → map → persist → audit → ack) means an unverified or
duplicate event **never** touches entitlement, and a processing crash **after**
dedupe-insert but **before** PROCESSED is reconciled by a redelivery being treated
as… still the same event id → re-run is safe only if steps 4–6 are idempotent:
`grant`/`revoke` are upserts (idempotent), and the `WebhookEvent` row lets a
crashed-mid-process event be **retried** by leaving it `RECEIVED` and letting
Razorpay redeliver (we do **not** short-circuit `RECEIVED`-but-not-`PROCESSED`
rows — only `PROCESSED` short-circuits). See §10.3 open decision on the exact
crash-window policy.

---

## 6. Plan-gating enforcement — lapse is authoritative

The gate is unchanged in shape (`SubscriptionService.hasActive` reads
`status==='ACTIVE' AND (expiresAt==null OR expiresAt>now)`), but TDA-015 makes it
**payment-authoritative** on both edges:

- **Grant edge:** only the webhook (real payment) sets `ACTIVE` with a real
  `expiresAt`. Checkout alone leaves the row `PAST_DUE` (no access). Admin grant
  (existing endpoint) with `expiresAt = null` stays the **comp/override** path.
- **Revoke edge (three redundant guarantees so a lapse cannot silently retain
  access):**
  1. Webhook `halted`/`cancelled`/`completed` → `revoke` (immediate).
  2. `expiresAt` is a hard wall — `hasActive` returns false once it passes even if
     `status` is still `ACTIVE` (missed-webhook safety).
  3. **Daily housekeeping sweep** flips any `ACTIVE` row with `expiresAt < now` to
     `EXPIRED` (durable cleanup + keeps `listForUser` honest for admin views).
- **Grace / dunning:** on a failed renewal the user keeps access until `expiresAt`
  (already paid-through) while Razorpay retries; `graceUntil` records the dunning
  window for UI ("payment failed — update your mandate"). Only `halted` (retries
  exhausted) truly revokes. No indefinite free access: `expiresAt` always caps it.

Because the gate already reads `Subscription`, **no gate/consumer code changes** —
TDA-015 only changes *what writes* `status`/`expiresAt`. The `SubscribeCard` and
`useSubscriptions` continue to work; only the CTA behind them becomes real.

---

## 7. Audit — every billing event (TDA-008)

Add a `billing` group to `AUDIT_ACTIONS` (`apps/api/src/common/audit/audit-actions.ts`),
appended additively (the union derives automatically):

```
billing: {
  BILLING_CHECKOUT_CREATED:        'BILLING_CHECKOUT_CREATED',
  BILLING_SUBSCRIPTION_ACTIVATED:  'BILLING_SUBSCRIPTION_ACTIVATED',
  BILLING_PAYMENT_CHARGED:         'BILLING_PAYMENT_CHARGED',
  BILLING_PAYMENT_FAILED:          'BILLING_PAYMENT_FAILED',
  BILLING_SUBSCRIPTION_HALTED:     'BILLING_SUBSCRIPTION_HALTED',
  BILLING_SUBSCRIPTION_CANCELLED:  'BILLING_SUBSCRIPTION_CANCELLED',
  BILLING_SUBSCRIPTION_COMPLETED:  'BILLING_SUBSCRIPTION_COMPLETED',
  BILLING_ACCESS_REVOKED_LAPSE:    'BILLING_ACCESS_REVOKED_LAPSE',
  BILLING_WEBHOOK_RECEIVED:        'BILLING_WEBHOOK_RECEIVED',
  BILLING_WEBHOOK_REJECTED:        'BILLING_WEBHOOK_REJECTED',
}
```

- `AuditService.append` is the sole writer; billing events pass through it exactly
  like execution/consent events. Meta is **redacted** (event id, providerSubId,
  segment, kind, amount) — **never** key-id/secret/signature/UPI/card data.
- The webhook rejection path audits `BILLING_WEBHOOK_REJECTED` so signature-forgery
  attempts are visible to an auditor.

## 8. Data-model deltas — minimal & additive

Only what plan-gating and billing reconciliation actually need. All additions are
**nullable/new tables** → the forward migration is additive (no backfill, no
`NOT NULL` on existing rows). Authored in the plan.

1. **`BillingProfile`** (new, one per user — the Razorpay customer + GST identity):
   ```prisma
   model BillingProfile {
     id                 String   @id @default(cuid())
     userId             String   @unique
     user               User     @relation(fields: [userId], references: [id], onDelete: Cascade)
     providerCustomerId String   @unique          // razorpay customer id
     gstin              String?                    // for GST invoicing (§10.1)
     billingName        String?
     createdAt          DateTime @default(now())
     updatedAt          DateTime @updatedAt
     @@map("billing_profiles")
   }
   ```
   A TENANT_MODEL (user-owned) — added to the tenant scope list like `Subscription`.

2. **`Subscription` — three additive nullable columns** (the billing linkage lives
   on the existing gate row, so the webhook maps `providerSubId → (userId, segment)`
   with no join table):
   ```prisma
   providerSubId   String?   @unique   // razorpay subscription id
   providerPlanId  String?             // razorpay plan id (segment tier)
   graceUntil      DateTime?           // dunning window end (failed-renewal grace)
   ```
   `SubscriptionStatus` enum is **reused** (`ACTIVE`/`PAST_DUE`/`CANCELLED`/`EXPIRED`);
   Razorpay states map onto it (pending→`PAST_DUE`, halted/cancelled→`CANCELLED`,
   completed/expired→`EXPIRED`). No new enum value needed.

3. **`WebhookEvent`** (new — the idempotency/dedupe ledger; NOT a tenant model,
   written by the unauthenticated webhook worker, mirrors `ExecutionClaim`'s
   rationale):
   ```prisma
   model WebhookEvent {
     id          String    @id @default(cuid())
     provider    String    @default("razorpay")
     eventId     String                              // provider event id
     eventType   String                              // razorpay event name
     status      String    @default("RECEIVED")      // RECEIVED | PROCESSED | FAILED
     payloadHash String                              // sha256 of raw body (forensics, no PII)
     receivedAt  DateTime  @default(now())
     processedAt DateTime?
     @@unique([provider, eventId])                   // the dedupe key
     @@index([status, receivedAt])
     @@map("webhook_events")
   }
   ```

`User` gains `billingProfile BillingProfile?` (relation only). No other model
changes. `Subscription` stays the gate's single source of truth.

## 9. Frontend — real checkout replaces the stub

- **`SubscribeCard.tsx`** — button calls `POST /api/me/billing/checkout { segment }`,
  loads Razorpay `checkout.js`, and opens the modal with the returned
  `subscription_id` + `keyId`. On dismiss/failure → toast; on success → the
  webhook will flip access (poll `GET /api/me/subscriptions` or show "activating…").
- **`useBilling` hook** — thin wrapper over `/api/me/billing` (status + profile) and
  the checkout/cancel calls, alongside the existing `useSubscriptions`.
- **Pricing** — TDA-014's `landingContent.ts` placeholder tiers gain **real INR
  monthly prices** (Intraday / Swing / Both). The IP/forbidden-term guard (TDA-014
  §7) still applies — pricing copy must not leak provenance.
- **Manage-billing** surface in Settings — show per-segment status (`ACTIVE` /
  `PAST_DUE` / grace) + a Cancel button + a "payment failed, update mandate"
  banner during grace.
- Razorpay `checkout.js` is an **external script** (the one allowed exception to
  self-containment) loaded from Razorpay's CDN — documented; no card data touches
  our origin (SAQ-A).

## 10. Open decisions & chosen defaults

1. **GST invoicing.** *Default:* rely on Razorpay's **GST-compliant invoices**
   (configure business GSTIN + HSN/SAC for SaaS on the Razorpay dashboard; collect
   customer `gstin` on `BillingProfile` for B2B input credit). *Flag:* whether we
   also generate our own invoice PDFs (deferred — not in this sprint).
2. **Razorpay Subscriptions vs one-time order + manual renewal.** *Default:*
   **Razorpay Subscriptions** (recurring, e-mandate) — matches the "subscription"
   product and automates renewal/dunning. *Alternative (rejected for MVP):* one-time
   `orders` + our own renewal cron — more code, worse UX, still needs e-mandate for
   auto-debit. *Flag* if mandate friction (AFA drop-off) proves too high — could
   fall back to one-time + reminder emails.
3. **Webhook crash-window / retry policy.** *Default:* only `PROCESSED` rows
   short-circuit; a `RECEIVED`-but-unfinished event is left for Razorpay to
   redeliver (steps 4–6 are idempotent upserts, so reprocessing is safe). *Flag:*
   TDA-012 (idempotency store hardening) may fold `WebhookEvent` into the same
   durable/transactional reconciliation as `ExecutionClaim`.
4. **Grace period length + refund/cancellation policy.** *Default:* **3-day** grace
   after `expiresAt` (env `BILLING_GRACE_DAYS`), access retained during Razorpay's
   dunning retries, hard-off on `halted`. Cancellation is **at cycle end** (no
   automatic proration/refund); immediate cancel + pro-rata refund is an **admin/ops
   path** (existing admin revoke + a manual Razorpay refund), audited. *Flag* the
   consumer-facing refund wording for legal.
5. **"Both" tier shape.** *Default:* **two independent Razorpay subscriptions**
   (one per segment) — honours "separate subscriptions" (roadmap §1). A "Both" CTA
   just initiates both checkouts (or a small discount coupon on each). *Rejected:* a
   single bundled Razorpay plan — it would couple the two gates and break
   independent lapse. *Flag* if marketing wants a single combined line-item.
6. **Settlement timing (informational).** Razorpay settles to the business bank
   account on a T+2/T+3 cycle; this is a treasury/reconciliation concern, **not**
   an access concern — access flips on the **webhook**, not on settlement. No code
   depends on settlement.
7. **Merchant-category caveat (Open Decision — needs a business/legal answer
   before go-live).** This charge is a **SaaS software subscription** (access to an
   execution *tool*). We are **NOT** collecting, custodying, or pooling user
   **trading funds**, and we are **NOT** selling an investment product or advisory
   guarantee. The Razorpay MCC / merchant onboarding, and all invoice/consent copy,
   must reflect "software subscription", not "investment"/"trading returns". This is
   the commercial mirror of the SEBI/legal open risk below — get the merchant
   category and product positioning signed off during Razorpay KYB.

## 11. Non-blocking legal / regulatory note

Roadmap §7 flags the **SEBI** "public auto-trading-against-own-broker" open risk
(and Angel One SmartAPI multi-user ToS). TDA-015 does **not** resolve it — the
**TDA-009 versioned consent/disclaimer gate is the first mitigation**, and the
merchant-category positioning (§10.7) is the commercial-side framing. Billing must
not launch publicly until that legal review lands; TDA-015 can be **built and
tested behind a flag** (`BILLING_PROVIDER=fake` / `LIVE_BILLING_ENABLED=false`)
meanwhile. Non-blocking for the build.

## 12. Out of scope (deferred)

- Own-generated invoice PDFs / a billing-history export UI (rely on Razorpay
  dashboard + emails for MVP).
- Proration, coupons/trials, annual plans, plan upgrades/downgrades mid-cycle
  (Razorpay supports these; not wired now).
- Cashfree/Stripe adapters (the `PaymentProvider` seam makes them additive later).
- Dunning **email** sequences (we set `graceUntil` + show a banner; Razorpay sends
  its own retry/pre-debit notifications).
- Tax computation beyond Razorpay's GST invoicing.
- Merging `WebhookEvent` into the TDA-012 durable idempotency store.

## 13. Acceptance criteria

1. `PaymentProvider` interface exists with a config-selected factory
   (`RazorpayProvider` default, `FakePaymentProvider` for test); the `razorpay`
   SDK is a dynamic import never required by the offline test build.
2. `POST /api/me/billing/checkout { segment }` creates (idempotently) a
   `BillingProfile` + a Razorpay subscription, upserts the `(userId, segment)`
   `Subscription` to `PAST_DUE` with `providerSubId`/`providerPlanId`, audits
   `BILLING_CHECKOUT_CREATED`, and returns a non-secret `checkout` payload.
3. `POST webhooks/razorpay` is `@Public()`, verifies the HMAC signature over the
   **raw body** (constant-time), rejects (`401` + `BILLING_WEBHOOK_REJECTED`) on
   mismatch, and is **idempotent**: a redelivered event id is acked `200` with no
   repeated state change (`WebhookEvent` `@@unique`).
4. A verified `subscription.charged` grants the matching segment (`ACTIVE`,
   `expiresAt = period end + grace`); `subscription.halted`/`cancelled` revokes it
   (`CANCELLED`) — with `SubscriptionService.grant`/`revoke` as the only entitlement
   writers (no duplication).
5. Lapse is authoritative: a user past `expiresAt` (missed webhook) is **not**
   `hasActive`, and the daily sweep flips the row to `EXPIRED`. A failed renewal
   keeps access only until `expiresAt` (+grace), then hard-off on `halted`.
6. Every billing event is in the tamper-evident audit chain; **no** Razorpay
   key/secret/signature/PII appears in logs or audit meta (asserted by a redaction
   test).
7. The migration is additive (`BillingProfile`, `WebhookEvent`, three nullable
   `Subscription` columns) — `prisma migrate status` clean, no backfill, existing
   gate reads unchanged.

## 14. Test plan

- **Unit (`apps/api/test/tda015/`, Style-A boot harness):**
  - `FakePaymentProvider` round-trips `createSubscription` / `verifyWebhookSignature`
    (valid + tampered) / `parseWebhookEvent` → each `BillingEventKind`.
  - `RazorpayProvider.verifyWebhookSignature` — HMAC-SHA256 constant-time against a
    known secret + payload vector (no network; SDK not needed for the HMAC path).
  - Webhook idempotency: two deliveries of the same `eventId` → one state change,
    second acked with no `grant`/`revoke` re-call (`WebhookEvent` conflict).
  - Kind→entitlement mapping: `charged`→`grant`(expiresAt≈period end+grace);
    `halted`/`cancelled`→`revoke`; `pending`/`failed`→`graceUntil` set, still
    `hasActive` until `expiresAt`; `UNHANDLED`→no state change.
  - Lapse: `hasActive` false once `expiresAt` passes though `status` still `ACTIVE`;
    sweep flips `ACTIVE`+expired → `EXPIRED`.
  - **Redaction guard:** audit meta + logs for a webhook contain no
    `RAZORPAY_KEY_SECRET` / signature / customer PII (grep-style assertion).
- **Integration:** `@Public()` webhook route bypasses `JwtAuthGuard`; forged
  signature → `401`; valid signature end-to-end flips `GET /api/me/subscriptions`
  from `false` → `true`; checkout requires auth (`401` anon).
- **Frontend (Vitest, pure-logic):** `useBilling` request shaping; pricing
  `landingContent` still passes the TDA-014 forbidden-term guard with real prices.
- Run from `apps/api`: `npx jest --config test/tda015/jest.config.js --verbose`
  (Jest 29.7 — `--verbose`, never `-v`).
