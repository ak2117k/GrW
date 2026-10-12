// apps/api/src/modules/sentinel-executor/domain/exit-order.spec.ts
import {
  aiExitOrderTag,
  findOrder,
  findOrderByTag,
  hasPriorAiExit,
  hasOpenOrderFor,
  isFlat,
  isMarketRefusal,
  isTerminalOrderStatus,
  istDayStartUtc,
  limitFallbackPrice,
  planExitOrder,
  tickRupees,
  type QtyPolicy,
} from './exit-order';

const row = (over: Record<string, unknown> = {}) => ({
  tradingsymbol: 'CRUDEOIL15OCT268950CE',
  symboltoken: '445566',
  exchange: 'MCX',
  producttype: 'CARRYFORWARD',
  netqty: '100',
  ltp: '50.25',
  ...over,
});
const target = { exchange: 'MCX', token: '445566', trackerQty: 100 };
/** Live, unit configured as units: the plan's original behaviour (quantity = |netqty|). */
const LIVE_UNITS: QtyPolicy = { mode: 'live', qtyUnit: 'units' };

describe('planExitOrder', () => {
  it('long → SELL the whole |netqty| at MARKET, identity from the broker row', () => {
    const p = planExitOrder([row()], target, LIVE_UNITS);
    expect(p).toEqual({
      ok: true,
      netQty: 100,
      ltp: 50.25,
      qtyUnit: 'units',
      unitVerified: true,
      order: {
        symbol: 'CRUDEOIL15OCT268950CE',
        token: '445566',
        exchange: 'MCX',
        side: 'SELL',
        orderType: 'MARKET',
        quantity: 100,
        positionType: 'CARRYFORWARD',
      },
    });
  });

  it('short → BUY to cover |netqty|', () => {
    const p = planExitOrder([row({ netqty: '-75', exchange: 'NFO', producttype: 'INTRADAY' })], {
      exchange: 'NFO', token: '445566', trackerQty: -75,
    }, LIVE_UNITS);
    expect(p.ok && [p.order.side, p.order.quantity, p.order.positionType]).toEqual(['BUY', 75, 'INTRADAY']);
  });

  it('netqty 0 or no row → ALREADY_FLAT', () => {
    expect(planExitOrder([row({ netqty: '0' })], target, LIVE_UNITS)).toEqual({ ok: false, reason: 'ALREADY_FLAT' });
    expect(planExitOrder([], target, LIVE_UNITS)).toEqual({ ok: false, reason: 'ALREADY_FLAT' });
  });

  it('a row on another exchange with the same token is not ours', () => {
    expect(planExitOrder([row({ exchange: 'NSE' })], target, LIVE_UNITS)).toEqual({ ok: false, reason: 'ALREADY_FLAT' });
  });

  it('two non-flat rows for one contract (intraday + carry) → AMBIGUOUS_POSITION_ROWS, never guess', () => {
    const p = planExitOrder([row(), row({ producttype: 'INTRADAY', netqty: '50' })], target, LIVE_UNITS);
    expect(p).toEqual({ ok: false, reason: 'AMBIGUOUS_POSITION_ROWS' });
  });

  it('broker side opposite to the tracker side → SIDE_MISMATCH (would reverse)', () => {
    expect(planExitOrder([row({ netqty: '-100' })], target, LIVE_UNITS)).toEqual({ ok: false, reason: 'SIDE_MISMATCH' });
  });

  it('unknown product → UNKNOWN_PRODUCT', () => {
    expect(planExitOrder([row({ producttype: 'BO' })], target, LIVE_UNITS)).toEqual({
      ok: false, reason: 'UNKNOWN_PRODUCT:BO',
    });
  });

  it('non-integer quantity → BAD_QTY', () => {
    expect(planExitOrder([row({ netqty: '1.5' })], target, LIVE_UNITS)).toEqual({ ok: false, reason: 'BAD_QTY' });
  });

  it('missing tradingsymbol → NO_SYMBOL', () => {
    expect(planExitOrder([row({ tradingsymbol: '' })], target, LIVE_UNITS)).toEqual({ ok: false, reason: 'NO_SYMBOL' });
  });
});

describe('planExitOrder — quantity unit (ruling R16, owner addition 2026-10-12)', () => {
  const mcx = { ...target, lotSize: 100 };
  const qty = (p: ReturnType<typeof planExitOrder>) => (p.ok ? p.order.quantity : p.reason);

  it('MCX 100 units, lot 100, unit=lots → 1 (lot)', () => {
    const p = planExitOrder([row()], mcx, { mode: 'live', qtyUnit: 'lots' });
    expect(qty(p)).toBe(1);
    expect(p.ok && [p.netQty, p.qtyUnit, p.unitVerified]).toEqual([100, 'lots', true]);
  });

  it('MCX 100 units, lot 100, unit=units → 100', () => {
    expect(qty(planExitOrder([row()], mcx, { mode: 'live', qtyUnit: 'units' }))).toBe(100);
  });

  it('MCX unit unconfigured → live refused, nothing planned', () => {
    expect(planExitOrder([row()], mcx, { mode: 'live', qtyUnit: undefined })).toEqual({
      ok: false, reason: 'QTY_UNIT_UNCONFIGURED:MCX',
    });
    expect(planExitOrder([row()], mcx, { mode: 'live', qtyUnit: null })).toEqual({
      ok: false, reason: 'QTY_UNIT_UNCONFIGURED:MCX',
    });
  });

  it('MCX unit unconfigured → dry-run still records the raw |netqty|, flagged unit-unverified', () => {
    const p = planExitOrder([row()], mcx, { mode: 'dry-run', qtyUnit: undefined });
    expect(p.ok && [p.order.quantity, p.qtyUnit, p.unitVerified]).toEqual([100, null, false]);
  });

  it('the short side converts the same way (BUY 2 lots for -200 units)', () => {
    const p = planExitOrder([row({ netqty: '-200' })], { ...mcx, trackerQty: -200 }, { mode: 'live', qtyUnit: 'lots' });
    expect(p.ok && [p.order.side, p.order.quantity]).toEqual(['BUY', 2]);
  });

  it('unit=lots needs a lot size: none known → NO_LOT_SIZE', () => {
    expect(planExitOrder([row()], target, { mode: 'live', qtyUnit: 'lots' })).toEqual({ ok: false, reason: 'NO_LOT_SIZE' });
    expect(planExitOrder([row()], { ...target, lotSize: 0 }, { mode: 'live', qtyUnit: 'lots' })).toEqual({
      ok: false, reason: 'NO_LOT_SIZE',
    });
    expect(planExitOrder([row()], { ...target, lotSize: 2.5 }, { mode: 'live', qtyUnit: 'lots' })).toEqual({
      ok: false, reason: 'NO_LOT_SIZE',
    });
  });

  it("falls back to the broker row's own lotsize when the caller has none", () => {
    expect(qty(planExitOrder([row({ lotsize: '100' })], target, { mode: 'live', qtyUnit: 'lots' }))).toBe(1);
  });

  it('unit=lots with a caller lot of 1 the broker row does not confirm → LOT_SIZE_UNCONFIRMED (1 is the repo-wide "missing" coercion)', () => {
    expect(planExitOrder([row()], { ...target, lotSize: 1 }, { mode: 'live', qtyUnit: 'lots' })).toEqual({
      ok: false, reason: 'LOT_SIZE_UNCONFIRMED',
    });
    // confirmed by the broker row → lots == units, no hazard
    expect(qty(planExitOrder([row({ lotsize: '1' })], { ...target, lotSize: 1 }, { mode: 'live', qtyUnit: 'lots' }))).toBe(100);
    // unit=units never divides, so a lot of 1 is harmless there
    expect(qty(planExitOrder([row()], { ...target, lotSize: 1 }, LIVE_UNITS))).toBe(100);
  });

  it('caller lot size and broker row lotsize disagree → LOT_SIZE_MISMATCH (never guess)', () => {
    expect(planExitOrder([row({ lotsize: '10' })], mcx, { mode: 'live', qtyUnit: 'lots' })).toEqual({
      ok: false, reason: 'LOT_SIZE_MISMATCH',
    });
    expect(planExitOrder([row({ lotsize: '10' })], mcx, LIVE_UNITS)).toEqual({ ok: false, reason: 'LOT_SIZE_MISMATCH' });
  });

  it('|netqty| not a whole number of lots → QTY_NOT_LOT_MULTIPLE (units or lots)', () => {
    expect(planExitOrder([row({ netqty: '150' })], { ...mcx, trackerQty: 150 }, { mode: 'live', qtyUnit: 'lots' })).toEqual({
      ok: false, reason: 'QTY_NOT_LOT_MULTIPLE',
    });
    // unit=units with netqty 1 and lot 100: netqty was probably reported in lots — refuse.
    expect(planExitOrder([row({ netqty: '1' })], { ...mcx, trackerQty: 1 }, LIVE_UNITS)).toEqual({
      ok: false, reason: 'QTY_NOT_LOT_MULTIPLE',
    });
  });

  it('unit=units without a known lot size still plans |netqty| (NFO/BFO default)', () => {
    expect(qty(planExitOrder([row({ exchange: 'NFO', netqty: '75' })], { exchange: 'NFO', token: '445566', trackerQty: 75 }, LIVE_UNITS))).toBe(75);
  });

  it('dry-run with a configured unit is verified and converts exactly like live', () => {
    const p = planExitOrder([row()], mcx, { mode: 'dry-run', qtyUnit: 'lots' });
    expect(p.ok && [p.order.quantity, p.unitVerified]).toEqual([1, true]);
  });

  it('position checks still come first: a flat MCX position with no unit is ALREADY_FLAT', () => {
    expect(planExitOrder([row({ netqty: '0' })], mcx, { mode: 'live', qtyUnit: undefined })).toEqual({
      ok: false, reason: 'ALREADY_FLAT',
    });
  });
});

describe('tickRupees (ruling R5)', () => {
  it('master paise → rupees', () => {
    expect(tickRupees(5, 'NFO')).toBe(0.05);
    expect(tickRupees(10, 'MCX')).toBe(0.1);
    expect(tickRupees(100, 'MCX')).toBe(1);
  });
  it('a sub-1 value is already rupees (column default)', () => {
    expect(tickRupees(0.05, 'NFO')).toBe(0.05);
  });
  it('missing → 0.05 for NFO/BFO, 1.00 for MCX', () => {
    expect(tickRupees(null, 'NFO')).toBe(0.05);
    expect(tickRupees(undefined, 'BFO')).toBe(0.05);
    expect(tickRupees(0, 'MCX')).toBe(1);
  });
});

describe('limitFallbackPrice', () => {
  it('SELL: LTP − pct, floored to the tick', () => {
    expect(limitFallbackPrice('SELL', 50.25, 2, 0.05)).toBe(49.2); // 49.245 → 49.20
  });
  it('BUY: LTP + pct, ceiled to the tick', () => {
    expect(limitFallbackPrice('BUY', 50.25, 2, 0.05)).toBe(51.3); // 51.255 → 51.30
  });
  it('MCX ₹1 tick', () => {
    expect(limitFallbackPrice('SELL', 6123.4, 2, 1)).toBe(6000);
  });
  it('no LTP or a non-positive SELL price → null', () => {
    expect(limitFallbackPrice('SELL', 0, 2, 0.05)).toBeNull();
    expect(limitFallbackPrice('SELL', 0.04, 2, 0.05)).toBeNull();
  });
  it('is free of float dust', () => {
    expect(String(limitFallbackPrice('SELL', 10.1, 2, 0.05))).toBe('9.85');
  });
  it('a price already on the tick is not pushed a tick away by float error', () => {
    // 50 * 0.98 = 49.000000000000004 ; 50 * 1.02 = 51
    expect(limitFallbackPrice('SELL', 50, 2, 0.05)).toBe(49);
    expect(limitFallbackPrice('BUY', 50, 2, 0.05)).toBe(51);
  });
});

describe('aiExitOrderTag (ruling R4)', () => {
  it('≤ 20 alphanumeric chars, leg-distinguished, deterministic', () => {
    const id = 'cm9x1abcde0001fghijklmnop';
    const m = aiExitOrderTag(id, 'M');
    const l = aiExitOrderTag(id, 'L');
    expect(m).toMatch(/^[A-Za-z0-9]{1,20}$/);
    expect(m).toBe('axMde0001fghijklmnop'); // 'ax' + leg + last 17 of the 25-char cuid
    expect(m).not.toBe(l);
    expect(aiExitOrderTag(id, 'M')).toBe(m);
  });
  it('strips non-alphanumerics', () => {
    expect(aiExitOrderTag('a-b_c', 'L')).toBe('axLabc');
  });
});

describe('isMarketRefusal (ruling R6)', () => {
  it.each([
    'Market orders are not allowed for this instrument',
    'MARKET order blocked in stock options, place a LIMIT order',
    'market price orders not permitted',
  ])('true for %s', (t) => expect(isMarketRefusal(t)).toBe(true));
  it.each([
    'Insufficient funds',
    'Order not allowed: RMS margin exceeds',
    '',
    null,
  ])('false for %s', (t) => expect(isMarketRefusal(t as string | null)).toBe(false));
});

describe('order book helpers', () => {
  const book = [
    { orderid: 'A1', status: 'rejected', text: 'Market orders are not allowed', symboltoken: '445566', exchange: 'MCX' },
    { orderid: 'A2', status: 'open', text: '', symboltoken: '999', exchange: 'NFO' },
    { orderid: 'A3', status: 'complete', text: '', symboltoken: '445566', exchange: 'MCX' },
  ];
  it('findOrder', () => {
    expect(findOrder(book, 'A1')).toEqual({ status: 'rejected', text: 'Market orders are not allowed' });
    expect(findOrder(book, 'ZZ')).toBeNull();
  });
  it('terminal statuses', () => {
    expect(['complete', 'rejected', 'cancelled'].every(isTerminalOrderStatus)).toBe(true);
    expect(['open', 'trigger pending', 'validation pending', ''].some(isTerminalOrderStatus)).toBe(false);
  });
  it('hasOpenOrderFor: any non-terminal order on exchange+token (unknown status counts as open)', () => {
    expect(hasOpenOrderFor(book, 'MCX', '445566')).toBe(false);
    expect(hasOpenOrderFor(book, 'NFO', '999')).toBe(true);
    expect(hasOpenOrderFor([{ orderid: 'X', status: 'weird', symboltoken: '1', exchange: 'NFO' }], 'NFO', '1')).toBe(true);
  });
  it('isFlat', () => {
    expect(isFlat([row({ netqty: '0' })], 'MCX', '445566')).toBe(true);
    expect(isFlat([row()], 'MCX', '445566')).toBe(false);
    expect(isFlat([], 'MCX', '445566')).toBe(true);
  });
});

describe('istDayStartUtc', () => {
  it('23:59 IST and 00:01 IST next day fall on different days', () => {
    // 2026-10-12 23:59 IST = 18:29Z; 2026-10-13 00:01 IST = 18:31Z
    expect(istDayStartUtc(new Date('2026-10-12T18:29:00Z')).toISOString()).toBe('2026-10-11T18:30:00.000Z');
    expect(istDayStartUtc(new Date('2026-10-12T18:31:00Z')).toISOString()).toBe('2026-10-12T18:30:00.000Z');
  });
});

describe('findOrderByTag (review fix 1)', () => {
  it('finds our order by ordertag; a live row wins over a dead one; absent → null', () => {
    const book = [
      { orderid: 'A', ordertag: 'axMx', status: 'rejected', text: 'r' },
      { orderid: 'B', ordertag: 'axMx', status: 'open', text: '' },
      { orderid: 'C', ordertag: 'other', status: 'open' },
    ];
    expect(findOrderByTag(book, 'axMx')).toEqual({ orderId: 'B', status: 'open', text: '' });
    expect(findOrderByTag([book[0]], 'axMx')).toEqual({ orderId: 'A', status: 'rejected', text: 'r' });
    expect(findOrderByTag(book, 'axLx')).toBeNull();
  });
});

describe('hasPriorAiExit (review fix 2: PRIOR_AI_EXIT_TODAY)', () => {
  const o = (x: Record<string, unknown>) => ({ symboltoken: '445566', exchange: 'MCX', ...x });
  it.each([
    ['complete axM on the contract', [o({ ordertag: 'axMabc', status: 'complete' })], true],
    ['open axL on the contract', [o({ ordertag: 'axLabc', status: 'open' })], true],
    ['unknown status counts', [o({ ordertag: 'axMabc' })], true],
    ['rejected ax order', [o({ ordertag: 'axMabc', status: 'rejected' })], false],
    ['cancelled ax order', [o({ ordertag: 'axMabc', status: 'cancelled' })], false],
    ['untagged order', [o({ status: 'complete' })], false],
    ['auto-execution sha256 tag', [o({ ordertag: 'a3f9', status: 'complete' })], false],
    ['ax order on another token', [o({ symboltoken: '1', ordertag: 'axMabc', status: 'complete' })], false],
    ['ax order on another exchange', [o({ exchange: 'NFO', ordertag: 'axMabc', status: 'complete' })], false],
  ])('%s → %s', (_n, rows, want) => {
    expect(hasPriorAiExit(rows, 'mcx', '445566')).toBe(want);
  });
});
