import { Prisma } from '@prisma/client';
import type { ClsService } from 'nestjs-cls';
import type { PrismaService } from '../../../../common/prisma/prisma.service';
import type { TenantContextService } from '../../../../common/tenant/tenant-context.service';
import { CoreJournalRepository, toJournalData } from './core-journal.repository';

function setup() {
  const prisma = {
    $queryRaw: jest.fn().mockResolvedValue([]),
    coreJournal: { createMany: jest.fn().mockResolvedValue({ count: 2 }), findMany: jest.fn().mockResolvedValue([]), findFirst: jest.fn().mockResolvedValue(null) },
  };
  const tenant = { runWithoutTenant: jest.fn((fn: () => unknown) => fn()) };
  const cls = { isActive: jest.fn().mockReturnValue(true), run: jest.fn((_opts: unknown, fn: () => unknown) => fn()) };
  const repo = new CoreJournalRepository(prisma as unknown as PrismaService, tenant as unknown as TenantContextService, cls as unknown as ClsService);
  return { prisma, tenant, repo };
}

const AT = new Date('2026-10-13T04:00:00.000Z'); // 09:30 IST

describe('CoreJournalRepository (spec §8.1)', () => {
  it('maps an entry: IST day from `at`, createdAt = at, price as Decimal, age rounded and never negative', () => {
    const d = toJournalData({ userId: 'u', type: 'FILL', at: AT, payload: { a: 1 }, priceUsed: 500.25, priceAgeMs: -3.4, dedupeKey: 'fill:1' });
    expect(d).toMatchObject({ userId: 'u', type: 'FILL', payload: { a: 1 }, priceAgeMs: 0, dedupeKey: 'fill:1', createdAt: AT, positionId: null, intentId: null });
    expect(d.istDay.toISOString()).toBe('2026-10-13T00:00:00.000Z');
    expect((d.priceUsed as Prisma.Decimal).toString()).toBe('500.25');
  });

  it('the IST day of 23:59 IST is that day, of 00:01 IST the next', () => {
    expect(toJournalData({ userId: 'u', type: 'BLIND', at: new Date('2026-10-13T18:29:00.000Z'), payload: {} }).istDay.toISOString().slice(0, 10)).toBe('2026-10-13');
    expect(toJournalData({ userId: 'u', type: 'BLIND', at: new Date('2026-10-13T18:31:00.000Z'), payload: {} }).istDay.toISOString().slice(0, 10)).toBe('2026-10-14');
  });

  it('append writes in one createMany with skipDuplicates; nothing for none', async () => {
    const { prisma, repo } = setup();
    expect(await repo.append([])).toBe(0);
    expect(prisma.coreJournal.createMany).not.toHaveBeenCalled();
    expect(await repo.append([{ userId: 'u', type: 'FILL', at: AT, payload: {} }, { userId: 'u', type: 'FILL', at: AT, payload: {} }])).toBe(2);
    expect(prisma.coreJournal.createMany).toHaveBeenCalledWith({ data: expect.any(Array), skipDuplicates: true });
  });

  it('every per-user read names the userId; the day scan is the only system read and lifts tenant scoping', async () => {
    const { prisma, tenant, repo } = setup();
    await repo.listForPosition('u', 'pos_1');
    await repo.listForDay('u', '2026-10-13', ['FILL']);
    await repo.findForUser('u', 'jr_1');
    await repo.hasType('u', '2026-10-13', 'DAILY_LOSS_LATCHED');
    for (const call of [...prisma.coreJournal.findMany.mock.calls, ...prisma.coreJournal.findFirst.mock.calls]) {
      expect((call[0] as { where: { userId: string } }).where.userId).toBe('u');
    }
    expect(tenant.runWithoutTenant).not.toHaveBeenCalled();
    await repo.listTypeOnDay('INTENT_SKIPPED', '2026-10-13', 5000);
    expect(tenant.runWithoutTenant).toHaveBeenCalledTimes(1);
  });

  it('unacked mismatches: one bounded anti-join query for the user (review fix 5): acked and historical rows are never loaded', async () => {
    const { prisma, repo } = setup();
    const row = (id: string) => ({
      id, userId: 'u', type: 'RECON_MISMATCH', positionId: null, strategyId: null, strategyVersionId: null, intentId: null, symbol: null,
      payload: {}, priceUsed: null, priceAgeMs: null, dedupeKey: 'recon:b', istDay: new Date('2026-10-13T00:00:00.000Z'), createdAt: AT,
    });
    prisma.$queryRaw.mockResolvedValueOnce([row('m2')]);
    expect((await repo.unackedMismatches('u')).map((r) => r.id)).toEqual(['m2']);
    expect(prisma.coreJournal.findMany).not.toHaveBeenCalled();
    expect(prisma.$queryRaw).toHaveBeenCalledTimes(1);
    const [sql, ...values] = prisma.$queryRaw.mock.calls[0] as [TemplateStringsArray, ...unknown[]];
    expect(sql.join('?')).toMatch(/NOT EXISTS/);
    expect(sql.join('?')).toContain("'RECON_MISMATCH'");
    expect(values).toEqual(['u']);
  });

  it('has no update or delete method (append-only)', () => {
    const { repo } = setup();
    expect(Object.getOwnPropertyNames(Object.getPrototypeOf(repo)).filter((n) => /update|delete|remove|upsert/i.test(n))).toEqual([]);
  });
});
