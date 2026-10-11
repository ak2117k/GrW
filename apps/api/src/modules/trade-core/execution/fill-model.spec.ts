import { Prisma } from '@prisma/client';
import type { PriceDepth } from '../../market-hub/hub.types';
import {
  decideFill,
  isWholeLots,
  maxLotsProblem,
  noPriceDeadline,
  priceProblem,
  priceShapeProblem,
  requestProblems,
  validateOrder,
  type FillableOrder,
  type FillDecision,
  type FillPrice,
  type OrderCheckContext,
} from './fill-model';
import { cashBuy, depth, mtfBuy, NOW, optionBuy, paperSettings } from './testing/paper-fixtures';

const D = (s: string) => new Prisma.Decimal(s);
const SUB = NOW.getTime();
const AT = SUB + 20;
const BPS5 = D('5');
const BPS0 = D('0');

const order = (over: Partial<FillableOrder> = {}): FillableOrder => ({
  side: 'BUY',
  type: 'MARKET',
  qty: 100,
  filledQty: 0,
  instrument: { lotSize: 1 },
  limitPrice: null,
  triggerPrice: null,
  submittedAt: NOW,
  ...over,
});
const px = (ltp: number, book?: PriceDepth, at = SUB + 10): FillPrice => ({ ltp, at, ...(book ? { depth: book } : {}) });
const shown = (d: FillDecision) => (d.kind === 'FILL' ? { qty: d.qty, price: d.price.toFixed(4), via: d.via } : d.kind);

describe('freshness (spec §4.3)', () => {
  it('a price stamped exactly at submission is not after it', () => {
    const at = decideFill(order(), px(500, undefined, SUB), AT, BPS5);
    expect(at).toEqual({ kind: 'NONE', reason: 'the price is not after the order was submitted' });
    expect(shown(decideFill(order(), px(500, undefined, SUB + 1), AT, BPS5))).toEqual({ qty: 100, price: '500.2500', via: 'SLIPPAGE' });
  });

  it('a price older than 15 s is stale; exactly 15 s is still fresh', () => {
    expect(priceProblem({ ltp: 500, at: SUB + 1 }, SUB, SUB + 1 + 15_000)).toBeNull();
    expect(priceProblem({ ltp: 500, at: SUB + 1 }, SUB, SUB + 1 + 15_001)).toBe('the price is 15001 ms old');
  });

  it('a non-positive price is never used', () => {
    expect(priceProblem({ ltp: 0, at: SUB + 1 }, SUB, SUB + 2)).toBe('the price is not positive');
  });

  it('the no-price deadline runs from submission, or from a later reload', () => {
    expect(noPriceDeadline(SUB, SUB, 30_000)).toBe(SUB + 30_000);
    expect(noPriceDeadline(SUB, SUB + 5_000, 30_000)).toBe(SUB + 35_000);
  });
});

describe('market orders', () => {
  it('a BUY walks the asks level by level', () => {
    expect(shown(decideFill(order(), px(500, depth([[500.5, 60], [501, 100]])), AT, BPS5))).toEqual({ qty: 100, price: '500.7000', via: 'DEPTH' });
  });

  it('a thin book fills part and leaves the rest open', () => {
    expect(shown(decideFill(order(), px(500, depth([[500, 40]])), AT, BPS5))).toEqual({ qty: 40, price: '500.0000', via: 'DEPTH' });
  });

  it('a SELL walks the bids best first, whatever order they arrive in', () => {
    const d = decideFill(order({ side: 'SELL', qty: 50 }), px(100, depth([], [[99, 30], [100, 30]])), AT, BPS5);
    expect(shown(d)).toEqual({ qty: 50, price: '99.6000', via: 'DEPTH' });
  });

  it('skips zero-quantity and non-positive levels', () => {
    const d = decideFill(order(), px(500, depth([[500, 0], [0, 50], [-1, 10], [501, 100]])), AT, BPS5);
    expect(shown(d)).toEqual({ qty: 100, price: '501.0000', via: 'DEPTH' });
  });

  it('a one-sided book waits instead of inventing a price', () => {
    expect(decideFill(order(), px(500, depth([], [[499, 500]])), AT, BPS5)).toEqual({ kind: 'NONE', reason: 'the book has no asks' });
    expect(decideFill(order({ side: 'SELL' }), px(500, depth([[501, 500]])), AT, BPS5)).toEqual({ kind: 'NONE', reason: 'the book has no bids' });
  });

  it('an empty book, or none, falls back to LTP ± slippage', () => {
    expect(shown(decideFill(order(), px(1000, depth([], [])), AT, BPS5))).toEqual({ qty: 100, price: '1000.5000', via: 'SLIPPAGE' });
    expect(shown(decideFill(order(), px(1000), AT, BPS5))).toEqual({ qty: 100, price: '1000.5000', via: 'SLIPPAGE' });
    expect(shown(decideFill(order({ side: 'SELL' }), px(1000), AT, BPS5))).toEqual({ qty: 100, price: '999.5000', via: 'SLIPPAGE' });
  });

  it('slippage rounds against the trader to the paisa', () => {
    expect(shown(decideFill(order(), px(100.03), AT, BPS5))).toEqual({ qty: 100, price: '100.0900', via: 'SLIPPAGE' });
    expect(shown(decideFill(order({ side: 'SELL' }), px(100.03), AT, BPS5))).toEqual({ qty: 100, price: '99.9700', via: 'SLIPPAGE' });
  });

  it('a volume-weighted price rounds against the trader at 4 dp', () => {
    expect(shown(decideFill(order({ qty: 3 }), px(100, depth([[100.05, 1], [100.1, 2]])), AT, BPS5))).toEqual({ qty: 3, price: '100.0834', via: 'DEPTH' });
    expect(shown(decideFill(order({ side: 'SELL', qty: 3 }), px(100, depth([], [[100.05, 1], [100.1, 2]])), AT, BPS5))).toEqual({ qty: 3, price: '100.0833', via: 'DEPTH' });
  });

  it('fills whole lots only', () => {
    const opt = order({ qty: 150, instrument: { lotSize: 75 } });
    expect(shown(decideFill(opt, px(100, depth([[100, 100]])), AT, BPS5))).toEqual({ qty: 75, price: '100.0000', via: 'DEPTH' });
    expect(decideFill(opt, px(100, depth([[100, 50]])), AT, BPS5)).toEqual({ kind: 'NONE', reason: 'the book holds less than one lot (50 < 75)' });
  });

  it('an order with nothing left does not fill', () => {
    expect(decideFill(order({ filledQty: 100 }), px(500), AT, BPS5)).toEqual({ kind: 'NONE', reason: 'nothing left to fill' });
  });
});

describe('limit orders (E3: strict trade-through, filled at the limit)', () => {
  const buy = order({ type: 'LIMIT', limitPrice: 100, qty: 150, instrument: { lotSize: 75 } });

  it('a BUY limit fills only below the limit', () => {
    expect(decideFill(buy, px(100), AT, BPS5)).toEqual({ kind: 'NONE', reason: 'the price 100 has not traded through the limit 100' });
    expect(shown(decideFill(buy, px(99.95), AT, BPS5))).toEqual({ qty: 150, price: '100.0000', via: 'LIMIT' });
  });

  it('a SELL limit fills only above the limit', () => {
    const sell = order({ side: 'SELL', type: 'LIMIT', limitPrice: 110, qty: 150, instrument: { lotSize: 75 } });
    expect(decideFill(sell, px(110), AT, BPS5).kind).toBe('NONE');
    expect(shown(decideFill(sell, px(110.05), AT, BPS5))).toEqual({ qty: 150, price: '110.0000', via: 'LIMIT' });
  });
});

describe('stop-loss market orders', () => {
  const sellStop = order({ side: 'SELL', type: 'SL_MARKET', triggerPrice: 95, qty: 10 });

  it('a SELL stop triggers at or below the trigger and fills as a market order', () => {
    expect(decideFill(sellStop, px(95.5), AT, BPS0)).toEqual({ kind: 'NONE', reason: 'the price 95.5 has not reached the trigger 95' });
    expect(shown(decideFill(sellStop, px(95), AT, BPS0))).toEqual({ qty: 10, price: '95.0000', via: 'SLIPPAGE' });
  });

  it('a gap through the trigger fills at the gap price, not the trigger', () => {
    expect(shown(decideFill(sellStop, px(90), AT, BPS0))).toEqual({ qty: 10, price: '90.0000', via: 'SLIPPAGE' });
    expect(shown(decideFill(sellStop, px(90, depth([], [[89.5, 10]])), AT, BPS0))).toEqual({ qty: 10, price: '89.5000', via: 'DEPTH' });
  });

  it('a BUY stop triggers at or above the trigger', () => {
    const buyStop = order({ type: 'SL_MARKET', triggerPrice: 105, qty: 10 });
    expect(decideFill(buyStop, px(104.95), AT, BPS0).kind).toBe('NONE');
    expect(shown(decideFill(buyStop, px(106), AT, BPS0))).toEqual({ qty: 10, price: '106.0000', via: 'SLIPPAGE' });
  });

  it('a partly filled stop keeps filling as a market order, even back across the trigger', () => {
    expect(shown(decideFill({ ...sellStop, filledQty: 4 }, px(96), AT, BPS0))).toEqual({ qty: 6, price: '96.0000', via: 'SLIPPAGE' });
  });
});

describe('validateOrder (business rules that REJECT)', () => {
  const ctx = (over: Partial<OrderCheckContext> = {}): OrderCheckContext => ({ settings: paperSettings(), position: { netQty: 0 }, pendingExitQty: 0, ...over });

  it('a vehicle trades only on its exchange', () => {
    const nfo = cashBuy({ instrument: { exchange: 'NFO', token: '2885', symbol: 'RELIANCE-EQ', lotSize: 1, underlying: null } });
    expect(validateOrder(nfo, ctx())).toBe('CASH_INTRADAY trades on NSE, not NFO');
  });

  it('qty must be a multiple of the lot size', () => {
    expect(validateOrder(optionBuy({ qty: 100 }), ctx())).toBe('qty 100 is not a multiple of the lot size 75');
  });

  it('options need an underlying with a maxLotsPerOrder row, and stay within it (E4)', () => {
    const inst = optionBuy().instrument;
    expect(validateOrder(optionBuy({ instrument: { ...inst, underlying: null } }), ctx())).toBe('an option order needs its underlying');
    expect(validateOrder(optionBuy({ instrument: { ...inst, underlying: 'TCS' } }), ctx())).toBe('no maxLotsPerOrder setting for TCS');
    expect(validateOrder(optionBuy({ qty: 825 }), ctx())).toBe('11 lots exceed the 10-lot limit per order for NIFTY');
    expect(validateOrder(optionBuy({ qty: 750 }), ctx())).toBeNull();
  });

  it('MTF and options open only with BUY; cash intraday may open short', () => {
    expect(validateOrder(mtfBuy({ side: 'SELL' }), ctx())).toBe('MTF opens only with BUY');
    expect(validateOrder(optionBuy({ side: 'SELL' }), ctx())).toBe('OPTIONS_BUY opens only with BUY');
    expect(validateOrder(cashBuy({ side: 'SELL' }), ctx())).toBeNull();
  });

  it('an ENTRY never reduces an open position', () => {
    expect(validateOrder(cashBuy({ side: 'SELL' }), ctx({ position: { netQty: 100 } }))).toBe('an ENTRY may not reduce the open position; place an EXIT');
  });

  it('an EXIT needs a position, the closing side and quantity not already being exited', () => {
    const exit = (over = {}) => cashBuy({ purpose: 'EXIT', side: 'SELL', ...over });
    expect(validateOrder(exit(), ctx())).toBe('no open position to exit');
    expect(validateOrder(exit({ side: 'BUY' }), ctx({ position: { netQty: 100 } }))).toBe('an exit of a long position must SELL');
    expect(validateOrder(exit(), ctx({ position: { netQty: 100 }, pendingExitQty: 40 }))).toBe('exit qty 100 exceeds the 60 units not already being exited');
    expect(validateOrder(exit({ qty: 60 }), ctx({ position: { netQty: 100 }, pendingExitQty: 40 }))).toBeNull();
    expect(validateOrder(exit({ side: 'BUY', qty: 50 }), ctx({ position: { netQty: -50 } }))).toBeNull();
  });
});

describe('requestProblems (a malformed request is a 400, not a REJECTED order)', () => {
  it('a well-formed request has none', () => {
    expect(requestProblems(cashBuy())).toEqual([]);
    expect(requestProblems(mtfBuy())).toEqual([]);
    expect(requestProblems(optionBuy())).toEqual([]);
  });

  it('lists every shape problem', () => {
    const bad = { ...cashBuy(), userId: '', vehicle: 'FUTURES', side: 'HOLD', qty: 0, refPrice: 100.123, limitPrice: 99 } as unknown as Parameters<typeof requestProblems>[0];
    expect(requestProblems(bad)).toEqual([
      'userId is required',
      'unknown vehicle FUTURES',
      'side must be BUY or SELL',
      'qty must be a whole number of 1 or more',
      'refPrice must be a price above 0 with at most 2 decimals',
      'limitPrice is only for LIMIT orders',
    ]);
  });

  it('LIMIT needs a limit and SL_MARKET a trigger', () => {
    expect(requestProblems(cashBuy({ type: 'LIMIT' }))).toEqual(['limitPrice must be a price above 0 with at most 2 decimals']);
    expect(requestProblems(cashBuy({ type: 'SL_MARKET' }))).toEqual(['triggerPrice must be a price above 0 with at most 2 decimals']);
  });
});

describe('shared order rules (ruling P7: one copy, reused by the modify path)', () => {
  it('isWholeLots: a safe whole number that is a multiple of the lot', () => {
    expect(isWholeLots(150, 75)).toBe(true);
    expect(isWholeLots(100, 75)).toBe(false);
    expect(isWholeLots(1.5, 1)).toBe(false);
    expect(isWholeLots(Number.NaN, 1)).toBe(false);
  });

  it('maxLotsProblem: the underlying needs a setting and the lots stay within it', () => {
    const max = paperSettings().maxLotsPerOrder;
    expect(maxLotsProblem(750, 75, 'NIFTY', max)).toBeNull();
    expect(maxLotsProblem(750, 75, ' nifty ', max)).toBeNull();
    expect(maxLotsProblem(825, 75, 'NIFTY', max)).toBe('11 lots exceed the 10-lot limit per order for NIFTY');
    expect(maxLotsProblem(75, 75, 'TCS', max)).toBe('no maxLotsPerOrder setting for TCS');
    expect(maxLotsProblem(75, 75, null, max)).toBe('an option order needs its underlying');
  });

  it('priceShapeProblem: above 0, finite, at most 2 decimals', () => {
    expect(priceShapeProblem(100.05, 'limitPrice')).toBeNull();
    expect(priceShapeProblem(100.123, 'limitPrice')).toBe('limitPrice must be a price above 0 with at most 2 decimals');
    expect(priceShapeProblem(0, 'triggerPrice')).toBe('triggerPrice must be a price above 0 with at most 2 decimals');
    expect(priceShapeProblem(Number.POSITIVE_INFINITY, 'refPrice')).toBe('refPrice must be a price above 0 with at most 2 decimals');
    expect(priceShapeProblem(null, 'refPrice')).toBe('refPrice must be a price above 0 with at most 2 decimals');
  });
});
