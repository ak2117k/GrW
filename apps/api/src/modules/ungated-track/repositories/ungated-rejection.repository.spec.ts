import { Test } from '@nestjs/testing';
import { UngatedRejectionRepository } from './ungated-rejection.repository';
import { PrismaService } from '../../../common/prisma/prisma.service';

describe('UngatedRejectionRepository', () => {
  let repo: UngatedRejectionRepository;
  let prisma: any;

  beforeEach(async () => {
    prisma = {
      ungatedRejection: {
        create: jest.fn().mockResolvedValue({ id: 'r1' }),
        groupBy: jest.fn().mockResolvedValue([
          { reason: 'capital-exhausted', _count: { _all: 3 } },
          { reason: 'symbol-dup', _count: { _all: 2 } },
        ]),
      },
    };
    const mod = await Test.createTestingModule({
      providers: [
        UngatedRejectionRepository,
        { provide: PrismaService, useValue: prisma },
      ],
    }).compile();
    repo = mod.get(UngatedRejectionRepository);
  });

  it('record writes one row with reason + score + alertId', async () => {
    await repo.record({
      alertId: 'a1', symbol: 'TCS', reason: 'capital-exhausted', score: 42, hitPrice: 100,
    });
    const data = prisma.ungatedRejection.create.mock.calls[0][0].data;
    expect(data).toMatchObject({
      alertId: 'a1', symbol: 'TCS', reason: 'capital-exhausted', score: 42, hitPrice: 100,
    });
  });

  it('countByDate returns a reason → count map for one IST day', async () => {
    const counts = await repo.countByDate('2026-05-20');
    expect(counts).toEqual({ 'capital-exhausted': 3, 'symbol-dup': 2 });
    const where = prisma.ungatedRejection.groupBy.mock.calls[0][0].where;
    expect(where.createdAt.gte).toBeInstanceOf(Date);
    expect(where.createdAt.lte).toBeInstanceOf(Date);
  });
});
