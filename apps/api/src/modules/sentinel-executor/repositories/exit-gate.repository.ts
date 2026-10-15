import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../../common/prisma/prisma.service';
import type { HistoryVerdict } from '../../exit-discipline/persistence';

/** Reads for the exit gate (exit discipline §6/§7). Read-only; never writes anything. */
@Injectable()
export class ExitGateRepository {
  constructor(private readonly prisma: PrismaService) {}

  async verdictPacket(verdictId: string): Promise<unknown | null> {
    const row = await this.prisma.sentinelVerdict.findUnique({ where: { id: verdictId }, select: { packet: true } });
    return row ? row.packet : null;
  }

  /** Live verdicts on the tracker in [since, before), newest first; overnight-review rows excluded. */
  recentVerdicts(trackerId: string, excludeId: string, before: Date, since: Date): Promise<HistoryVerdict[]> {
    return this.prisma.$queryRaw<HistoryVerdict[]>(Prisma.sql`
      SELECT v."id", v."verdict", v."createdAt",
        CASE WHEN jsonb_typeof(v."packet" #> '{position,underlyingLtp,value}') = 'number'
             THEN (v."packet" #>> '{position,underlyingLtp,value}')::float8 END AS "underlying",
        CASE WHEN jsonb_typeof(v."packet" #> '{structure,nearestSupport,value}') = 'number'
             THEN (v."packet" #>> '{structure,nearestSupport,value}')::float8 END AS "support",
        CASE WHEN jsonb_typeof(v."packet" #> '{structure,nearestResistance,value}') = 'number'
             THEN (v."packet" #>> '{structure,nearestResistance,value}')::float8 END AS "resistance"
      FROM "sentinel_verdicts" v
      WHERE v."trackerId" = ${trackerId}
        AND v."id" <> ${excludeId}
        AND v."createdAt" < ${before} AND v."createdAt" >= ${since}
        AND v."promptVersion" !~ '^o[0-9]+/'
      ORDER BY v."createdAt" DESC
      LIMIT 60`);
  }

  /**
   * The user's `maxRiskPerTrade@ALL` in force, by the risk wall's own rule
   * (`trade-core/risk-wall/limits/append-only.ts` resolveAppendOnly): the most
   * recently CREATED row whose effectiveFrom <= now, id breaking a tie. No row
   * (unseeded user) ⇒ null ⇒ the HARD_MAX_LOSS clause is unmeasurable.
   */
  async maxRiskPerTrade(userId: string, now: Date): Promise<number | null> {
    const row = await this.prisma.coreRiskLimit.findFirst({
      where: { userId, key: 'maxRiskPerTrade', scope: 'ALL', effectiveFrom: { lte: now } },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      select: { numValue: true },
    });
    const n = row?.numValue != null ? Number(row.numValue.toString()) : NaN;
    return Number.isFinite(n) && n > 0 ? n : null;
  }

  async dailyLossLatched(userId: string, istDay: string): Promise<boolean> {
    const row = await this.prisma.coreJournal.findUnique({ where: { dedupeKey: `latch:${userId}:${istDay}` }, select: { id: true } });
    return row !== null;
  }
}
