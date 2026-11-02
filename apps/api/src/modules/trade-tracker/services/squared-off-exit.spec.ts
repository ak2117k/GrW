import { roundTripExitPrice, squaredOffExitPrices } from './trade-tracker.service';

/** Prod 2026-11-02 RELIANCE23NOV261300CE: bought 500 @ 6.9, AI sold @ 7.15; the tracker showed its last tick 8.15. */
describe('squared-off exit price (broker fill, not the last tick)', () => {
  const row = (o: Record<string, unknown>) => ({ symboltoken: '125997', netqty: '0', sellavgprice: '7.15', sellqty: '500', buyavgprice: '6.90', buyqty: '500', ...o });

  it('reads only netqty-0 legs, by token', () => {
    const m = squaredOffExitPrices([row({}), row({ symboltoken: '999', netqty: '500' })]);
    expect([...m.keys()]).toEqual(['125997']);
    expect(m.get('125997')).toEqual({ sell: 7.15, sellQty: 500, buy: 6.9, buyQty: 500 });
  });

  it('a single round trip exits at the day sell average (7.15), a short at the buy average', () => {
    const leg = squaredOffExitPrices([row({})]).get('125997');
    expect(roundTripExitPrice(leg, 500, [])).toBe(7.15);
    expect(roundTripExitPrice(leg, -500, [])).toBe(6.9);
  });

  it('a second same-day round trip takes the earlier one out of the average', () => {
    // 500 sold @ 7.15 earlier, 500 now: day sell avg 9.15 over 1000 → this trip 11.15.
    const leg = squaredOffExitPrices([row({ sellavgprice: '9.15', sellqty: '1000', buyqty: '1000' })]).get('125997');
    expect(roundTripExitPrice(leg, 500, [{ qty: 500, exitPrice: 7.15 }])).toBe(11.15);
  });

  it('cannot read it cleanly → 0 (the caller falls back to the last tick)', () => {
    const leg = squaredOffExitPrices([row({ sellqty: '700' })]).get('125997');
    expect(roundTripExitPrice(leg, 500, [])).toBe(0);
    expect(roundTripExitPrice(undefined, 500, [])).toBe(0);
    expect(roundTripExitPrice(squaredOffExitPrices([row({ sellavgprice: '0' })]).get('125997'), 500, [])).toBe(0);
  });
});
