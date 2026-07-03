# TDA-015 — Razorpay Setup Runbook (deployment-gated)

**Status:** Deployment-gated — **NOT part of the MVP test loop.** The whole
billing path is exercised offline with `BILLING_PROVIDER=fake`; this runbook is
the one-time Razorpay dashboard/KYB checklist to perform **before** flipping
`LIVE_BILLING_ENABLED=true`. Nothing here runs in CI.

> Do **not** enable live billing publicly until the SEBI/legal review (roadmap
> §7) lands. TDA-009 versioned consent is the first mitigation; the
> merchant-category positioning below is the commercial-side framing.

---

## 1. Create the two monthly INR Plans

Dashboard → Subscriptions → Plans. Create one **monthly** INR plan per segment:

- **Intraday** → set `RAZORPAY_PLAN_INTRADAY` to the returned `plan_...` id.
- **Swing** → set `RAZORPAY_PLAN_SWING` to the returned `plan_...` id.

Set the **per-transaction mandate max** ≥ the plan price (RBI e-mandate caps the
debitable amount per cycle; a debit above the cap needs fresh AFA). Keep the plan
price ≤ the mandate max so renewals auto-debit without re-authentication.

There is **no bundled "Both" plan** — "Both" is two independent subscriptions
(one per segment). This preserves independent lapse per gate (spec §10.5).

## 2. Enable Subscriptions + UPI Autopay

- Enable **Subscriptions** on the account.
- Enable **UPI Autopay / RBI e-mandate** (cards / net-banking mandate come with
  the same plan). The first debit requires **AFA**; Razorpay Checkout handles the
  mandate-registration UX. Our code never sees card/UPI details (SAQ-A scope).

## 3. Configure the webhook endpoint

Dashboard → Settings → Webhooks → Add:

- **URL:** `https://<api-origin>/webhooks/razorpay`
- **Secret:** generate a strong value and set it as `RAZORPAY_WEBHOOK_SECRET`
  (resolved via the SecretsProvider; never logged). The handler HMAC-SHA256
  verifies the **raw body** against this secret, constant-time.
- **Active events** (spec §3 — every one the handler maps):
  - `subscription.activated`
  - `subscription.authenticated`
  - `subscription.charged`
  - `subscription.pending`
  - `subscription.halted`
  - `subscription.cancelled`
  - `subscription.completed`
  - `payment.failed`

Any other event is acked `200` and audited as `UNHANDLED` (no state change).
Redeliveries are safe — the handler dedupes on the provider event id
(`WebhookEvent @@unique([provider, eventId])`), so a redelivered event is a no-op.

## 4. Credentials

Set from Dashboard → Settings → API Keys:

- `RAZORPAY_KEY_ID` — **publishable**; handed to the browser to launch Checkout.
- `RAZORPAY_KEY_SECRET` — **secret**; server-side only, never client-side, never
  committed. Resolved via the SecretsProvider.

## 5. GST business config

- Configure the business **GSTIN** + **HSN/SAC** for a SaaS software subscription
  on the Razorpay dashboard so Razorpay issues **GST-compliant invoices**.
- We collect the customer `gstin` on `BillingProfile` (B2B input credit).
- Own-generated invoice PDFs are out of scope for the MVP (rely on Razorpay's).

## 6. Merchant-category / product-positioning caveat (confirm at KYB)

This charge is a **SaaS software subscription** — access to an execution *tool*.
We do **NOT** collect, custody, or pool user **trading funds**, and we do **NOT**
sell an investment product or an advisory-return guarantee. The Razorpay **MCC /
merchant onboarding**, and all invoice/consent copy, must read
**"software subscription"**, never "investment" / "trading returns". Get the
merchant category and product positioning signed off during Razorpay **KYB**
(spec §10.7).

## 7. Go-live gate

Keep `LIVE_BILLING_ENABLED=false` and `BILLING_PROVIDER=fake` until:

1. the SEBI/legal review (roadmap §7) lands, and
2. the merchant category + consent/invoice copy are signed off (§6).

Then set `BILLING_PROVIDER=razorpay`, populate the five Razorpay secrets/ids
above, and flip `LIVE_BILLING_ENABLED=true`.

---

### Environment variables summary

| Var | Prod | Secret? | Notes |
|-----|------|---------|-------|
| `BILLING_PROVIDER` | `razorpay` | no | `fake` in tests/dev |
| `BILLING_GRACE_DAYS` | `3` | no | dunning window |
| `LIVE_BILLING_ENABLED` | `true` (post-review) | no | public-launch kill switch |
| `RAZORPAY_KEY_ID` | required | no (publishable) | browser Checkout key |
| `RAZORPAY_KEY_SECRET` | required | **yes** | server-side only |
| `RAZORPAY_WEBHOOK_SECRET` | required | **yes** | raw-body HMAC |
| `RAZORPAY_PLAN_INTRADAY` | required | no | `plan_...` id |
| `RAZORPAY_PLAN_SWING` | required | no | `plan_...` id |

All resolve via the `SecretsProvider` (TDA-004) — **no defaults, never logged.**
A missing secret rejects the webhook / fails the checkout (never a silent default).
