import type { ModuleRef } from '@nestjs/core';
import { Prisma } from '@prisma/client';
import type { CoreKillSwitchService } from '../risk-wall/services/core-kill-switch.service';
import type { CoreOrder } from './execution.types';
import { CoreOrderEvents } from './order-events';
import { PaperExecutionAdapter } from './paper-execution.adapter';
import { PaperLedgerService, type PlaceContext } from './paper-ledger.service';
import { PaperMatcherService } from './paper-matcher.service';
import { FakeHub, fakeHubSource, fakeModuleRef } from './testing/fake-hub';
import { fakeDefaults, MemoryPaperStore } from './testing/memory-paper-store';
import { cashBuy, NOW } from './testing/paper-fixtures';

const OPEN: PlaceContext = { sessionOpen: true, killSwitchActive: false };
const D = (s: string) => new Prisma.Decimal(s);

function setup() {
  const store = new MemoryPaperStore(() => NOW);
  const events = new CoreOrderEvents();
  const defaults = fakeDefaults();
  const ledger = new PaperLedgerService(store.tx, store.orderRepo, store.fillRepo, store.ledgerRepo, defaults, events);
  const seen: CoreOrder[] = [];
  events.subscribe((o) => seen.push(o));
  return { store, events, ledger, defaults, seen };
}

describe('order updates (ruling L3)', () => {
  it('emits once per committed placement, fill and cancel, carrying the positionId', async () => {
    const { ledger, seen } = setup();
    const placed = (await ledger.place(cashBuy({ positionId: 'pos_1' }), OPEN, NOW)).order;
    expect(placed.positionId).toBe('pos_1');
    const filled = await ledger.applyFill('user_A', placed.id, placed, { qty: 40, price: D('500'), priceAt: new Date(NOW.getTime() + 5) }, NOW);
    expect(filled?.state).toBe('PARTIAL');
    await ledger.close('user_A', placed.id, 'CANCEL', 'test');
    expect(seen.map((o) => [o.state, o.filledQty, o.positionId])).toEqual([
      ['OPEN', 0, 'pos_1'],
      ['PARTIAL', 40, 'pos_1'],
      ['CANCELLED', 40, 'pos_1'],
    ]);
  });

  it('a placement replay and a refused fill emit nothing', async () => {
    const { ledger, seen } = setup();
    const placed = (await ledger.place(cashBuy(), OPEN, NOW)).order;
    await ledger.place(cashBuy(), OPEN, NOW);
    expect(await ledger.applyFill('user_A', placed.id, { ...placed, filledQty: 7 }, { qty: 10, price: D('500'), priceAt: NOW }, NOW)).toBeNull();
    expect(seen).toHaveLength(1);
  });

  it('a throwing listener never fails the write', async () => {
    const { ledger, events, seen } = setup();
    events.subscribe(() => {
      throw new Error('listener bug');
    });
    await expect(ledger.place(cashBuy(), OPEN, NOW)).resolves.toMatchObject({ created: true });
    expect(seen).toHaveLength(1);
  });

  it('the adapter exposes the stream and the position orders; unsubscribe stops delivery', async () => {
    const { ledger, defaults } = setup();
    const matcher = new PaperMatcherService(ledger, defaults, fakeModuleRef(fakeHubSource({ user_A: new FakeHub() })) as unknown as ModuleRef, { isOpen: () => true });
    const adapter = new PaperExecutionAdapter(ledger, matcher, { isActive: async () => false } as unknown as CoreKillSwitchService, { isOpen: () => true });
    const got: string[] = [];
    const off = adapter.onOrderUpdate((o) => got.push(o.idempotencyKey));
    await adapter.placeOrder(cashBuy({ positionId: 'pos_1' }));
    off();
    await adapter.placeOrder(cashBuy({ idempotencyKey: 'other:entry', instrument: { exchange: 'NSE', token: '1594', symbol: 'INFY-EQ', lotSize: 1, underlying: null } }));
    expect(got).toEqual(['intent_cash_1:entry']);
    expect((await adapter.listPositionOrders('user_A', 'pos_1')).map((o) => o.idempotencyKey)).toEqual(['intent_cash_1:entry']);
    expect(await adapter.listPositionOrders('user_B', 'pos_1')).toEqual([]);
  });
});

describe('netPnlTodayByPosition', () => {
  it("sums today's realised P&L and charges of each position's orders", async () => {
    const { ledger } = setup();
    const entry = (await ledger.place(cashBuy({ positionId: 'pos_1' }), OPEN, NOW)).order;
    await ledger.applyFill('user_A', entry.id, entry, { qty: 100, price: D('500'), priceAt: NOW }, NOW);
    const exit = (await ledger.place(cashBuy({ idempotencyKey: 'intent_cash_1:exit:1', purpose: 'EXIT', side: 'SELL', positionId: 'pos_1', refPrice: 510 }), OPEN, NOW)).order;
    await ledger.applyFill('user_A', exit.id, exit, { qty: 100, price: D('510'), priceAt: NOW }, NOW);
    const byPos = await ledger.netPnlTodayByPosition('user_A', NOW);
    const funds = await ledger.funds('user_A');
    expect([...byPos.keys()]).toEqual(['pos_1']);
    // gross 1000.00 minus both legs' charges = the user's realised minus charges
    expect(byPos.get('pos_1')?.toFixed(2)).toBe(D(funds.realisedPnl).minus(D(funds.charges)).toFixed(2));
    expect(await ledger.netPnlTodayByPosition('user_A', new Date(NOW.getTime() + 86_400_000))).toEqual(new Map());
  });
});
