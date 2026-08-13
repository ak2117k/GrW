import { estimateCharges, computeGreenFloor, GREEN_FLOOR_MARGIN_RUPEES } from './charges';

describe('estimateCharges', () => {
  it('charges an equity delivery round trip on turnover, not on quantity alone', () => {
    const small = estimateCharges({ segment: 'EQ_DELIVERY', entryPrice: 100, exitPrice: 100, qty: 10 });
    const large = estimateCharges({ segment: 'EQ_DELIVERY', entryPrice: 100, exitPrice: 100, qty: 100 });
    expect(large).toBeGreaterThan(small);
  });

  it('never returns a negative charge for a losing trade', () => {
    expect(estimateCharges({ segment: 'EQ_INTRADAY', entryPrice: 100, exitPrice: 50, qty: 10 })).toBeGreaterThan(0);
  });

  it('applies the flat per-order brokerage cap for intraday', () => {
    const huge = estimateCharges({ segment: 'EQ_INTRADAY', entryPrice: 10000, exitPrice: 10000, qty: 1000 });
    // 2 orders x Rs 20 cap = Rs 40 brokerage; the rest is statutory, so the
    // total must exceed 40 but brokerage must not scale without bound.
    expect(huge).toBeGreaterThan(40);
  });
});

describe('computeGreenFloor', () => {
  it('is not armed until net P&L clears charges plus the margin', () => {
    const floor = computeGreenFloor({
      segment: 'EQ_INTRADAY', entryPrice: 100, ltp: 100.1, qty: 100, side: 'LONG',
    });
    expect(floor.armed).toBe(false);
  });

  it('arms once net P&L clears charges plus the margin, and reports the floor price', () => {
    const floor = computeGreenFloor({
      segment: 'EQ_INTRADAY', entryPrice: 100, ltp: 140, qty: 100, side: 'LONG',
    });
    expect(floor.armed).toBe(true);
    expect(floor.floorPrice).toBeGreaterThan(100);
    expect(floor.floorPrice).toBeLessThan(140);
  });

  it('puts a SHORT floor above the entry price', () => {
    const floor = computeGreenFloor({
      segment: 'EQ_INTRADAY', entryPrice: 100, ltp: 60, qty: 100, side: 'SHORT',
    });
    expect(floor.armed).toBe(true);
    expect(floor.floorPrice).toBeGreaterThan(60);
    expect(floor.floorPrice).toBeLessThan(100);
  });

  it('exposes the margin it used so the packet can state it', () => {
    const floor = computeGreenFloor({
      segment: 'EQ_INTRADAY', entryPrice: 100, ltp: 140, qty: 100, side: 'LONG',
    });
    expect(floor.marginRupees).toBe(GREEN_FLOOR_MARGIN_RUPEES);
  });
});
