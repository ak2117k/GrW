import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../../common/prisma/prisma.service';
import { istDayStart } from '../../signal-trader/domain/execution';
import { istDay, underlyingOf } from '../../portfolio-review/domain/symbols';
import type { ClosedTrade, DayPnlPath, TradeOrigin } from '../domain/desk.types';
import type { GuardOpenTrade } from '../domain/pnl-path';

/** The guard's stored day state, already scoped to today (a row from another IST day reads as empty). */
export interface GuardDayState {
  pausedUntil: Date | null;
  pauseScope: string | null;
  resetAt: Date | null;
}

const EMPTY: GuardDayState = { pausedUntil: null, pauseScope: null, resetAt: null };

/** signal_orders.source → the trade's origin. No order row = the owner's own (manual) trade. */
function originOf(source: string | null | undefined): TradeOrigin {
  if (source === 'signal' || source === 'reentry' || source === 'manager') return source;
  return source == null ? 'manual' : 'unknown';
}

/**
 * The desk guard's reads and writes (plan Task 1). Reads EVERY live position tracker (IST day, NSE + MCX) with its
 * origin; which ones the guard counts is decided in guardDayPath (only the desk manager's own, not held — supreme
 * fixes W1, 2026-11-28). Never read: paper trades (`paper:` ids live in `trades`, never here), delivery HOLDING
 * rows (not day trades), and anything closed before the owner's reset today.
 */
@Injectable()
export class DeskDayRepository {
  constructor(private readonly prisma: PrismaService) {}

  async closedToday(userId: string, now: Date): Promise<ClosedTrade[]> {
    const dayStart = istDayStart(now);
    const { resetAt } = await this.guardDay(userId, now);
    const from = resetAt && resetAt.getTime() > dayStart.getTime() ? resetAt : dayStart;
    const rows = await this.prisma.tradeTracker.findMany({
      where: {
        userId,
        kind: 'POSITION',
        status: 'CLOSED',
        exitTime: { gte: from, lte: now },
        NOT: { id: { startsWith: 'paper:' } },
      },
      select: { id: true, symbol: true, entryPrice: true, exitPrice: true, qty: true, exitTime: true, pnl: true },
      orderBy: { exitTime: 'asc' },
    });
    if (rows.length === 0) return [];
    const sourceBy = await this.sourcesOf(rows.map((r) => r.id));
    return rows.map((r) => ({
      trackerId: r.id,
      symbol: r.symbol,
      underlying: underlyingOf(r.symbol) || null,
      exitAt: r.exitTime as Date,
      // A closed row without a stored pnl is priced from its exit (value factor 1) — never silently 0, which
      // would end a loss streak.
      pnl: Number.isFinite(r.pnl) ? (r.pnl as number) : r.exitPrice != null ? (r.exitPrice - r.entryPrice) * r.qty : 0,
      origin: originOf(sourceBy.has(r.id) ? sourceBy.get(r.id) : undefined),
    }));
  }

  /**
   * The owner's open live position trackers (kind POSITION, non-paper) with their origin and stored pnl — the
   * same pnl the packet's positions block shows (the guard reads it through positionOpenPnl; one reading, no
   * second "today's move" computation). The guard decides which of them count (guardDayPath).
   */
  async openTrades(userId: string): Promise<GuardOpenTrade[]> {
    const rows = await this.prisma.tradeTracker.findMany({
      where: { userId, kind: 'POSITION', status: 'OPEN', NOT: { id: { startsWith: 'paper:' } } },
      select: { id: true, symbol: true, pnl: true },
    });
    if (rows.length === 0) return [];
    const sourceBy = await this.sourcesOf(rows.map((r) => r.id));
    return rows.map((r) => ({
      trackerId: r.id,
      symbol: r.symbol,
      pnl: typeof r.pnl === 'number' && Number.isFinite(r.pnl) ? r.pnl : null,
      origin: originOf(sourceBy.has(r.id) ? sourceBy.get(r.id) : undefined),
    }));
  }

  /** tracker id → signal_orders.source (first row wins; a row with a null source is the signal trader). */
  private async sourcesOf(trackerIds: string[]): Promise<Map<string, string | null>> {
    const orders = await this.prisma.signalOrder.findMany({
      where: { trackerId: { in: trackerIds } },
      select: { trackerId: true, source: true },
    });
    const sourceBy = new Map<string, string | null>();
    for (const o of orders) if (o.trackerId && !sourceBy.has(o.trackerId)) sourceBy.set(o.trackerId, o.source ?? 'signal');
    return sourceBy;
  }

  /** Today's pause / reset (a row left from an earlier IST day is ignored). */
  async guardDay(userId: string, now: Date): Promise<GuardDayState> {
    const row = await this.prisma.deskGuardState.findUnique({ where: { userId } });
    if (!row || row.day !== istDay(now)) return { ...EMPTY };
    return { pausedUntil: row.pausedUntil ?? null, pauseScope: row.pauseScope ?? null, resetAt: row.resetAt ?? null };
  }

  /** Writes today's pause; a new day starts clean (no reset carried over). */
  async savePause(userId: string, now: Date, until: Date | null, scope: string | null): Promise<void> {
    const day = istDay(now);
    const prev = await this.guardDay(userId, now);
    await this.prisma.deskGuardState.upsert({
      where: { userId },
      create: { userId, day, pausedUntil: until, pauseScope: scope, resetAt: null },
      update: { day, pausedUntil: until, pauseScope: scope, resetAt: prev.resetAt },
    });
  }

  /** The owner's reset: trades closed before `now` stop counting today, and any pause is cleared. */
  async saveReset(userId: string, now: Date): Promise<void> {
    const day = istDay(now);
    await this.prisma.deskGuardState.upsert({
      where: { userId },
      create: { userId, day, pausedUntil: null, pauseScope: null, resetAt: now },
      update: { day, pausedUntil: null, pauseScope: null, resetAt: now },
    });
  }

  async recordEvent(e: { userId: string; at: Date; source: string; blocked: boolean; reasons: string[]; path: DayPnlPath | null }): Promise<void> {
    await this.prisma.deskGuardEvent.create({
      data: {
        userId: e.userId,
        at: e.at,
        source: e.source,
        blocked: e.blocked,
        reasons: e.reasons as Prisma.InputJsonValue,
        path: (e.path ?? {}) as unknown as Prisma.InputJsonValue,
      },
    });
  }
}
