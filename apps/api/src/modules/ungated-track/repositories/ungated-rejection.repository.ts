import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../../common/prisma/prisma.service';

export type UngatedRejectionReason =
  | 'capital-exhausted'
  | 'position-cap'
  | 'symbol-dup'
  | 'cooldown'
  | 'kill-switch'
  | 'sell-direction'
  | 'last-loss'
  | 'stale-entry'
  | 'no-quote'
  | 'scanner-not-allowed';

export interface UngatedRecordRejectionInput {
  alertId: string | null;
  symbol: string;
  reason: UngatedRejectionReason;
  score?: number | null;
  hitPrice?: number | null;
}

@Injectable()
export class UngatedRejectionRepository {
  constructor(private readonly prisma: PrismaService) {}

  async record(input: UngatedRecordRejectionInput): Promise<void> {
    await this.prisma.ungatedRejection.create({
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
    const grouped = await this.prisma.ungatedRejection.groupBy({
      by: ['reason'],
      where: { createdAt: { gte: start, lte: end } },
      _count: { _all: true },
    });
    const out: Record<string, number> = {};
    for (const g of grouped) out[g.reason] = g._count._all;
    return out;
  }
}
