import { describe, expect, it } from 'vitest';
import {
  buildCancelRequest,
  buildCheckoutRequest,
  describeSegmentBilling,
  isInGrace,
  normalizeBillingResponse,
  type BillingSegmentState,
} from './useBilling';

const NOW = Date.UTC(2026, 6, 3, 12, 0, 0); // 2026-07-03T12:00:00Z
const FUTURE = new Date(NOW + 5 * 24 * 3600_000).toISOString();
const PAST = new Date(NOW - 5 * 24 * 3600_000).toISOString();

function state(partial: Partial<BillingSegmentState>): BillingSegmentState {
  return {
    segment: 'INTRADAY',
    status: 'NONE',
    expiresAt: null,
    graceUntil: null,
    ...partial,
  };
}

describe('buildCheckoutRequest / buildCancelRequest', () => {
  it('posts { segment } to the checkout endpoint', () => {
    expect(buildCheckoutRequest('INTRADAY')).toEqual({
      url: '/me/billing/checkout',
      body: { segment: 'INTRADAY' },
    });
    expect(buildCheckoutRequest('SWING').body).toEqual({ segment: 'SWING' });
  });

  it('posts { segment } to the cancel endpoint', () => {
    expect(buildCancelRequest('SWING')).toEqual({
      url: '/me/billing/cancel',
      body: { segment: 'SWING' },
    });
  });
});

describe('isInGrace', () => {
  it('is true only for an ACTIVE row with a future graceUntil', () => {
    expect(isInGrace(state({ status: 'ACTIVE', graceUntil: FUTURE }), NOW)).toBe(true);
  });
  it('is false when the grace window has elapsed', () => {
    expect(isInGrace(state({ status: 'ACTIVE', graceUntil: PAST }), NOW)).toBe(false);
  });
  it('is false when there is no graceUntil', () => {
    expect(isInGrace(state({ status: 'ACTIVE', graceUntil: null }), NOW)).toBe(false);
  });
  it('is false when the row is not ACTIVE even with a future graceUntil', () => {
    expect(isInGrace(state({ status: 'CANCELLED', graceUntil: FUTURE }), NOW)).toBe(false);
  });
});

describe('describeSegmentBilling', () => {
  it('maps a clean ACTIVE row to a success "Active" badge with cancel enabled', () => {
    const v = describeSegmentBilling(state({ status: 'ACTIVE', expiresAt: FUTURE }), NOW);
    expect(v.label).toBe('Active');
    expect(v.tone).toBe('success');
    expect(v.canCancel).toBe(true);
    expect(v.canSubscribe).toBe(false);
    expect(v.showGraceBanner).toBe(false);
    expect(v.renewalAt).toBe(FUTURE);
  });

  it('maps an ACTIVE row in dunning grace to a warning banner', () => {
    const v = describeSegmentBilling(
      state({ status: 'ACTIVE', expiresAt: FUTURE, graceUntil: FUTURE }),
      NOW,
    );
    expect(v.label).toBe('Payment failed');
    expect(v.tone).toBe('warning');
    expect(v.showGraceBanner).toBe(true);
    expect(v.canCancel).toBe(true);
  });

  it('maps PAST_DUE (checkout pending authorization) to "Awaiting payment", no access', () => {
    const v = describeSegmentBilling(state({ status: 'PAST_DUE' }), NOW);
    expect(v.label).toBe('Awaiting payment');
    expect(v.tone).toBe('warning');
    expect(v.canSubscribe).toBe(false);
  });

  it('maps EXPIRED to a danger badge that can re-subscribe', () => {
    const v = describeSegmentBilling(state({ status: 'EXPIRED' }), NOW);
    expect(v.label).toBe('Expired');
    expect(v.tone).toBe('danger');
    expect(v.canSubscribe).toBe(true);
    expect(v.canCancel).toBe(false);
  });

  it('maps NONE to a neutral "Not subscribed" that can subscribe', () => {
    const v = describeSegmentBilling(state({ status: 'NONE' }), NOW);
    expect(v.label).toBe('Not subscribed');
    expect(v.canSubscribe).toBe(true);
    expect(v.canCancel).toBe(false);
  });
});

describe('normalizeBillingResponse', () => {
  it('reads a keyed-object shape', () => {
    const out = normalizeBillingResponse({
      segments: {
        INTRADAY: { status: 'ACTIVE', expiresAt: FUTURE, graceUntil: null },
        SWING: { status: 'EXPIRED' },
      },
    });
    expect(out.INTRADAY.status).toBe('ACTIVE');
    expect(out.INTRADAY.expiresAt).toBe(FUTURE);
    expect(out.SWING.status).toBe('EXPIRED');
  });

  it('reads an array-of-segments shape', () => {
    const out = normalizeBillingResponse([
      { segment: 'INTRADAY', status: 'PAST_DUE' },
      { segment: 'SWING', status: 'ACTIVE', expiresAt: FUTURE },
    ]);
    expect(out.INTRADAY.status).toBe('PAST_DUE');
    expect(out.SWING.status).toBe('ACTIVE');
  });

  it('reads a top-level keyed object without a segments wrapper', () => {
    const out = normalizeBillingResponse({ INTRADAY: { status: 'active' } });
    expect(out.INTRADAY.status).toBe('ACTIVE'); // case-normalized
    expect(out.SWING.status).toBe('NONE');
  });

  it('degrades unknown / malformed input to NONE, never throws', () => {
    expect(normalizeBillingResponse(null).INTRADAY.status).toBe('NONE');
    expect(normalizeBillingResponse('nope').SWING.status).toBe('NONE');
    expect(
      normalizeBillingResponse({ segments: { INTRADAY: { status: 'WAT' } } }).INTRADAY.status,
    ).toBe('NONE');
  });
});
