import { realizedIntradayPnlPct } from './intraday-pnl';

describe('realizedIntradayPnlPct', () => {
  it('(a) returns plain final % when no partial leg', () => {
    const pct = realizedIntradayPnlPct({ entryPrice: 100, exitPrice: 105 });
    expect(pct).toBeCloseTo(5, 6);
  });

  it('(b) blends 50% partial booked at +3% with final exit at 0% → +1.5%', () => {
    const pct = realizedIntradayPnlPct({
      entryPrice: 100,
      exitPrice: 100, // final at 0%
      partialExitPrice: 103, // partial at +3%
      partialFraction: 0.5,
    });
    expect(pct).toBeCloseTo(1.5, 6);
  });

  it('(c) blends 50% partial at +3% with final at -2% (runner) → +0.5%', () => {
    const pct = realizedIntradayPnlPct({
      entryPrice: 100,
      exitPrice: 98, // final at -2%
      partialExitPrice: 103, // partial at +3%
      partialFraction: 0.5,
    });
    expect(pct).toBeCloseTo(0.5, 6);
  });

  it('(d) returns null when exitPrice is null', () => {
    expect(
      realizedIntradayPnlPct({ entryPrice: 100, exitPrice: null, partialExitPrice: 103, partialFraction: 0.5 }),
    ).toBeNull();
  });

  it('returns null when entryPrice is not positive', () => {
    expect(realizedIntradayPnlPct({ entryPrice: 0, exitPrice: 105 })).toBeNull();
  });

  it('ignores partial leg when partialFraction is 0', () => {
    const pct = realizedIntradayPnlPct({
      entryPrice: 100,
      exitPrice: 105,
      partialExitPrice: 103,
      partialFraction: 0,
    });
    expect(pct).toBeCloseTo(5, 6);
  });
});
