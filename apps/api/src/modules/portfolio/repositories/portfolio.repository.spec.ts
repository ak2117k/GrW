import { Test, TestingModule } from '@nestjs/testing';
import { PortfolioRepository } from './portfolio.repository';
import { PrismaService } from '../../../common/prisma/prisma.service';

/**
 * Performance-refactor pin tests for PortfolioRepository.
 *
 * getTradesByStrategy was a full `findMany` over every CLOSED/FILLED trade
 * followed by an in-memory reduce. It is now expressed as DB-side
 * `groupBy`/`_sum`/`_count` aggregations. These tests pin the EXACT public
 * return shape so the refactor stays behaviour-preserving.
 *
 * getTradesBySegment must group by the related instrument's `segment`, which
 * Prisma groupBy cannot do across a relation — so it stays a findMany but is
 * narrowed to `select` only the two columns it needs. These tests pin that
 * narrowed query and the identical output.
 */
describe('PortfolioRepository — aggregate refactor', () => {
  let module: TestingModule;
  let repo: PortfolioRepository;
  let groupBy: jest.Mock;
  let findMany: jest.Mock;

  const build = async () => {
    module = await Test.createTestingModule({
      providers: [
        PortfolioRepository,
        {
          provide: PrismaService,
          useValue: { trade: { groupBy, findMany } },
        },
      ],
    }).compile();
    repo = module.get(PortfolioRepository);
  };

  describe('getTradesByStrategy', () => {
    beforeEach(async () => {
      // Three groupBy calls expected: total (by strategy), wins, losses.
      groupBy = jest.fn(async (args: any) => {
        const isWins = args._count && args.where?.pnl?.gt === 0;
        const isLosses = args._count && args.where?.pnl?.lt === 0;
        if (isWins) {
          return [
            { strategy: 'momentum', _count: { _all: 3 } },
            { strategy: 'reversal', _count: { _all: 1 } },
          ];
        }
        if (isLosses) {
          return [
            { strategy: 'momentum', _count: { _all: 1 } },
            { strategy: 'reversal', _count: { _all: 1 } },
          ];
        }
        // totals
        return [
          { strategy: 'momentum', _sum: { pnl: 1500 }, _count: { _all: 5 } },
          { strategy: 'reversal', _sum: { pnl: -200 }, _count: { _all: 2 } },
        ];
      });
      findMany = jest.fn();
      await build();
    });

    it('returns the same shape the old findMany+reduce produced', async () => {
      const result = await repo.getTradesByStrategy();

      expect(result).toEqual([
        {
          strategy: 'momentum',
          pnl: 1500,
          trades: 5,
          wins: 3,
          losses: 1,
          winRate: (3 / 5) * 100,
        },
        {
          strategy: 'reversal',
          pnl: -200,
          trades: 2,
          wins: 1,
          losses: 1,
          winRate: (1 / 2) * 100,
        },
      ]);
    });

    it('does the work in the DB (groupBy, not a full findMany)', async () => {
      await repo.getTradesByStrategy();
      expect(groupBy).toHaveBeenCalled();
      expect(findMany).not.toHaveBeenCalled();
    });

    it('handles strategies that appear only in totals (zero wins/losses)', async () => {
      groupBy = jest.fn(async (args: any) => {
        if (args._count && args.where?.pnl?.gt === 0) return [];
        if (args._count && args.where?.pnl?.lt === 0) return [];
        return [{ strategy: 'flat', _sum: { pnl: 0 }, _count: { _all: 2 } }];
      });
      await build();

      const result = await repo.getTradesByStrategy();
      expect(result).toEqual([
        { strategy: 'flat', pnl: 0, trades: 2, wins: 0, losses: 0, winRate: 0 },
      ]);
    });
  });

  describe('getTradesWithEventsByToken', () => {
    beforeEach(async () => {
      groupBy = jest.fn();
      findMany = jest.fn(async () => [{ id: 'trade-1', events: [] }]);
      await build();
    });

    it('queries trades for the token WITH their events (userId scoped by the tenant interceptor)', async () => {
      const rows = await repo.getTradesWithEventsByToken('45678');

      expect(rows).toEqual([{ id: 'trade-1', events: [] }]);
      const arg = findMany.mock.calls[0][0];
      expect(arg.where).toEqual({ instrument: { token: '45678' } });
      expect(arg.include).toEqual({ events: true });
    });
  });

  describe('getTradesBySegment', () => {
    beforeEach(async () => {
      groupBy = jest.fn(async () => [
        { positionType: 'LONG', _sum: { pnl: 100 }, _count: { id: 2 } },
      ]);
      // Narrowed query: only pnl + instrument.segment selected.
      findMany = jest.fn(async () => [
        { pnl: 100, instrument: { segment: 'EQUITY' } },
        { pnl: -50, instrument: { segment: 'EQUITY' } },
        { pnl: 200, instrument: { segment: 'OPTIONS' } },
        { pnl: null, instrument: { segment: 'OPTIONS' } },
        { pnl: 30, instrument: null },
      ]);
      await build();
    });

    it('aggregates per segment with identical pnl/count/win/loss math', async () => {
      const result = await repo.getTradesBySegment();

      expect(result).toEqual([
        { segment: 'EQUITY', pnl: 50, trades: 2, wins: 1, losses: 1 },
        { segment: 'OPTIONS', pnl: 200, trades: 2, wins: 1, losses: 0 },
        { segment: 'UNKNOWN', pnl: 30, trades: 1, wins: 1, losses: 0 },
      ]);
    });

    it('narrows the findMany to only pnl + instrument.segment (no full rows)', async () => {
      await repo.getTradesBySegment();
      const arg = findMany.mock.calls[0][0];
      expect(arg.select).toEqual({
        pnl: true,
        instrument: { select: { segment: true } },
      });
      // must not pull whole rows via `include`
      expect(arg.include).toBeUndefined();
    });
  });
});
