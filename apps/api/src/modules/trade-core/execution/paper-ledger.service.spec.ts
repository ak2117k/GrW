import { ConflictException, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PaperLedgerService, type PlaceContext } from './paper-ledger.service';
import type { PaperSettings } from './paper-settings';
import { fakeDefaults, idempotencyKeyViolation, MemoryPaperStore } from './testing/memory-paper-store';
import { cashBuy, mtfBuy, NOW, optionBuy, paperSettings } from './testing/paper-fixtures';

const OPEN: PlaceContext = { sessionOpen: true, killSwitchActive: false };

function setup(settings: PaperSettings | null = paperSettings()) {
  const store = new MemoryPaperStore(() => NOW);
  const svc = new PaperLedgerService(store.tx, store.orderRepo, store.fillRepo, store.ledgerRepo, fakeDefaults(settings));
  return { store, svc };
}

const shown = (store: MemoryPaperStore) => store.ledger.map((r) => [r.type, r.amount.toFixed(2), r.orderId !== null, r.fillId !== null]);
const total = (store: MemoryPaperStore, userId = 'user_A') =>
  store.ledger.filter((r) => r.userId === userId).reduce((a, r) => a.plus(r.amount), new Prisma.Decimal(0)).toFixed(2);

describe('PaperLedgerService.place', () => {
  it('the first order deposits the starting capital and blocks its margin, in one user transaction', async () => {
    const { store, svc } = setup();
    const r = await svc.place(cashBuy(), OPEN, NOW);
    expect(r.created).toBe(true);
    expect(r.settings).not.toBeNull();
    expect(r.order).toMatchObject({ userId: 'user_A', state: 'OPEN', qty: 100, filledQty: 0, rejectReason: null, submittedAt: NOW, triggeredAt: null });
    expect(shown(store)).toEqual([
      ['DEPOSIT', '1000000.00', false, false],
      ['MARGIN_BLOCK', '-10000.00', true, false],
    ]);
    expect(store.txUsers).toEqual(['user_A']);
  });

  it('the same idempotency key twice returns the same order and writes nothing more', async () => {
    const { store, svc } = setup();
    const a = await svc.place(cashBuy(), OPEN, NOW);
    const b = await svc.place(cashBuy(), OPEN, NOW);
    expect(b).toEqual({ order: a.order, created: false, settings: null });
    expect(store.orders).toHaveLength(1);
    expect(store.ledger).toHaveLength(2);
  });

  it('a key that another request inserts between the read and the write returns that order', async () => {
    const { store, svc } = setup();
    const first = await svc.place(cashBuy(), OPEN, NOW);
    jest.spyOn(store.orderRepo, 'findByKey').mockResolvedValueOnce(null).mockResolvedValueOnce(null);
    const raced = await svc.place(cashBuy(), OPEN, NOW);
    expect(raced).toEqual({ order: first.order, created: false, settings: null });
    expect(store.orders).toHaveLength(1);
    expect(store.ledger).toHaveLength(2);
  });

  it('a key already used by another user is refused, never returned', async () => {
    const { store, svc } = setup();
    await svc.place(cashBuy(), OPEN, NOW);
    await expect(svc.place(cashBuy({ userId: 'user_B' }), OPEN, NOW)).rejects.toBeInstanceOf(ConflictException);
    expect(store.orders.filter((o) => o.userId === 'user_B')).toEqual([]);
  });

  it('insufficient free cash rejects the order and blocks nothing', async () => {
    const { store, svc } = setup(paperSettings({ startingCapital: new Prisma.Decimal('1000') }));
    const r = await svc.place(cashBuy(), OPEN, NOW);
    expect(r.order.state).toBe('REJECTED');
    expect(r.order.rejectReason).toBe('insufficient free cash: the order blocks ₹10000.00, ₹1000.00 is free');
    expect(shown(store)).toEqual([['DEPOSIT', '1000.00', false, false]]);
  });

  it('an incomplete settings table rejects every order and deposits nothing', async () => {
    const { store, svc } = setup(null);
    const r = await svc.place(cashBuy(), OPEN, NOW);
    expect(r).toMatchObject({ created: true, settings: null, order: { state: 'REJECTED', rejectReason: 'paper settings are incomplete: startingCapital@ALL' } });
    expect(store.ledger).toEqual([]);
  });

  it('out of session, or an entry while the kill switch is on, is rejected; the kill switch never gates an exit', async () => {
    const { svc } = setup();
    expect((await svc.place(cashBuy({ idempotencyKey: 'k1' }), { sessionOpen: false, killSwitchActive: false }, NOW)).order.rejectReason).toBe('NSE is not in session');
    expect((await svc.place(cashBuy({ idempotencyKey: 'k2' }), { sessionOpen: true, killSwitchActive: true }, NOW)).order.rejectReason).toBe('the kill switch is on: no new entries');
    const exit = await svc.place(cashBuy({ idempotencyKey: 'k3', purpose: 'EXIT', side: 'SELL' }), { sessionOpen: true, killSwitchActive: true }, NOW);
    expect(exit.order.rejectReason).toBe('no open position to exit');
  });

  it('a business rejection is kept with its reason, and the key keeps answering with it', async () => {
    const { store, svc } = setup();
    const r = await svc.place(mtfBuy({ side: 'SELL' }), OPEN, NOW);
    expect(r.order).toMatchObject({ state: 'REJECTED', rejectReason: 'MTF opens only with BUY', side: 'SELL' });
    expect((await svc.place(mtfBuy({ side: 'SELL' }), OPEN, NOW)).order.id).toBe(r.order.id);
    expect(shown(store)).toEqual([['DEPOSIT', '1000000.00', false, false]]);
  });
});

describe('PaperLedgerService.place idempotency (rulings P3, P12)', () => {
  it('(a) the same user and key twice: one order, one DEPOSIT, one MARGIN_BLOCK', async () => {
    const { store, svc } = setup();
    const a = await svc.place(cashBuy(), OPEN, NOW);
    const b = await svc.place(cashBuy(), OPEN, NOW);
    expect(b.order.id).toBe(a.order.id);
    expect(store.orders).toHaveLength(1);
    expect(store.ledger.filter((r) => r.type === 'DEPOSIT')).toHaveLength(1);
    expect(store.ledger.filter((r) => r.type === 'MARGIN_BLOCK')).toHaveLength(1);
  });

  it("(b) another user's key found by findByKey is 409 and nothing of user_B is written", async () => {
    const { store, svc } = setup();
    await svc.place(cashBuy(), OPEN, NOW);
    const err = await svc.place(cashBuy({ userId: 'user_B' }), OPEN, NOW).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ConflictException);
    expect((err as ConflictException).message).not.toContain('user_A');
    expect(store.ledger.filter((r) => r.userId === 'user_B')).toEqual([]);
    expect(store.txUsers).toEqual(['user_A']);
  });

  it('(c) create raising P2002 on idempotencyKey (key hidden by the tenant scope) is 409 and nothing is written', async () => {
    const { store, svc } = setup();
    jest.spyOn(store.orderRepo, 'create').mockRejectedValueOnce(idempotencyKeyViolation());
    await expect(svc.place(cashBuy(), OPEN, NOW)).rejects.toBeInstanceOf(ConflictException);
    expect(store.orders).toEqual([]);
    expect(store.ledger).toEqual([]);
  });

  it("(c') a P2002 race against another user's order hidden from findByKey is 409, never that order", async () => {
    const { store, svc } = setup();
    await svc.place(cashBuy({ userId: 'user_B' }), OPEN, NOW);
    // In request context the tenant extension hides user_B's row from user_A's lookups.
    jest.spyOn(store.orderRepo, 'findByKey').mockResolvedValueOnce(null).mockResolvedValueOnce(null);
    await expect(svc.place(cashBuy(), OPEN, NOW)).rejects.toBeInstanceOf(ConflictException);
    expect(store.orders.filter((o) => o.userId === 'user_A')).toEqual([]);
    expect(store.ledger.filter((r) => r.userId === 'user_A')).toEqual([]);
  });

  it('a P2002 on any other column is not an idempotency conflict and is rethrown', async () => {
    const { store, svc } = setup();
    const other = new Prisma.PrismaClientKnownRequestError('Unique constraint failed on the fields: (`id`)', {
      code: 'P2002',
      clientVersion: 'memory',
      meta: { target: ['id'] },
    });
    jest.spyOn(store.orderRepo, 'create').mockRejectedValueOnce(other);
    await expect(svc.place(cashBuy(), OPEN, NOW)).rejects.toBe(other);
  });
});

describe('PaperLedgerService.close', () => {
  it('a cancel releases exactly the pending margin; cancelling again changes nothing', async () => {
    const { store, svc } = setup();
    const { order } = await svc.place(cashBuy(), OPEN, NOW);
    const c = await svc.close('user_A', order.id, 'CANCEL', 'not needed');
    expect(c.state).toBe('CANCELLED');
    expect(shown(store).slice(2)).toEqual([['MARGIN_RELEASE', '10000.00', true, false]]);
    expect(total(store)).toBe('1000000.00');
    expect(await svc.close('user_A', order.id, 'CANCEL', 'again')).toEqual(c);
    expect(store.ledger).toHaveLength(3);
  });

  it('a reject keeps its reason', async () => {
    const { svc } = setup();
    const { order } = await svc.place(cashBuy(), OPEN, NOW);
    const r = await svc.close('user_A', order.id, 'REJECT', 'no fresh price after submission (waited 30000 ms)');
    expect(r).toMatchObject({ state: 'REJECTED', rejectReason: 'no fresh price after submission (waited 30000 ms)' });
  });

  it("another user's order id is 404", async () => {
    const { svc } = setup();
    const { order } = await svc.place(cashBuy(), OPEN, NOW);
    await expect(svc.close('user_B', order.id, 'CANCEL', 'mine now')).rejects.toBeInstanceOf(NotFoundException);
    await expect(svc.getOrder('user_B', order.id)).rejects.toBeInstanceOf(NotFoundException);
    expect(await svc.findOrder('user_B', order.id)).toBeNull();
  });
});

describe('PaperLedgerService reads', () => {
  it('funds: cash, blocked margin, free cash and margin per vehicle', async () => {
    const { svc } = setup();
    await svc.place(cashBuy(), OPEN, NOW);
    await svc.place(optionBuy(), OPEN, NOW);
    expect(await svc.funds('user_A')).toEqual({
      userId: 'user_A',
      deposited: '1000000.00',
      realisedPnl: '0.00',
      charges: '0.00',
      mtfInterest: '0.00',
      cash: '1000000.00',
      blockedMargin: '25000.00',
      freeCash: '975000.00',
      deployedByVehicle: { CASH_INTRADAY: '10000.00', MTF: '0.00', OPTIONS_BUY: '15000.00' },
    });
  });

  it("dayStats counts today's accepted entries and today's net P&L", async () => {
    const { svc } = setup();
    await svc.place(cashBuy(), OPEN, NOW);
    await svc.place(optionBuy(), OPEN, NOW);
    await svc.place(mtfBuy({ side: 'SELL' }), OPEN, NOW);
    const d = await svc.dayStats('user_A', NOW);
    expect(d.entriesToday).toBe(2);
    expect(d.netPnlToday.toFixed(2)).toBe('0.00');
  });

  it("openOrders is every user's open orders; openOrdersForUser is one user's", async () => {
    const { svc } = setup();
    await svc.place(cashBuy(), OPEN, NOW);
    await svc.place(cashBuy({ userId: 'user_B', idempotencyKey: 'intent_b:entry' }), OPEN, NOW);
    expect((await svc.openOrders()).map((o) => o.userId)).toEqual(['user_A', 'user_B']);
    expect((await svc.openOrdersForUser('user_B')).map((o) => o.userId)).toEqual(['user_B']);
  });
});
