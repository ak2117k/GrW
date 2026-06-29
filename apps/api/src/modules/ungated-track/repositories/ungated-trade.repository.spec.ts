import { Test } from '@nestjs/testing';
import { UngatedTradeRepository } from './ungated-trade.repository';
import { PrismaService } from '../../../common/prisma/prisma.service';

describe('UngatedTradeRepository', () => {
  let repo: UngatedTradeRepository;
  let prisma: any;

  beforeEach(async () => {
    prisma = {
      ungatedTrade: {
        create:     jest.fn().mockResolvedValue({ id: 'ut1' }),
        findUnique: jest.fn(),
        findMany:   jest.fn().mockResolvedValue([]),
        update:     jest.fn().mockResolvedValue({}),
        aggregate:  jest.fn(),
      },
    };
    const mod = await Test.createTestingModule({
      providers: [
        UngatedTradeRepository,
        { provide: PrismaService, useValue: prisma },
      ],
    }).compile();
    repo = mod.get(UngatedTradeRepository);
  });

  it('getOpenTrades returns OPEN + PARTIALLY_FILLED statuses', async () => {
    await repo.getOpenTrades();
    const where = prisma.ungatedTrade.findMany.mock.calls[0][0].where;
    expect(where.status.in).toEqual(expect.arrayContaining(['OPEN', 'PARTIALLY_FILLED']));
  });

  it('findRealization returns { pnl, fees } per closed trade id', async () => {
    prisma.ungatedTrade.findMany.mockResolvedValue([
      { id: 'a', pnl: 100, fees: 12 },
      { id: 'b', pnl: null, fees: 0 },     // skip null pnl
      { id: 'c', pnl: -50, fees: null },   // null fees coerces to 0
    ]);
    const map = await repo.findRealization(['a', 'b', 'c']);
    expect(map.get('a')).toEqual({ pnl: 100, fees: 12 });
    expect(map.has('b')).toBe(false);
    expect(map.get('c')).toEqual({ pnl: -50, fees: 0 });
  });
});
