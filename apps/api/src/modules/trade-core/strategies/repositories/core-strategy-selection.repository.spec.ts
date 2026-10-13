import { Prisma } from '@prisma/client';
import type { PrismaService } from '../../../../common/prisma/prisma.service';
import { CoreStrategySelectionRepository } from './core-strategy-selection.repository';

describe('CoreStrategySelectionRepository.listEnabledPaper (M1 note: live = enabled AND PAPER)', () => {
  it('asks for enabled selections whose version is PAPER, with the strategy key and the blocks', async () => {
    const findMany = jest.fn().mockResolvedValue([
      {
        userId: 'u', strategyId: 'cs_adaptive_stop', strategyVersionId: 'csv_adaptive_stop_v1', capitalAllocation: new Prisma.Decimal('200000'),
        strategy: { key: 'adaptive-stop' }, strategyVersion: { blocks: { entry: { kind: 'chartink' } } },
      },
    ]);
    const repo = new CoreStrategySelectionRepository({ coreStrategySelection: { findMany } } as unknown as PrismaService);
    expect(await repo.listEnabledPaper()).toEqual([
      { userId: 'u', strategyId: 'cs_adaptive_stop', strategyKey: 'adaptive-stop', strategyVersionId: 'csv_adaptive_stop_v1', blocks: { entry: { kind: 'chartink' } }, capitalAllocation: '200000.00' },
    ]);
    expect(findMany).toHaveBeenCalledWith({
      where: { enabled: true, strategyVersion: { status: 'PAPER' } },
      include: { strategy: true, strategyVersion: true },
      orderBy: [{ userId: 'asc' }, { createdAt: 'asc' }],
    });
  });
});
