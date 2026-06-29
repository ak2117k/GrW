import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../../common/prisma/prisma.service';
import { NOTIONAL } from '../constants';

// Notional capital base, mirroring AnandDualTrackRepository.getSwingCapital
// (₹20,00,000 recycling base). Each exit returns its engaged capital ± realized P&L.
const BASE_CAPITAL = 2_000_000;

export interface CreateQueuedEntryInput {
  symbol: string;
  token: string | null;
  alertId: string;
  scoreBreakdown: unknown;
  signalPrice: number;
  resistance: number;
  prevDayClose: number;
  limitPrice: number;
}

export interface FillEntryInput {
  entryPrice: number;
  enteredAt: Date;
  quantity: number;
  stopPrice: number;
}

export interface UpdateStatusInput {
  status: string;
  exitPrice?: number;
  exitedAt?: Date;
  exitReason?: string;
}

export interface ListEntriesFilter {
  from?: Date;
}

@Injectable()
export class BreakoutSwingRepository {
  constructor(private readonly prisma: PrismaService) {}

  async createQueuedEntry(input: CreateQueuedEntryInput): Promise<{ id: string }> {
    return this.prisma.breakoutSwingEntry.create({
      data: {
        symbol: input.symbol,
        token: input.token,
        alertId: input.alertId,
        signalPrice: input.signalPrice,
        resistance: input.resistance,
        prevDayClose: input.prevDayClose,
        limitPrice: input.limitPrice,
        status: 'QUEUED',
        scoreBreakdown:
          input.scoreBreakdown == null
            ? Prisma.JsonNull
            : (input.scoreBreakdown as Prisma.InputJsonValue),
      },
      select: { id: true },
    });
  }

  /** QUEUED entries waiting for their resting limit to fill. */
  async listQueued() {
    return this.prisma.breakoutSwingEntry.findMany({
      where: { status: 'QUEUED' },
      orderBy: { queuedAt: 'desc' },
    });
  }

  /** Open (filled) positions being managed for target/stop/trail. */
  async listTraded() {
    return this.prisma.breakoutSwingEntry.findMany({
      where: { status: 'TRADED' },
      orderBy: { enteredAt: 'desc' },
    });
  }

  /**
   * Any active row (QUEUED or TRADED) for a symbol, regardless of when it was
   * queued. Drives the entry-time dedup gate. All-time (not date-windowed)
   * because QUEUED resting limits are GTC — they persist until filled, so a
   * resting order from a prior day must still block a duplicate.
   */
  async findActiveBySymbol(symbol: string): Promise<{ id: string } | null> {
    return this.prisma.breakoutSwingEntry.findFirst({
      where: { symbol, status: { in: ['QUEUED', 'TRADED'] } },
      select: { id: true },
    });
  }

  async findActiveByToken(token: string) {
    return this.prisma.breakoutSwingEntry.findMany({
      where: { token, status: { in: ['QUEUED', 'TRADED'] } },
    });
  }

  async fill(id: string, data: FillEntryInput): Promise<void> {
    await this.prisma.breakoutSwingEntry.update({
      where: { id },
      data: {
        status: 'TRADED',
        entryPrice: data.entryPrice,
        enteredAt: data.enteredAt,
        quantity: data.quantity,
        stopPrice: data.stopPrice,
      },
    });
  }

  async setTrailing(id: string, data: { trailingHighWater: number; stopPrice: number }): Promise<void> {
    await this.prisma.breakoutSwingEntry.update({
      where: { id },
      data: { trailing: true, trailingHighWater: data.trailingHighWater, stopPrice: data.stopPrice },
    });
  }

  async recordTick(id: string, data: { currentPrice: number; lastTickAt: Date }): Promise<void> {
    await this.prisma.breakoutSwingEntry.update({ where: { id }, data });
  }

  async updateStatus(id: string, data: UpdateStatusInput): Promise<void> {
    await this.prisma.breakoutSwingEntry.update({ where: { id }, data });
  }

  async listEntries(filter: ListEntriesFilter = {}) {
    return this.prisma.breakoutSwingEntry.findMany({
      where: {
        ...(filter.from ? { queuedAt: { gte: filter.from } } : {}),
      },
      orderBy: { queuedAt: 'desc' },
      take: 200,
    });
  }

  /**
   * DERIVED capital summary — computed live from BreakoutSwingEntry, mirroring
   * AnandDualTrackRepository.getSwingCapital. Models a recycling capital base:
   * `available` = base capital − capital tied up in open positions + realized P&L.
   * Quantity uses the same `floor(NOTIONAL / entryPrice)` lot formula for both
   * invested and realized so the two are internally consistent.
   */
  async getCapital(): Promise<{
    baseCapital: number;
    investedOpen: number;
    realizedPnl: number;
    available: number;
    openCount: number;
  }> {
    const open = await this.prisma.breakoutSwingEntry.findMany({ where: { status: 'TRADED' } });
    let investedOpen = 0;
    for (const e of open) {
      const px = e.entryPrice ?? 0;
      const qty = px > 0 ? Math.floor(NOTIONAL / px) : 0;
      investedOpen += qty * px;
    }

    const exited = await this.prisma.breakoutSwingEntry.findMany({
      where: { status: { notIn: ['QUEUED', 'TRADED'] }, exitPrice: { not: null }, entryPrice: { not: null } },
    });
    let realizedPnl = 0;
    for (const e of exited) {
      const px = e.entryPrice ?? 0;
      if (px <= 0) continue;
      const qty = Math.floor(NOTIONAL / px);
      realizedPnl += (e.exitPrice! - px) * qty;
    }

    const available = BASE_CAPITAL - investedOpen + realizedPnl;
    return { baseCapital: BASE_CAPITAL, investedOpen, realizedPnl, available, openCount: open.length };
  }
}
