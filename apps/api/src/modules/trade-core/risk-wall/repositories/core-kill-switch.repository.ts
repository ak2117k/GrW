import { Injectable } from '@nestjs/common';
import type { CoreKillSwitch } from '@prisma/client';
import { PrismaService } from '../../../../common/prisma/prisma.service';
import { ConcurrentRiskChangeError, nextCreatedAt } from './core-risk-limit.repository';

export interface NewKillSwitchRow {
  active: boolean;
  effectiveFrom: Date;
  setBy: string;
  reason: string;
}

/** Per-user, append-only kill switch rows (spec §5.4). No update or delete method. */
@Injectable()
export class CoreKillSwitchRepository {
  constructor(private readonly prisma: PrismaService) {}

  listForUser(userId: string): Promise<CoreKillSwitch[]> {
    return this.prisma.coreKillSwitch.findMany({ where: { userId }, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] });
  }

  /**
   * `expectNewestId` undefined = no check: turning the switch ON is never refused
   * (plan decision 8). A release passes the newest id it read.
   */
  append(userId: string, row: NewKillSwitchRow, now: Date, expectNewestId?: string | null): Promise<CoreKillSwitch> {
    return this.prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`core_kill_switch:${userId}`}, 0))`;
      const newest = await tx.coreKillSwitch.findFirst({
        where: { userId },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        select: { id: true, createdAt: true },
      });
      if (expectNewestId !== undefined && (newest?.id ?? null) !== expectNewestId) {
        throw new ConcurrentRiskChangeError('the kill switch');
      }
      return tx.coreKillSwitch.create({ data: { ...row, userId, createdAt: nextCreatedAt(newest?.createdAt ?? null, now) } });
    });
  }
}
