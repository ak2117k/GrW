import type { PrismaService } from '../../../../common/prisma/prisma.service';
import { TENANT_MODELS } from '../../../../common/tenant/tenant.constants';
import { CoreStrategyRepository } from './core-strategy.repository';
import { CoreStrategySelectionRepository } from './core-strategy-selection.repository';

function fakePrisma() {
  return {
    coreStrategy: { findMany: jest.fn().mockResolvedValue([]), findUnique: jest.fn().mockResolvedValue(null) },
    coreStrategyVersion: {
      findUnique: jest.fn().mockResolvedValue(null),
      aggregate: jest.fn(),
      create: jest.fn().mockImplementation(({ data }) => Promise.resolve({ id: 'v_new', ...data })),
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
    },
    coreStrategySelection: {
      findMany: jest.fn().mockResolvedValue([]),
      findUnique: jest.fn().mockResolvedValue(null),
      upsert: jest.fn().mockImplementation(({ create }) => Promise.resolve({ id: 'sel_1', ...create })),
    },
  };
}

describe('CoreStrategyRepository', () => {
  it('lists strategies with only the asked-for version statuses, newest version first', async () => {
    const prisma = fakePrisma();
    const repo = new CoreStrategyRepository(prisma as unknown as PrismaService);
    await repo.listWithVersions(['PAPER']);
    expect(prisma.coreStrategy.findMany).toHaveBeenCalledWith({
      orderBy: { name: 'asc' },
      include: { versions: { where: { status: { in: ['PAPER'] } }, orderBy: { version: 'desc' } } },
    });
    await repo.listWithVersions();
    expect(prisma.coreStrategy.findMany).toHaveBeenLastCalledWith({
      orderBy: { name: 'asc' },
      include: { versions: { where: undefined, orderBy: { version: 'desc' } } },
    });
  });

  it('numbers the next version from the highest one, starting at 1', async () => {
    const prisma = fakePrisma();
    const repo = new CoreStrategyRepository(prisma as unknown as PrismaService);
    prisma.coreStrategyVersion.aggregate.mockResolvedValueOnce({ _max: { version: null } });
    expect(await repo.nextVersionNumber('s1')).toBe(1);
    prisma.coreStrategyVersion.aggregate.mockResolvedValueOnce({ _max: { version: 3 } });
    expect(await repo.nextVersionNumber('s1')).toBe(4);
    expect(prisma.coreStrategyVersion.aggregate).toHaveBeenCalledWith({ where: { strategyId: 's1' }, _max: { version: true } });
  });

  it('creates every version as a DRAFT', async () => {
    const prisma = fakePrisma();
    const repo = new CoreStrategyRepository(prisma as unknown as PrismaService);
    await repo.createVersion({ strategyId: 's1', version: 2, blocks: {}, createdBy: 'AI', notes: null });
    expect(prisma.coreStrategyVersion.create).toHaveBeenCalledWith({
      data: { strategyId: 's1', version: 2, blocks: {}, createdBy: 'AI', notes: null, status: 'DRAFT' },
    });
  });

  it('updates a version only while it is still a DRAFT, and says when it was not', async () => {
    const prisma = fakePrisma();
    const repo = new CoreStrategyRepository(prisma as unknown as PrismaService);
    expect(await repo.updateDraft('v1', { blocks: { a: 1 }, notes: 'n' })).toBe(true);
    expect(prisma.coreStrategyVersion.updateMany).toHaveBeenCalledWith({ where: { id: 'v1', status: 'DRAFT' }, data: { blocks: { a: 1 }, notes: 'n' } });
    prisma.coreStrategyVersion.updateMany.mockResolvedValueOnce({ count: 0 });
    expect(await repo.updateDraft('v1', { blocks: {}, notes: null })).toBe(false);
  });

  it('moves status only from the status the caller read (no lost update)', async () => {
    const prisma = fakePrisma();
    const repo = new CoreStrategyRepository(prisma as unknown as PrismaService);
    const at = new Date('2026-10-09T05:00:00Z');
    expect(await repo.transition('v1', 'DRAFT', { status: 'PAPER', approvedBy: 'usr_owner', approvedAt: at })).toBe(true);
    expect(prisma.coreStrategyVersion.updateMany).toHaveBeenCalledWith({
      where: { id: 'v1', status: 'DRAFT' }, data: { status: 'PAPER', approvedBy: 'usr_owner', approvedAt: at },
    });
  });

  it('finds a version together with its strategy', async () => {
    const prisma = fakePrisma();
    const repo = new CoreStrategyRepository(prisma as unknown as PrismaService);
    await repo.findVersion('v1');
    expect(prisma.coreStrategyVersion.findUnique).toHaveBeenCalledWith({ where: { id: 'v1' }, include: { strategy: true } });
  });
});

describe('CoreStrategySelectionRepository', () => {
  it("selection queries always carry the caller's userId, and an update can never move a row to another user", async () => {
    const prisma = fakePrisma();
    const repo = new CoreStrategySelectionRepository(prisma as unknown as PrismaService);
    await repo.listForUser('user_A');
    expect(prisma.coreStrategySelection.findMany).toHaveBeenCalledWith({ where: { userId: 'user_A' }, orderBy: { createdAt: 'asc' } });
    await repo.findForUser('user_A', 's1');
    expect(prisma.coreStrategySelection.findUnique).toHaveBeenCalledWith({ where: { userId_strategyId: { userId: 'user_A', strategyId: 's1' } } });
    await repo.upsert('user_A', 's1', { strategyVersionId: 'v1', enabled: true, capitalAllocation: 100000 });
    expect(prisma.coreStrategySelection.upsert).toHaveBeenCalledWith({
      where: { userId_strategyId: { userId: 'user_A', strategyId: 's1' } },
      create: { userId: 'user_A', strategyId: 's1', strategyVersionId: 'v1', enabled: true, capitalAllocation: 100000 },
      update: { strategyVersionId: 'v1', enabled: true, capitalAllocation: 100000 },
    });
  });

  it('CoreStrategySelection is a tenant model; the global catalogue is not', () => {
    expect(TENANT_MODELS.has('CoreStrategySelection')).toBe(true);
    expect(TENANT_MODELS.has('CoreStrategy')).toBe(false);
    expect(TENANT_MODELS.has('CoreStrategyVersion')).toBe(false);
  });
});
