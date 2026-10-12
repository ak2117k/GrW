import type { ModuleRef } from '@nestjs/core';
import type { CoreKillSwitch } from '@prisma/client';
import { Prisma } from '@prisma/client';
import type { AuditService } from '../../../common/audit/audit.service';
import { createCoreSessionClock } from '../risk-wall/ports';
import type { CoreKillSwitchRepository, NewKillSwitchRow } from '../risk-wall/repositories/core-kill-switch.repository';
import { CoreKillSwitchService } from '../risk-wall/services/core-kill-switch.service';
import type { SiloSquareOffAdapter } from '../risk-wall/services/silo-square-off.adapter';
import { coreOrderOwner, PaperMatcherService } from './paper-matcher.service';
import { PaperLedgerService, type PlaceContext } from './paper-ledger.service';
import { PaperOrderSquareOff } from './paper-order-square-off';
import { FakeHub, fakeHubSource, fakeModuleRef } from './testing/fake-hub';
import { fakeDefaults, MemoryPaperStore } from './testing/memory-paper-store';
import { cashBuy, NOW, optionBuy } from './testing/paper-fixtures';

const OPEN: PlaceContext = { sessionOpen: true, killSwitchActive: false };
const D = (s: string) => new Prisma.Decimal(s);

function setup() {
  const store = new MemoryPaperStore(() => NOW);
  const defaults = fakeDefaults();
  const hub = new FakeHub();
  const ledger = new PaperLedgerService(store.tx, store.orderRepo, store.fillRepo, store.ledgerRepo, defaults);
  const matcher = new PaperMatcherService(ledger, defaults, fakeModuleRef(fakeHubSource({ user_A: hub })) as unknown as ModuleRef, { isOpen: () => true });
  return { store, hub, ledger, matcher, squareOff: new PaperOrderSquareOff(ledger, matcher) };
}

describe('CORE_SQUARE_OFF (paper)', () => {
  it("cancels every pending core order of the user and nothing of another user's", async () => {
    const { store, ledger, matcher, squareOff } = setup();
    const a1 = (await ledger.place(cashBuy(), OPEN, NOW)).order;
    const a2 = (await ledger.place(optionBuy(), OPEN, NOW)).order;
    const b1 = (await ledger.place(cashBuy({ userId: 'user_B', idempotencyKey: 'kb' }), OPEN, NOW)).order;
    for (const o of [a1, a2, b1]) matcher.track(o, 30_000, NOW.getTime());
    expect(await squareOff.squareOffAll('user_A', 'KILL_SWITCH', 'stop everything')).toEqual({
      cancelledOrders: 2,
      exitsRequested: 0,
      detail: '2 pending core entry order(s) cancelled',
    });
    expect(store.orders.map((o) => [o.userId, o.state])).toEqual([['user_A', 'CANCELLED'], ['user_A', 'CANCELLED'], ['user_B', 'OPEN']]);
    expect([a1, a2, b1].map((o) => matcher.isTracked(o.id))).toEqual([false, false, true]);
  });

  it('a failed cancellation makes the step fail, never a silent partial OK', async () => {
    const { ledger, squareOff } = setup();
    await ledger.place(cashBuy(), OPEN, NOW);
    await ledger.place(optionBuy(), OPEN, NOW);
    jest.spyOn(ledger, 'close').mockRejectedValueOnce(new Error('db down'));
    await expect(squareOff.squareOffAll('user_A', 'KILL_SWITCH', 'stop')).rejects.toThrow('cancelled 1 of 2 pending core entry orders; failed: ');
  });

  it('leaves exit orders alone: they are the square-off of open positions (ruling L14)', async () => {
    const { store, ledger, squareOff } = setup();
    const entry = (await ledger.place(cashBuy(), OPEN, NOW)).order;
    await ledger.applyFill('user_A', entry.id, entry, { qty: 100, price: D('500'), priceAt: NOW }, NOW);
    const exit = (await ledger.place(cashBuy({ idempotencyKey: 'intent_cash_1:exit:1', purpose: 'EXIT', side: 'SELL', type: 'LIMIT', limitPrice: 600 }), OPEN, NOW)).order;
    const pending = (await ledger.place(optionBuy(), OPEN, NOW)).order;
    expect(await squareOff.squareOffAll('user_A', 'KILL_SWITCH', 'stop')).toEqual({ cancelledOrders: 1, exitsRequested: 0, detail: '1 pending core entry order(s) cancelled' });
    expect(store.orders.find((o) => o.id === exit.id)?.state).toBe('OPEN');
    expect(store.orders.find((o) => o.id === pending.id)?.state).toBe('CANCELLED');
  });
});

/** Minimal CoreKillSwitchRepository with the append-only contract the service needs. */
class MemoryKillRepo {
  rows: CoreKillSwitch[] = [];

  async listForUser(userId: string) {
    return this.rows.filter((r) => r.userId === userId);
  }

  async append(userId: string, row: NewKillSwitchRow, now: Date) {
    const r = { id: `ks_${this.rows.length + 1}`, userId, ...row, createdAt: now } as CoreKillSwitch;
    this.rows.push(r);
    return r;
  }
}

describe('kill switch ON → CORE_SQUARE_OFF (paper)', () => {
  it("cancels the user's pending core orders, releases their margin and hub watches, then runs the silos", async () => {
    const { store, hub, ledger, matcher, squareOff } = setup();
    const a1 = (await ledger.place(cashBuy(), OPEN, NOW)).order;
    const a2 = (await ledger.place(optionBuy(), OPEN, NOW)).order;
    for (const o of [a1, a2]) matcher.track(o, 30_000, NOW.getTime());
    expect((await ledger.funds('user_A')).blockedMargin).not.toBe('0.00');
    expect(hub.watches.map((w) => w.owner)).toEqual([coreOrderOwner(a1.id), coreOrderOwner(a2.id)]);

    const silos = { squareOffAll: jest.fn().mockResolvedValue([{ target: 'auto-execution', status: 'OK', detail: 'set' }]) };
    const kill = new CoreKillSwitchService(
      new MemoryKillRepo() as unknown as CoreKillSwitchRepository,
      { append: jest.fn().mockResolvedValue({ seq: 1n, hash: 'h' }) } as unknown as AuditService,
      createCoreSessionClock(),
      squareOff,
      silos as unknown as SiloSquareOffAdapter,
    );
    const r = await kill.set({ userId: 'user_A', role: 'USER' }, { active: true, reason: 'stop' }, NOW);

    expect(r.cascade?.core).toEqual({
      status: 'OK',
      detail: '2 pending core entry order(s) cancelled (cancelled 2 orders, requested 0 exits)',
    });
    expect(silos.squareOffAll).toHaveBeenCalledTimes(1);
    expect(store.orders.map((o) => o.state)).toEqual(['CANCELLED', 'CANCELLED']);
    expect((await ledger.funds('user_A')).blockedMargin).toBe('0.00');
    expect(store.ledger.filter((e) => e.type === 'MARGIN_RELEASE').map((e) => e.orderId)).toEqual([a1.id, a2.id]);
    expect([a1, a2].map((o) => matcher.isTracked(o.id))).toEqual([false, false]);
    expect(hub.unwatches.map((w) => w.owner)).toEqual([coreOrderOwner(a1.id), coreOrderOwner(a2.id)]);
  });
});
