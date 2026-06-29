import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../../common/prisma/prisma.service';
import { AdaptiveStopTradeRepository } from '../repositories/adaptive-stop-trade.repository';

export interface DailyComparison {
  date: string;
  gated:        { tradeCount: number; gross: number; charges: number; net: number };
  adaptiveStop: {
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
export class AdaptiveStopComparisonService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly _trades: AdaptiveStopTradeRepository,
  ) {}

  async daily(date: string): Promise<DailyComparison> {
    const start = new Date(`${date}T00:00:00.000+05:30`);
    const end = new Date(`${date}T23:59:59.999+05:30`);

    const [gatedRows, adaptiveStopRows] = await Promise.all([
      this.prisma.trade.findMany({
        where: { isPaperTrade: true, status: 'CLOSED', exitTime: { gte: start, lte: end } },
        select: { pnl: true, fees: true },
      }),
      this.prisma.adaptiveStopTrade.findMany({
        where: { isPaperTrade: true, status: 'CLOSED', exitTime: { gte: start, lte: end } },
        select: { pnl: true, fees: true },
      }),
    ]);

    // The adaptive-stop track does not persist a rejection ledger, so the
    // rejection breakdown is empty (no rejection repo was cloned for this track).
    const rejected: Record<string, number> = {};

    const sum = (rows: { pnl: number | null; fees: number | null }[]) => {
      let gross = 0, charges = 0;
      for (const r of rows) { gross += r.pnl ?? 0; charges += r.fees ?? 0; }
      return { tradeCount: rows.length, gross, charges, net: gross - charges };
    };

    const gated = sum(gatedRows);
    const adaptiveStop = { ...sum(adaptiveStopRows), rejected };
    const netDiff = gated.net - adaptiveStop.net;
    return { date, gated, adaptiveStop, edge: { netDiff, verdict: this.verdict(netDiff) } };
  }

  private verdict(netDiff: number): string {
    if (Math.abs(netDiff) < NEUTRAL_BAND) return 'no meaningful edge today';
    return netDiff > 0
      ? `gate added value: +₹${netDiff.toFixed(0)} vs adaptive-stop`
      : `adaptive-stop outperformed by ₹${Math.abs(netDiff).toFixed(0)}`;
  }
}
