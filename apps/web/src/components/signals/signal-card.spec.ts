import { describe, it, expect } from 'vitest';
import { signalPnl } from './signal-card';
import type { AnandEntry } from '@/services/anand';

const base = (over: Partial<AnandEntry>): AnandEntry =>
  ({ id: '1', symbol: 'X', token: '1', entryPrice: 100, targetPct: 5, status: 'TRADED', enteredAt: new Date().toISOString(), ...over } as AnandEntry);

describe('signalPnl', () => {
  it('computes rupee P&L from pnlPct against notional', () => {
    const r = signalPnl(base({ pnlPct: 5, currentPrice: 105, exitPrice: null }), 200_000);
    expect(r.pnlPct).toBe(5);
    expect(r.pnlRs).toBe(10_000);
    expect(r.priceShown).toBe(105);
    expect(r.stale).toBe(false);
  });
  it('returns null P&L and stale when an open row has no live price', () => {
    const r = signalPnl(base({ pnlPct: null, currentPrice: null, exitPrice: null, priceStale: true }), 200_000);
    expect(r.pnlRs).toBeNull();
    expect(r.stale).toBe(true);
  });
  it('uses exitPrice for a closed row', () => {
    const r = signalPnl(base({ pnlPct: -5, exitPrice: 95 }), 200_000);
    expect(r.priceShown).toBe(95);
    expect(r.pnlRs).toBe(-10_000);
  });
});
