import { Injectable } from '@nestjs/common';
import { Prisma, type PaperSentinelLook } from '@prisma/client';
import { PrismaService } from '../../../common/prisma/prisma.service';
import type { HistoryVerdict } from '../../exit-discipline/persistence';
import type { RecordVerdictInput } from '../repositories/sentinel-verdict.repository';
import { isPaperTracker, tradeIdOf } from './paper-tracker';

/**
 * The paper sentinel's verdict store: `paper_sentinel_looks`, the same columns as sentinel_verdicts.
 * It is the `verdicts` the paper cycle is built with, so the cycle reads its "last look" and writes
 * every look here — and nothing the live trigger watcher or auto-exit executor reads.
 */
@Injectable()
export class PaperLookRepository {
  constructor(private readonly prisma: PrismaService) {}

  async record(input: RecordVerdictInput): Promise<PaperSentinelLook> {
    if (!isPaperTracker(input.trackerId)) throw new Error(`paper look for a non-paper tracker ${input.trackerId}`);
    return this.prisma.paperSentinelLook.create({
      data: {
        tradeId: tradeIdOf(input.trackerId),
        userId: input.userId,
        trackerId: input.trackerId,
        symbol: input.symbol,
        verdict: input.verdict,
        confidence: input.confidence,
        thesisStatus: input.thesisStatus,
        recoveryAvailable: input.recoveryAvailable,
        reason: input.reason,
        evidence: input.evidence satisfies Prisma.InputJsonValue,
        invalidationPoint: input.invalidationPoint,
        reviewInSec: input.reviewInSec,
        packet: input.packet,
        promptVersion: input.promptVersion,
        triggeredBy: input.triggeredBy satisfies Prisma.InputJsonValue,
        netPnl: input.netPnl,
        greenFloor: input.greenFloor,
        ...(input.exitTrigger !== undefined ? { exitTrigger: input.exitTrigger } : {}),
        ...(input.newsShadow != null ? { newsShadow: input.newsShadow } : {}),
      },
    });
  }

  /** Newest first. Paper looks are all live looks (no overnight review runs on paper), so `liveOnly` changes nothing. */
  recentForTracker(trackerId: string, limit: number, _opts: { liveOnly?: boolean } = {}): Promise<PaperSentinelLook[]> {
    return this.prisma.paperSentinelLook.findMany({ where: { trackerId }, orderBy: { createdAt: 'desc' }, take: limit });
  }

  /** The exit gate's history (ExitGateRepository.recentVerdicts over this table): looks in [since, before), newest first. */
  history(trackerId: string, excludeId: string, before: Date, since: Date): Promise<HistoryVerdict[]> {
    return this.prisma.$queryRaw<HistoryVerdict[]>(Prisma.sql`
      SELECT v."id", v."verdict", v."createdAt",
        CASE WHEN jsonb_typeof(v."packet" #> '{position,underlyingLtp,value}') = 'number'
             THEN (v."packet" #>> '{position,underlyingLtp,value}')::float8 END AS "underlying",
        CASE WHEN jsonb_typeof(v."packet" #> '{structure,nearestSupport,value}') = 'number'
             THEN (v."packet" #>> '{structure,nearestSupport,value}')::float8 END AS "support",
        CASE WHEN jsonb_typeof(v."packet" #> '{structure,nearestResistance,value}') = 'number'
             THEN (v."packet" #>> '{structure,nearestResistance,value}')::float8 END AS "resistance"
      FROM "paper_sentinel_looks" v
      WHERE v."trackerId" = ${trackerId}
        AND v."id" <> ${excludeId}
        AND v."createdAt" < ${before} AND v."createdAt" >= ${since}
      ORDER BY v."createdAt" DESC
      LIMIT 60`);
  }
}
