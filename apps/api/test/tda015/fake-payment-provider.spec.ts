/**
 * TDA-015 Task 1 — PaymentProvider seam + FakePaymentProvider.
 *
 * The FakePaymentProvider is the deterministic, in-memory, no-network default
 * (BILLING_PROVIDER=fake) that lets the ENTIRE webhook -> gating -> audit path
 * be tested with zero Razorpay account. It must:
 *   - createSubscription -> a synthetic providerSubId + a NON-secret checkout
 *     payload (keyId + subscriptionId, never a key_secret);
 *   - verifyWebhookSignature -> accept a canned HMAC over the raw body, reject a
 *     tampered signature / tampered body (constant-time);
 *   - parseWebhookEvent -> normalize a Razorpay-shaped envelope into a
 *     BillingEvent, mapping subscription.charged -> PAYMENT_CHARGED and an
 *     unknown event -> UNHANDLED.
 *
 * Pure unit test — no DB, no network.
 *
 * Run from apps/api:
 *   npx jest --config test/tda015/jest.config.js fake-payment --runInBand --verbose
 */
import { createHmac } from 'crypto';
import {
  FakePaymentProvider,
  FAKE_WEBHOOK_SECRET,
} from '../../src/modules/billing/providers/fake-payment.provider';
import type { BillingEvent } from '../../src/modules/billing/providers/payment-provider.interface';

function sign(rawBody: Buffer, secret = FAKE_WEBHOOK_SECRET): string {
  return createHmac('sha256', secret).update(rawBody).digest('hex');
}

function chargedEnvelope(subId: string, currentEndSec: number): Buffer {
  return Buffer.from(
    JSON.stringify({
      entity: 'event',
      event: 'subscription.charged',
      created_at: 1_700_000_000,
      payload: {
        subscription: { entity: { id: subId, current_end: currentEndSec } },
        payment: { entity: { id: 'pay_FAKE123' } },
      },
    }),
  );
}

describe('TDA-015 Task 1 — FakePaymentProvider', () => {
  const provider = new FakePaymentProvider();

  describe('createCustomer / createSubscription', () => {
    it('returns a synthetic customer id', async () => {
      const res = await provider.createCustomer({
        userId: 'usr_1',
        email: 'a@b.local',
      });
      expect(typeof res.providerCustomerId).toBe('string');
      expect(res.providerCustomerId.length).toBeGreaterThan(0);
    });

    it('returns a providerSubId + a NON-secret checkout payload', async () => {
      const res = await provider.createSubscription({
        providerCustomerId: 'cust_1',
        segment: 'INTRADAY',
      });
      expect(res.providerSubId).toMatch(/^sub_/);
      expect(res.providerPlanId).toMatch(/^plan_/);
      expect(res.checkout.subscriptionId).toBe(res.providerSubId);
      expect(typeof res.checkout.keyId).toBe('string');
      // The checkout payload must NEVER carry a secret.
      const serialized = JSON.stringify(res.checkout);
      expect(serialized).not.toMatch(/secret/i);
    });
  });

  describe('verifyWebhookSignature (constant-time HMAC)', () => {
    const body = chargedEnvelope('sub_ABC', 1_700_100_000);

    it('accepts a valid canned HMAC signature', async () => {
      await expect(
        provider.verifyWebhookSignature(body, sign(body)),
      ).resolves.toBe(true);
    });

    it('rejects a tampered signature', async () => {
      await expect(
        provider.verifyWebhookSignature(body, sign(body).replace(/.$/, '0')),
      ).resolves.toBe(false);
    });

    it('rejects when the raw body was tampered (signature no longer matches)', async () => {
      const goodSig = sign(body);
      const tamperedBody = chargedEnvelope('sub_ABC', 1_700_999_999);
      await expect(
        provider.verifyWebhookSignature(tamperedBody, goodSig),
      ).resolves.toBe(false);
    });

    it('rejects a garbage signature without throwing', async () => {
      await expect(
        provider.verifyWebhookSignature(body, 'not-hex'),
      ).resolves.toBe(false);
    });
  });

  describe('parseWebhookEvent', () => {
    it('maps subscription.charged -> PAYMENT_CHARGED with providerSubId + currentPeriodEnd', () => {
      const body = chargedEnvelope('sub_XYZ', 1_700_200_000);
      const ev: BillingEvent = provider.parseWebhookEvent(body);
      expect(ev.kind).toBe('PAYMENT_CHARGED');
      expect(ev.providerSubId).toBe('sub_XYZ');
      expect(ev.currentPeriodEnd).toEqual(new Date(1_700_200_000 * 1000));
      expect(typeof ev.eventId).toBe('string');
      expect(ev.eventId.length).toBeGreaterThan(0);
    });

    it('gives redelivered (byte-identical) bodies the SAME eventId', () => {
      const body = chargedEnvelope('sub_XYZ', 1_700_200_000);
      const a = provider.parseWebhookEvent(body);
      const b = provider.parseWebhookEvent(Buffer.from(body));
      expect(a.eventId).toBe(b.eventId);
    });

    it('maps an unknown event -> UNHANDLED', () => {
      const body = Buffer.from(
        JSON.stringify({ event: 'payout.processed', payload: {} }),
      );
      const ev = provider.parseWebhookEvent(body);
      expect(ev.kind).toBe('UNHANDLED');
    });

    it('maps each known Razorpay event name to its BillingEventKind', () => {
      const cases: Array<[string, BillingEvent['kind']]> = [
        ['subscription.activated', 'SUBSCRIPTION_ACTIVATED'],
        ['subscription.authenticated', 'SUBSCRIPTION_ACTIVATED'],
        ['subscription.charged', 'PAYMENT_CHARGED'],
        ['subscription.pending', 'PAYMENT_PENDING'],
        ['payment.failed', 'PAYMENT_FAILED'],
        ['subscription.halted', 'SUBSCRIPTION_HALTED'],
        ['subscription.cancelled', 'SUBSCRIPTION_CANCELLED'],
        ['subscription.completed', 'SUBSCRIPTION_COMPLETED'],
      ];
      for (const [name, kind] of cases) {
        const body = Buffer.from(
          JSON.stringify({
            event: name,
            created_at: 1_700_000_001,
            payload: { subscription: { entity: { id: 'sub_1', current_end: 1_700_300_000 } } },
          }),
        );
        expect(provider.parseWebhookEvent(body).kind).toBe(kind);
      }
    });
  });
});
