import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../../common/prisma/prisma.service';

export type SellFuturesRejectionReason =
  | 'no-future'
  | 'symbol-dup'
  | 'cooldown'
  | 'position-cap'
  | 'margin-exhausted'
  | 'kill-switch'
  | 'no-quote';

export interface SellFuturesRecordRejectionInput {
  alertId: string | null;
  symbol: string;
  reason: SellFuturesRejectionReason;
  score?: number | null;
  hitPrice?: number | null;
}

@Injectable()
export class SellFuturesRejectionRepository {
  constructor(private readonly prisma: PrismaService) {}

  async record(input: SellFuturesRecordRejectionInput): Promise<void> {
    await this.prisma.sellFuturesRejection.create({
      data: {
        alertId: input.alertId,
        symbol: input.symbol,
        reason: input.reason,
        score: input.score ?? null,
        hitPrice: input.hitPrice ?? null,
      },
    });
  }

  async countByDate(date: string): Promise<Record<string, number>> {
    const start = new Date(`${date}T00:00:00.000+05:30`);
    const end = new Date(`${date}T23:59:59.999+05:30`);
    const grouped = await this.prisma.sellFuturesRejection.groupBy({
      by: ['reason'],
      where: { createdAt: { gte: start, lte: end } },
      _count: { _all: true },
    });
    const out: Record<string, number> = {};
    for (const g of grouped) out[g.reason] = g._count._all;
    return out;
  }
}
