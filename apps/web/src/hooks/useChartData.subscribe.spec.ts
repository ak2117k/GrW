import { describe, it, expect } from 'vitest';
import { computeSubscriptionDelta } from './useChartData';

describe('computeSubscriptionDelta', () => {
  it('computes tokens to add and remove on symbol switch', () => {
    expect(computeSubscriptionDelta('111', '222')).toEqual({ add: ['222'], remove: ['111'] });
    expect(computeSubscriptionDelta(null, '222')).toEqual({ add: ['222'], remove: [] });
    expect(computeSubscriptionDelta('222', '222')).toEqual({ add: [], remove: [] });
  });

  it('removes the previous token when switching to none', () => {
    expect(computeSubscriptionDelta('111', null)).toEqual({ add: [], remove: ['111'] });
  });

  it('is a no-op when both are null', () => {
    expect(computeSubscriptionDelta(null, null)).toEqual({ add: [], remove: [] });
  });
});
