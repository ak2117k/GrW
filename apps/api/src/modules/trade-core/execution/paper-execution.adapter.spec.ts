import { BadRequestException, ConflictException, Logger, NotFoundException } from '@nestjs/common';
import type { ModuleRef } from '@nestjs/core';
import { Prisma } from '@prisma/client';
import { chargesForLeg } from '../../trade-sentinel/charges';
import type { CoreKillSwitchService } from '../risk-wall/services/core-kill-switch.service';
import type { CoreOrder, CoreOrderRequest } from './execution.types';
import { money } from './ledger-math';
import { PaperExecutionAdapter } from './paper-execution.adapter';
import { PaperLedgerService } from './paper-ledger.service';
import { coreOrderOwner, PaperMatcherService } from './paper-matcher.service';
import type { PaperSettings } from './paper-settings';
import { FakeHub, fakeHubSource, fakeModuleRef } from './testing/fake-hub';
import { fakeDefaults, MemoryPaperStore } from './testing/memory-paper-store';
import { cashBuy, depth, hubPrice, mtfBuy, optionBuy, paperSettings } from './testing/paper-fixtures';

const D = (s: string) => new Prisma.Decimal(s);

function setup(opts: { settings?: PaperSettings; kill?: boolean | 'throws'; open?: boolean } = {}) {
  const store = new MemoryPaperStore();
  const defaults = fakeDefaults(opts.settings ?? paperSettings());
  const ledger = new PaperLedgerService(store.tx, store.orderRepo, store.fillRepo, store.ledgerRepo, defaults);
  const hub = new FakeHub();
  const clock = { isOpen: () => opts.open ?? true };
  const matcher = new PaperMatcherService(ledger, defaults, fakeModuleRef(fakeHubSource({ user_A: hub, user_B: hub })) as unknown as ModuleRef, clock);
  const killSwitch = {
    isActive: jest.fn(async () => {
      if (opts.kill === 'throws') throw new Error('db down');
      return opts.kill === true;
    }),
  };
  const adapter = new PaperExecutionAdapter(ledger, matcher, killSwitch as unknown as CoreKillSwitchService, clock);
  /** Deliver a price stamped `ms` after the order's submission, evaluated 1 ms later. */
  const push = (o: CoreOrder, req: CoreOrderRequest, ltp: number, book?: ReturnType<typeof depth>, ms = 10) => {
    const at = o.submittedAt.getTime() + ms;
    return matcher.onPrice(hub, hubPrice(req, ltp, at, book), at + 1);
  };
  const sumRows = (userId = 'user_A') => store.ledger.filter((r) => r.userId === userId).reduce((a, r) => a.plus(r.amount), D('0')).toFixed(2);
  /**
   * Review Focus 3: once every position is flat the ledger equals Σ rows with no residue —
   * nothing blocked, every position key's margin rows net to zero (an entry's fill blocks
   * against the entry order, the exit's fill releases against the exit order, so the
   * netting is per token, not per order), nothing left in the matcher.
   */
  const expectReconciled = async (userId = 'user_A') => {
    const funds = await adapter.getFunds(userId);
    expect(funds.blockedMargin).toBe('0.00');
    expect(funds.cash).toBe(funds.freeCash);
    expect(sumRows(userId)).toBe(funds.freeCash);
    expect(D(funds.deposited).plus(funds.realisedPnl).minus(funds.charges).minus(funds.mtfInterest).toFixed(2)).toBe(funds.cash);
    for (const v of Object.values(funds.deployedByVehicle)) expect(v).toBe('0.00');
    const marginByToken = new Map<string, Prisma.Decimal>();
    for (const r of store.ledger) {
      if (r.userId !== userId || (r.type !== 'MARGIN_BLOCK' && r.type !== 'MARGIN_RELEASE')) continue;
      marginByToken.set(r.token as string, (marginByToken.get(r.token as string) ?? D('0')).plus(r.amount));
    }
    expect(marginByToken.size).toBeGreaterThan(0);
    for (const [token, net] of marginByToken) expect([token, net.toFixed(2)]).toEqual([token, '0.00']);
    expect(await adapter.getPositions(userId)).toEqual([]);
    expect(matcher.openCount()).toBe(0);
    return funds;
  };
  return { store, ledger, matcher, hub, adapter, killSwitch, push, sumRows, expectReconciled };
}

describe('PaperExecutionAdapter, per vehicle (spec §1 done-when)', () => {
  it('cash intraday: place → fill → exit → the ledger reconciles', async () => {
    const { adapter, push, sumRows, expectReconciled } = setup();
    const entryReq = cashBuy();
    const entry = await adapter.placeOrder(entryReq);
    expect(entry.state).toBe('OPEN');
    await push(entry, entryReq, 500, depth([[500.5, 60], [501, 100]]));
    expect(await adapter.getOrder('user_A', entry.id)).toMatchObject({ state: 'FILLED', avgFillPrice: 500.7 });
    const exitReq = cashBuy({ idempotencyKey: 'intent_cash_1:exit', purpose: 'EXIT', side: 'SELL', refPrice: 505 });
    const exit = await adapter.placeOrder(exitReq);
    await push(exit, exitReq, 505, depth([], [[505, 200]]));
    expect((await adapter.getOrder('user_A', exit.id)).state).toBe('FILLED');
    expect(await adapter.getPositions('user_A')).toEqual([]);
    expect(await adapter.getFunds('user_A')).toMatchObject({
      realisedPnl: '430.00',
      charges: '64.97',
      blockedMargin: '0.00',
      cash: '1000365.03',
      freeCash: '1000365.03',
    });
    expect(sumRows()).toBe('1000365.03');
    await expectReconciled();
  });

  it('MTF: fills at LTP + slippage without depth, pays the pledge fee once, exits with realised P&L', async () => {
    const { adapter, push, sumRows, expectReconciled } = setup();
    const req = mtfBuy();
    const entry = await adapter.placeOrder(req);
    await push(entry, req, 1000);
    expect(await adapter.getOrder('user_A', entry.id)).toMatchObject({ state: 'FILLED', avgFillPrice: 1000.5 });
    expect((await adapter.getFunds('user_A')).deployedByVehicle.MTF).toBe('5002.50');
    const exitReq = mtfBuy({ idempotencyKey: 'intent_mtf_1:exit', purpose: 'EXIT', side: 'SELL', refPrice: 1010 });
    const exit = await adapter.placeOrder(exitReq);
    await push(exit, exitReq, 1010, depth([], [[1010, 10]]));
    const buy = money(chargesForLeg({ segment: 'EQ_DELIVERY', leg: 'BUY', price: 1000.5, qty: 10 }).total + 23.6);
    const sell = money(chargesForLeg({ segment: 'EQ_DELIVERY', leg: 'SELL', price: 1010, qty: 10 }).total);
    const funds = await adapter.getFunds('user_A');
    expect(funds).toMatchObject({ realisedPnl: '95.00', blockedMargin: '0.00', charges: buy.plus(sell).toFixed(2) });
    expect(funds.freeCash).toBe(D('1000095').minus(buy).minus(sell).toFixed(2));
    expect(sumRows()).toBe(funds.freeCash);
    await expectReconciled();
  });

  it('options: a LIMIT buy fills only on a strict trade-through, at the limit; the exit too', async () => {
    const { adapter, push, sumRows, expectReconciled } = setup();
    const req = optionBuy();
    const entry = await adapter.placeOrder(req);
    await push(entry, req, 100, undefined, 10);
    expect((await adapter.getOrder('user_A', entry.id)).state).toBe('OPEN');
    await push(entry, req, 99.95, undefined, 20);
    expect(await adapter.getOrder('user_A', entry.id)).toMatchObject({ state: 'FILLED', avgFillPrice: 100 });
    expect((await adapter.getFunds('user_A')).deployedByVehicle.OPTIONS_BUY).toBe('15000.00');
    const exitReq = optionBuy({ idempotencyKey: 'intent_opt_1:exit', purpose: 'EXIT', side: 'SELL', limitPrice: 110, refPrice: 110 });
    const exit = await adapter.placeOrder(exitReq);
    await push(exit, exitReq, 110, undefined, 10);
    expect((await adapter.getOrder('user_A', exit.id)).state).toBe('OPEN');
    await push(exit, exitReq, 110.05, undefined, 20);
    expect((await adapter.getOrder('user_A', exit.id)).state).toBe('FILLED');
    const funds = await adapter.getFunds('user_A');
    expect(funds).toMatchObject({ realisedPnl: '1500.00', blockedMargin: '0.00' });
    const charges = money(chargesForLeg({ segment: 'OPT', leg: 'BUY', price: 100, qty: 150 }).total).plus(
      money(chargesForLeg({ segment: 'OPT', leg: 'SELL', price: 110, qty: 150 }).total),
    );
    expect(funds.charges).toBe(charges.toFixed(2));
    expect(funds.freeCash).toBe(D('1001500').minus(charges).toFixed(2));
    expect(sumRows()).toBe(funds.freeCash);
    await expectReconciled();
  });

  it('the same idempotency key twice returns the same order: one order, one margin block', async () => {
    const { store, adapter } = setup();
    const a = await adapter.placeOrder(cashBuy());
    const b = await adapter.placeOrder(cashBuy());
    expect(b.id).toBe(a.id);
    expect(store.orders).toHaveLength(1);
    expect(store.ledger.filter((r) => r.type === 'MARGIN_BLOCK')).toHaveLength(1);
  });

  it("another user's idempotency key is a 409 and writes nothing for the caller (rulings P3/P12)", async () => {
    const { store, adapter, matcher } = setup();
    const a = await adapter.placeOrder(cashBuy());
    await expect(adapter.placeOrder(cashBuy({ userId: 'user_B' }))).rejects.toBeInstanceOf(ConflictException);
    expect(store.orders).toHaveLength(1);
    expect(store.ledger.filter((r) => r.userId === 'user_B')).toEqual([]);
    expect(matcher.openCount()).toBe(1);
    expect(matcher.isTracked(a.id)).toBe(true);
  });

  it('insufficient cash is a REJECTED order with nothing blocked and nothing watched', async () => {
    const { adapter, matcher, hub } = setup({ settings: paperSettings({ startingCapital: D('1000') }) });
    const o = await adapter.placeOrder(optionBuy());
    expect(o).toMatchObject({ state: 'REJECTED', rejectReason: 'insufficient free cash: the order blocks ₹15000.00, ₹1000.00 is free' });
    expect(matcher.isTracked(o.id)).toBe(false);
    expect(hub.watches).toEqual([]);
    expect((await adapter.getFunds('user_A')).blockedMargin).toBe('0.00');
  });

  it('an accepted order is tracked and its ref watched at P0 on the user hub', async () => {
    const { adapter, matcher, hub } = setup();
    const o = await adapter.placeOrder(optionBuy());
    expect(matcher.isTracked(o.id)).toBe(true);
    expect(hub.watches).toEqual([{ key: 'NFO:43521', priority: 0, owner: coreOrderOwner(o.id) }]);
  });

  it('cancel releases the margin and stops watching', async () => {
    const { adapter, matcher, hub } = setup();
    const o = await adapter.placeOrder(optionBuy());
    const c = await adapter.cancel('user_A', o.id);
    expect(c.state).toBe('CANCELLED');
    expect((await adapter.getFunds('user_A')).freeCash).toBe('1000000.00');
    expect(matcher.isTracked(o.id)).toBe(false);
    expect(matcher.openCount()).toBe(0);
    expect(hub.unwatches).toEqual([{ key: 'NFO:43521', owner: coreOrderOwner(o.id) }]);
  });

  it('a cancelled order never fills: a later price for its ref is ignored', async () => {
    const { store, adapter, push } = setup();
    const req = optionBuy();
    const o = await adapter.placeOrder(req);
    await adapter.cancel('user_A', o.id);
    await push(o, req, 90, undefined, 10);
    expect(await adapter.getOrder('user_A', o.id)).toMatchObject({ state: 'CANCELLED', filledQty: 0 });
    expect(store.fills).toEqual([]);
  });

  it('cancelling an order twice returns it unchanged and releases nothing more', async () => {
    const { store, adapter, hub } = setup();
    const o = await adapter.placeOrder(optionBuy());
    await adapter.cancel('user_A', o.id);
    const again = await adapter.cancel('user_A', o.id);
    expect(again.state).toBe('CANCELLED');
    expect(store.ledger.filter((r) => r.type === 'MARGIN_RELEASE')).toHaveLength(1);
    expect(hub.unwatches).toHaveLength(1);
  });

  it('partial fill, then cancel: only the filled part stays blocked', async () => {
    const { adapter, matcher, push } = setup();
    const req = cashBuy();
    const o = await adapter.placeOrder(req);
    await push(o, req, 500, depth([[500, 40]]));
    expect(matcher.isTracked(o.id)).toBe(true);
    const c = await adapter.cancel('user_A', o.id);
    expect(c).toMatchObject({ state: 'CANCELLED', filledQty: 40 });
    expect(matcher.isTracked(o.id)).toBe(false);
    expect((await adapter.getFunds('user_A')).blockedMargin).toBe('4000.00');
    expect((await adapter.getPositions('user_A')).map((p) => [p.netQty, p.blockedMargin])).toEqual([[40, '4000.00']]);
  });

  it('partial fill, cancel, then exit the filled part: the ledger reconciles', async () => {
    const { adapter, push, expectReconciled } = setup();
    const req = cashBuy();
    const o = await adapter.placeOrder(req);
    await push(o, req, 500, depth([[500, 40]]));
    await adapter.cancel('user_A', o.id);
    const exitReq = cashBuy({ idempotencyKey: 'intent_cash_1:exit', purpose: 'EXIT', side: 'SELL', qty: 40, refPrice: 510 });
    const exit = await adapter.placeOrder(exitReq);
    await push(exit, exitReq, 510, depth([], [[510, 40]]));
    const funds = await expectReconciled();
    expect(funds.realisedPnl).toBe('400.00');
  });

  it('the kill switch rejects an entry, an unreadable switch counts as on, and an exit never asks it', async () => {
    const logged = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    try {
      const on = setup({ kill: true });
      expect((await on.adapter.placeOrder(cashBuy())).rejectReason).toBe('the kill switch is on: no new entries');
      expect(logged).not.toHaveBeenCalled();
      const unreadable = setup({ kill: 'throws' });
      expect((await unreadable.adapter.placeOrder(cashBuy())).rejectReason).toBe('the kill switch is on: no new entries');
      expect(logged).toHaveBeenCalledWith(expect.stringContaining('db down'));
      const exit = await on.adapter.placeOrder(cashBuy({ idempotencyKey: 'x', purpose: 'EXIT', side: 'SELL' }));
      expect(exit.rejectReason).toBe('no open position to exit');
      expect(on.killSwitch.isActive).toHaveBeenCalledTimes(1);
      expect(on.matcher.openCount()).toBe(0);
    } finally {
      logged.mockRestore();
    }
  });

  it('the kill switch does not stop an exit of an open position', async () => {
    const { adapter, push, killSwitch } = setup();
    const req = cashBuy();
    const o = await adapter.placeOrder(req);
    await push(o, req, 500, depth([[500, 100]]));
    killSwitch.isActive.mockResolvedValue(true);
    const exit = await adapter.placeOrder(cashBuy({ idempotencyKey: 'intent_cash_1:exit', purpose: 'EXIT', side: 'SELL' }));
    expect(exit.state).toBe('OPEN');
    expect(killSwitch.isActive).toHaveBeenCalledTimes(1);
  });

  it('out of session is a REJECTED order', async () => {
    const { adapter, matcher } = setup({ open: false });
    const o = await adapter.placeOrder(cashBuy());
    expect(o.rejectReason).toBe('NSE is not in session');
    expect(matcher.isTracked(o.id)).toBe(false);
  });

  it('a malformed request is a 400 and writes nothing', async () => {
    const { store, adapter, killSwitch } = setup();
    await expect(adapter.placeOrder(cashBuy({ qty: 0 }))).rejects.toBeInstanceOf(BadRequestException);
    expect(store.orders).toEqual([]);
    expect(store.ledger).toEqual([]);
    expect(killSwitch.isActive).not.toHaveBeenCalled();
  });

  it('modify moves the limit the matcher uses', async () => {
    const { adapter, push } = setup();
    const req = optionBuy();
    const o = await adapter.placeOrder(req);
    await adapter.modify('user_A', o.id, { limitPrice: 99 });
    // 99.5 trades through the old limit 100: a matcher still holding it would fill here.
    await push(o, req, 99.5, undefined, 10);
    expect((await adapter.getOrder('user_A', o.id)).state).toBe('OPEN');
    await push(o, req, 98.95, undefined, 20);
    expect(await adapter.getOrder('user_A', o.id)).toMatchObject({ state: 'FILLED', avgFillPrice: 99 });
  });

  it('modify moves the trigger the matcher uses for a resting stop', async () => {
    const { adapter, push } = setup();
    const req = cashBuy();
    const o = await adapter.placeOrder(req);
    await push(o, req, 500, depth([[500, 100]]));
    const stopReq = cashBuy({ idempotencyKey: 'intent_cash_1:stop', purpose: 'EXIT', side: 'SELL', type: 'SL_MARKET', triggerPrice: 495, refPrice: 495 });
    const stop = await adapter.placeOrder(stopReq);
    await adapter.modify('user_A', stop.id, { triggerPrice: 490 });
    // 494 reaches the old trigger 495: a matcher still holding it would trigger and fill here.
    await push(stop, stopReq, 494, undefined, 10);
    expect(await adapter.getOrder('user_A', stop.id)).toMatchObject({ state: 'OPEN', triggeredAt: null, filledQty: 0 });
    await push(stop, stopReq, 489, undefined, 20);
    expect((await adapter.getOrder('user_A', stop.id)).state).toBe('FILLED');
  });

  it('modify of a triggered stop is a 409 and the matcher keeps the order as it was (ruling P11)', async () => {
    const { adapter, matcher, push } = setup();
    const req = cashBuy();
    const o = await adapter.placeOrder(req);
    await push(o, req, 500, depth([[500, 100]]));
    const stopReq = cashBuy({ idempotencyKey: 'intent_cash_1:stop', purpose: 'EXIT', side: 'SELL', type: 'SL_MARKET', triggerPrice: 495, refPrice: 495 });
    const stop = await adapter.placeOrder(stopReq);
    // Asks only: the trigger is reached but a SELL finds no bids, so it is triggered, unfilled.
    await push(stop, stopReq, 494, depth([[494, 100]]), 10);
    expect((await adapter.getOrder('user_A', stop.id)).triggeredAt).not.toBeNull();
    await expect(adapter.modify('user_A', stop.id, { triggerPrice: 480 })).rejects.toBeInstanceOf(ConflictException);
    expect(matcher.isTracked(stop.id)).toBe(true);
    // Still executing as MARKET on the next usable price.
    await push(stop, stopReq, 500, undefined, 20);
    expect((await adapter.getOrder('user_A', stop.id)).state).toBe('FILLED');
  });

  it('modify of a closed order is a 409 and leaves it untracked', async () => {
    const { adapter, matcher } = setup();
    const o = await adapter.placeOrder(optionBuy());
    await adapter.cancel('user_A', o.id);
    await expect(adapter.modify('user_A', o.id, { limitPrice: 99 })).rejects.toBeInstanceOf(ConflictException);
    expect(matcher.isTracked(o.id)).toBe(false);
  });

  it("orders, positions and funds are the caller's own", async () => {
    const { adapter, matcher, push } = setup();
    const req = optionBuy();
    const o = await adapter.placeOrder(req);
    await expect(adapter.getOrder('user_B', o.id)).rejects.toBeInstanceOf(NotFoundException);
    await expect(adapter.cancel('user_B', o.id)).rejects.toBeInstanceOf(NotFoundException);
    await expect(adapter.modify('user_B', o.id, { limitPrice: 99 })).rejects.toBeInstanceOf(NotFoundException);
    expect(matcher.isTracked(o.id)).toBe(true);
    await push(o, req, 99.5, undefined, 10);
    expect(await adapter.getOrder('user_A', o.id)).toMatchObject({ state: 'FILLED', avgFillPrice: 100 });
    expect(await adapter.getPositions('user_B')).toEqual([]);
    expect(await adapter.getFunds('user_B')).toMatchObject({ deposited: '0.00', freeCash: '0.00', blockedMargin: '0.00' });
  });
});
