/**
 * TDA-015 Task 3 — RazorpayProvider (HMAC webhook verify + event parse).
 *
 * Only the crypto/parse paths are exercised here — no network, and the razorpay
 * SDK is never imported by verify/parse (it is a dynamic import used only by
 * createCustomer/createSubscription/cancelSubscription). Secrets resolve through
 * a stub SecretsProvider (the real one is TDA-004).
 *
 * Run from apps/api:
 *   npx jest --config test/tda015/jest.config.js razorpay-provider --runInBand --verbose
 */
import { createHmac } from 'crypto';
import { RazorpayProvider } from '../../src/modules/billing/providers/razorpay.provider';
import type { SecretsProvider } from '../../src/common/secrets/secrets-provider.interface';
import { MissingSecretError } from '../../src/common/secrets/secrets-provider.interface';

const WEBHOOK_SECRET = 'whsec_test_tda015_abc';

function stubSecrets(map: Record<string, string>): SecretsProvider {
  return {
    async getSecret(name: string) {
      return map[name];
    },
    async getRequiredSecret(name: string) {
      const v = map[name];
      if (v === undefined) throw new MissingSecretError(name);
      return v;
    },
  };
}

function chargedBody(subId: string, currentEndSec: number): Buffer {
  return Buffer.from(
    JSON.stringify({
      entity: 'event',
      event: 'subscription.charged',
      created_at: 1_700_000_000,
      payload: {
        subscription: { entity: { id: subId, current_end: currentEndSec } },
        payment: { entity: { id: 'pay_REAL42' } },
      },
    }),
  );
}

describe('TDA-015 RazorpayProvider', () => {
  const provider = new RazorpayProvider(
    stubSecrets({ RAZORPAY_WEBHOOK_SECRET: WEBHOOK_SECRET }),
  );

  describe('verifyWebhookSignature (HMAC-SHA256, constant-time)', () => {
    const body = chargedBody('sub_REAL', 1_700_500_000);
    const validSig = createHmac('sha256', WEBHOOK_SECRET).update(body).digest('hex');

    it('returns true for a signature computed with the webhook secret', async () => {
      await expect(provider.verifyWebhookSignature(body, validSig)).resolves.toBe(true);
    });

    it('returns false for a tampered signature', async () => {
      await expect(
        provider.verifyWebhookSignature(body, validSig.replace(/.$/, validSig.endsWith('0') ? '1' : '0')),
      ).resolves.toBe(false);
    });

    it('returns false when the raw body was tampered', async () => {
      const tampered = chargedBody('sub_REAL', 1_799_999_999);
      await expect(provider.verifyWebhookSignature(tampered, validSig)).resolves.toBe(false);
    });

    it('returns false on a malformed (non-hex) signature without throwing', async () => {
      await expect(provider.verifyWebhookSignature(body, 'zzzz')).resolves.toBe(false);
    });

    it('rejects (all webhooks) when the webhook secret is unconfigured', async () => {
      const noSecret = new RazorpayProvider(stubSecrets({}));
      await expect(noSecret.verifyWebhookSignature(body, validSig)).resolves.toBe(false);
    });
  });

  describe('parseWebhookEvent', () => {
    it('maps subscription.charged -> PAYMENT_CHARGED with sub id + current_end', () => {
      const body = chargedBody('sub_FROM_ENTITY', 1_700_600_000);
      const ev = provider.parseWebhookEvent(body);
      expect(ev.kind).toBe('PAYMENT_CHARGED');
      expect(ev.providerSubId).toBe('sub_FROM_ENTITY');
      expect(ev.currentPeriodEnd).toEqual(new Date(1_700_600_000 * 1000));
      expect(ev.eventId).toContain('pay_REAL42');
    });

    it('maps subscription.halted -> SUBSCRIPTION_HALTED', () => {
      const body = Buffer.from(
        JSON.stringify({
          event: 'subscription.halted',
          created_at: 1_700_000_002,
          payload: { subscription: { entity: { id: 'sub_H' } } },
        }),
      );
      const ev = provider.parseWebhookEvent(body);
      expect(ev.kind).toBe('SUBSCRIPTION_HALTED');
      expect(ev.providerSubId).toBe('sub_H');
    });
  });
});
