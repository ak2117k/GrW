import { normalizeRazorpayEnvelope } from '../../src/modules/billing/providers/payment-provider.interface';

function charged(paymentId: string, amount: number): Buffer {
  return Buffer.from(
    JSON.stringify({
      event: 'subscription.charged',
      created_at: 1_700_000_100,
      payload: {
        subscription: { entity: { id: 'sub_1', current_end: 1_700_003_600 } },
        payment: { entity: { id: paymentId, amount } },
      },
    }),
  );
}

describe('normalizeRazorpayEnvelope — payment fields', () => {
  it('surfaces providerPaymentId and amount (paise) from the payment entity', () => {
    const ev = normalizeRazorpayEnvelope(charged('pay_abc', 49900));
    expect(ev.kind).toBe('PAYMENT_CHARGED');
    expect(ev.providerPaymentId).toBe('pay_abc');
    expect(ev.amount).toBe(49900);
  });

  it('leaves payment fields undefined when there is no payment entity', () => {
    const ev = normalizeRazorpayEnvelope(
      Buffer.from(JSON.stringify({ event: 'subscription.activated', payload: { subscription: { entity: { id: 'sub_1' } } } })),
    );
    expect(ev.providerPaymentId).toBeUndefined();
    expect(ev.amount).toBeUndefined();
  });
});
