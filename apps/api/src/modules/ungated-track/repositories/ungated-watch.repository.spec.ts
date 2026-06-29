import { Test } from '@nestjs/testing';
import { UngatedWatchRepository } from './ungated-watch.repository';
import { PrismaService } from '../../../common/prisma/prisma.service';

describe('UngatedWatchRepository', () => {
  let repo: UngatedWatchRepository;
  let prisma: any;

  beforeEach(async () => {
    prisma = {
      ungatedWatchEntry: {
        create:     jest.fn().mockResolvedValue({ id: 'uw1' }),
        findMany:   jest.fn().mockResolvedValue([]),
        findFirst:  jest.fn().mockResolvedValue(null),
        findUnique: jest.fn().mockResolvedValue(null),
        update:     jest.fn().mockResolvedValue({}),
        count:      jest.fn().mockResolvedValue(0),
      },
      ungatedWatchEvent: { create: jest.fn().mockResolvedValue({ id: 'ev1' }) },
    };
    const mod = await Test.createTestingModule({
      providers: [
        UngatedWatchRepository,
        { provide: PrismaService, useValue: prisma },
      ],
    }).compile();
    repo = mod.get(UngatedWatchRepository);
  });

  it('createEntry persists to ungated_watch_entries (not watch_entries)', async () => {
    await repo.createEntry({
      alertId: 'a1', setupId: null, symbol: 'TCS', token: '11536', exchange: 'NSE',
      side: 'BUY', initialPrice: 4000, initialScore: 42,
      initialBreakdown: { checks: [] }, profitTarget: 4080,
      profitTargetSource: 'fallback-2pct', stopLossScore: 50,
    });
    expect(prisma.ungatedWatchEntry.create).toHaveBeenCalledTimes(1);
    expect(prisma.watchEntry).toBeUndefined(); // proves we didn't touch the gated table
  });

  it('findActiveByToken filters out closed states (STOPPED/TARGET_HIT/EXITED/DISMISSED)', async () => {
    await repo.findActiveByToken('11536');
    const where = prisma.ungatedWatchEntry.findMany.mock.calls[0][0].where;
    expect(where.token).toBe('11536');
    expect(where.status.notIn).toEqual(
      expect.arrayContaining(['STOPPED', 'TARGET_HIT', 'EXITED', 'DISMISSED']),
    );
  });
});
