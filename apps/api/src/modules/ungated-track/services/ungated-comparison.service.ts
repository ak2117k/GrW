import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../../common/prisma/prisma.service';
import { UngatedTradeRepository } from '../repositories/ungated-trade.repository';
import { UngatedRejectionRepository } from '../repositories/ungated-rejection.repository';

export interface DailyComparison {
  date: string;
  gated:   { tradeCount: number; gross: number; charges: number; net: number };
  ungated: {
    tradeCount: number; gross: number; charges: number; net: number;
    rejected: Record<string, number>;
  };
  edge: {
    netDiff: number;
    verdict: string;
  };
}

const NEUTRAL_BAND = 100; // ₹

@Injectable()
export class UngatedComparisonService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly _trades: UngatedTradeRepository,
    private readonly rejections: UngatedRejectionRepository,
  ) {}

  async daily(date: string): Promise<DailyComparison> {
    const start = new Date(`${date}T00:00:00.000+05:30`);
    const end = new Date(`${date}T23:59:59.999+05:30`);

    const [gatedRows, ungatedRows, rejected] = await Promise.all([
      this.prisma.trade.findMany({
        where: { isPaperTrade: true, status: 'CLOSED', exitTime: { gte: start, lte: end } },
        select: { pnl: true, fees: true },
      }),
      this.prisma.ungatedTrade.findMany({
        where: { isPaperTrade: true, status: 'CLOSED', exitTime: { gte: start, lte: end } },
        select: { pnl: true, fees: true },
      }),
      this.rejections.countByDate(date),
    ]);

    const sum = (rows: { pnl: number | null; fees: number | null }[]) => {
      let gross = 0, charges = 0;
      for (const r of rows) { gross += r.pnl ?? 0; charges += r.fees ?? 0; }
      return { tradeCount: rows.length, gross, charges, net: gross - charges };
    };

    const gated = sum(gatedRows);
    const ungated = { ...sum(ungatedRows), rejected };
    const netDiff = gated.net - ungated.net;
    return { date, gated, ungated, edge: { netDiff, verdict: this.verdict(netDiff) } };
  }

  private verdict(netDiff: number): string {
    if (Math.abs(netDiff) < NEUTRAL_BAND) return 'no meaningful edge today';
    return netDiff > 0
      ? `gate added value: +₹${netDiff.toFixed(0)} vs ungated`
      : `ungated outperformed by ₹${Math.abs(netDiff).toFixed(0)}`;
  }
}
