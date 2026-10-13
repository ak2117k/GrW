import { Injectable } from '@nestjs/common';
import { Prisma, type CoreTradeSummary as CoreTradeSummaryDb } from '@prisma/client';
import { ClsService } from 'nestjs-cls';
import { PrismaService } from '../../../../common/prisma/prisma.service';
import type { ExitReason } from '../../lifecycle/lifecycle.types';
import type { Vehicle } from '../../strategies/blocks/block-types';
import type { NewTradeSummary, TradeSummary } from '../journal.types';
import { inSystemScope } from './system-scope';

const dec = (s: string | null): Prisma.Decimal | null => (s === null ? null : new Prisma.Decimal(s));
const str = (d: Prisma.Decimal | null, dp: number): string | null => (d === null ? null : d.toFixed(dp));

export function toSummary(r: CoreTradeSummaryDb): TradeSummary {
  return {
    id: r.id,
    userId: r.userId,
    positionId: r.positionId,
    intentId: r.intentId,
    strategyId: r.strategyId,
    strategyVersionId: r.strategyVersionId,
    vehicle: r.vehicle as Vehicle,
    exchange: r.exchange,
    token: r.token,
    symbol: r.symbol,
    side: r.side as 'BUY' | 'SELL',
    qty: r.qty,
    entryAvgPrice: r.entryAvgPrice.toFixed(4),
    exitAvgPrice: r.exitAvgPrice.toFixed(4),
    openedAt: r.openedAt,
    closedAt: r.closedAt,
    grossPnl: r.grossPnl.toFixed(2),
    charges: r.charges.toFixed(2),
    mtfInterest: r.mtfInterest.toFixed(2),
    netPnl: r.netPnl.toFixed(2),
    initialRisk: str(r.initialRisk, 2),
    rMultiple: str(r.rMultiple, 4),
    mfePrice: str(r.mfePrice, 4),
    maePrice: str(r.maePrice, 4),
    mfeRupees: str(r.mfeRupees, 2),
    maeRupees: str(r.maeRupees, 2),
    holdMinutes: r.holdMinutes,
    exitReason: r.exitReason as ExitReason,
    istDay: r.istDay.toISOString().slice(0, 10),
    createdAt: r.createdAt,
  };
}

/** core_trade_summaries (spec §8.2): one per closed position, append-only (no update or delete method). */
@Injectable()
export class CoreTradeSummaryRepository {
  constructor(
    private readonly prisma: PrismaService,
    private readonly cls: ClsService,
  ) {}

  /**
   * Writes the summary unless the position already has one, then returns the stored row (first
   * write wins). Outside any tenant scope: the row keeps its own userId whoever's context closes it.
   */
  async createIfAbsent(s: NewTradeSummary): Promise<TradeSummary> {
    return inSystemScope(this.cls, () => this.writeAndRead(s));
  }

  private async writeAndRead(s: NewTradeSummary): Promise<TradeSummary> {
    await this.prisma.coreTradeSummary.createMany({
      data: [
        {
          ...s,
          entryAvgPrice: new Prisma.Decimal(s.entryAvgPrice),
          exitAvgPrice: new Prisma.Decimal(s.exitAvgPrice),
          grossPnl: new Prisma.Decimal(s.grossPnl),
          charges: new Prisma.Decimal(s.charges),
          mtfInterest: new Prisma.Decimal(s.mtfInterest),
          netPnl: new Prisma.Decimal(s.netPnl),
          initialRisk: dec(s.initialRisk),
          rMultiple: dec(s.rMultiple),
          mfePrice: dec(s.mfePrice),
          maePrice: dec(s.maePrice),
          mfeRupees: dec(s.mfeRupees),
          maeRupees: dec(s.maeRupees),
          istDay: new Date(`${s.istDay}T00:00:00.000Z`),
        },
      ],
      skipDuplicates: true,
    });
    const row = await this.prisma.coreTradeSummary.findFirst({ where: { userId: s.userId, positionId: s.positionId } });
    if (!row) throw new Error(`the summary of ${s.positionId} was not stored`);
    return toSummary(row);
  }

  async findByPosition(userId: string, positionId: string): Promise<TradeSummary | null> {
    const r = await this.prisma.coreTradeSummary.findFirst({ where: { userId, positionId } });
    return r ? toSummary(r) : null;
  }

  async positionIdsWithSummary(userId: string, positionIds: readonly string[]): Promise<Set<string>> {
    if (positionIds.length === 0) return new Set();
    const rows = await this.prisma.coreTradeSummary.findMany({ where: { userId, positionId: { in: [...positionIds] } }, select: { positionId: true } });
    return new Set(rows.map((r) => r.positionId));
  }

  async listForDay(userId: string, day: string): Promise<TradeSummary[]> {
    const rows = await this.prisma.coreTradeSummary.findMany({
      where: { userId, istDay: new Date(`${day}T00:00:00.000Z`) },
      orderBy: [{ closedAt: 'asc' }, { id: 'asc' }],
    });
    return rows.map(toSummary);
  }
}
