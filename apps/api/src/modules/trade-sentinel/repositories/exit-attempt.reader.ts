import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../../common/prisma/prisma.service';
import type { ExitAttempt, ExitAttemptReader } from '../services/futile-rejudge';

/**
 * READ-ONLY view of `ai_exit_executions` for the futile re-judge rule: the
 * latest exit attempt per tracker since `since`, for a whole cycle's open
 * trackers in ONE query (DISTINCT ON, on the (userId, createdAt) index).
 * Never writes, never reaches a broker.
 */
@Injectable()
export class PrismaExitAttemptReader implements ExitAttemptReader {
  constructor(private readonly prisma: PrismaService) {}

  async latestSince(userIds: string[], trackerIds: string[], since: Date): Promise<Map<string, ExitAttempt>> {
    const out = new Map<string, ExitAttempt>();
    if (userIds.length === 0 || trackerIds.length === 0) return out;
    const rows = await this.prisma.$queryRaw<ExitAttempt[]>(Prisma.sql`
      SELECT DISTINCT ON (e."trackerId") e."id", e."trackerId", e."status", e."reason", e."createdAt"
      FROM "ai_exit_executions" e
      WHERE e."userId" IN (${Prisma.join(userIds)})
        AND e."createdAt" >= ${since}
        AND e."trackerId" IN (${Prisma.join(trackerIds)})
      ORDER BY e."trackerId", e."createdAt" DESC
    `);
    for (const r of rows) out.set(r.trackerId, r);
    return out;
  }
}
