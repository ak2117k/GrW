import { computeOrderCharges } from './trade-charges';

describe('computeOrderCharges - Indian equity intraday', () => {
  it('a BUY order: stamp duty present, STT absent', () => {
    // turnover = 100 x 1000 = 100,000
    const c = computeOrderCharges({ side: 'BUY', price: 100, quantity: 1000, exchange: 'NSE' });
    expect(c.stt).toBe(0);
    expect(c.stampDuty).toBeCloseTo(3, 2);          // 0.003% of 100,000
    expect(c.brokerage).toBeCloseTo(20, 2);         // 0.03% = 30, capped at 20
    expect(c.exchangeTxn).toBeCloseTo(2.97, 2);     // 0.00297%
    expect(c.sebiFee).toBeCloseTo(0.1, 2);          // 10 per crore
    expect(c.gst).toBeCloseTo((20 + 2.97) * 0.18, 2);
    expect(c.total).toBeCloseTo(
      c.brokerage + c.stt + c.exchangeTxn + c.sebiFee + c.stampDuty + c.gst, 2,
    );
  });

  it('a SELL order: STT present, stamp duty absent', () => {
    const c = computeOrderCharges({ side: 'SELL', price: 100, quantity: 1000, exchange: 'NSE' });
    expect(c.stampDuty).toBe(0);
    expect(c.stt).toBeCloseTo(25, 2);               // 0.025% of 100,000
  });

  it('brokerage is 0.03% when below the 20-rupee cap', () => {
    // turnover 10,000 -> 0.03% = 3 < 20
    const c = computeOrderCharges({ side: 'BUY', price: 100, quantity: 100, exchange: 'NSE' });
    expect(c.brokerage).toBeCloseTo(3, 2);
  });

  it('BSE uses the higher exchange transaction rate', () => {
    const nse = computeOrderCharges({ side: 'BUY', price: 100, quantity: 1000, exchange: 'NSE' });
    const bse = computeOrderCharges({ side: 'BUY', price: 100, quantity: 1000, exchange: 'BSE' });
    expect(bse.exchangeTxn).toBeGreaterThan(nse.exchangeTxn);
  });

  it('total is the sum of all itemised charges', () => {
    const c = computeOrderCharges({ side: 'SELL', price: 250, quantity: 400, exchange: 'NSE' });
    expect(c.total).toBeCloseTo(
      c.brokerage + c.stt + c.exchangeTxn + c.sebiFee + c.stampDuty + c.gst, 2,
    );
  });
});
