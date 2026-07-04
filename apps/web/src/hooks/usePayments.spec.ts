import { describe, it, expect } from 'vitest';
import { groupByMonth, type PaymentRow } from './usePayments';

const row = (over: Partial<PaymentRow>): PaymentRow =>
  ({ id: '1', segment: 'INTRADAY', amount: 49900, currency: 'INR', status: 'CAPTURED', providerPaymentId: 'p', invoiceUrl: null, description: null, createdAt: '2026-06-15T10:00:00.000Z', ...over });

describe('groupByMonth', () => {
  it('groups rows by calendar month, newest month first', () => {
    const groups = groupByMonth([
      row({ id: 'a', createdAt: '2026-06-15T10:00:00.000Z' }),
      row({ id: 'b', createdAt: '2026-07-01T10:00:00.000Z' }),
      row({ id: 'c', createdAt: '2026-06-02T10:00:00.000Z' }),
    ]);
    expect(groups[0].rows.map((r) => r.id)).toEqual(['b']);
    expect(groups[1].rows.map((r) => r.id).sort()).toEqual(['a', 'c']);
  });
  it('returns [] for no rows', () => {
    expect(groupByMonth([])).toEqual([]);
  });
});
