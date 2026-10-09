import { describe, it, expect } from 'vitest';
import { computeSubscriptionDelta } from './useChartData';

const A = { token: '111', exchange: 'NSE', symbol: 'AAA' };
const B = { token: '222', exchange: 'NSE' };

describe('computeSubscriptionDelta', () => {
  it('computes refs to add and remove on symbol switch', () => {
    expect(computeSubscriptionDelta(A, B)).toEqual({ add: [B], remove: [A] });
    expect(computeSubscriptionDelta(null, B)).toEqual({ add: [B], remove: [] });
    expect(computeSubscriptionDelta(B, { ...B })).toEqual({ add: [], remove: [] });
  });

  it('the same token on another exchange is a switch, not a no-op', () => {
    const A_MCX = { token: '111', exchange: 'MCX' };
    expect(computeSubscriptionDelta(A, A_MCX)).toEqual({ add: [A_MCX], remove: [A] });
  });

  it('a change of case or symbol only is a no-op', () => {
    expect(computeSubscriptionDelta(A, { token: '111', exchange: 'nse', symbol: 'other' })).toEqual({ add: [], remove: [] });
  });

  it('removes the previous ref when switching to none, and is a no-op when both are null', () => {
    expect(computeSubscriptionDelta(A, null)).toEqual({ add: [], remove: [A] });
    expect(computeSubscriptionDelta(null, null)).toEqual({ add: [], remove: [] });
  });
});
