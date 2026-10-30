import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../../common/prisma/prisma.service';

/** ai_exit_executions statuses that produce a noise read (sentinel-executor NOISE_READ_STATUSES). */
const NOISE_READ_STATUSES = ['PLACED', 'FILLED', 'DRY_RUN'];

/**
 * The sanity audit's ONLY reads of ai_exit_executions (sanctioned in sentinel-executor.structure.spec as
 * an audit reader). Read-only, and never a manual exit: the owner's Exit button writes `man_` verdict ids,
 * which are not AI decisions and get no noise read — counting them would raise false alarms.
 */
@Injectable()
export class AiExitAuditReader {
  constructor(private readonly prisma: PrismaService) {}

  /** FILLED real AI exits since `from`, with the price the sentinel last saw before the attempt. */
  filledExits(from: Date): Promise<Array<{ id: string; symbol: string; fill: unknown; at: Date; look_ltp: unknown; look_at: Date | null }>> {
    return this.prisma.$queryRaw`
      SELECT a.id, a.symbol, a."fillPrice" AS fill, COALESCE(a."fillAt", a."createdAt") AS at,
        v.packet->'position'->>'ltp' AS look_ltp, v."createdAt" AS look_at
      FROM "ai_exit_executions" a
      LEFT JOIN LATERAL (
        SELECT s.packet, s."createdAt" FROM "sentinel_verdicts" s
        WHERE s."trackerId" = a."trackerId" AND s."createdAt" <= a."createdAt" ORDER BY s."createdAt" DESC LIMIT 1
      ) v ON true
      WHERE a.status = 'FILLED' AND a."fillPrice" IS NOT NULL AND a."createdAt" >= ${from}
        AND left(a."verdictId", 4) <> 'man_'`;
  }

  /** Real AI exits the executor acted on since `from`, each with its noise read's write time. */
  exitRecords(from: Date): Promise<Array<{ id: string; symbol: string; at: Date; read_at: Date | null }>> {
    return this.prisma.$queryRaw`
      SELECT a.id, a.symbol, COALESCE(a."orderSentAt", a."createdAt") AS at,
        (SELECT min(n.created_at) FROM "exit_noise_reads" n WHERE n.source = 'real' AND n.ref_id = a."verdictId") AS read_at
      FROM "ai_exit_executions" a
      WHERE a.status = ANY(${NOISE_READ_STATUSES}) AND a."createdAt" >= ${from}
        AND left(a."verdictId", 4) <> 'man_'`;
  }
}
