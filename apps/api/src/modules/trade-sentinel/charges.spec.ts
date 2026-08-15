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

  /**
   * GOLDEN VALUES — the only assertions in this file that would survive a
   * transposed rate digit.
   *
   * Every other test here is RELATIONAL: bigger than, sub-linear in, differs
   * from. Swap 0.001 for 0.0001 in `sttSell` and all of them still pass, because
   * every relation they check is preserved under a uniform scaling of one rate.
   * A charge model whose only tests are relational is a charge model with no
   * tests — and the green floor, the arming decision and `money.netPnl` in the
   * agent's packet are all solved from these numbers.
   *
   * Each expected total is hand-computed component by component below, so a
   * failure says WHICH rate moved rather than "the number changed". They are not
   * snapshots: do not update one to match new output without re-deriving it.
   */
  describe('golden totals', () => {
    it('bills a Rs 1,00,000 x 2 delivery round trip at Rs 288.24', () => {
      // Entry and exit at 1000 x 100 shares: Rs 1,00,000 of turnover per leg.
      //   brokerage  min(20, 100000 x 0.1%) x 2 legs          =  40
      //   STT        100000 x 0.1% on BOTH legs (delivery)    = 200
      //   exchange   200000 x 0.00297%                        =   5.94
      //   stamp      100000 x 0.015%, buy leg only            =  15
      //   SEBI       200000 x 0.0001%                         =   0.20
      //   DP         flat, one sell of one scrip              =  15.93
      //   GST        18% of (brokerage + exchange + SEBI + DP) =  11.1726
      //                                                        --------
      //                                                         288.2426
      const total = estimateCharges({
        segment: 'EQ_DELIVERY', entryPrice: 1000, exitPrice: 1000, qty: 100, side: 'LONG',
      });
      expect(total).toBeCloseTo(288.2426, 4);
    });

    it('bills a 75-lot option round trip (100 -> 120) at Rs 63.26', () => {
      //   brokerage  flat Rs 20 x 2 legs (options never % )   =  40
      //   STT        sell leg 9000 x 0.1%                     =   9
      //   exchange   16500 x 0.03503%                         =   5.77995
      //   stamp      buy leg 7500 x 0.003%                    =   0.225
      //   SEBI       16500 x 0.0001%                          =   0.0165
      //   GST        18% of (40 + 5.77995 + 0.0165)           =   8.24336
      //                                                        --------
      //                                                          63.2648
      const total = estimateCharges({
        segment: 'OPT', entryPrice: 100, exitPrice: 120, qty: 75, side: 'LONG',
      });
      expect(total).toBeCloseTo(63.2648, 4);
    });

    it('bills the mirrored SHORT of that option round trip at Rs 61.81', () => {
      // Same two prices, legs swapped: the SHORT sells 7500 at entry and buys
      // 9000 at exit, so STT falls on 7500 and stamp duty on 9000. A golden on
      // one side only would pass with the legs derived from entry/exit instead
      // of from `side` — which is the exact bug the header warns about.
      //   STT  7500 x 0.1% = 7.5   (vs 9 for the long)
      //   stamp 9000 x 0.003% = 0.27 (vs 0.225)
      const total = estimateCharges({
        segment: 'OPT', entryPrice: 100, exitPrice: 120, qty: 75, side: 'SHORT',
      });
      expect(total).toBeCloseTo(61.8098, 4);
    });

    it('charges delivery brokerage at 0.1%, not the 0.25% intraday slab', () => {
      // The percentage arm only BINDS below ~Rs 8,000 of leg turnover; above it
      // the flat Rs 20 is lower and the rate is unobservable. So the test has to
      // sit under the cap or it proves nothing: Rs 5,000 per leg.
      //   brokerage  min(20, 5000 x 0.1%) x 2                 =  10   (0.25% -> 25)
      //   STT        5000 x 0.1% x 2 legs                     =  10
      //   exchange   10000 x 0.00297%                         =   0.297
      //   stamp      5000 x 0.015%                            =   0.75
      //   SEBI       10000 x 0.0001%                          =   0.01
      //   DP                                                  =  15.93
      //   GST        18% of (10 + 0.297 + 0.01 + 15.93)       =   4.72266
      //                                                        --------
      //                                                          41.70966
      const total = estimateCharges({
        segment: 'EQ_DELIVERY', entryPrice: 50, exitPrice: 50, qty: 100, side: 'LONG',
      });
      expect(total).toBeCloseTo(41.70966, 5);
      // Under the old single 0.25% rate this was 59.41. Wrong in the
      // conservative direction — it moves the floor UP — but still wrong.
      expect(total).not.toBeCloseTo(59.41, 2);
    });

    it('keeps the 0.25% slab for intraday and futures', () => {
      // Same Rs 5,000 legs, where the rate is observable: 0.25% of 5000 is
      // 12.50 per leg, so brokerage is 25 rather than 10.
      const intraday = estimateCharges({
        segment: 'EQ_INTRADAY', entryPrice: 50, exitPrice: 50, qty: 100, side: 'LONG',
      });
      const fut = estimateCharges({
        segment: 'FUT', entryPrice: 50, exitPrice: 50, qty: 100, side: 'LONG',
      });
      expect(intraday).toBeCloseTo(31.26226, 5);
      // FUT differs from EQ_INTRADAY only in STT/exchange/stamp, never in the
      // brokerage slab — so both carry the same Rs 25.
      expect(fut).toBeGreaterThan(25);
    });
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

  it('returns null rather than a NEGATIVE price when the margin is unreachable', () => {
    // A short option at Rs 2 on 75 lots: charges alone are ~Rs 47 and the margin
    // is Rs 150, so netting the margin needs the premium to fall Rs 2.63 — past
    // zero. The solver is right; -0.64 is simply not a price. It used to be
    // reported as one, and `clampFloorTowardLtp` cannot repair it (the gap is
    // Rs 1.64, eighty times the two-paise rounding tolerance), so the packet
    // carried `greenFloorPrice: -0.64` with `greenFloorArmed: false` — and the
    // prompt tells the model to read an unarmed floor as A TARGET.
    const floor = computeGreenFloor({
      segment: 'OPT', entryPrice: 2, ltp: 2, qty: 75, side: 'SHORT',
    });
    expect(floor.armed).toBe(false);
    expect(floor.floorPrice).toBeNull();
    // The rest of the block still reports honestly — only the impossible PRICE
    // is withheld, so the agent still sees what the trade actually costs.
    expect(floor.charges).toBeCloseTo(47.4789, 4);
    expect(floor.netPnl).toBeCloseTo(-47.4789, 4);
  });

  it('still reports a floor at exactly zero as no floor at all', () => {
    // The boundary: zero is not a tradeable price either, and the prompt reads
    // null as "no floor could be solved, not a floor at zero".
    const floor = computeGreenFloor({
      segment: 'OPT', entryPrice: 2, ltp: 1, qty: 75, side: 'SHORT',
    });
    expect(floor.floorPrice).toBeNull();
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
