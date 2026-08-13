import {
  estimateCharges,
  computeGreenFloor,
  GREEN_FLOOR_MARGIN_RUPEES,
  Segment,
  Side,
} from './charges';

describe('estimateCharges', () => {
  it('charges an equity delivery round trip on turnover, not on quantity alone', () => {
    const small = estimateCharges({ segment: 'EQ_DELIVERY', entryPrice: 100, exitPrice: 100, qty: 10, side: 'LONG' });
    const large = estimateCharges({ segment: 'EQ_DELIVERY', entryPrice: 100, exitPrice: 100, qty: 100, side: 'LONG' });
    expect(large).toBeGreaterThan(small);
  });

  it('never returns a negative charge for a losing trade', () => {
    expect(
      estimateCharges({ segment: 'EQ_INTRADAY', entryPrice: 100, exitPrice: 50, qty: 10, side: 'LONG' }),
    ).toBeGreaterThan(0);
  });

  it('caps brokerage per order, so total charges grow sub-linearly in quantity', () => {
    // Every statutory component scales linearly with quantity; a capped
    // brokerage does not. Doubling qty therefore leaves exactly one round trip's
    // worth of capped brokerage (2 orders x Rs 20, plus GST) unaccounted for.
    const q1 = estimateCharges({ segment: 'EQ_INTRADAY', entryPrice: 10000, exitPrice: 10000, qty: 1000, side: 'LONG' });
    const q2 = estimateCharges({ segment: 'EQ_INTRADAY', entryPrice: 10000, exitPrice: 10000, qty: 2000, side: 'LONG' });
    expect(q2 - 2 * q1).toBeCloseTo(-(2 * 20 * 1.18), 2);
  });

  it('bills a SHORT differently from a LONG, because the sell leg is the entry', () => {
    // Mirrored round trips: the LONG buys at 200 and sells at 50, the SHORT
    // sells at 200 and buys at 50. Sell-side STT dominates options charges, so
    // charging the short's STT on the exit price understates it badly.
    const long = estimateCharges({ segment: 'OPT', entryPrice: 200, exitPrice: 50, qty: 750, side: 'LONG' });
    const short = estimateCharges({ segment: 'OPT', entryPrice: 200, exitPrice: 50, qty: 750, side: 'SHORT' });
    expect(short).not.toBeCloseTo(long, 2);
    // Two components swap legs. STT (sell side, 0.1%): the short sells Rs 150,000
    // of premium at entry, the long sells only Rs 37,500 at exit. Stamp duty
    // (buy side, 0.003%) swaps the other way. Nothing else is leg-dependent here,
    // because option brokerage is flat per order.
    const sttDelta = 150000 * 0.001 - 37500 * 0.001;
    const stampDelta = 37500 * 0.00003 - 150000 * 0.00003;
    expect(sttDelta).toBeCloseTo(112.5, 6);
    expect(short - long).toBeCloseTo(sttDelta + stampDelta, 2);
  });

  it('adds a flat DP charge to delivery sells that does not scale with quantity', () => {
    const dpBearing = estimateCharges({ segment: 'EQ_DELIVERY', entryPrice: 100, exitPrice: 100, qty: 1, side: 'LONG' });
    const noDp = estimateCharges({ segment: 'EQ_INTRADAY', entryPrice: 100, exitPrice: 100, qty: 1, side: 'LONG' });
    expect(dpBearing - noDp).toBeGreaterThan(15);
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

  it('puts a SHORT floor below the entry price', () => {
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

  it('subtracts charges from net P&L rather than reporting gross', () => {
    const floor = computeGreenFloor({
      segment: 'EQ_INTRADAY', entryPrice: 100, ltp: 101.6, qty: 100, side: 'LONG',
    });
    const gross = (101.6 - 100) * 100;
    expect(gross).toBeCloseTo(160, 6);
    expect(floor.charges).toBeGreaterThan(0);
    expect(floor.netPnl).toBeCloseTo(gross - floor.charges, 6);
    // Gross clears the margin but net does not — armed is false ONLY because
    // charges were subtracted. Drop the subtraction and this flips to true.
    expect(floor.netPnl).toBeLessThan(GREEN_FLOOR_MARGIN_RUPEES);
    expect(floor.armed).toBe(false);
  });

  it('prices the floor above breakeven by the charges incurred there, not just the margin', () => {
    const floor = computeGreenFloor({
      segment: 'EQ_INTRADAY', entryPrice: 100, ltp: 140, qty: 100, side: 'LONG',
    });
    // Margin alone would put the floor at 101.50. Charges must push it higher.
    expect(floor.floorPrice).toBeGreaterThan(100 + GREEN_FLOOR_MARGIN_RUPEES / 100);
  });

  it('returns a null floor price for a zero-quantity position', () => {
    const floor = computeGreenFloor({
      segment: 'EQ_INTRADAY', entryPrice: 100, ltp: 140, qty: 0, side: 'LONG',
    });
    expect(floor.floorPrice).toBeNull();
    expect(floor.armed).toBe(false);
  });

  describe('the floor price actually nets the margin when exited there', () => {
    const cases: Array<{ segment: Segment; side: Side; entryPrice: number; ltp: number; qty: number }> = [
      { segment: 'EQ_DELIVERY', side: 'LONG', entryPrice: 100, ltp: 140, qty: 100 },
      { segment: 'EQ_DELIVERY', side: 'SHORT', entryPrice: 100, ltp: 60, qty: 100 },
      { segment: 'EQ_INTRADAY', side: 'LONG', entryPrice: 100, ltp: 140, qty: 100 },
      { segment: 'EQ_INTRADAY', side: 'SHORT', entryPrice: 100, ltp: 60, qty: 100 },
      { segment: 'FUT', side: 'LONG', entryPrice: 20000, ltp: 20500, qty: 50 },
      { segment: 'FUT', side: 'SHORT', entryPrice: 20000, ltp: 19500, qty: 50 },
      { segment: 'OPT', side: 'LONG', entryPrice: 50, ltp: 200, qty: 750 },
      // The case that a single-pass floor gets wrong: it returns a price that
      // locks in a LOSS of about Rs 8.69 instead of a Rs 150 gain.
      { segment: 'OPT', side: 'SHORT', entryPrice: 200, ltp: 50, qty: 750 },
    ];

    it.each(cases)('$segment $side nets at least the margin at its floor', ({ segment, side, entryPrice, ltp, qty }) => {
      const floor = computeGreenFloor({ segment, entryPrice, ltp, qty, side });
      expect(floor.armed).toBe(true);
      expect(floor.floorPrice).not.toBeNull();

      const exitAtFloor = floor.floorPrice as number;
      const dir = side === 'LONG' ? 1 : -1;
      const grossAtFloor = (exitAtFloor - entryPrice) * qty * dir;
      const chargesAtFloor = estimateCharges({ segment, entryPrice, exitPrice: exitAtFloor, qty, side });
      const netAtFloor = grossAtFloor - chargesAtFloor;

      expect(netAtFloor).toBeGreaterThanOrEqual(GREEN_FLOOR_MARGIN_RUPEES);
    });
  });
});
