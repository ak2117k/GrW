// apps/api/src/modules/sentinel-executor/domain/owner-orders.spec.ts
import { floorStopTag } from './floor-broker-sl';
import { isOwnerExitOrder, ownerExitOrdersFor } from './owner-orders';

const EXIT = { exchange: 'BFO', token: '1171', side: 'SELL' as const, trackerId: 't1' };
const row = (x: Record<string, unknown> = {}) => ({
  orderid: 'OWN1', variety: 'NORMAL', ordertype: 'LIMIT', transactiontype: 'SELL', producttype: 'CARRYFORWARD',
  quantity: '40', price: '520', triggerprice: '0', status: 'open', symboltoken: '1171', exchange: 'BFO', ordertag: '', ...x,
});

describe('ownerExitOrdersFor (EXIT_CANCEL_OWNER_ORDERS)', () => {
  it('no open order on the contract → none (terminal rows and other contracts ignored)', () => {
    expect(ownerExitOrdersFor([row({ status: 'complete' }), row({ symboltoken: '999' }), row({ exchange: 'NFO' })], EXIT, { cancelOwnStop: true }))
      .toEqual({ kind: 'none' });
  });

  it('an owner exit-side order of ANY type / qty / product is cancellable, with its price and trigger', () => {
    const r = ownerExitOrdersFor([row({ quantity: '80', producttype: 'INTRADAY', ordertype: 'STOPLOSS_LIMIT', variety: 'STOPLOSS', triggerprice: '450', price: '449' })], EXIT, { cancelOwnStop: false });
    expect(r).toEqual({ kind: 'cancel', orders: [{
      orderId: 'OWN1', variety: 'STOPLOSS', orderType: 'STOPLOSS_LIMIT', side: 'SELL', quantity: 80, status: 'open',
      price: 449, triggerPrice: 450, owner: true,
    }] });
  });

  it('an entry-side owner order anywhere on the contract → blocking (nothing is cancelled)', () => {
    expect(ownerExitOrdersFor([row(), row({ orderid: 'B1', transactiontype: 'BUY' })], EXIT, { cancelOwnStop: true }).kind).toBe('blocking');
  });

  it('an order of ours (any GrW ordertag prefix) → blocking', () => {
    for (const tag of ['axMabc', 'amMabc', 'atMabc', 'aeabc', 'sgabc', floorStopTag('other')]) {
      expect(ownerExitOrdersFor([row(), row({ orderid: 'X', ordertag: tag })], EXIT, { cancelOwnStop: true }).kind).toBe('blocking');
    }
  });

  it('an unreadable side → blocking', () => {
    expect(ownerExitOrdersFor([row({ transactiontype: '' })], EXIT, { cancelOwnStop: true }).kind).toBe('blocking');
  });

  it('our floor stop rides along only when cancelOwnStop (AI_AUTO_EXIT_CANCEL_PROTECTIVE); alone it is not an owner order', () => {
    const stop = row({ orderid: 'SL1', ordertag: floorStopTag('t1'), variety: 'STOPLOSS', ordertype: 'STOPLOSS_LIMIT' });
    const both = ownerExitOrdersFor([row(), stop], EXIT, { cancelOwnStop: true });
    expect(both.kind === 'cancel' && both.orders.map((o) => [o.orderId, o.owner])).toEqual([['OWN1', true], ['SL1', false]]);
    expect(ownerExitOrdersFor([row(), stop], EXIT, { cancelOwnStop: false }).kind).toBe('blocking');
    expect(ownerExitOrdersFor([stop], EXIT, { cancelOwnStop: true }).kind).toBe('blocking');
  });

  it('an owner exit-side order with no order id, or more than 3 to cancel → uncancellable (visible, never silent)', () => {
    const noId = ownerExitOrdersFor([row({ orderid: '' })], EXIT, { cancelOwnStop: true });
    expect(noId).toEqual({ kind: 'uncancellable', detail: expect.stringContaining('no order id') });
    const many = ownerExitOrdersFor(['A', 'B', 'C', 'D'].map((id) => row({ orderid: id })), EXIT, { cancelOwnStop: true });
    expect(many).toEqual({ kind: 'uncancellable', detail: expect.stringContaining('4 exit-side orders') });
  });

  it('a short: the owner BUY is exit-side, an owner SELL is entry-side', () => {
    const SHORT = { ...EXIT, side: 'BUY' as const };
    expect(ownerExitOrdersFor([row({ transactiontype: 'BUY' })], SHORT, { cancelOwnStop: true }).kind).toBe('cancel');
    expect(ownerExitOrdersFor([row()], SHORT, { cancelOwnStop: true }).kind).toBe('blocking');
  });

  it('isOwnerExitOrder: untagged / foreign tag on the exit side only', () => {
    expect(isOwnerExitOrder(row(), 'SELL')).toBe(true);
    expect(isOwnerExitOrder(row({ ordertag: 'mytag' }), 'SELL')).toBe(true);
    expect(isOwnerExitOrder(row(), 'BUY')).toBe(false);
    expect(isOwnerExitOrder(row({ ordertag: floorStopTag('t1') }), 'SELL')).toBe(false);
  });
});
