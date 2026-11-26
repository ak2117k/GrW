import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { mcxUnderlyingOf } from '@td/shared';
import { contractsByTokens } from '../../../common/instruments/contract-by-token';
import { PrismaService } from '../../../common/prisma/prisma.service';
import { istDayStart } from '../../signal-trader/domain/execution';

/** A desk_manager_pending_entries row as the actions read it. */
export interface PendingEntryRow {
  id: string;
  decisionId: string;
  userId: string;
  underlying: string;
  mode: string;
  decision: unknown;
  validUntil: Date;
  status: string;
  result: unknown;
  orderRowId: string | null;
  tradeId: string | null;
  createdAt: Date;
}

export type PendingStatus = 'PENDING' | 'FILLED' | 'EXPIRED' | 'REFUSED' | 'FAILED';

/** signal_orders statuses of an entry still in flight (placed, not yet a tracker or dead). */
export const IN_FLIGHT_ORDER_STATUSES = ['CLAIMED', 'PLACED', 'UNCERTAIN', 'PARTIAL'];

const isUnique = (err: unknown) => err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002';
const up = (v: unknown) => String(v ?? '').trim().toUpperCase();
/** A tracker / order symbol's underlying when the master row has no name: the MCX root, else the leading letters. */
function nameOf(symbol: string): string {
  const s = up(symbol);
  return mcxUnderlyingOf(s) ?? (/^[A-Z&-]+/.exec(s.replace(/-EQ$/, ''))?.[0] ?? s);
}

/**
 * The desk manager's OPEN reads and writes: the pending-entry rows (also the per-day entry count — every OPEN
 * that acted or waits has one), and "is anything already open or in flight on this underlying" across every
 * source. Every (exchange, token) → instrument goes through common/instruments/contract-by-token.
 */
@Injectable()
export class DeskActionsRepository {
  constructor(private readonly prisma: PrismaService) {}

  private get db(): any {
    return this.prisma as any;
  }

  /** Manager OPENs today (IST): pending or acted, the given decision excluded. */
  async entriesToday(userId: string, now: Date, excludeDecisionId?: string): Promise<number> {
    return this.db.deskManagerPendingEntry.count({
      where: {
        userId,
        createdAt: { gte: istDayStart(now) },
        status: { in: ['PENDING', 'FILLED'] },
        ...(excludeDecisionId ? { decisionId: { not: excludeDecisionId } } : {}),
      },
    });
  }

  /**
   * Underlyings that already hold something, upper-case → what: the owner's open live trackers, live entries in
   * flight (signal / re-entry / manager), PENDING manager entries, and open manager paper trades.
   */
  async busyUnderlyings(userId: string, now: Date, excludeDecisionId?: string): Promise<Map<string, string>> {
    const out = new Map<string, string>();
    const add = (u: string | null | undefined, what: string) => {
      const k = up(u);
      if (k && !out.has(k)) out.set(k, what);
    };
    const [trackers, orders, pending, filled] = await Promise.all([
      this.db.tradeTracker.findMany({ where: { userId, status: 'OPEN', kind: 'POSITION' }, select: { id: true, symbol: true, exchange: true, token: true } }),
      this.db.signalOrder.findMany({
        where: { userId, createdAt: { gte: istDayStart(now) }, status: { in: IN_FLIGHT_ORDER_STATUSES } },
        select: { id: true, tradingsymbol: true, exchange: true, token: true, source: true },
      }),
      this.db.deskManagerPendingEntry.findMany({
        where: { userId, status: 'PENDING', ...(excludeDecisionId ? { decisionId: { not: excludeDecisionId } } : {}) },
        select: { decisionId: true, underlying: true },
      }),
      this.db.deskManagerPendingEntry.findMany({
        where: { userId, status: 'FILLED', tradeId: { not: null }, createdAt: { gte: new Date(now.getTime() - 3 * 86_400_000) } },
        select: { underlying: true, tradeId: true },
      }),
    ]);
    const refs = [
      ...(trackers as Array<{ id: string; symbol: string; exchange: string; token: string }>).map((t) => ({ exchange: t.exchange, token: t.token, symbol: t.symbol, what: `open position ${t.symbol} (tracker ${t.id})` })),
      ...(orders as Array<{ id: string; tradingsymbol: string; exchange: string; token: string; source: string | null }>).map((o) => ({ exchange: o.exchange, token: o.token, symbol: o.tradingsymbol, what: `${o.source ?? 'signal'} entry in flight ${o.tradingsymbol} (order ${o.id})` })),
    ];
    if (refs.length > 0) {
      const rows = await contractsByTokens(this.db, refs.map((r) => ({ exchange: r.exchange, token: r.token, symbol: r.symbol })));
      refs.forEach((r, i) => add(rows[i]?.name || nameOf(r.symbol), r.what));
    }
    for (const p of pending as Array<{ decisionId: string; underlying: string }>) add(p.underlying, `pending manager entry (decision ${p.decisionId})`);
    const paper = filled as Array<{ underlying: string; tradeId: string }>;
    if (paper.length > 0) {
      const open = (await this.db.trade.findMany({ where: { id: { in: paper.map((p) => p.tradeId) }, status: { in: ['OPEN', 'PARTIALLY_FILLED', 'PENDING'] } }, select: { id: true } })) as Array<{ id: string }>;
      const ids = new Set(open.map((t) => t.id));
      for (const p of paper) if (ids.has(p.tradeId)) add(p.underlying, `open manager paper trade ${p.tradeId}`);
    }
    return out;
  }

  /** Insert the entry row; null when the decision already has one (unique decisionId). */
  async insertPending(row: { decisionId: string; userId: string; underlying: string; mode: string; decision: unknown; validUntil: Date; status: PendingStatus; result?: unknown }): Promise<string | null> {
    try {
      const r = await this.db.deskManagerPendingEntry.create({
        data: { ...row, underlying: up(row.underlying), decision: row.decision as Prisma.InputJsonValue, result: (row.result ?? null) as Prisma.InputJsonValue },
        select: { id: true },
      });
      return r.id as string;
    } catch (err) {
      if (isUnique(err)) return null;
      throw err;
    }
  }

  async pendingRows(): Promise<PendingEntryRow[]> {
    return this.db.deskManagerPendingEntry.findMany({ where: { status: 'PENDING' }, orderBy: { createdAt: 'asc' }, take: 50 });
  }

  /** FILLED rows from `since` (≤ a few a day): the pass arms each one's stop once its tracker exists. */
  async filledSince(since: Date): Promise<PendingEntryRow[]> {
    return this.db.deskManagerPendingEntry.findMany({ where: { status: 'FILLED', createdAt: { gte: since } }, orderBy: { createdAt: 'asc' }, take: 50 });
  }

  /** Conditional status move; true when this caller made it (the claim). */
  async move(id: string, from: PendingStatus, to: PendingStatus, data: { result?: unknown; orderRowId?: string | null; tradeId?: string | null } = {}): Promise<boolean> {
    const r = await this.db.deskManagerPendingEntry.updateMany({
      where: { id, status: from },
      data: {
        status: to,
        ...(data.result !== undefined ? { result: data.result as Prisma.InputJsonValue } : {}),
        ...(data.orderRowId !== undefined ? { orderRowId: data.orderRowId } : {}),
        ...(data.tradeId !== undefined ? { tradeId: data.tradeId } : {}),
      },
    });
    return r.count === 1;
  }

  /** Update a row's result in place (status unchanged). */
  async setResult(id: string, result: unknown): Promise<void> {
    await this.db.deskManagerPendingEntry.update({ where: { id }, data: { result: result as Prisma.InputJsonValue } });
  }

  /** The live entry order's status and tracker. */
  async orderTracker(orderRowId: string): Promise<{ status: string; trackerId: string | null } | null> {
    return this.db.signalOrder.findUnique({ where: { id: orderRowId }, select: { status: true, trackerId: true } });
  }

  /** The decision row's outcome (a pending entry settling after its run). */
  async updateDecision(decisionId: string, data: { status: string; result: unknown; orderRowId?: string | null; tradeId?: string | null }): Promise<void> {
    await this.db.deskManagerDecision.updateMany({
      where: { id: decisionId },
      data: {
        status: data.status,
        result: data.result as Prisma.InputJsonValue,
        ...(data.orderRowId !== undefined ? { orderRowId: data.orderRowId } : {}),
        ...(data.tradeId !== undefined ? { tradeId: data.tradeId } : {}),
      },
    });
  }
}
