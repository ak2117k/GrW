import { ConflictException, Logger, NotFoundException } from '@nestjs/common';
import type { ModuleRef } from '@nestjs/core';
import type { HubPrices } from '../../market-hub/hub-prices';
import type { CoreKillSwitchService } from '../risk-wall/services/core-kill-switch.service';
import type { CoreOrder, CoreOrderRequest } from './execution.types';
import { PaperExecutionAdapter } from './paper-execution.adapter';
import { PaperLedgerService } from './paper-ledger.service';
import { coreOrderOwner, PaperMatcherService } from './paper-matcher.service';
import { PaperOrderSquareOff } from './paper-order-square-off';
import { PaperRiskStateProvider } from './paper-risk-state.provider';
import { FakeHub, fakeHubSource, fakeModuleRef } from './testing/fake-hub';
import { fakeDefaults, MemoryPaperStore } from './testing/memory-paper-store';
import { cashBuy, depth, hubPrice } from './testing/paper-fixtures';

/**
 * Each user gets their OWN FakeHub, so an order watched or matched on the wrong user's hub
 * shows up as a missing fill, a stray watch or a fill from the other user's price.
 */
function setup(opts: { serveB?: boolean } = {}) {
  const store = new MemoryPaperStore();
  const defaults = fakeDefaults();
  const ledger = new PaperLedgerService(store.tx, store.orderRepo, store.fillRepo, store.ledgerRepo, defaults);
  const hubA = new FakeHub();
  const hubB = new FakeHub();
  const hubs: Record<string, HubPrices> = { user_A: hubA, ...(opts.serveB === false ? {} : { user_B: hubB }) };
  const clock = { isOpen: () => true };
  const matcher = new PaperMatcherService(ledger, defaults, fakeModuleRef(fakeHubSource(hubs)) as unknown as ModuleRef, clock);
  const killed = new Set<string>();
  const killSwitch = { isActive: async (userId: string) => killed.has(userId) };
  const adapter = new PaperExecutionAdapter(ledger, matcher, killSwitch as unknown as CoreKillSwitchService, clock);
  const hubOf = (userId: string): FakeHub => (userId === 'user_A' ? hubA : hubB);
  /** A price 10 ms after submission, pushed on `hub` (default: the order's own user's hub), evaluated 1 ms later. */
  const fill = async (o: CoreOrder, req: CoreOrderRequest, ltp: number, hub: FakeHub = hubOf(o.userId)) => {
    const at = o.submittedAt.getTime() + 10;
    await matcher.onPrice(hub, hubPrice(req, ltp, at, depth([[ltp, 1000]], [[ltp, 1000]])), at + 1);
  };
  return { store, ledger, matcher, adapter, fill, hubA, hubB, killed };
}

describe("tenant isolation (spec §6: user A's orders, fills and ledger never appear for user B)", () => {
  it('two users trading the same symbol keep separate orders, fills, ledgers and positions', async () => {
    const { store, adapter, fill } = setup();
    const aReq = cashBuy();
    const bReq = cashBuy({ userId: 'user_B', idempotencyKey: 'intent_b:entry', qty: 10 });
    await fill(await adapter.placeOrder(aReq), aReq, 500);
    await fill(await adapter.placeOrder(bReq), bReq, 500);
    const aExit = cashBuy({ idempotencyKey: 'intent_a:exit', purpose: 'EXIT', side: 'SELL', refPrice: 510 });
    await fill(await adapter.placeOrder(aExit), aExit, 510);

    expect((await adapter.getPositions('user_A')).map((p) => p.netQty)).toEqual([]);
    expect((await adapter.getPositions('user_B')).map((p) => p.netQty)).toEqual([10]);
    expect((await adapter.getFunds('user_B')).realisedPnl).toBe('0.00');
    expect((await adapter.getFunds('user_A')).realisedPnl).toBe('1000.00');
    const ownerOf = new Map(store.orders.map((o) => [o.id, o.userId]));
    for (const f of store.fills) expect(ownerOf.get(f.orderId)).toBe(f.userId);
    for (const r of store.ledger) if (r.orderId) expect(ownerOf.get(r.orderId)).toBe(r.userId);
    expect(new Set(store.txUsers)).toEqual(new Set(['user_A', 'user_B']));
  });

  it("another user's idempotency key is refused, never answered with that user's order", async () => {
    const { adapter } = setup();
    await adapter.placeOrder(cashBuy());
    await expect(adapter.placeOrder(cashBuy({ userId: 'user_B' }))).rejects.toBeInstanceOf(ConflictException);
  });

  it("user B cannot read, cancel or modify user A's order", async () => {
    const { adapter } = setup();
    const o = await adapter.placeOrder(cashBuy({ type: 'LIMIT', limitPrice: 400 }));
    await expect(adapter.getOrder('user_B', o.id)).rejects.toBeInstanceOf(NotFoundException);
    await expect(adapter.cancel('user_B', o.id)).rejects.toBeInstanceOf(NotFoundException);
    await expect(adapter.modify('user_B', o.id, { limitPrice: 390 })).rejects.toBeInstanceOf(NotFoundException);
    expect((await adapter.getOrder('user_A', o.id)).state).toBe('OPEN');
  });

  it("a user the hub does not serve gets no fills, only a no-price reject, and the served user's order fills", async () => {
    const log = jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    const { matcher, adapter, fill, hubA } = setup({ serveB: false });
    const aReq = cashBuy();
    const bReq = cashBuy({ userId: 'user_B', idempotencyKey: 'kb' });
    const a = await adapter.placeOrder(aReq);
    const b = await adapter.placeOrder(bReq);
    await fill(a, aReq, 500);
    // B's order is never priced by A's hub, even on the same token.
    await fill(b, bReq, 500, hubA);
    await matcher.sweep(b.submittedAt.getTime() + 30_001);
    expect((await adapter.getOrder('user_A', a.id)).state).toBe('FILLED');
    expect(await adapter.getOrder('user_B', b.id)).toMatchObject({ state: 'REJECTED', rejectReason: 'no fresh price after submission (waited 30000 ms)' });
    expect((await adapter.getFunds('user_B')).freeCash).toBe('1000000.00');
    expect(log).toHaveBeenCalledWith('reloaded 1 open core order(s)');
    log.mockRestore();
  });

  it("each order is watched and matched on its own user's hub only: A's price never fills B's order on the same token", async () => {
    const { matcher, adapter, fill, hubA, hubB } = setup();
    const aReq = cashBuy();
    const bReq = cashBuy({ userId: 'user_B', idempotencyKey: 'intent_b:entry', qty: 10 });
    const a = await adapter.placeOrder(aReq);
    const b = await adapter.placeOrder(bReq);
    expect(hubA.watches.map((w) => w.owner)).toEqual([coreOrderOwner(a.id)]);
    expect(hubB.watches.map((w) => w.owner)).toEqual([coreOrderOwner(b.id)]);

    await fill(a, aReq, 500, hubA);
    expect((await adapter.getOrder('user_A', a.id)).state).toBe('FILLED');
    expect((await adapter.getOrder('user_B', b.id)).state).toBe('OPEN');
    expect(matcher.isTracked(b.id)).toBe(true);
    expect(await adapter.getPositions('user_B')).toEqual([]);

    await fill(b, bReq, 501, hubB);
    expect(await adapter.getOrder('user_B', b.id)).toMatchObject({ state: 'FILLED', filledQty: 10 });
    expect((await adapter.getPositions('user_A')).map((p) => p.netQty)).toEqual([100]);
    expect(hubA.unwatches.map((w) => w.owner)).toEqual([coreOrderOwner(a.id)]);
    expect(hubB.unwatches.map((w) => w.owner)).toEqual([coreOrderOwner(b.id)]);
  });

  it("user A's kill switch refuses A's entries only, and A's square-off cancels A's pending orders only", async () => {
    const { ledger, matcher, adapter, hubA, hubB, killed } = setup();
    const a = await adapter.placeOrder(cashBuy({ type: 'LIMIT', limitPrice: 400 }));
    const b = await adapter.placeOrder(cashBuy({ userId: 'user_B', idempotencyKey: 'intent_b:entry', type: 'LIMIT', limitPrice: 400 }));
    const bFundsBefore = await adapter.getFunds('user_B');
    expect(bFundsBefore.blockedMargin).not.toBe('0.00');

    killed.add('user_A');
    const aRefused = await adapter.placeOrder(cashBuy({ idempotencyKey: 'intent_a2:entry', type: 'LIMIT', limitPrice: 400 }));
    expect(aRefused).toMatchObject({ state: 'REJECTED', rejectReason: 'the kill switch is on: no new entries' });
    const bAllowed = await adapter.placeOrder(cashBuy({ userId: 'user_B', idempotencyKey: 'intent_b2:entry', type: 'LIMIT', limitPrice: 400 }));
    expect(bAllowed.state).toBe('OPEN');

    const r = await new PaperOrderSquareOff(ledger, matcher).squareOffAll('user_A', 'KILL_SWITCH', 'stop everything');
    expect(r.cancelledOrders).toBe(1);
    expect((await adapter.getOrder('user_A', a.id)).state).toBe('CANCELLED');
    expect((await adapter.getFunds('user_A')).blockedMargin).toBe('0.00');
    expect(matcher.isTracked(a.id)).toBe(false);
    expect(hubA.unwatches.map((w) => w.owner)).toEqual([coreOrderOwner(a.id)]);

    expect((await adapter.getOrder('user_B', b.id)).state).toBe('OPEN');
    expect((await adapter.getOrder('user_B', bAllowed.id)).state).toBe('OPEN');
    expect(matcher.isTracked(b.id)).toBe(true);
    expect(matcher.isTracked(bAllowed.id)).toBe(true);
    expect(hubB.unwatches).toEqual([]);
    const bFundsAfter = await adapter.getFunds('user_B');
    expect(bFundsAfter.freeCash).not.toBe(bFundsBefore.freeCash); // B's own second order blocked B's margin
    expect(bFundsAfter.deposited).toBe(bFundsBefore.deposited);
  });

  it("the risk state of user B never includes user A's positions or entries", async () => {
    const { ledger, adapter, fill } = setup();
    const provider = new PaperRiskStateProvider(ledger);
    const at = new Date();
    await adapter.placeOrder(cashBuy({ userId: 'user_B', idempotencyKey: 'intent_b:entry', type: 'LIMIT', limitPrice: 400 }));
    const bAlone = await provider.liveState('user_B', at);
    expect(bAlone.openPositions).toEqual([]);
    expect(bAlone.tradesToday).toBe(1); // B's own pending entry

    const aReq = cashBuy();
    await fill(await adapter.placeOrder(aReq), aReq, 500);
    const aExit = cashBuy({ idempotencyKey: 'intent_a:exit', purpose: 'EXIT', side: 'SELL', qty: 40, refPrice: 510 });
    await fill(await adapter.placeOrder(aExit), aExit, 510);
    await adapter.placeOrder(cashBuy({ idempotencyKey: 'intent_a2:entry', type: 'LIMIT', limitPrice: 400 }));

    expect(await provider.liveState('user_B', at)).toEqual(bAlone);
    const a = await provider.liveState('user_A', at);
    expect(a.openPositions.map((p) => p.positionId)).toEqual(['CASH_INTRADAY:2885']);
    expect(a.tradesToday).toBe(2);
    expect(a.realisedPnlToday).not.toBe(0);
    expect(a.deployedCapital.CASH_INTRADAY).not.toBe(bAlone.deployedCapital.CASH_INTRADAY);
  });
});
