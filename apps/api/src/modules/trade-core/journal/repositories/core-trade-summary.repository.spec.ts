import { AsyncLocalStorage } from 'node:async_hooks';
import { ClsService } from 'nestjs-cls';
import type { PrismaService } from '../../../../common/prisma/prisma.service';
import { TenantContextService } from '../../../../common/tenant/tenant-context.service';
import { MemoryJournalStore } from '../testing/memory-journal-store';
import { tenantStampingPrisma } from '../testing/tenant-prisma';
import { CoreTradeSummaryRepository } from './core-trade-summary.repository';

describe('CoreTradeSummaryRepository (review fix 1: writes keep their own userId)', () => {
  it("a summary written while another USER's request is in scope is stored and read back as the position owner's", async () => {
    const cls = new ClsService(new AsyncLocalStorage());
    const tenant = new TenantContextService(cls);
    const db = tenantStampingPrisma(tenant, ['coreTradeSummary']);
    const repo = new CoreTradeSummaryRepository(db.prisma as unknown as PrismaService, cls);
    const sample = new MemoryJournalStore().sampleSummary({ userId: 'owner', positionId: 'pos_owner' });
    const stored = await cls.run(async () => {
      tenant.set({ userId: 'user_B', role: 'USER' });
      return repo.createIfAbsent(sample);
    });
    expect(stored.userId).toBe('owner');
    expect(db.rows.coreTradeSummary.map((r) => r.userId)).toEqual(['owner']);
  });
});
