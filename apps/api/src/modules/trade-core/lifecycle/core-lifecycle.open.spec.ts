import { BadRequestException, ConflictException } from '@nestjs/common';
import { corePositionOwner } from './core-lifecycle.service';
import { NOW } from './testing/lifecycle-fixtures';
import { lifecycleHarness, openRequest } from './testing/lifecycle-harness';

beforeEach(() => jest.useFakeTimers({ now: NOW, doNotFake: ['nextTick', 'setImmediate', 'queueMicrotask'] }));
afterEach(() => jest.useRealTimers());

describe('CoreLifecycleService: opening and following the orders (spec §7.1)', () => {
  it('opens PENDING_ENTRY with one MARKET entry keyed <intentId>:entry; the same intent again returns the same position', async () => {
    const h = lifecycleHarness();
    const p = await h.lifecycle.openPosition(openRequest());
    expect(p).toMatchObject({ status: 'PENDING_ENTRY', requestedQty: 100, underlying: 'RELIANCE', direction: 'LONG', strategyId: 'cs_ungated' });
    expect(h.ordersOf(p.id).map((o) => [o.idempotencyKey, o.type, o.side, o.qty, o.purpose])).toEqual([['int_1:entry', 'MARKET', 'BUY', 100, 'ENTRY']]);
    expect((await h.lifecycle.openPosition(openRequest())).id).toBe(p.id);
    expect(h.paper.orders).toHaveLength(1);
    expect(h.sink.types(p.id)).toEqual(['POSITION_STATE']);
  });

  it('the entry fill makes it OPEN, arms its levels from the fill and watches the instrument at P0', async () => {
    const h = lifecycleHarness();
    const p = await h.lifecycle.openPosition(openRequest());
    await h.price(500);
    const open = h.positions.rows.find((x) => x.id === p.id);
    expect(open).toMatchObject({ status: 'OPEN', entryFilledQty: 100, openQty: 100, entryAvgPrice: 500, initialStopPrice: 492.5, stopPrice: 492.5, targetPrice: 515, highWater: 500, lowWater: 500 });
    expect(open?.openedAt).not.toBeNull();
    expect(h.hub.watches).toEqual(expect.arrayContaining([{ key: 'NSE:2885', priority: 0, owner: corePositionOwner(p.id) }]));
    expect(h.sink.events.filter((e) => e.type === 'POSITION_STATE').map((e) => e.payload.to)).toEqual(['PENDING_ENTRY', 'OPEN']);
    expect(h.lifecycle.mark(p.id)).toMatchObject({ ltp: 500 });
  });

  it('refuses what it cannot open, before any order or row exists', async () => {
    const h = lifecycleHarness();
    await expect(h.lifecycle.openPosition(openRequest({}, { strategyVersionId: 'csv_draft' }))).rejects.toThrow('is DRAFT; only PAPER versions trade in SP2');
    await expect(h.lifecycle.openPosition(openRequest({}, { strategyVersionId: 'csv_missing' }))).rejects.toBeInstanceOf(BadRequestException);
    await expect(h.lifecycle.openPosition(openRequest({}, { symbol: 'RELIANCE' }))).rejects.toThrow('instrument RELIANCE-EQ is not the intent');
    await expect(h.lifecycle.openPosition(openRequest({ qty: 101 }))).rejects.toThrow('the verdict may only reduce');
    await expect(h.lifecycle.openPosition(openRequest({ limits: [] }))).rejects.toThrow('squareOffTime@CASH_INTRADAY is missing');
    expect(h.paper.orders).toHaveLength(0);
    expect(h.positions.rows).toHaveLength(0);
  });

  it('a second active position on the same instrument is a 409; another user is unaffected', async () => {
    const h = lifecycleHarness();
    await h.lifecycle.openPosition(openRequest());
    await expect(h.lifecycle.openPosition(openRequest({}, { intentId: 'int_2' }))).rejects.toBeInstanceOf(ConflictException);
    await expect(h.lifecycle.openPosition(openRequest({}, { intentId: 'int_b', userId: 'user_B' }))).resolves.toMatchObject({ userId: 'user_B' });
  });

  it("another user's intent id is a 409, never that user's position", async () => {
    const h = lifecycleHarness();
    await h.lifecycle.openPosition(openRequest());
    await expect(h.lifecycle.openPosition(openRequest({}, { userId: 'user_B' }))).rejects.toBeInstanceOf(ConflictException);
  });

  it('an entry rejected for want of a price ends CANCELLED and the position is let go', async () => {
    const h = lifecycleHarness();
    const p = await h.lifecycle.openPosition(openRequest());
    h.advance(30_001);
    await h.sweep();
    expect(h.positions.rows[0]).toMatchObject({ id: p.id, status: 'CANCELLED' });
    expect(h.positions.rows[0].closedAt).not.toBeNull();
    expect(h.lifecycle.activeCount()).toBe(0);
  });

  it('a missed order update is caught by the 5 s re-read (ruling L3)', async () => {
    const h = lifecycleHarness({ subscribe: false });
    const p = await h.lifecycle.openPosition(openRequest());
    await h.price(500);
    expect(h.positions.rows[0].status).toBe('PENDING_ENTRY');
    h.advance(5_000);
    await h.lifecycle.sweep(Date.now());
    await h.settle();
    expect(h.positions.rows[0]).toMatchObject({ id: p.id, status: 'OPEN', entryAvgPrice: 500 });
  });

  it('an entry that cannot be placed leaves no PENDING ghost: the position is CANCELLED and the error surfaces', async () => {
    const h = lifecycleHarness();
    jest.spyOn(h.adapter, 'placeOrder').mockRejectedValueOnce(new Error('ledger down'));
    await expect(h.lifecycle.openPosition(openRequest())).rejects.toThrow('ledger down');
    expect(h.positions.rows[0]).toMatchObject({ status: 'CANCELLED' });
    expect(h.lifecycle.activeCount()).toBe(0);
  });
});
