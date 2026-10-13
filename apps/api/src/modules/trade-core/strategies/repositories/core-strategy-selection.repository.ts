import { Injectable } from '@nestjs/common';
import type { CoreStrategySelection, Prisma } from '@prisma/client';
import { PrismaService } from '../../../../common/prisma/prisma.service';
import type { StrategyBlocks } from '../blocks/block-types';

export interface SelectionWrite {
  strategyVersionId: string;
  enabled: boolean;
  /** Exact rupees for the DECIMAL(14,2) column; handed to Prisma as-is, never via a float. */
  capitalAllocation: Prisma.Decimal;
}

/** One live selection for the M5 intake (M1 note: live = enabled AND its version is PAPER). */
export interface LiveSelection {
  userId: string;
  strategyId: string;
  strategyKey: string;
  strategyVersionId: string;
  blocks: StrategyBlocks;
  /** Exact rupees; journaled, not enforced in M5 (O8). */
  capitalAllocation: string;
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

  /**
   * M5 intake system scan (ruling J24): every user's enabled selection whose version is PAPER. Called
   * from the Chartink worker, outside any request, so the tenant extension does not scope it.
   */
  async listEnabledPaper(): Promise<LiveSelection[]> {
    const rows = await this.prisma.coreStrategySelection.findMany({
      where: { enabled: true, strategyVersion: { status: 'PAPER' } },
      include: { strategy: true, strategyVersion: true },
      orderBy: [{ userId: 'asc' }, { createdAt: 'asc' }],
    });
    return rows.map((r) => ({
      userId: r.userId,
      strategyId: r.strategyId,
      strategyKey: r.strategy.key,
      strategyVersionId: r.strategyVersionId,
      blocks: r.strategyVersion.blocks as unknown as StrategyBlocks,
      capitalAllocation: r.capitalAllocation.toFixed(2),
    }));
  }
}
