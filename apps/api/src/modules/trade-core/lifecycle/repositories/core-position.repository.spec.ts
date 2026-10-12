import { AsyncLocalStorage } from 'node:async_hooks';
import { ClsService } from 'nestjs-cls';
import type { PrismaService } from '../../../../common/prisma/prisma.service';
import { TenantContextService } from '../../../../common/tenant/tenant-context.service';
import { CorePositionRepository } from './core-position.repository';

/** A Prisma stand-in that records the tenant context in force when each query runs (the real extension scopes by it). */
function setup() {
  const cls = new ClsService(new AsyncLocalStorage());
  const tenant = new TenantContextService(cls);
  const seen: Array<string | undefined> = [];
  const findMany = jest.fn(async () => {
    seen.push(tenant.get()?.userId);
    return [];
  });
  const prisma = { corePosition: { findMany } } as unknown as PrismaService;
  return { cls, tenant, seen, repo: new CorePositionRepository(prisma, tenant, cls) };
}

describe('CorePositionRepository: the system scans ignore the caller tenant (review fix 1)', () => {
  it("listActive and listActiveUserIds run unscoped inside a user's request, and the context is restored after", async () => {
    const s = setup();
    await s.cls.run(async () => {
      s.tenant.set({ userId: 'user_A', role: 'USER' });
      await s.repo.listActive();
      await s.repo.listActiveUserIds();
      expect(s.tenant.get()).toEqual({ userId: 'user_A', role: 'USER' });
    });
    expect(s.seen).toEqual([undefined, undefined]);
  });

  it('outside any CLS store (crons, the sweep timer) the scans just run', async () => {
    const s = setup();
    await s.repo.listActive();
    await s.repo.listActiveUserIds();
    expect(s.seen).toEqual([undefined, undefined]);
  });
});
