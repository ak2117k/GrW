// apps/api/src/modules/sentinel-executor/repositories/sentinel-exit-trigger.repository.ts
import { Injectable } from '@nestjs/common';
import { Prisma, type SentinelExitTrigger } from '@prisma/client';
import { PrismaService } from '../../../common/prisma/prisma.service';
import type { TriggerInstrument, TriggerOp } from '../domain/trigger.types';

export interface ProposalRow {
  id: string;
  userId: string;
  trackerId: string;
  symbol: string;
  verdict: string;
  exitTrigger: unknown;
  createdAt: Date;
}

export interface TrackerLite {
  id: string;
  userId: string;
  symbol: string;
  exchange: string;
  token: string;
  qty: number;
  status: string;
  kind: string;
}

export interface TriggerFields {
  instrument?: TriggerInstrument;
  op?: TriggerOp;
  price?: number;
  watchExchange?: string;
  watchToken?: string;
  watchSymbol?: string;
  refPrice?: number;
}

const isUnique = (err: unknown) => err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002';

@Injectable()
export class SentinelExitTriggerRepository {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * THE 5-SECOND ARMING QUERY (ruling R15). Served by sentinel_verdicts(userId,
   * createdAt) and the unique sentinel_exit_triggers(verdictId). A verdict with a
   * NULL exitTrigger is never returned — which is why null never disarms (R5).
   */
  pendingProposals(userIds: string[], since: Date, limit: number): Promise<ProposalRow[]> {
    if (userIds.length === 0) return Promise.resolve([]);
    return this.prisma.$queryRaw<ProposalRow[]>(Prisma.sql`
      SELECT v."id", v."userId", v."trackerId", v."symbol", v."verdict", v."exitTrigger", v."createdAt"
      FROM "sentinel_verdicts" v
      WHERE v."userId" IN (${Prisma.join(userIds)})
        AND v."createdAt" >= ${since}
        AND v."verdict" IN ('HOLD', 'EXIT_ARMED')
        AND v."exitTrigger" IS NOT NULL
        AND NOT EXISTS (SELECT 1 FROM "sentinel_exit_triggers" t WHERE t."verdictId" = v."id")
      ORDER BY v."createdAt" ASC
      LIMIT ${limit}`);
  }

  trackerFor(id: string): Promise<TrackerLite | null> {
    return this.prisma.tradeTracker.findUnique({
      where: { id },
      select: { id: true, userId: true, symbol: true, exchange: true, token: true, qty: true, status: true, kind: true },
    }) as Promise<TrackerLite | null>;
  }

  /** One REJECTED row per proposal. false = the verdict was already handled. */
  async reject(p: ProposalRow, f: TriggerFields, reason: string): Promise<boolean> {
    try {
      await this.prisma.sentinelExitTrigger.create({
        data: { userId: p.userId, trackerId: p.trackerId, verdictId: p.id, symbol: p.symbol, status: 'REJECTED', reason, ...f },
      });
      return true;
    } catch (err) {
      if (isUnique(err)) return false;
      throw err;
    }
  }

  /** Supersede + insert, atomically. null = lost a unique race (retried next pass, or already handled). */
  async arm(p: ProposalRow, f: Required<TriggerFields>, now: Date): Promise<{ id: string; superseded: string[] } | null> {
    try {
      return await this.prisma.$transaction(async (tx) => {
        const old = await tx.sentinelExitTrigger.findMany({ where: { trackerId: p.trackerId, status: 'ARMED' }, select: { id: true } });
        const superseded = old.map((o) => o.id);
        if (superseded.length > 0) {
          await tx.sentinelExitTrigger.updateMany({
            where: { id: { in: superseded }, status: 'ARMED' },
            data: { status: 'SUPERSEDED', endedAt: now, reason: `SUPERSEDED_BY:${p.id}` },
          });
        }
        const row = await tx.sentinelExitTrigger.create({
          data: { userId: p.userId, trackerId: p.trackerId, verdictId: p.id, symbol: p.symbol, status: 'ARMED', armedAt: now, ...f },
          select: { id: true },
        });
        return { id: row.id, superseded };
      });
    } catch (err) {
      if (isUnique(err)) return null;
      throw err;
    }
  }

  /** Ruling R7 layer 2: exactly one caller can move a trigger ARMED → FIRED. */
  async claimFire(id: string, tick: { price: number; at: Date }, now: Date): Promise<boolean> {
    const r = await this.prisma.sentinelExitTrigger.updateMany({
      where: { id, status: 'ARMED' },
      data: { status: 'FIRED', firedAt: now, firedPrice: tick.price, firedTickAt: tick.at },
    });
    return r.count === 1;
  }

  async expire(ids: string[], reason: string, now: Date): Promise<number> {
    if (ids.length === 0) return 0;
    const r = await this.prisma.sentinelExitTrigger.updateMany({
      where: { id: { in: ids }, status: 'ARMED' },
      data: { status: 'EXPIRED', endedAt: now, reason },
    });
    return r.count;
  }

  loadArmed(userIds: string[]): Promise<SentinelExitTrigger[]> {
    if (userIds.length === 0) return Promise.resolve([]);
    return this.prisma.sentinelExitTrigger.findMany({ where: { status: 'ARMED', userId: { in: userIds } } });
  }

  /** tracker id → its exchange (upper-cased). One PK query; used by the boot rebuild. */
  async trackerExchanges(ids: string[]): Promise<Map<string, string>> {
    if (ids.length === 0) return new Map();
    const rows = await this.prisma.tradeTracker.findMany({ where: { id: { in: ids } }, select: { id: true, exchange: true } });
    return new Map(rows.map((r) => [r.id, String(r.exchange ?? '').toUpperCase()]));
  }

  /** Trackers among `ids` that are no longer OPEN, or no longer exist. One PK query. */
  async closedTrackerIds(ids: string[]): Promise<string[]> {
    if (ids.length === 0) return [];
    const rows = await this.prisma.tradeTracker.findMany({ where: { id: { in: ids } }, select: { id: true, status: true } });
    const open = new Set(rows.filter((r) => r.status === 'OPEN').map((r) => r.id));
    return ids.filter((id) => !open.has(id));
  }

  /** ARMED first, then the newest `limit` rows — the caller's own only. */
  async listForUser(userId: string, limit: number): Promise<SentinelExitTrigger[]> {
    const [armed, recent] = await Promise.all([
      this.prisma.sentinelExitTrigger.findMany({ where: { userId, status: 'ARMED' }, orderBy: { armedAt: 'desc' } }),
      this.prisma.sentinelExitTrigger.findMany({ where: { userId }, orderBy: { createdAt: 'desc' }, take: limit }),
    ]);
    const seen = new Set(armed.map((r) => r.id));
    return [...armed, ...recent.filter((r) => !seen.has(r.id))];
  }
}
