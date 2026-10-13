// apps/api/src/modules/sentinel-executor/repositories/ai-exit-execution.repository.ts
import { Injectable } from '@nestjs/common';
import { Prisma, type AiExitExecution } from '@prisma/client';
import { PrismaService } from '../../../common/prisma/prisma.service';
import {
  COUNTED_STATUSES,
  UNKNOWN_FATE_REASONS,
  type AiExitStatus,
  type AutoExitMode,
  type SessionSource,
} from '../domain/auto-exit.types';
import { istDayStartUtc } from '../domain/exit-order';
import { MANUAL_VERDICT_PREFIX } from '../domain/manual-exit';

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

  /**
   * Cap count (spec §5.3, review fix 2): every row where an order may have been
   * sent — PLACED, FILLED, FAILED with an unknown fate — plus DRY_RUN, counted
   * in ONE mode (review fix 4): dry-run rehearsals never use up the live cap.
   */
  countCountedSince(userId: string, since: Date, mode: AutoExitMode): Promise<number> {
    return this.prisma.aiExitExecution.count({
      where: {
        userId,
        mode,
        createdAt: { gte: since },
        OR: [
          { status: { in: [...COUNTED_STATUSES] } },
          { status: 'FAILED', reason: { in: [...UNKNOWN_FATE_REASONS] } },
        ],
        // The owner's manual "Exit now" never uses up the AI's daily cap.
        NOT: { verdictId: { startsWith: MANUAL_VERDICT_PREFIX } },
      },
    });
  }

  /** Every manual attempt ever made for the tracker (the next attempt's sequence number - 1). */
  countManualForTracker(trackerId: string): Promise<number> {
    return this.prisma.aiExitExecution.count({
      where: { trackerId, verdictId: { startsWith: MANUAL_VERDICT_PREFIX } },
    });
  }

  /**
   * The caller's manual attempt on this tracker that is still working: CLAIMED,
   * or PLACED today (its order may be resting). A repeat click returns it.
   */
  findActiveManual(trackerId: string, userId: string, now: Date): Promise<AiExitExecution | null> {
    return this.prisma.aiExitExecution.findFirst({
      where: {
        trackerId,
        userId,
        verdictId: { startsWith: MANUAL_VERDICT_PREFIX },
        OR: [
          { status: 'CLAIMED' },
          { status: 'PLACED', createdAt: { gte: istDayStartUtc(now) } },
        ],
      },
      orderBy: { createdAt: 'desc' },
    });
  }

  findById(id: string): Promise<AiExitExecution | null> {
    return this.prisma.aiExitExecution.findUnique({ where: { id } });
  }

  findByVerdictId(verdictId: string): Promise<AiExitExecution | null> {
    return this.prisma.aiExitExecution.findUnique({ where: { verdictId } });
  }

  /**
   * Review fix 2. Another attempt blocks this one when it is still CLAIMED, or
   * when — today (IST) — it is PLACED (any age; FILLED is settled) or FAILED with
   * an unknown fate (ORDER_UNCERTAIN / INTERRUPTED): its order may be resting or
   * already filled, and a second exit could reverse the position. Matched on the
   * tracker OR the contract (exchange + token, as written to the row before the
   * order), so a re-created tracker for the same position is blocked too.
   */
  async hasInFlight(
    trackerId: string,
    excludeId: string,
    now: Date,
    contract?: { userId: string; exchange: string; token: string },
  ): Promise<boolean> {
    const scope: Prisma.AiExitExecutionWhereInput[] = [{ trackerId }];
    if (contract?.userId && contract?.exchange && contract?.token) {
      scope.push({ userId: contract.userId, exchange: String(contract.exchange).toUpperCase(), token: String(contract.token) });
    }
    const n = await this.prisma.aiExitExecution.count({
      where: {
        id: { not: excludeId },
        AND: [
          { OR: scope },
          {
            OR: [
              { status: 'CLAIMED' },
              {
                createdAt: { gte: istDayStartUtc(now) },
                OR: [
                  { status: 'PLACED' },
                  { status: 'FAILED', reason: { in: [...UNKNOWN_FATE_REASONS] } },
                ],
              },
            ],
          },
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
