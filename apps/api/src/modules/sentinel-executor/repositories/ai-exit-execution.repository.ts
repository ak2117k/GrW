// apps/api/src/modules/sentinel-executor/repositories/ai-exit-execution.repository.ts
import { Injectable } from '@nestjs/common';
import { Prisma, type AiExitExecution } from '@prisma/client';
import { PrismaService } from '../../../common/prisma/prisma.service';
import {
  COUNTED_STATUSES,
  type AiExitStatus,
  type AutoExitMode,
  type SessionSource,
} from '../domain/auto-exit.types';

export interface PendingVerdict {
  id: string;
  userId: string;
  trackerId: string;
  symbol: string;
  reason: string;
  createdAt: Date;
}

export type AiExitPatch = Partial<
  Pick<
    AiExitExecution,
    | 'exchange' | 'token' | 'side' | 'quantity' | 'productType' | 'orderType' | 'limitPrice'
    | 'reason' | 'brokerOrderId' | 'brokerMessage' | 'orderStatus' | 'marketOrderId'
  >
> & { status?: AiExitStatus; sessionSource?: SessionSource };

const IN_FLIGHT_PLACED_MS = 60_000;

@Injectable()
export class AiExitExecutionRepository {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * THE 5-SECOND QUERY (spec §5.1, plan R7). One statement, served by
   * sentinel_verdicts(userId, createdAt) and the unique ai_exit_executions(verdictId).
   */
  async pendingVerdicts(userIds: string[], since: Date, limit = 5): Promise<PendingVerdict[]> {
    if (userIds.length === 0) return [];
    return this.prisma.$queryRaw<PendingVerdict[]>(Prisma.sql`
      SELECT v."id", v."userId", v."trackerId", v."symbol", v."reason", v."createdAt"
      FROM "sentinel_verdicts" v
      WHERE v."userId" IN (${Prisma.join(userIds)})
        AND v."createdAt" >= ${since}
        AND v."verdict" = 'EXIT_NOW'
        AND NOT EXISTS (SELECT 1 FROM "ai_exit_executions" e WHERE e."verdictId" = v."id")
      ORDER BY v."createdAt" ASC
      LIMIT ${limit}`);
  }

  /** Insert the CLAIMED row BEFORE any broker call. null = already claimed elsewhere. */
  async claim(v: PendingVerdict, mode: AutoExitMode): Promise<string | null> {
    try {
      const row = await this.prisma.aiExitExecution.create({
        data: {
          userId: v.userId,
          verdictId: v.id,
          trackerId: v.trackerId,
          symbol: v.symbol,
          mode,
          status: 'CLAIMED',
          verdictReason: v.reason,
        },
        select: { id: true },
      });
      return row.id;
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') return null;
      throw err;
    }
  }

  async update(id: string, patch: AiExitPatch): Promise<void> {
    await this.prisma.aiExitExecution.update({ where: { id }, data: patch });
  }

  countCountedSince(userId: string, since: Date): Promise<number> {
    return this.prisma.aiExitExecution.count({
      where: { userId, createdAt: { gte: since }, status: { in: [...COUNTED_STATUSES] } },
    });
  }

  async hasInFlight(trackerId: string, excludeId: string, now: Date): Promise<boolean> {
    const n = await this.prisma.aiExitExecution.count({
      where: {
        trackerId,
        id: { not: excludeId },
        OR: [
          { status: 'CLAIMED' },
          { status: 'PLACED', createdAt: { gte: new Date(now.getTime() - IN_FLIGHT_PLACED_MS) } },
        ],
      },
    });
    return n > 0;
  }

  /** Plan R8: a CLAIMED row this old was cut off mid-flight. Never re-sent. */
  async sweepInterrupted(olderThan: Date): Promise<number> {
    const r = await this.prisma.aiExitExecution.updateMany({
      where: { status: 'CLAIMED', createdAt: { lt: olderThan } },
      data: { status: 'FAILED', reason: 'INTERRUPTED' },
    });
    return r.count;
  }

  listForUser(userId: string, limit: number): Promise<AiExitExecution[]> {
    return this.prisma.aiExitExecution.findMany({
      where: { userId },
      orderBy: { createdAt: 'desc' },
      take: limit,
    });
  }
}
