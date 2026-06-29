import { computeAtrFromCandles } from './per-tf-atr';

const mk = (h: number, l: number, c: number) => ({ high: h, low: l, close: c });

describe('computeAtrFromCandles', () => {
  it('returns 0 when fewer than period+1 candles', () => {
    expect(computeAtrFromCandles([mk(10, 9, 9.5)], 14)).toBe(0);
  });
  it('computes a positive ATR for a real series and tracks range size', () => {
    const tight = Array.from({ length: 30 }, (_, i) => mk(100 + i * 0.1, 99.9 + i * 0.1, 100 + i * 0.1));
    const wide = Array.from({ length: 30 }, (_, i) => mk(100 + i, 98 + i, 99 + i));
    const atrTight = computeAtrFromCandles(tight, 14);
    const atrWide = computeAtrFromCandles(wide, 14);
    expect(atrTight).toBeGreaterThan(0);
    expect(atrWide).toBeGreaterThan(atrTight); // wider ranges → larger ATR
  });
});
