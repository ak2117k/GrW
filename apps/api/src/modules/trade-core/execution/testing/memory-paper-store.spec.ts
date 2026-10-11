import { Prisma } from '@prisma/client';
import { PaperLedgerService } from '../paper-ledger.service';
import type { NewLedgerRow } from '../repositories/core-cash-ledger.repository';
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

describe('MemoryPaperStore ledger CHECKs (ruling P15, migration core_cash_ledger_type_check)', () => {
  const D = (s: string) => new Prisma.Decimal(s);
  const row = (type: NewLedgerRow['type'], amount: string, links: Partial<NewLedgerRow> = {}): NewLedgerRow => ({ userId: 'user_A', type, amount: D(amount), note: 'n', ...links });

  it.each<[string, NewLedgerRow]>([
    ['a zero DEPOSIT', row('DEPOSIT', '0')],
    ['a positive MARGIN_BLOCK', row('MARGIN_BLOCK', '10', { orderId: 'o' })],
    ['a zero MARGIN_BLOCK', row('MARGIN_BLOCK', '0', { orderId: 'o' })],
    ['a MARGIN_BLOCK with no orderId', row('MARGIN_BLOCK', '-10')],
    ['a zero MARGIN_RELEASE', row('MARGIN_RELEASE', '0.00', { orderId: 'o' })],
    ['a MARGIN_RELEASE with no orderId', row('MARGIN_RELEASE', '10')],
    ['a zero CHARGES', row('CHARGES', '0.00', { fillId: 'f' })],
    ['a CHARGES with no fillId', row('CHARGES', '-1')],
    ['a REALISED_PNL with no fillId', row('REALISED_PNL', '5')],
    ['a positive MTF_INTEREST', row('MTF_INTEREST', '1', { token: 't', interestDate: '2026-10-12' })],
    ['an MTF_INTEREST with no token', row('MTF_INTEREST', '-1', { interestDate: '2026-10-12' })],
  ])('refuses %s, and stores nothing of the batch', async (_name, bad) => {
    const { store, order } = await seeded();
    const before = store.ledger.length;
    const good = row('MARGIN_RELEASE', '1', { orderId: order.id });
    await expect(store.tx.run('user_A', (db) => store.ledgerRepo.append([good, bad], db))).rejects.toThrow(/core_cash_ledger_type_check/);
    expect(store.ledger).toHaveLength(before);
  });

  it('appendInterest is checked too', async () => {
    const { store } = await seeded();
    await expect(store.tx.run('user_A', (db) => store.ledgerRepo.appendInterest([row('MTF_INTEREST', '2', { token: 't', interestDate: '2026-10-12' })], db))).rejects.toThrow(
      /core_cash_ledger_type_check/,
    );
  });

  it('accepts a REALISED_PNL of 0.00 or a negative one with a fillId, and a zero MTF_INTEREST with a token', async () => {
    const { store } = await seeded();
    await store.tx.run('user_A', async (db) => {
      await store.ledgerRepo.append([row('REALISED_PNL', '0.00', { fillId: 'f' }), row('REALISED_PNL', '-12.50', { fillId: 'f' })], db);
      await store.ledgerRepo.appendInterest([row('MTF_INTEREST', '0.00', { token: 't', interestDate: '2026-10-12' })], db);
    });
    expect(store.ledger.slice(-3).map((r) => [r.type, r.amount.toFixed(2)])).toEqual([
      ['REALISED_PNL', '0.00'],
      ['REALISED_PNL', '-12.50'],
      ['MTF_INTEREST', '0.00'],
    ]);
  });
});
