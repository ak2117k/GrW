import { resolvePriceFields } from './price-fields';

const entry = { token: '9309', entryPrice: 651.6, targetPct: 10 };

describe('resolvePriceFields', () => {
  it('uses the live LTP batch when present', () => {
    const r = resolvePriceFields(entry, new Map([['9309', 619.75]]), new Map());
    expect(r.currentPrice).toBe(619.75);
    expect(r.pnlPct).toBeCloseTo(((619.75 - 651.6) / 651.6) * 100, 6);
    expect(r.targetLeftPct).toBeCloseTo(10 - r.pnlPct!, 6);
    expect(r.priceStale).toBe(false);
  });

  it('falls back to the level-book seed when the batch misses the token', () => {
    // batch has nothing for 9309; seed (level book) does — must NOT show entryPrice
    const r = resolvePriceFields(entry, new Map(), new Map([['9309', 619.75]]));
    expect(r.currentPrice).toBe(619.75);
    expect(r.priceStale).toBe(false);
  });

  it('marks the row stale (all nulls) when neither batch nor seed has a price', () => {
    const r = resolvePriceFields(entry, new Map(), new Map());
    expect(r.currentPrice).toBeNull();
    expect(r.pnlPct).toBeNull();
    expect(r.targetLeftPct).toBeNull();
    expect(r.priceStale).toBe(true);
  });

  it('never silently substitutes entryPrice for a missing price', () => {
    const r = resolvePriceFields(entry, new Map(), new Map());
    expect(r.currentPrice).not.toBe(entry.entryPrice); // the old bug
  });

  it('treats a null token as stale', () => {
    const r = resolvePriceFields({ token: null, entryPrice: 100, targetPct: 5 }, new Map(), new Map());
    expect(r.priceStale).toBe(true);
    expect(r.currentPrice).toBeNull();
  });
});
