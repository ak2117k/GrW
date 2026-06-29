import { describe, it, expect } from 'vitest';
import { summarizeOpenBook } from './swingOpenBook';
import type { AnandEntry } from '../services/anand';

function entry(o: Partial<AnandEntry>): AnandEntry {
  return {
    id: 's', symbol: 'X', token: '1', entryPrice: 100, enteredAt: '2026-06-04T08:00:00.000Z',
    targetPct: 10, stopPct: 10, status: 'TRADED', exitPrice: null, exitedAt: null,
    currentPrice: 100, pnlPct: 0, targetLeftPct: 10, scannerName: null, scoreBreakdown: null,
    ...o,
  };
}

const NOTIONAL = 200_000;

describe('summarizeOpenBook', () => {
  it('empty list yields all zeros', () => {
    expect(summarizeOpenBook([], NOTIONAL)).toEqual({
      openCount: 0, invested: 0, currentValue: 0, unrealizedRs: 0,
    });
  });

  it('invested = floor(notional/entry) × entry — the ACTUAL deployed amount, not the full notional', () => {
    // entry 300, notional 200000 → qty floor(666.67)=666 → invested 666×300 = 199,800 (₹200 left as cash)
    const r = summarizeOpenBook([entry({ entryPrice: 300, currentPrice: 300 })], NOTIONAL);
    expect(r.invested).toBe(199_800);
    expect(r.invested).toBeLessThan(NOTIONAL);
    expect(r.currentValue).toBe(199_800);
    expect(r.unrealizedRs).toBe(0);
  });

  it('current value marks open positions at the live price; unrealized = value − invested', () => {
    // entry 100 → qty 2000, invested 200000; live 110 → value 220000 → +20000
    const r = summarizeOpenBook([entry({ entryPrice: 100, currentPrice: 110 })], NOTIONAL);
    expect(r.invested).toBe(200_000);
    expect(r.currentValue).toBe(220_000);
    expect(r.unrealizedRs).toBe(20_000);
  });

  it('sums actual invested + value across positions and counts every open position', () => {
    const win = entry({ entryPrice: 100, currentPrice: 110 });   // qty 2000, inv 200000, val 220000
    const loss = entry({ entryPrice: 200, currentPrice: 190 });  // qty 1000, inv 200000, val 190000
    const r = summarizeOpenBook([win, loss], NOTIONAL);
    expect(r.openCount).toBe(2);
    expect(r.invested).toBe(400_000);
    expect(r.currentValue).toBe(410_000);
    expect(r.unrealizedRs).toBe(10_000);
  });

  it('holds a stale position (no live price) at cost — counted in invested, contributes 0 unrealized', () => {
    const live = entry({ entryPrice: 100, currentPrice: 110 });                       // +20000
    const stale = entry({ entryPrice: 100, currentPrice: null, priceStale: true });   // qty 2000, held at cost
    const r = summarizeOpenBook([live, stale], NOTIONAL);
    expect(r.openCount).toBe(2);
    expect(r.invested).toBe(400_000);
    expect(r.currentValue).toBe(420_000); // 220000 (live) + 200000 (stale at cost)
    expect(r.unrealizedRs).toBe(20_000);  // stale adds nothing
  });

  it('is independent of entry dates — positions from different days all contribute', () => {
    const yesterday = entry({ enteredAt: '2026-06-04T07:40:00.000Z', entryPrice: 100, currentPrice: 110 });
    const today = entry({ enteredAt: '2026-06-05T09:20:00.000Z', entryPrice: 100, currentPrice: 105 });
    const r = summarizeOpenBook([yesterday, today], NOTIONAL);
    expect(r.openCount).toBe(2);
    expect(r.invested).toBe(400_000);
    expect(r.unrealizedRs).toBe(30_000); // +20000 + 10000
  });
});
