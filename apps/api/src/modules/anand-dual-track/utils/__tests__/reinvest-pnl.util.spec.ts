import { computeLotLivePnl, sumOpenLotsUnrealizedPnl } from '../reinvest-pnl.util';

describe('reinvest-pnl util', () => {
  describe('computeLotLivePnl', () => {
    it('marks a +10% lot to ₹2,000 on ₹20k capital', () => {
      const r = computeLotLivePnl({ entryPrice: 100, capital: 20_000 }, 110);
      expect(r.currentPrice).toBe(110);
      expect(r.pnlPct).toBeCloseTo(10);
      expect(r.pnlRs).toBeCloseTo(2_000);
    });

    it('marks a loss negative', () => {
      const r = computeLotLivePnl({ entryPrice: 200, capital: 20_000 }, 190);
      expect(r.pnlPct).toBeCloseTo(-5);
      expect(r.pnlRs).toBeCloseTo(-1_000);
    });
  });

  describe('sumOpenLotsUnrealizedPnl', () => {
    it('sums live P&L across OPEN lots only (closed lots excluded)', () => {
      const lots = [
        // PANAMAPET-like: +0.75% on 20k → +150
        { entryPrice: 474.95, capital: 20_000, status: 'OPEN', currentPrice: 478.5 },
        // INOXINDIA-like: +2.28% on 20k → +456
        { entryPrice: 1869, capital: 20_000, status: 'OPEN', currentPrice: 1911.6 },
        // A closed winner must NOT inflate the *unrealized* total.
        { entryPrice: 100, capital: 20_000, status: 'TARGET_HIT', currentPrice: 110 },
      ];
      // 149.49 (PANAMAPET) + 455.86 (INOXINDIA) = 605.35; closed lot ignored.
      expect(sumOpenLotsUnrealizedPnl(lots)).toBeCloseTo(605.35, 1);
    });

    it('is 0 when there are no open lots', () => {
      expect(sumOpenLotsUnrealizedPnl([])).toBe(0);
      expect(
        sumOpenLotsUnrealizedPnl([
          { entryPrice: 100, capital: 20_000, status: 'STOPPED', currentPrice: 90 },
        ]),
      ).toBe(0);
    });
  });
});
