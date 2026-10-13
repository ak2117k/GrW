import { Prisma } from '@prisma/client';
import { AUDIT_ACTIONS } from '../../../../common/audit/audit-actions';
import type { PrismaService } from '../../../../common/prisma/prisma.service';
import { TENANT_MODELS } from '../../../../common/tenant/tenant.constants';
import { NOW } from '../testing/paper-fixtures';
import { CoreCashLedgerRepository } from './core-cash-ledger.repository';
import { CoreFillRepository } from './core-fill.repository';
import { CoreOrderRepository, toCoreOrder, type PaperDb } from './core-order.repository';
import { CorePaperDefaultsRepository } from './core-paper-defaults.repository';
import { CorePaperTx } from './core-paper-tx';

const D = (s: string) => new Prisma.Decimal(s);
const OPEN = { in: ['NEW', 'OPEN', 'PARTIAL'] };

function fakePrisma() {
  const prisma = {
    coreOrder: {
      findUnique: jest.fn().mockResolvedValue(null),
      findFirst: jest.fn().mockResolvedValue(null),
      findMany: jest.fn().mockResolvedValue([]),
      create: jest.fn(),
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
    },
    coreFill: { findMany: jest.fn().mockResolvedValue([]), create: jest.fn() },
    coreCashLedger: {
      findMany: jest.fn().mockResolvedValue([]),
      findFirst: jest.fn().mockResolvedValue(null),
      createMany: jest.fn().mockResolvedValue({ count: 2 }),
    },
    corePaperDefault: { findMany: jest.fn().mockResolvedValue([]), upsert: jest.fn().mockResolvedValue({}) },
    $executeRaw: jest.fn().mockResolvedValue(1),
    $transaction: jest.fn(),
  };
  prisma.$transaction.mockImplementation((fn: (tx: unknown) => unknown) => fn(prisma));
  return prisma;
}

const orderRow = (over: Record<string, unknown> = {}) => ({
  id: 'ord_1', userId: 'user_A', idempotencyKey: 'k1', vehicle: 'OPTIONS_BUY', exchange: 'NFO', token: '43521',
  symbol: 'NIFTY13OCT2625000CE', lotSize: 75, underlying: 'NIFTY', side: 'BUY', qty: 150, filledQty: 75,
  avgFillPrice: D('100.0834'), type: 'LIMIT', limitPrice: D('100.00'), triggerPrice: null, refPrice: D('100.00'),
  purpose: 'ENTRY', strategyVersionId: 'ver_1', state: 'PARTIAL', rejectReason: null, submittedAt: NOW, triggeredAt: null, updatedAt: NOW, ...over,
});

const methods = (cls: { prototype: object }) => Object.getOwnPropertyNames(cls.prototype).filter((n) => n !== 'constructor').sort();

describe('CoreOrderRepository', () => {
  it('every per-user read names the userId', async () => {
    const prisma = fakePrisma();
    const repo = new CoreOrderRepository(prisma as unknown as PrismaService);
    const order = [{ submittedAt: 'asc' }, { id: 'asc' }];
    await repo.findForUser('user_A', 'ord_1');
    expect(prisma.coreOrder.findFirst).toHaveBeenLastCalledWith({ where: { id: 'ord_1', userId: 'user_A' } });
    await repo.listForUser('user_A');
    expect(prisma.coreOrder.findMany).toHaveBeenLastCalledWith({ where: { userId: 'user_A' }, orderBy: order });
    await repo.listOpenForUser('user_A');
    expect(prisma.coreOrder.findMany).toHaveBeenLastCalledWith({ where: { userId: 'user_A', state: OPEN }, orderBy: order });
    await repo.listForPosition('user_A', 'CASH_INTRADAY', '2885');
    expect(prisma.coreOrder.findMany).toHaveBeenLastCalledWith({ where: { userId: 'user_A', vehicle: 'CASH_INTRADAY', token: '2885' }, orderBy: order });
  });

  it('looks an idempotency key up on its own (the service refuses a key of another user)', async () => {
    const prisma = fakePrisma();
    await new CoreOrderRepository(prisma as unknown as PrismaService).findByKey('k1');
    expect(prisma.coreOrder.findUnique).toHaveBeenCalledWith({ where: { idempotencyKey: 'k1' } });
  });

  it('the two system scans are the only cross-user reads', async () => {
    const prisma = fakePrisma();
    const repo = new CoreOrderRepository(prisma as unknown as PrismaService);
    await repo.listOpenAll();
    expect(prisma.coreOrder.findMany).toHaveBeenLastCalledWith({ where: { state: OPEN }, orderBy: [{ submittedAt: 'asc' }, { id: 'asc' }] });
    prisma.coreOrder.findMany.mockResolvedValueOnce([{ userId: 'user_A', token: '1594' }]);
    expect(await repo.listMtfHolders()).toEqual([{ userId: 'user_A', token: '1594' }]);
    expect(prisma.coreOrder.findMany).toHaveBeenLastCalledWith({
      where: { vehicle: 'MTF', filledQty: { gt: 0 } }, select: { userId: true, token: true }, distinct: ['userId', 'token'],
    });
  });

  it('update is guarded by the state and filledQty it was read at; a lost race is null', async () => {
    const prisma = fakePrisma();
    const repo = new CoreOrderRepository(prisma as unknown as PrismaService);
    prisma.coreOrder.findFirst.mockResolvedValueOnce(orderRow({ filledQty: 150, state: 'FILLED' }));
    const out = await repo.update('user_A', 'ord_1', { state: 'PARTIAL', filledQty: 75 }, { state: 'FILLED', filledQty: 150 }, prisma as unknown as PaperDb);
    expect(prisma.coreOrder.updateMany).toHaveBeenCalledWith({
      where: { id: 'ord_1', userId: 'user_A', state: 'PARTIAL', filledQty: 75 }, data: { state: 'FILLED', filledQty: 150 },
    });
    expect(out?.state).toBe('FILLED');
    prisma.coreOrder.updateMany.mockResolvedValueOnce({ count: 0 });
    expect(await repo.update('user_A', 'ord_1', { state: 'PARTIAL', filledQty: 75 }, { state: 'FILLED' }, prisma as unknown as PaperDb)).toBeNull();
  });

  it('update persists triggeredAt on its own, for a triggered stop that did not fill (ruling P10)', async () => {
    const prisma = fakePrisma();
    const repo = new CoreOrderRepository(prisma as unknown as PrismaService);
    const at = new Date('2026-10-12T05:00:05.000Z');
    prisma.coreOrder.findFirst.mockResolvedValueOnce(orderRow({ type: 'SL_MARKET', state: 'OPEN', filledQty: 0, triggeredAt: at }));
    const out = await repo.update('user_A', 'ord_1', { state: 'OPEN', filledQty: 0 }, { triggeredAt: at }, prisma as unknown as PaperDb);
    expect(prisma.coreOrder.updateMany).toHaveBeenCalledWith({
      where: { id: 'ord_1', userId: 'user_A', state: 'OPEN', filledQty: 0 }, data: { triggeredAt: at },
    });
    expect(out?.triggeredAt).toEqual(at);
  });

  it('maps a row to the domain order with numeric prices', () => {
    const o = toCoreOrder(orderRow() as never);
    expect(o.instrument).toEqual({ exchange: 'NFO', token: '43521', symbol: 'NIFTY13OCT2625000CE', lotSize: 75, underlying: 'NIFTY' });
    expect([o.avgFillPrice, o.limitPrice, o.triggerPrice, o.refPrice]).toEqual([100.0834, 100, null, 100]);
    expect(o.triggeredAt).toBeNull();
  });
});

describe('append-only repositories', () => {
  it('fills: per-user reads; no update or delete method', async () => {
    const prisma = fakePrisma();
    const repo = new CoreFillRepository(prisma as unknown as PrismaService);
    await repo.listForOrders('user_A', ['ord_1', 'ord_2']);
    expect(prisma.coreFill.findMany).toHaveBeenLastCalledWith({ where: { userId: 'user_A', orderId: { in: ['ord_1', 'ord_2'] } }, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] });
    prisma.coreFill.findMany.mockClear();
    expect(await repo.listForOrders('user_A', [])).toEqual([]);
    expect(prisma.coreFill.findMany).not.toHaveBeenCalled();
    expect(methods(CoreFillRepository)).toEqual(['create', 'listForOrders', 'listForUser']);
  });

  it('ledger: per-user reads; interest is skipDuplicates; dates are days; no update or delete method', async () => {
    const prisma = fakePrisma();
    const repo = new CoreCashLedgerRepository(prisma as unknown as PrismaService);
    await repo.listForUser('user_A');
    expect(prisma.coreCashLedger.findMany).toHaveBeenLastCalledWith({ where: { userId: 'user_A' }, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] });
    const row = { userId: 'user_A', type: 'MTF_INTEREST' as const, amount: D('-2.47'), token: '1594', interestDate: '2026-10-12', note: 'n' };
    expect(await repo.appendInterest([row, { ...row, interestDate: '2026-10-13' }], prisma as unknown as PaperDb)).toBe(2);
    expect(prisma.coreCashLedger.createMany).toHaveBeenLastCalledWith({
      data: [
        { userId: 'user_A', type: 'MTF_INTEREST', amount: D('-2.47'), orderId: null, fillId: null, token: '1594', interestDate: new Date('2026-10-12T00:00:00.000Z'), note: 'n' },
        { userId: 'user_A', type: 'MTF_INTEREST', amount: D('-2.47'), orderId: null, fillId: null, token: '1594', interestDate: new Date('2026-10-13T00:00:00.000Z'), note: 'n' },
      ],
      skipDuplicates: true,
    });
    prisma.coreCashLedger.findFirst.mockResolvedValueOnce({ interestDate: new Date('2026-10-09T00:00:00.000Z') });
    expect(await repo.lastInterestDate('user_A', '1594')).toBe('2026-10-09');
    expect(prisma.coreCashLedger.findFirst).toHaveBeenLastCalledWith({
      where: { userId: 'user_A', token: '1594', type: 'MTF_INTEREST' }, orderBy: { interestDate: 'desc' }, select: { interestDate: true },
    });
    // M5 (ruling J19) adds reads only: still no update or delete method.
    expect(methods(CoreCashLedgerRepository)).toEqual([
      'append', 'appendInterest', 'heldMarginByVehicle', 'interestTokensOn', 'lastInterestDate',
      'listForOrders', 'listForUser', 'listForUserSince', 'listInterest', 'sumsByType',
    ]);
  });

  it('append writes nothing for an empty list', async () => {
    const prisma = fakePrisma();
    await new CoreCashLedgerRepository(prisma as unknown as PrismaService).append([], prisma as unknown as PaperDb);
    expect(prisma.coreCashLedger.createMany).not.toHaveBeenCalled();
  });
});

describe('the paper transaction and the defaults', () => {
  it('takes the per-user paper lock before anything else', async () => {
    const prisma = fakePrisma();
    const seen: string[] = [];
    prisma.$executeRaw.mockImplementation(async () => { seen.push('lock'); return 1; });
    await new CorePaperTx(prisma as unknown as PrismaService).run('user_A', async () => { seen.push('work'); });
    expect(seen).toEqual(['lock', 'work']);
    const [strings, key] = prisma.$executeRaw.mock.calls[0];
    expect((strings as string[]).join('?')).toContain('pg_advisory_xact_lock');
    expect(key).toBe('core_paper:user_A');
  });

  it('upserts a default by (key, scope)', async () => {
    const prisma = fakePrisma();
    await new CorePaperDefaultsRepository(prisma as unknown as PrismaService).upsert('slippageBps', 'MTF', D('3'), 'why', 'usr_owner', NOW);
    expect(prisma.corePaperDefault.upsert).toHaveBeenCalledWith({
      where: { key_scope: { key: 'slippageBps', scope: 'MTF' } },
      create: { key: 'slippageBps', scope: 'MTF', numValue: D('3'), note: 'why', updatedBy: 'usr_owner', updatedAt: NOW },
      update: { numValue: D('3'), note: 'why', updatedBy: 'usr_owner', updatedAt: NOW },
    });
  });
});

describe('wiring constants', () => {
  it('the per-user execution models are tenant models; the global defaults are not', () => {
    for (const m of ['CoreOrder', 'CoreFill', 'CoreCashLedger']) expect(TENANT_MODELS.has(m)).toBe(true);
    expect(TENANT_MODELS.has('CorePaperDefault')).toBe(false);
  });

  it('the paper audit action exists', () => {
    expect(AUDIT_ACTIONS.paper).toEqual({ CORE_PAPER_DEFAULT_CHANGED: 'CORE_PAPER_DEFAULT_CHANGED' });
  });
});
