import { Prisma } from '@prisma/client';
import { PaperLedgerService } from '../paper-ledger.service';
import type { PaperDb } from '../repositories/core-order.repository';
import { fakeDefaults, MemoryPaperStore } from './memory-paper-store';
import { cashBuy, NOW } from './paper-fixtures';

const OPEN = { sessionOpen: true, killSwitchActive: false };

async function seeded() {
  const store = new MemoryPaperStore(() => NOW);
  const svc = new PaperLedgerService(store.tx, store.orderRepo, store.fillRepo, store.ledgerRepo, fakeDefaults());
  const { order } = await svc.place(cashBuy(), OPEN, NOW);
  return { store, order };
}

const image = (store: MemoryPaperStore) => ({
  orders: store.orders.map((o) => ({ ...o, instrument: { ...o.instrument } })),
  fills: store.fills.map((f) => ({ ...f })),
  ledger: store.ledger.map((r) => ({ ...r })),
});

describe('MemoryPaperStore (ruling P13)', () => {
  it('a run that writes an order update and a ledger row and then throws leaves the store exactly as before', async () => {
    const { store, order } = await seeded();
    const before = image(store);
    const boom = new Error('boom after the writes');
    await expect(
      store.tx.run('user_A', async (db) => {
        await store.orderRepo.update('user_A', order.id, { state: 'OPEN', filledQty: 0 }, { state: 'CANCELLED', rejectReason: null }, db);
        await store.ledgerRepo.append([{ userId: 'user_A', type: 'MARGIN_RELEASE', amount: new Prisma.Decimal('10000'), orderId: order.id, note: 'x' }], db);
        expect(store.orders[0].state).toBe('CANCELLED');
        expect(store.ledger).toHaveLength(3);
        throw boom;
      }),
    ).rejects.toBe(boom);
    expect(image(store)).toEqual(before);
    expect(store.orders[0].state).toBe('OPEN');
  });

  it('reads return copies: mutating a returned ledger row, fill or order never changes the store', async () => {
    const { store, order } = await seeded();
    await store.tx.run('user_A', (db) =>
      store.fillRepo.create(
        { orderId: order.id, userId: 'user_A', price: new Prisma.Decimal('500'), qty: 100, charges: { total: 1 } as never, chargesTotal: new Prisma.Decimal('1'), priceAt: NOW },
        db,
      ),
    );
    const before = image(store);
    const rows = await store.ledgerRepo.listForUser('user_A');
    rows[0].amount = new Prisma.Decimal('999');
    rows.push(rows[0]);
    const fills = await store.fillRepo.listForOrders('user_A', [order.id]);
    fills[0].qty = 1;
    (fills[0].charges as unknown as { total: number }).total = 99;
    const userFills = await store.fillRepo.listForUser('user_A');
    userFills[0].qty = 2;
    const o = await store.orderRepo.findForUser('user_A', order.id);
    (o as { state: string }).state = 'FILLED';
    expect(image(store)).toEqual(before);
    expect((store.fills[0].charges as unknown as { total: number }).total).toBe(1);
  });

  it('writes need the run db; reads inside a run need it; reads outside a run take none', async () => {
    const { store, order } = await seeded();
    const other = {} as PaperDb;
    await expect(store.orderRepo.update('user_A', order.id, { state: 'OPEN', filledQty: 0 }, { state: 'CANCELLED' }, undefined as never)).rejects.toThrow(/inside tx.run/);
    await expect(store.ledgerRepo.append([], store.db)).rejects.toThrow(/inside tx.run/);
    await expect(store.tx.run('user_A', () => store.ledgerRepo.append([], other))).rejects.toThrow(/inside tx.run/);
    await expect(store.tx.run('user_A', () => store.ledgerRepo.listForUser('user_A'))).rejects.toThrow(/must be passed its db/);
    await expect(store.tx.run('user_A', () => store.orderRepo.findByKey(order.idempotencyKey))).rejects.toThrow(/must be passed its db/);
    await expect(store.ledgerRepo.listForUser('user_A', store.db)).rejects.toThrow(/outside tx.run/);
    expect(await store.ledgerRepo.listForUser('user_A')).toHaveLength(2);
    expect(await store.orderRepo.findByKey(order.idempotencyKey)).not.toBeNull();
    expect(await store.orderRepo.listOpenAll()).toHaveLength(1);
    expect(await store.tx.run('user_A', (db) => store.orderRepo.findForUser('user_A', order.id, db))).toMatchObject({ id: order.id });
  });
});
