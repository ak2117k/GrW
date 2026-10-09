import { Injectable } from '@nestjs/common';
import type { CoreStrategy, CoreStrategyVersion, Prisma } from '@prisma/client';
import { PrismaService } from '../../../../common/prisma/prisma.service';
import type { VersionCreator, VersionStatus } from '../version-status';

export type StrategyWithVersions = CoreStrategy & { versions: CoreStrategyVersion[] };
export type VersionWithStrategy = CoreStrategyVersion & { strategy: CoreStrategy };

export interface NewVersion {
  strategyId: string;
  version: number;
  blocks: Prisma.InputJsonValue;
  createdBy: VersionCreator;
  notes: string | null;
}

/**
 * The global, owner-curated catalogue (plan decision 1). Versions change only
 * through `updateDraft` (DRAFT rows) and `transition` (compare-and-set on the
 * status the caller read); the database trigger refuses anything else.
 */
@Injectable()
export class CoreStrategyRepository {
  constructor(private readonly prisma: PrismaService) {}

  listWithVersions(statuses?: readonly VersionStatus[]): Promise<StrategyWithVersions[]> {
    return this.prisma.coreStrategy.findMany({
      orderBy: { name: 'asc' },
      include: {
        versions: {
          where: statuses ? { status: { in: [...statuses] } } : undefined,
          orderBy: { version: 'desc' },
        },
      },
    });
  }

  findStrategy(id: string): Promise<CoreStrategy | null> {
    return this.prisma.coreStrategy.findUnique({ where: { id } });
  }

  findVersion(id: string): Promise<VersionWithStrategy | null> {
    return this.prisma.coreStrategyVersion.findUnique({ where: { id }, include: { strategy: true } });
  }

  async nextVersionNumber(strategyId: string): Promise<number> {
    const agg = await this.prisma.coreStrategyVersion.aggregate({ where: { strategyId }, _max: { version: true } });
    return (agg._max.version ?? 0) + 1;
  }

  createVersion(data: NewVersion): Promise<CoreStrategyVersion> {
    return this.prisma.coreStrategyVersion.create({ data: { ...data, status: 'DRAFT' } });
  }

  async updateDraft(id: string, data: { blocks: Prisma.InputJsonValue; notes: string | null }): Promise<boolean> {
    const r = await this.prisma.coreStrategyVersion.updateMany({ where: { id, status: 'DRAFT' }, data });
    return r.count === 1;
  }

  async transition(
    id: string,
    from: VersionStatus,
    data: { status: VersionStatus; approvedBy?: string; approvedAt?: Date },
  ): Promise<boolean> {
    const r = await this.prisma.coreStrategyVersion.updateMany({ where: { id, status: from }, data });
    return r.count === 1;
  }
}
