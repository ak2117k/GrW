import type { CoreOrder, ExecutionAdapter } from '../execution/execution.types';
import type { PaperLedgerService } from '../execution/paper-ledger.service';
import { NOW } from '../lifecycle/testing/lifecycle-fixtures';
import { lifecycleHarness, openRequest } from '../lifecycle/testing/lifecycle-harness';
import { OrderJournaler } from './order-journaler';
import { FakeJournal } from './testing/fake-journal';

beforeEach(() => jest.useFakeTimers({ now: NOW, doNotFake: ['nextTick', 'setImmediate', 'queueMicrotask'] }));
afterEach(() => jest.useRealTimers());

async function settleJournaler() {
  for (let i = 0; i < 5; i += 1) await new Promise((r) => setImmediate(r));
}

describe('OrderJournaler (spec §8.1 ORDER_PLACED, ORDER_STATE, FILL)', () => {
  it('journals placement, each state and each fill once, keyed for idempotence, with the position', async () => {
    const h = lifecycleHarness();
    const journal = new FakeJournal();
    const oj = new OrderJournaler(h.adapter, h.ledger, journal);
    oj.onModuleInit();
    const p = await h.lifecycle.openPosition(openRequest());
    await h.price(500);
    await settleJournaler();
    const entry = h.ordersOf(p.id)[0];
    // Every emission of the order repeats ORDER_PLACED under the same key; the store keeps one (J11).
    const placed = journal.ofType('ORDER_PLACED');
    expect(new Set(placed.map((x) => x.dedupeKey)).size).toBe(1);
    expect([placed[0]]).toEqual([
      expect.objectContaining({ positionId: p.id, symbol: 'RELIANCE-EQ', dedupeKey: `order:${entry.id}:placed`, payload: expect.objectContaining({ orderId: entry.id, purpose: 'ENTRY', side: 'BUY', qty: 100 }) }),
    ]);
    expect(journal.ofType('ORDER_STATE').map((x) => x.payload.state)).toContain('FILLED');
    const fills = journal.ofType('FILL');
    // FakeJournal does not dedupe; the store does, by key — so one fill means one distinct key.
    const keys = [...new Set(fills.map((f) => f.dedupeKey))];
    expect(keys).toHaveLength(1);
    expect(keys[0]).toMatch(/^fill:/);
    expect(fills[0]).toMatchObject({ positionId: p.id, priceUsed: 500, payload: expect.objectContaining({ orderId: entry.id, qty: 100, price: '500.0000' }) });
    oj.onModuleDestroy();
  });

  it('a fill read failure is logged; the order rows are still written', async () => {
    const order: CoreOrder = {
      id: 'ord_x', userId: 'user_A', idempotencyKey: 'ci_1:entry', vehicle: 'CASH_INTRADAY',
      instrument: { exchange: 'NSE', token: '2885', symbol: 'RELIANCE-EQ', lotSize: 1, underlying: null },
      side: 'BUY', qty: 10, filledQty: 10, avgFillPrice: 500, type: 'MARKET', limitPrice: null, triggerPrice: null, refPrice: 500,
      purpose: 'ENTRY', strategyVersionId: 'csv_x', positionId: 'pos_1', state: 'FILLED', rejectReason: null,
      submittedAt: NOW, triggeredAt: null, updatedAt: NOW,
    };
    const journal = new FakeJournal();
    const adapter = { onOrderUpdate: jest.fn(() => () => undefined) };
    const ledger = { fillsFor: jest.fn().mockRejectedValue(new Error('db down')) };
    const oj = new OrderJournaler(adapter as unknown as ExecutionAdapter, ledger as unknown as PaperLedgerService, journal);
    await oj.onOrder(order);
    expect(journal.types()).toEqual(['ORDER_PLACED', 'ORDER_STATE']);
    expect(journal.entries[1]).toMatchObject({ dedupeKey: 'order:ord_x:FILLED:10', positionId: 'pos_1' });
  });

  it('a journal that throws never rejects back into the order stream (fail open)', async () => {
    const journal = new FakeJournal();
    journal.record = () => {
      throw new Error('journal down');
    };
    const adapter = { onOrderUpdate: jest.fn(() => () => undefined) };
    const ledger = { fillsFor: jest.fn().mockResolvedValue([]) };
    const oj = new OrderJournaler(adapter as unknown as ExecutionAdapter, ledger as unknown as PaperLedgerService, journal);
    const order = { id: 'ord_y', userId: 'user_A', instrument: { symbol: 'RELIANCE-EQ' }, state: 'NEW', filledQty: 0, submittedAt: NOW, updatedAt: NOW } as unknown as CoreOrder;
    await expect(oj.onOrder(order)).resolves.toBeUndefined();
  });
});
