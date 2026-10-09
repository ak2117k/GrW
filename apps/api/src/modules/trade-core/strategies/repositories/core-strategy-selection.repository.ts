import { Injectable } from '@nestjs/common';
import type { CoreStrategySelection, Prisma } from '@prisma/client';
import { PrismaService } from '../../../../common/prisma/prisma.service';

export interface SelectionWrite {
  strategyVersionId: string;
  enabled: boolean;
  /** Exact rupees for the DECIMAL(14,2) column; handed to Prisma as-is, never via a float. */
  capitalAllocation: Prisma.Decimal;
}

/**
 * Per-user selections (spec §4.2, one row per user per strategy). Every query
 * names the caller's userId explicitly; the Prisma tenant extension adds the same
 * filter again for non-admin requests (TENANT_MODELS). `update` never carries
 * userId or strategyId, so a row cannot move to another user or strategy.
 */
@Injectable()
export class CoreStrategySelectionRepository {
  constructor(private readonly prisma: PrismaService) {}

  listForUser(userId: string): Promise<CoreStrategySelection[]> {
    return this.prisma.coreStrategySelection.findMany({ where: { userId }, orderBy: { createdAt: 'asc' } });
  }

  findForUser(userId: string, strategyId: string): Promise<CoreStrategySelection | null> {
    return this.prisma.coreStrategySelection.findUnique({ where: { userId_strategyId: { userId, strategyId } } });
  }

  upsert(userId: string, strategyId: string, data: SelectionWrite): Promise<CoreStrategySelection> {
    return this.prisma.coreStrategySelection.upsert({
      where: { userId_strategyId: { userId, strategyId } },
      create: { userId, strategyId, ...data },
      update: { ...data },
    });
  }
}
