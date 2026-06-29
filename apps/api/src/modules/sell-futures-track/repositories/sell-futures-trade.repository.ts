import { Injectable } from '@nestjs/common';
import { Prisma, SellFuturesTrade } from '@prisma/client';
import { PrismaService } from '../../../common/prisma/prisma.service';

@Injectable()
export class SellFuturesTradeRepository {
  constructor(private readonly prisma: PrismaService) {}

  async createTrade(data: Prisma.SellFuturesTradeUncheckedCreateInput): Promise<SellFuturesTrade> {
    return this.prisma.sellFuturesTrade.create({ data });
  }

  async getTradeById(id: string) {
    return this.prisma.sellFuturesTrade.findUnique({ where: { id } });
  }

  async getOpenTrades() {
    return this.prisma.sellFuturesTrade.findMany({
      where: { status: { in: ['OPEN', 'PARTIALLY_FILLED'] } },
    });
  }

  async update(id: string, data: Prisma.SellFuturesTradeUpdateInput) {
    return this.prisma.sellFuturesTrade.update({ where: { id }, data });
  }

  async findRealization(
    tradeIds: string[],
  ): Promise<Map<string, { pnl: number; fees: number }>> {
    const ids = [...new Set(tradeIds.filter((x): x is string => !!x))];
    if (ids.length === 0) return new Map();
    const trades = await this.prisma.sellFuturesTrade.findMany({
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
    const r = await this.prisma.sellFuturesTrade.aggregate({
      where: { status: 'CLOSED' },
      _sum: { pnl: true, fees: true },
    });
    return { pnl: r._sum.pnl ?? 0, fees: r._sum.fees ?? 0 };
  }

  /** Total notional (entryPrice × quantity) of all open futures positions. */
  async sumOpenNotional(): Promise<number> {
    const open = await this.getOpenTrades();
    return open.reduce(
      (s, t) => s + (t.entryPrice ?? 0) * (t.quantity ?? 0),
      0,
    );
  }
}
