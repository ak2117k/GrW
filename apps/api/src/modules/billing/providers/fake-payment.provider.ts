import { Injectable } from '@nestjs/common';
import { createHmac, randomBytes, timingSafeEqual } from 'crypto';
import {
  BillingEvent,
  CreateSubscriptionResult,
  PaymentProvider,
  normalizeRazorpayEnvelope,
} from './payment-provider.interface';

/**
 * The fixed webhook secret the fake HMAC-signs with. Exported so tests can forge
 * a VALID signature (`HMAC_SHA256(rawBody, FAKE_WEBHOOK_SECRET)`) to drive the
 * whole webhook path offline. This is a TEST secret only — the real Razorpay
 * secret is never in code (it resolves via `SecretsProvider`).
 */
export const FAKE_WEBHOOK_SECRET = 'fake-webhook-secret';

/** The publishable (non-secret) key id the fake hands to the browser. */
const FAKE_KEY_ID = 'rzp_test_fake0000000000';

/**
 * Deterministic, in-memory {@link PaymentProvider} (default when
 * `BILLING_PROVIDER=fake`). Zero network, zero Razorpay account — it lets the
 * ENTIRE webhook -> gating -> audit path be exercised in CI. `createSubscription`
 * mints synthetic ids; `verifyWebhookSignature` checks a fixed-secret HMAC
 * (constant-time); `parseWebhookEvent` reads the same Razorpay-shaped envelope
 * the real provider does.
 */
@Injectable()
export class FakePaymentProvider implements PaymentProvider {
  async createCustomer(input: {
    userId: string;
    email: string;
    name?: string;
  }): Promise<{ providerCustomerId: string }> {
    return { providerCustomerId: `cust_fake_${input.userId}` };
  }

  async createSubscription(input: {
    providerCustomerId: string;
    segment: 'INTRADAY' | 'SWING';
  }): Promise<CreateSubscriptionResult> {
    const providerSubId = `sub_fake_${randomBytes(8).toString('hex')}`;
    const providerPlanId = `plan_fake_${input.segment.toLowerCase()}`;
    return {
      providerSubId,
      providerPlanId,
      // keyId only — NEVER a secret.
      checkout: { keyId: FAKE_KEY_ID, subscriptionId: providerSubId },
    };
  }

  async cancelSubscription(_input: {
    providerSubId: string;
    atCycleEnd: boolean;
  }): Promise<void> {
    // No-op: the fake has no remote state. The webhook (subscription.cancelled)
    // is what revokes access in tests.
  }

  async verifyWebhookSignature(
    rawBody: Buffer,
    signature: string,
  ): Promise<boolean> {
    const expected = createHmac('sha256', FAKE_WEBHOOK_SECRET)
      .update(rawBody)
      .digest('hex');
    return constantTimeEqualHex(expected, signature);
  }

  parseWebhookEvent(rawBody: Buffer): BillingEvent {
    return normalizeRazorpayEnvelope(rawBody);
  }
}

/**
 * Constant-time compare of two hex strings. Length-guarded (a length mismatch —
 * including a non-hex / malformed input — returns false without throwing),
 * mirroring `ChartinkWebhookController.constantTimeEqual`.
 */
function constantTimeEqualHex(a: string, b: string): boolean {
  const bufA = Buffer.from(a, 'hex');
  const bufB = Buffer.from(b, 'hex');
  if (bufA.length === 0 || bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}
