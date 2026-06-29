import { Test } from '@nestjs/testing';
import { UngatedComparisonService } from './ungated-comparison.service';
import { UngatedTradeRepository } from '../repositories/ungated-trade.repository';
import { UngatedRejectionRepository } from '../repositories/ungated-rejection.repository';
import { PrismaService } from '../../../common/prisma/prisma.service';

describe('UngatedComparisonService', () => {
  let svc: UngatedComparisonService;
  let prisma: any, trades: any, rejections: any;

  beforeEach(async () => {
    prisma = {
      trade: { findMany: jest.fn().mockResolvedValue([
        { pnl: 100, fees: 10 }, { pnl: -300, fees: 12 },
      ]) },
      ungatedTrade: { findMany: jest.fn().mockResolvedValue([
        { pnl: 1000, fees: 50 }, { pnl: 800, fees: 40 }, { pnl: -200, fees: 30 },
      ]) },
    };
    trades = {};
    rejections = {
      countByDate: jest.fn().mockResolvedValue({ 'capital-exhausted': 3 }),
    };

    const mod = await Test.createTestingModule({
      providers: [
        UngatedComparisonService,
        { provide: PrismaService, useValue: prisma },
        { provide: UngatedTradeRepository, useValue: trades },
        { provide: UngatedRejectionRepository, useValue: rejections },
      ],
    }).compile();
    svc = mod.get(UngatedComparisonService);
  });

  it('computes gated + ungated + edge for one IST day', async () => {
    const r = await svc.daily('2026-05-20');
    expect(r.gated).toEqual({
      tradeCount: 2, gross: -200, charges: 22, net: -222,
    });
    expect(r.ungated).toMatchObject({
      tradeCount: 3, gross: 1600, charges: 120, net: 1480,
      rejected: { 'capital-exhausted': 3 },
    });
    expect(r.edge.netDiff).toBe(-222 - 1480);
    expect(r.edge.verdict).toMatch(/ungated outperformed/i);
  });

  it('verdict says "gate added value" when gated.net > ungated.net by ≥ ₹100', async () => {
    prisma.trade.findMany.mockResolvedValue([{ pnl: 5000, fees: 50 }]);
    prisma.ungatedTrade.findMany.mockResolvedValue([{ pnl: 100, fees: 20 }]);
    const r = await svc.daily('2026-05-20');
    expect(r.edge.verdict).toMatch(/gate added value/i);
  });

  it('verdict is neutral when |netDiff| < ₹100', async () => {
    prisma.trade.findMany.mockResolvedValue([{ pnl: 100, fees: 5 }]);
    prisma.ungatedTrade.findMany.mockResolvedValue([{ pnl: 130, fees: 10 }]);
    const r = await svc.daily('2026-05-20');
    expect(r.edge.verdict).toMatch(/no meaningful edge/i);
  });
});
