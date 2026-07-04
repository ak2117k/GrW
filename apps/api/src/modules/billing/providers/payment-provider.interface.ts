/**
 * TDA-015 §3 — the PaymentProvider adapter seam.
 *
 * Payment gateways are swappable infrastructure (exactly like the broker
 * adapters and the TDA-004 SecretsProvider/KmsProvider). The gateway is fronted
 * by ONE interface so that plan-gating — the webhook -> SubscriptionService
 * mapping — NEVER imports Razorpay, and a later Cashfree/Stripe move is an
 * adapter swap. Selected at runtime by `billing.provider` (config) via the
 * `PAYMENT_PROVIDER` DI token:
 *   - `RazorpayProvider`   (prod/dev default) — real; dynamic `razorpay` import.
 *   - `FakePaymentProvider` (test/offline)    — deterministic, in-memory.
 */

/** DI token for the config-selected {@link PaymentProvider}. */
export const PAYMENT_PROVIDER = Symbol('PAYMENT_PROVIDER');

/**
 * Provider-agnostic billing event kind — the normalized vocabulary the webhook
 * handler maps onto `SubscriptionService.grant`/`revoke`. Every concrete
 * provider translates its own event names into these.
 */
export type BillingEventKind =
  | 'SUBSCRIPTION_ACTIVATED' // subscription.activated / .authenticated
  | 'PAYMENT_CHARGED' // subscription.charged (a cycle was paid)
  | 'PAYMENT_PENDING' // subscription.pending (a retry is pending — dunning)
  | 'PAYMENT_FAILED' // payment.failed on a subscription invoice
  | 'SUBSCRIPTION_HALTED' // subscription.halted (retries exhausted -> lapse)
  | 'SUBSCRIPTION_CANCELLED' // subscription.cancelled
  | 'SUBSCRIPTION_COMPLETED' // subscription.completed (fixed-count plan ended)
  | 'UNHANDLED'; // any other event — audited + acked, no state change

/** A verified provider webhook payload, normalized. */
export interface BillingEvent {
  kind: BillingEventKind;
  /** Provider event id — the idempotency key (`WebhookEvent.eventId`). */
  eventId: string;
  /** Razorpay subscription id — maps to a `Subscription` row via `providerSubId`. */
  providerSubId?: string;
  /** Paid-through instant (drives `expiresAt`). */
  currentPeriodEnd?: Date;
  /** Provider payment id for the charge/failure (Payment idempotency key). */
  providerPaymentId?: string;
  /** Charged amount in minor units (paise). */
  amount?: number;
  /** Opaque provider payload — for audit forensics only, ALWAYS redacted. */
  raw: unknown;
}

/** Result of creating a provider subscription — handed (in part) to the browser. */
export interface CreateSubscriptionResult {
  /** Store on `Subscription.providerSubId`. */
  providerSubId: string;
  providerPlanId: string;
  /**
   * Handed to the browser to launch checkout (§4). NEVER a secret — `keyId` is
   * the publishable Razorpay key id, not the key secret.
   */
  checkout: { keyId: string; subscriptionId: string; shortUrl?: string };
}

/** The provider-agnostic gateway seam. */
export interface PaymentProvider {
  createCustomer(input: {
    userId: string;
    email: string;
    name?: string;
  }): Promise<{ providerCustomerId: string }>;

  createSubscription(input: {
    providerCustomerId: string;
    segment: 'INTRADAY' | 'SWING';
  }): Promise<CreateSubscriptionResult>;

  cancelSubscription(input: {
    providerSubId: string;
    atCycleEnd: boolean;
  }): Promise<void>;

  /** Constant-time HMAC verify of the RAW request body against the webhook secret. */
  verifyWebhookSignature(rawBody: Buffer, signature: string): Promise<boolean>;

  /** Normalize a verified provider payload into a {@link BillingEvent}. */
  parseWebhookEvent(rawBody: Buffer): BillingEvent;
}

/**
 * Map a Razorpay(-shaped) webhook envelope into a {@link BillingEvent}. Shared
 * by `RazorpayProvider` and `FakePaymentProvider` (the fake emits the same
 * envelope shape so the whole path is exercised identically offline).
 *
 * The idempotency `eventId` is derived from the body only (the interface has no
 * headers): a payment id when present (unique per charge), else
 * `event:subId:created_at`. Redeliveries are byte-identical, so the id is
 * stable; distinct events differ by name / payment id / timestamp.
 */
export function normalizeRazorpayEnvelope(rawBody: Buffer): BillingEvent {
  const parsed = JSON.parse(rawBody.toString('utf8')) as {
    event?: string;
    created_at?: number;
    payload?: {
      subscription?: { entity?: { id?: string; current_end?: number } };
      payment?: { entity?: { id?: string; amount?: number } };
    };
  };

  const event = parsed.event ?? '';
  const subEntity = parsed.payload?.subscription?.entity;
  const providerSubId = subEntity?.id;
  const currentPeriodEnd =
    typeof subEntity?.current_end === 'number'
      ? new Date(subEntity.current_end * 1000)
      : undefined;

  const paymentEntity = parsed.payload?.payment?.entity;
  const paymentId = paymentEntity?.id;
  const eventId = paymentId
    ? `${event}:${paymentId}`
    : `${event}:${providerSubId ?? '-'}:${parsed.created_at ?? '-'}`;

  return {
    kind: mapEventKind(event),
    eventId,
    providerSubId,
    currentPeriodEnd,
    providerPaymentId: paymentId,
    amount: typeof paymentEntity?.amount === 'number' ? paymentEntity.amount : undefined,
    raw: parsed,
  };
}

/** Razorpay event name -> normalized {@link BillingEventKind}. */
export function mapEventKind(eventName: string): BillingEventKind {
  switch (eventName) {
    case 'subscription.activated':
    case 'subscription.authenticated':
      return 'SUBSCRIPTION_ACTIVATED';
    case 'subscription.charged':
      return 'PAYMENT_CHARGED';
    case 'subscription.pending':
      return 'PAYMENT_PENDING';
    case 'payment.failed':
      return 'PAYMENT_FAILED';
    case 'subscription.halted':
      return 'SUBSCRIPTION_HALTED';
    case 'subscription.cancelled':
      return 'SUBSCRIPTION_CANCELLED';
    case 'subscription.completed':
      return 'SUBSCRIPTION_COMPLETED';
    default:
      return 'UNHANDLED';
  }
}
