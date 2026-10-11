import { ConflictException, UnprocessableEntityException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { chargesForLeg } from '../../trade-sentinel/charges';
import { money } from './ledger-math';
import { fillCharges, heldMargin, PaperLedgerService, pendingMargin, type PlaceContext } from './paper-ledger.service';
import type { PaperSettings } from './paper-settings';
import { fakeDefaults, MemoryPaperStore } from './testing/memory-paper-store';
import { cashBuy, mtfBuy, NOW, optionBuy, paperSettings } from './testing/paper-fixtures';

const D = (s: string) => new Prisma.Decimal(s);
const OPEN: PlaceContext = { sessionOpen: true, killSwitchActive: false };
const AT = new Date(NOW.getTime() + 10);

function setup(settings: PaperSettings | null = paperSettings()) {
  const store = new MemoryPaperStore(() => NOW);
  const svc = new PaperLedgerService(store.tx, store.orderRepo, store.fillRepo, store.ledgerRepo, fakeDefaults(settings));
  return { store, svc };
}

const rowsAfter = (store: MemoryPaperStore, n: number) => store.ledger.slice(n).map((r) => [r.type, r.amount.toFixed(2), r.fillId !== null]);
const total = (store: MemoryPaperStore) => store.ledger.reduce((a, r) => a.plus(r.amount), D('0')).toFixed(2);
const legTotal = (segment: 'EQ_INTRADAY' | 'EQ_DELIVERY' | 'OPT', leg: 'BUY' | 'SELL', price: number, qty: number) =>
  money(chargesForLeg({ segment, leg, price, qty }).total);

describe('PaperLedgerService.applyFill', () => {
  it('an entry fill posts its charges, frees the pending margin for its qty and blocks margin at the fill price', async () => {
    const { store, svc } = setup();
    const { order } = await svc.place(cashBuy(), OPEN, NOW);
    const out = await svc.applyFill('user_A', order.id, 0, { qty: 100, price: D('500.7'), priceAt: AT });
    expect(out).toMatchObject({ state: 'FILLED', filledQty: 100, avgFillPrice: 500.7 });
    expect(store.fills).toHaveLength(1);
    expect(store.fills[0].chargesTotal.toFixed(2)).toBe('26.92');
    expect(store.fills[0].charges).toMatchObject({ segment: 'EQ_INTRADAY', leg: 'BUY', pledgeFee: 0 });
    expect(rowsAfter(store, 2)).toEqual([
      ['CHARGES', '-26.92', true],
      ['MARGIN_RELEASE', '10000.00', false],
      ['MARGIN_BLOCK', '-10014.00', true],
    ]);
  });

  it('a partial fill, then a cancel, releases exactly the unfilled part', async () => {
    const { store, svc } = setup();
    const { order } = await svc.place(cashBuy(), OPEN, NOW);
    const p = await svc.applyFill('user_A', order.id, 0, { qty: 40, price: D('500'), priceAt: AT });
    expect(p).toMatchObject({ state: 'PARTIAL', filledQty: 40 });
    expect(rowsAfter(store, 3)).toEqual([
      ['MARGIN_RELEASE', '4000.00', false],
      ['MARGIN_BLOCK', '-4000.00', true],
    ]);
    await svc.close('user_A', order.id, 'CANCEL', 'rest not needed');
    expect(rowsAfter(store, 5)).toEqual([['MARGIN_RELEASE', '6000.00', false]]);
    expect(pendingMargin(store.ledger, order.id).toFixed(2)).toBe('0.00');
    expect(heldMargin(store.ledger, (r) => r.orderId === order.id).toFixed(2)).toBe('4000.00');
    // The ledger is the sum of its rows: no residue in pending margin, only the position's 4000 blocked.
    const funds = await svc.funds('user_A');
    expect(funds.blockedMargin).toBe('4000.00');
    expect(funds.freeCash).toBe(total(store));
    expect(funds.freeCash).toBe(D('1000000').minus(legTotal('EQ_INTRADAY', 'BUY', 500, 40)).minus(4000).toFixed(2));
  });

  it('an exit books gross realised P&L and its own charges, releases margin in proportion, and all of it on the last fill', async () => {
    const { store, svc } = setup();
    const entry = (await svc.place(cashBuy(), OPEN, NOW)).order;
    await svc.applyFill('user_A', entry.id, 0, { qty: 100, price: D('500.7'), priceAt: AT });
    const exit = (await svc.place(cashBuy({ idempotencyKey: 'intent_cash_1:exit', purpose: 'EXIT', side: 'SELL', refPrice: 505 }), OPEN, NOW)).order;
    expect(exit.state).toBe('OPEN');
    const before = store.ledger.length;
    await svc.applyFill('user_A', exit.id, 0, { qty: 60, price: D('505'), priceAt: AT });
    expect(rowsAfter(store, before)).toEqual([
      ['CHARGES', legTotal('EQ_INTRADAY', 'SELL', 505, 60).neg().toFixed(2), true],
      ['REALISED_PNL', '258.00', true],
      ['MARGIN_RELEASE', '6008.40', true],
    ]);
    await svc.applyFill('user_A', exit.id, 60, { qty: 40, price: D('506'), priceAt: AT });
    expect(store.ledger.slice(-2).map((r) => [r.type, r.amount.toFixed(2)])).toEqual([
      ['REALISED_PNL', '212.00'],
      ['MARGIN_RELEASE', '4005.60'],
    ]);
    const charges = legTotal('EQ_INTRADAY', 'BUY', 500.7, 100).plus(legTotal('EQ_INTRADAY', 'SELL', 505, 60)).plus(legTotal('EQ_INTRADAY', 'SELL', 506, 40));
    const funds = await svc.funds('user_A');
    expect(funds.blockedMargin).toBe('0.00');
    expect(funds.freeCash).toBe(D('1000000').plus(258).plus(212).minus(charges).toFixed(2));
    expect(funds.freeCash).toBe(total(store));
  });

  it('MTF: delivery charges, the pledge fee once per buy order, the own share blocked', async () => {
    const { store, svc } = setup();
    const { order } = await svc.place(mtfBuy(), OPEN, NOW);
    expect(store.ledger[1].amount.toFixed(2)).toBe('-5000.00');
    await svc.applyFill('user_A', order.id, 0, { qty: 4, price: D('1000.5'), priceAt: AT });
    await svc.applyFill('user_A', order.id, 4, { qty: 6, price: D('1000.5'), priceAt: AT });
    expect(store.fills.map((f) => [f.charges.segment, f.charges.pledgeFee])).toEqual([['EQ_DELIVERY', 23.6], ['EQ_DELIVERY', 0]]);
    expect(store.fills[0].chargesTotal.toFixed(2)).toBe(money(chargesForLeg({ segment: 'EQ_DELIVERY', leg: 'BUY', price: 1000.5, qty: 4 }).total + 23.6).toFixed(2));
    expect(store.ledger.filter((r) => r.type.startsWith('MARGIN')).map((r) => r.amount.toFixed(2))).toEqual(['-5000.00', '2000.00', '-2001.00', '3000.00', '-3001.50']);
  });

  it('options: the full premium is blocked and the option schedule applies', async () => {
    const { store, svc } = setup();
    const { order } = await svc.place(optionBuy(), OPEN, NOW);
    await svc.applyFill('user_A', order.id, 0, { qty: 150, price: D('100'), priceAt: AT });
    expect(store.fills[0].charges).toMatchObject({ segment: 'OPT', leg: 'BUY', brokerage: 20 });
    expect(store.ledger.filter((r) => r.type.startsWith('MARGIN')).map((r) => r.amount.toFixed(2))).toEqual(['-15000.00', '15000.00', '-15000.00']);
  });

  it('a stale expectation (another writer filled first) writes nothing and returns null', async () => {
    const { store, svc } = setup();
    const { order } = await svc.place(cashBuy(), OPEN, NOW);
    expect(await svc.applyFill('user_A', order.id, 10, { qty: 100, price: D('500'), priceAt: AT })).toBeNull();
    expect(store.fills).toEqual([]);
    expect(store.ledger).toHaveLength(2);
  });

  it('no settings, no fill', async () => {
    const { store, svc } = setup();
    const { order } = await svc.place(cashBuy(), OPEN, NOW);
    const blind = new PaperLedgerService(store.tx, store.orderRepo, store.fillRepo, store.ledgerRepo, fakeDefaults(null));
    expect(await blind.applyFill('user_A', order.id, 0, { qty: 100, price: D('500'), priceAt: AT })).toBeNull();
    expect(store.fills).toEqual([]);
  });

  it('a fill that does not fit the order throws and writes nothing', async () => {
    const { store, svc } = setup();
    const { order } = await svc.place(optionBuy(), OPEN, NOW);
    await expect(svc.applyFill('user_A', order.id, 0, { qty: 100, price: D('100'), priceAt: AT })).rejects.toThrow('does not fit');
    await expect(svc.applyFill('user_A', order.id, 0, { qty: 225, price: D('100'), priceAt: AT })).rejects.toThrow('does not fit');
    await expect(svc.applyFill('user_A', order.id, 0, { qty: 75, price: D('0'), priceAt: AT })).rejects.toThrow('does not fit');
    expect(store.fills).toEqual([]);
    expect(store.ledger).toHaveLength(2);
    expect(store.orders[0]).toMatchObject({ state: 'OPEN', filledQty: 0 });
  });

  it('an exit fill larger than the open position throws and writes nothing', async () => {
    const { store, svc } = setup();
    const entry = (await svc.place(cashBuy(), OPEN, NOW)).order;
    await svc.applyFill('user_A', entry.id, 0, { qty: 100, price: D('500'), priceAt: AT });
    const exit = (await svc.place(cashBuy({ idempotencyKey: 'x1', purpose: 'EXIT', side: 'SELL', refPrice: 505 }), OPEN, NOW)).order;
    store.orders[1].qty = 200; // a corrupted exit: the service must not trust it
    const rows = store.ledger.length;
    await expect(svc.applyFill('user_A', exit.id, 0, { qty: 150, price: D('505'), priceAt: AT })).rejects.toThrow('exceeds the open position');
    expect(store.fills).toHaveLength(1);
    expect(store.ledger).toHaveLength(rows);
    expect(store.orders[1]).toMatchObject({ state: 'OPEN', filledQty: 0 });
  });
});

describe('PaperLedgerService: SL_MARKET triggers (ruling P10)', () => {
  const stopBuy = () => cashBuy({ idempotencyKey: 'intent_stop_1:entry', type: 'SL_MARKET', triggerPrice: 510, refPrice: 510 });

  it('markTriggered persists triggeredAt for a NONE decision that reached the trigger, once', async () => {
    const { store, svc } = setup();
    const { order } = await svc.place(stopBuy(), OPEN, NOW);
    const out = await svc.markTriggered('user_A', order.id, 0, AT);
    expect(out).toMatchObject({ state: 'OPEN', filledQty: 0, triggeredAt: AT });
    expect(store.orders[0].triggeredAt).toEqual(AT);
    expect(store.fills).toEqual([]);
    expect(store.ledger).toHaveLength(2);
    // A stop never un-triggers and its first trigger time is kept.
    const later = new Date(AT.getTime() + 1000);
    expect(await svc.markTriggered('user_A', order.id, 0, later)).toMatchObject({ triggeredAt: AT });
  });

  it('markTriggered writes nothing for a non-stop, a closed order, a stale expectation or another user', async () => {
    const { store, svc } = setup();
    const market = (await svc.place(cashBuy(), OPEN, NOW)).order;
    expect(await svc.markTriggered('user_A', market.id, 0, AT)).toBeNull();
    const stop = (await svc.place(stopBuy(), OPEN, NOW)).order;
    expect(await svc.markTriggered('user_A', stop.id, 5, AT)).toBeNull();
    expect(await svc.markTriggered('user_B', stop.id, 0, AT)).toBeNull();
    await svc.close('user_A', stop.id, 'CANCEL', 'gone');
    expect(await svc.markTriggered('user_A', stop.id, 0, AT)).toBeNull();
    expect(store.orders.map((o) => o.triggeredAt)).toEqual([null, null]);
  });

  it('a triggered FILL decision persists triggeredAt in the same write as the fill', async () => {
    const { store, svc } = setup();
    const { order } = await svc.place(stopBuy(), OPEN, NOW);
    const out = await svc.applyFill('user_A', order.id, 0, { qty: 40, price: D('511'), priceAt: AT, triggered: true });
    expect(out).toMatchObject({ state: 'PARTIAL', filledQty: 40, triggeredAt: AT });
    expect(store.fills).toHaveLength(1);
    const later = new Date(AT.getTime() + 1000);
    expect(await svc.applyFill('user_A', order.id, 40, { qty: 60, price: D('512'), priceAt: later, triggered: true })).toMatchObject({ triggeredAt: AT });
  });

  it('a stale triggered fill writes neither the fill nor triggeredAt', async () => {
    const { store, svc } = setup();
    const { order } = await svc.place(stopBuy(), OPEN, NOW);
    expect(await svc.applyFill('user_A', order.id, 10, { qty: 40, price: D('511'), priceAt: AT, triggered: true })).toBeNull();
    expect(store.orders[0].triggeredAt).toBeNull();
    expect(store.fills).toEqual([]);
  });
});

describe('PaperLedgerService.modify', () => {
  it('more qty blocks more margin, less releases it; an unfunded increase or a closed order is refused', async () => {
    const { store, svc } = setup();
    const { order } = await svc.place(cashBuy(), OPEN, NOW);
    expect((await svc.modify('user_A', order.id, { qty: 150 })).qty).toBe(150);
    expect(rowsAfter(store, 2)).toEqual([['MARGIN_BLOCK', '-5000.00', false]]);
    await svc.modify('user_A', order.id, { qty: 50 });
    expect(rowsAfter(store, 3)).toEqual([['MARGIN_RELEASE', '10000.00', false]]);
    await expect(svc.modify('user_A', order.id, { qty: 100000 })).rejects.toThrow('insufficient free cash');
    await svc.close('user_A', order.id, 'CANCEL', 'done');
    await expect(svc.modify('user_A', order.id, { qty: 60 })).rejects.toBeInstanceOf(ConflictException);
  });

  it('a new limit re-blocks at the new limit; a wrong field or a bad qty is 422', async () => {
    const { store, svc } = setup();
    const { order } = await svc.place(optionBuy(), OPEN, NOW);
    expect((await svc.modify('user_A', order.id, { limitPrice: 90 })).limitPrice).toBe(90);
    expect(rowsAfter(store, 2)).toEqual([['MARGIN_RELEASE', '1500.00', false]]);
    await expect(svc.modify('user_A', order.id, { triggerPrice: 80 })).rejects.toThrow('only an SL_MARKET order has a trigger price');
    await expect(svc.modify('user_A', order.id, { qty: 100 })).rejects.toThrow('qty must be a whole multiple of the lot size 75');
    await expect(svc.modify('user_A', order.id, { qty: 900 })).rejects.toThrow('12 lots exceed the 10-lot limit per order for NIFTY');
    await expect(svc.modify('user_A', order.id, { limitPrice: 90.005 })).rejects.toThrow('limitPrice must be a price above 0 with at most 2 decimals');
    await expect(svc.modify('user_A', order.id, {})).rejects.toBeInstanceOf(UnprocessableEntityException);
  });

  it('a triggered SL_MARKET, or one with a fill, cannot be modified (409, ruling P11)', async () => {
    const { store, svc } = setup();
    const stop = (await svc.place(cashBuy({ idempotencyKey: 's1', type: 'SL_MARKET', triggerPrice: 510, refPrice: 510 }), OPEN, NOW)).order;
    expect((await svc.modify('user_A', stop.id, { triggerPrice: 512 })).triggerPrice).toBe(512);
    await svc.markTriggered('user_A', stop.id, 0, AT);
    const rows = store.ledger.length;
    await expect(svc.modify('user_A', stop.id, { triggerPrice: 520 })).rejects.toBeInstanceOf(ConflictException);
    await expect(svc.modify('user_A', stop.id, { qty: 50 })).rejects.toBeInstanceOf(ConflictException);
    expect(store.ledger).toHaveLength(rows);
    expect(store.orders[0].triggerPrice).toBe(512);

    // A stop with a fill (triggeredAt not recorded) is also executing.
    const filled = (await svc.place(cashBuy({ idempotencyKey: 's2', type: 'SL_MARKET', triggerPrice: 510, refPrice: 510 }), OPEN, NOW)).order;
    await svc.applyFill('user_A', filled.id, 0, { qty: 40, price: D('511'), priceAt: AT });
    expect(store.orders[1]).toMatchObject({ state: 'PARTIAL', triggeredAt: null });
    await expect(svc.modify('user_A', filled.id, { triggerPrice: 520 })).rejects.toBeInstanceOf(ConflictException);
  });
});

describe('PaperLedgerService.positions and fillCharges', () => {
  it('one view per non-flat (vehicle, token), with average, realised P&L and the margin it holds', async () => {
    const { svc } = setup();
    const entry = (await svc.place(cashBuy(), OPEN, NOW)).order;
    await svc.applyFill('user_A', entry.id, 0, { qty: 100, price: D('500.7'), priceAt: AT });
    const exit = (await svc.place(cashBuy({ idempotencyKey: 'x1', purpose: 'EXIT', side: 'SELL', refPrice: 505 }), OPEN, NOW)).order;
    await svc.applyFill('user_A', exit.id, 0, { qty: 60, price: D('505'), priceAt: AT });
    expect(await svc.positions('user_A')).toEqual([
      {
        key: 'CASH_INTRADAY:2885',
        vehicle: 'CASH_INTRADAY',
        instrument: { exchange: 'NSE', token: '2885', symbol: 'RELIANCE-EQ', lotSize: 1, underlying: null },
        netQty: 40,
        direction: 'LONG',
        avgPrice: '500.7000',
        realisedPnl: '258.00',
        blockedMargin: '4005.60',
        openedAt: AT,
      },
    ]);
    await svc.applyFill('user_A', exit.id, 60, { qty: 40, price: D('506'), priceAt: AT });
    expect(await svc.positions('user_A')).toEqual([]);
    expect(await svc.positions('user_B')).toEqual([]);
  });

  it('fillCharges prices one leg by vehicle and adds the pledge fee only to the first MTF buy fill', () => {
    const s = paperSettings();
    expect(fillCharges({ vehicle: 'CASH_INTRADAY', side: 'SELL', filledQty: 0 }, 60, D('505'), s)).toMatchObject({ segment: 'EQ_INTRADAY', leg: 'SELL', pledgeFee: 0 });
    expect(fillCharges({ vehicle: 'MTF', side: 'BUY', filledQty: 0 }, 4, D('1000.5'), s).pledgeFee).toBe(23.6);
    expect(fillCharges({ vehicle: 'MTF', side: 'BUY', filledQty: 4 }, 6, D('1000.5'), s).pledgeFee).toBe(0);
    expect(fillCharges({ vehicle: 'MTF', side: 'SELL', filledQty: 0 }, 10, D('1010'), s)).toMatchObject({ segment: 'EQ_DELIVERY', leg: 'SELL', pledgeFee: 0 });
    expect(fillCharges({ vehicle: 'OPTIONS_BUY', side: 'BUY', filledQty: 0 }, 75, D('100'), s).segment).toBe('OPT');
    const mtf = fillCharges({ vehicle: 'MTF', side: 'BUY', filledQty: 0 }, 4, D('1000.5'), s);
    expect(mtf.total).toBeCloseTo(chargesForLeg({ segment: 'EQ_DELIVERY', leg: 'BUY', price: 1000.5, qty: 4 }).total + 23.6, 10);
  });
});
