import { Injectable, Logger } from '@nestjs/common';
import { createHmac, timingSafeEqual } from 'crypto';
import { SecretsProvider } from '../../../common/secrets/secrets-provider.interface';
import {
  BillingEvent,
  CreateSubscriptionResult,
  PaymentProvider,
  normalizeRazorpayEnvelope,
} from './payment-provider.interface';

/** Razorpay secret / config names, all resolved via {@link SecretsProvider}. */
const SECRET = {
  keyId: 'RAZORPAY_KEY_ID',
  keySecret: 'RAZORPAY_KEY_SECRET',
  webhookSecret: 'RAZORPAY_WEBHOOK_SECRET',
  planIntraday: 'RAZORPAY_PLAN_INTRADAY',
  planSwing: 'RAZORPAY_PLAN_SWING',
} as const;

/**
 * The real {@link PaymentProvider} (default when `BILLING_PROVIDER=razorpay`).
 *
 * The `razorpay` Node SDK is a DYNAMIC import inside the create/cancel methods
 * (mirrors TDA-004's gated `@aws-sdk` adapters) so the offline test build never
 * needs the package — and the HMAC verify / event parse paths use only Node
 * `crypto`, never the SDK. Every key/secret resolves through the TDA-004 secrets
 * seam; none is ever logged.
 */
@Injectable()
export class RazorpayProvider implements PaymentProvider {
  private readonly logger = new Logger(RazorpayProvider.name);

  constructor(private readonly secrets: SecretsProvider) {}

  async createCustomer(input: {
    userId: string;
    email: string;
    name?: string;
  }): Promise<{ providerCustomerId: string }> {
    const rzp = await this.client();
    const customer = await rzp.customers.create({
      email: input.email,
      name: input.name,
      fail_existing: 0, // return the existing customer instead of erroring
      notes: { userId: input.userId },
    });
    return { providerCustomerId: customer.id };
  }

  async createSubscription(input: {
    providerCustomerId: string;
    segment: 'INTRADAY' | 'SWING';
  }): Promise<CreateSubscriptionResult> {
    const planId = await this.secrets.getRequiredSecret(
      input.segment === 'INTRADAY' ? SECRET.planIntraday : SECRET.planSwing,
    );
    const keyId = await this.secrets.getRequiredSecret(SECRET.keyId);
    const rzp = await this.client();

    const sub = await rzp.subscriptions.create({
      plan_id: planId,
      customer_id: input.providerCustomerId,
      total_count: 120, // 10 years of monthly cycles — effectively open-ended
      customer_notify: 1,
    });

    return {
      providerSubId: sub.id,
      providerPlanId: planId,
      // keyId (publishable) only — NEVER key_secret.
      checkout: { keyId, subscriptionId: sub.id, shortUrl: sub.short_url },
    };
  }

  async cancelSubscription(input: {
    providerSubId: string;
    atCycleEnd: boolean;
  }): Promise<void> {
    const rzp = await this.client();
    // cancel_at_cycle_end: 1 keeps access until period end (§4).
    await rzp.subscriptions.cancel(input.providerSubId, input.atCycleEnd);
  }

  async verifyWebhookSignature(
    rawBody: Buffer,
    signature: string,
  ): Promise<boolean> {
    const secret = await this.secrets.getSecret(SECRET.webhookSecret);
    if (!secret) {
      // Missing/unconfigured secret → reject ALL webhooks (like Chartink).
      this.logger.warn(
        `${SECRET.webhookSecret} is not configured — rejecting all webhooks`,
      );
      return false;
    }
    const expected = createHmac('sha256', secret).update(rawBody).digest('hex');
    return constantTimeEqualHex(expected, signature);
  }

  parseWebhookEvent(rawBody: Buffer): BillingEvent {
    return normalizeRazorpayEnvelope(rawBody);
  }

  /**
   * Lazily construct a Razorpay SDK client. The `razorpay` package is imported
   * DYNAMICALLY (never a static dep of the test build) and the key secret is
   * read from the secrets seam at call time only.
   */
  private async client(): Promise<RazorpayClient> {
    const [keyId, keySecret] = await Promise.all([
      this.secrets.getRequiredSecret(SECRET.keyId),
      this.secrets.getRequiredSecret(SECRET.keySecret),
    ]);
    const Razorpay = (await import('razorpay')).default;
    return new Razorpay({ key_id: keyId, key_secret: keySecret }) as RazorpayClient;
  }
}

/**
 * Minimal structural type for the bits of the `razorpay` SDK we call. Avoids a
 * compile-time dependency on `@types/razorpay` (the package is not installed);
 * the dynamic import keeps it out of the offline build entirely.
 */
interface RazorpayClient {
  customers: {
    create(input: {
      email: string;
      name?: string;
      fail_existing?: 0 | 1;
      notes?: Record<string, string>;
    }): Promise<{ id: string }>;
  };
  subscriptions: {
    create(input: {
      plan_id: string;
      customer_id: string;
      total_count: number;
      customer_notify?: 0 | 1;
    }): Promise<{ id: string; short_url?: string }>;
    cancel(subscriptionId: string, cancelAtCycleEnd: boolean): Promise<unknown>;
  };
}

/**
 * Constant-time compare of two hex strings (length-guarded; a length or hex
 * mismatch returns false without throwing). Mirrors the Chartink webhook's
 * `constantTimeEqual` discipline.
 */
function constantTimeEqualHex(a: string, b: string): boolean {
  const bufA = Buffer.from(a, 'hex');
  const bufB = Buffer.from(b, 'hex');
  if (bufA.length === 0 || bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}
