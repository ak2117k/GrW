import { Test, TestingModule } from '@nestjs/testing';
import { TradeRepository } from './trade.repository';
import { PrismaService } from '../../../common/prisma/prisma.service';

/**
 * Spec for the optional `source` filter on getOpenTrades (Task 4).
 *
 * GET /api/trades/open?source=MANUAL scopes the manual-trade page to
 * user-placed orders only. With no source the where-clause must be
 * unchanged so existing consumers (kill-switch, positions sync) still see
 * every open trade.
 */
describe('TradeRepository.getOpenTrades — source filter', () => {
  let module: TestingModule;
  let repo: TradeRepository;
  let findMany: jest.Mock;

  beforeEach(async () => {
    findMany = jest.fn(async () => []);

    module = await Test.createTestingModule({
      providers: [
        TradeRepository,
        {
          provide: PrismaService,
          useValue: { trade: { findMany } },
        },
      ],
    }).compile();

    repo = module.get(TradeRepository);
  });

  it('adds a source filter to the where clause when source is provided', async () => {
    await repo.getOpenTrades('MANUAL');

    expect(findMany).toHaveBeenCalledTimes(1);
    const arg = findMany.mock.calls[0][0];
    expect(arg.where).toEqual({
      status: { in: ['OPEN', 'PARTIALLY_FILLED'] },
      source: 'MANUAL',
    });
  });

  it('omits the source filter when no source is passed (unchanged behavior)', async () => {
    await repo.getOpenTrades();

    expect(findMany).toHaveBeenCalledTimes(1);
    const arg = findMany.mock.calls[0][0];
    expect(arg.where).toEqual({
      status: { in: ['OPEN', 'PARTIALLY_FILLED'] },
    });
    expect(arg.where).not.toHaveProperty('source');
  });
});
