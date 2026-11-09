// apps/api/src/modules/sentinel-executor/repositories/floor-broker-sl.repository.ts
import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../../common/prisma/prisma.service';
import { AUTO_EXIT_EXCHANGES } from '../domain/auto-exit.types';

export interface FloorSlTracker {
  id: string; userId: string; symbol: string; exchange: string; token: string; qty: number;
  status: string; kind: string; entryTime: Date | null; exitPrice: number | null; exitTime: Date | null;
}

export interface FloorSlEventInput {
  userId: string; trackerId: string; symbol: string; exchange: string; token: string;
  mode: 'shadow' | 'live';
  action: 'PLACE' | 'MODIFY' | 'CANCEL' | 'SKIP' | 'FILLED' | 'RECONCILE' | 'ERROR' | 'EXIT_COMPARE';
  reason?: string | null; side?: string | null; triggerPrice?: number | null; limitPrice?: number | null;
  prevTriggerPrice?: number | null; quantity?: number | null; productType?: string | null; floorPrice?: number | null;
  ltp?: number | null; orderTag?: string | null; brokerOrderId?: string | null; brokerStatus?: string | null;
  brokerMessage?: string | null; exitPrice?: number | null; exitAt?: Date | null; wouldFillPrice?: number | null;
  wouldFillLimit?: number | null; wouldTriggerAt?: Date | null; savedRupees?: number | null; detail?: Record<string, unknown> | null;
}

export interface StopHistoryRow {
  trackerId: string; action: string; reason: string | null; side: string | null; triggerPrice: number | null;
  limitPrice: number | null; quantity: number | null; createdAt: Date;
}

const TRACKER_SELECT = {
  id: true, userId: true, symbol: true, exchange: true, token: true, qty: true, status: true, kind: true,
  entryTime: true, exitPrice: true, exitTime: true,
} as const;

/** floor_broker_sl_events + the reads FLOOR_BROKER_SL needs. Writes only its own table. */
@Injectable()
export class FloorBrokerSlRepository {
  constructor(private readonly prisma: PrismaService) {}

  async record(e: FloorSlEventInput): Promise<void> {
    const { detail, ...rest } = e;
    await this.prisma.floorBrokerSlEvent.create({
      data: { ...rest, quantity: rest.quantity != null && Number.isInteger(rest.quantity) ? rest.quantity : null, ...(detail ? { detail: detail as never } : {}) },
    });
  }

  /** Open F&O positions of the allow-listed users. */
  openTrackers(userIds: string[]): Promise<FloorSlTracker[]> {
    if (userIds.length === 0) return Promise.resolve([]);
    return this.prisma.tradeTracker.findMany({
      where: { userId: { in: userIds }, status: 'OPEN', kind: 'POSITION', exchange: { in: [...AUTO_EXIT_EXCHANGES] } },
      select: TRACKER_SELECT,
    }) as Promise<FloorSlTracker[]>;
  }

  trackers(ids: string[]): Promise<FloorSlTracker[]> {
    if (ids.length === 0) return Promise.resolve([]);
    return this.prisma.tradeTracker.findMany({ where: { id: { in: ids } }, select: TRACKER_SELECT }) as Promise<FloorSlTracker[]>;
  }

  /**
   * The contract's OWN instrument row: exchange + tradingsymbol first (tokens are reused after expiry —
   * f54ce0db, d050d539), newest; never by token alone, which can name a dead contract (2026-11-09). No isActive
   * filter: expired rows are deactivated (prod 2026-11-06) but a live position's own row is what we want.
   */
  async instrument(exchange: string, symbol: string): Promise<{ tickSize: number | null; lotSize: number | null } | null> {
    return this.prisma.instrument.findFirst({ where: { exchange, symbol }, orderBy: { updatedAt: 'desc' }, select: { tickSize: true, lotSize: true } });
  }

  /** PLACE / MODIFY / CANCEL rows since `since`, oldest first (restart memory and the comparison's steps). */
  stopHistory(mode: 'shadow' | 'live', since: Date, trackerIds?: string[]): Promise<StopHistoryRow[]> {
    return this.prisma.floorBrokerSlEvent.findMany({
      where: { mode, createdAt: { gte: since }, action: { in: ['PLACE', 'MODIFY', 'CANCEL'] }, ...(trackerIds ? { trackerId: { in: trackerIds } } : {}) },
      orderBy: { createdAt: 'asc' },
      select: { trackerId: true, action: true, reason: true, side: true, triggerPrice: true, limitPrice: true, quantity: true, createdAt: true },
    });
  }

  /** Trackers with a stop placed since `since` and no EXIT_COMPARE yet. */
  async pendingCompares(mode: 'shadow' | 'live', since: Date): Promise<string[]> {
    const [placed, compared] = await Promise.all([
      this.prisma.floorBrokerSlEvent.findMany({ where: { mode, action: 'PLACE', createdAt: { gte: since } }, select: { trackerId: true }, distinct: ['trackerId'] }),
      this.prisma.floorBrokerSlEvent.findMany({ where: { mode, action: 'EXIT_COMPARE', createdAt: { gte: since } }, select: { trackerId: true }, distinct: ['trackerId'] }),
    ]);
    const done = new Set(compared.map((r) => r.trackerId));
    return placed.map((r) => r.trackerId).filter((id) => !done.has(id));
  }

  /** The position's real exit fill when the executor closed it (live, FILLED); null otherwise. */
  async exitFill(trackerId: string): Promise<{ fillPrice: number; fillAt: Date } | null> {
    const row = await this.prisma.aiExitExecution.findFirst({
      where: { trackerId, mode: 'live', status: 'FILLED', fillPrice: { not: null } },
      orderBy: { createdAt: 'desc' },
      select: { fillPrice: true, fillAt: true, updatedAt: true },
    });
    return row && row.fillPrice != null ? { fillPrice: row.fillPrice, fillAt: row.fillAt ?? row.updatedAt } : null;
  }
}
