import { chargesForLeg, estimateCharges, type ChargeBreakdown, type Segment } from '../../trade-sentinel/charges';

const parts = (b: ChargeBreakdown) => b.brokerage + b.stt + b.exchangeTxn + b.stamp + b.sebi + b.dp + b.gst;

describe('chargesForLeg (M3: charges per fill)', () => {
  it('an intraday buy leg pays stamp duty and no STT', () => {
    const b = chargesForLeg({ segment: 'EQ_INTRADAY', leg: 'BUY', price: 100, qty: 100 });
    expect(b.brokerage).toBe(20);
    expect(b.stt).toBe(0);
    expect(b.stamp).toBeCloseTo(0.3, 10);
    expect(b.exchangeTxn).toBeCloseTo(0.297, 10);
    expect(b.sebi).toBeCloseTo(0.01, 10);
    expect(b.dp).toBe(0);
    expect(b.gst).toBeCloseTo((20 + 0.297 + 0.01) * 0.18, 10);
    expect(b.total).toBeCloseTo(parts(b), 10);
  });

  it('an intraday sell leg pays STT and no stamp duty', () => {
    const s = chargesForLeg({ segment: 'EQ_INTRADAY', leg: 'SELL', price: 100, qty: 100 });
    expect(s.stt).toBeCloseTo(2.5, 10);
    expect(s.stamp).toBe(0);
    expect(s.total).toBeCloseTo(parts(s), 10);
  });

  it('delivery pays STT on both legs and the DP charge only on the sell leg', () => {
    const buy = chargesForLeg({ segment: 'EQ_DELIVERY', leg: 'BUY', price: 500, qty: 10 });
    const sell = chargesForLeg({ segment: 'EQ_DELIVERY', leg: 'SELL', price: 500, qty: 10 });
    expect(buy.stt).toBeCloseTo(5, 10);
    expect(sell.stt).toBeCloseTo(5, 10);
    expect(buy.brokerage).toBeCloseTo(5, 10);
    expect(buy.dp).toBe(0);
    expect(sell.dp).toBeCloseTo(15.93, 10);
  });

  it('options pay the flat ₹20 brokerage per leg even on a tiny premium', () => {
    expect(chargesForLeg({ segment: 'OPT', leg: 'BUY', price: 0.05, qty: 75 }).brokerage).toBe(20);
    expect(chargesForLeg({ segment: 'OPT', leg: 'SELL', price: 0.05, qty: 75 }).brokerage).toBe(20);
  });

  it('the two legs of a round trip add up to estimateCharges', () => {
    const cases: Array<[Segment, number, number, number]> = [
      ['EQ_INTRADAY', 500.7, 505, 100],
      ['EQ_DELIVERY', 1000.5, 1010, 10],
      ['OPT', 100, 110, 150],
      ['FUT', 24000, 23900, 75],
    ];
    for (const [segment, entry, exit, qty] of cases) {
      const legs = chargesForLeg({ segment, leg: 'BUY', price: entry, qty }).total + chargesForLeg({ segment, leg: 'SELL', price: exit, qty }).total;
      expect(legs).toBeCloseTo(estimateCharges({ segment, entryPrice: entry, exitPrice: exit, qty, side: 'LONG' }), 6);
    }
  });

  it('never returns a negative part', () => {
    for (const segment of ['EQ_DELIVERY', 'EQ_INTRADAY', 'FUT', 'OPT'] as Segment[]) {
      for (const leg of ['BUY', 'SELL'] as const) {
        const b = chargesForLeg({ segment, leg, price: 1, qty: 1 });
        expect(Object.values(b).every((v) => v >= 0)).toBe(true);
      }
    }
  });
});
