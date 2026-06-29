import { describe, it, expect } from 'vitest';
import { computeStripState } from './ComparisonStrip';

describe('computeStripState', () => {
  const base = {
    date: 'd',
    gated: { tradeCount: 16, gross: 0, charges: 0, net: 1234 },
    ungated: { tradeCount: 42, gross: 0, charges: 0, net: -5678, rejected: {} },
    edge: { netDiff: 1234 - (-5678), verdict: 'gate added value: +₹6912 vs ungated' },
  };

  it('returns "hidden" when ungated.tradeCount = 0', () => {
    const s = computeStripState({ ...base, ungated: { ...base.ungated, tradeCount: 0 } });
    expect(s.hidden).toBe(true);
  });

  it('emerald tone when gated.net > ungated.net by >= ₹100', () => {
    expect(computeStripState(base).tone).toBe('emerald');
  });

  it('red tone when ungated.net > gated.net by >= ₹100', () => {
    const flipped = { ...base, gated: { ...base.gated, net: -5678 }, ungated: { ...base.ungated, net: 1234 } };
    expect(computeStripState(flipped).tone).toBe('red');
  });

  it('grey tone when within ±₹100', () => {
    const tight = { ...base, gated: { ...base.gated, net: 100 }, ungated: { ...base.ungated, net: 50 } };
    expect(computeStripState(tight).tone).toBe('grey');
  });
});
