import { Injectable } from '@nestjs/common';
import { Prisma, UngatedTrade } from '@prisma/client';
import { PrismaService } from '../../../common/prisma/prisma.service';

@Injectable()
export class UngatedTradeRepository {
  constructor(private readonly prisma: PrismaService) {}

  async createTrade(data: Prisma.UngatedTradeUncheckedCreateInput): Promise<UngatedTrade> {
    return this.prisma.ungatedTrade.create({ data });
  }

  async getTradeById(id: string) {
    return this.prisma.ungatedTrade.findUnique({ where: { id } });
  }

  async getOpenTrades() {
    return this.prisma.ungatedTrade.findMany({
      where: { status: { in: ['OPEN', 'PARTIALLY_FILLED'] } },
    });
  }

  async update(id: string, data: Prisma.UngatedTradeUpdateInput) {
    return this.prisma.ungatedTrade.update({ where: { id }, data });
  }

  async findRealization(
    tradeIds: string[],
  ): Promise<Map<string, { pnl: number; fees: number }>> {
    const ids = [...new Set(tradeIds.filter((x): x is string => !!x))];
    if (ids.length === 0) return new Map();
    const trades = await this.prisma.ungatedTrade.findMany({
      where: { id: { in: ids } },
      select: { id: true, pnl: true, fees: true },
    });
    return new Map(
      trades
        .filter((t) => t.pnl != null)
        .map((t) => [t.id, { pnl: t.pnl as number, fees: t.fees ?? 0 }]),
    );
  }

  async sumRealized(): Promise<{ pnl: number; fees: number }> {
    const r = await this.prisma.ungatedTrade.aggregate({
      where: { status: 'CLOSED' },
      _sum: { pnl: true, fees: true },
    });
    return { pnl: r._sum.pnl ?? 0, fees: r._sum.fees ?? 0 };
  }

  async sumDeployedOpen(): Promise<number> {
    const open = await this.getOpenTrades();
    return open.reduce(
      (s, t) => s + (t.entryPrice ?? 0) * (t.quantity ?? 0),
      0,
    );
  }
}
