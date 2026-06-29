import { Injectable, Logger } from '@nestjs/common';
import { Prisma, Setup } from '@prisma/client';
import { PrismaService } from '../../../common/prisma/prisma.service';

/**
 * Persistence-side mirror of LockedSetup. Mirrors the in-memory fields
 * the tracker needs to write at lock / update / close time. The Setup
 * row is created at lock(), patched on meaningful tick transitions
 * (status change, every Nth tick), and finalized at close().
 *
 * The in-memory tracker remains the source of truth for hot-path
 * lookups — every method here is best-effort and the tracker never
 * blocks on a DB error. See SetupTrackerService for the try/catch
 * wrappers.
 */
export interface SetupCreateInput {
  token: number;
  symbol: string;
  exchange: string;
  side: string;
  setupType: string;
  levelType: string;
  levelValue: number;
  entry: number;
  stoploss: number;
  target: number;
  partialTakeAt?: number | null;
  grade: string;
  atr14?: number | null;
  regime?: string | null;
  intradayRangeRatio?: number | null;
  higherTimeframeTrend?: Prisma.InputJsonValue | null;
  recommendedStrike?: Prisma.InputJsonValue | null;
  reason: string;
  status: string;
  lockedAt?: Date;
}

export interface SetupUpdateInput {
  status?: string;
  triggeredAt?: Date | null;
  triggerBarTimestamp?: Date | null;
  closedAt?: Date | null;
  closeReason?: string | null;
  invalidationKind?: string | null;
  invalidationReason?: string | null;
  mfeR?: number | null;
  maeR?: number | null;
  barsSinceEntry?: number | null;
  recommendedStrike?: Prisma.InputJsonValue | null;
}

@Injectable()
export class SetupRepository {
  private readonly logger = new Logger(SetupRepository.name);

  constructor(private readonly prisma: PrismaService) {}

  async create(data: SetupCreateInput): Promise<Setup> {
    const {
      higherTimeframeTrend,
      recommendedStrike,
      ...rest
    } = data;
    return this.prisma.setup.create({
      data: {
        ...rest,
        ...(higherTimeframeTrend !== undefined && higherTimeframeTrend !== null
          ? { higherTimeframeTrend }
          : {}),
        ...(recommendedStrike !== undefined && recommendedStrike !== null
          ? { recommendedStrike }
          : {}),
      },
    });
  }

  async update(id: string, data: SetupUpdateInput): Promise<Setup> {
    const { recommendedStrike, ...rest } = data;
    return this.prisma.setup.update({
      where: { id },
      data: {
        ...rest,
        ...(recommendedStrike !== undefined && recommendedStrike !== null
          ? { recommendedStrike }
          : {}),
      },
    });
  }

  async findActiveByToken(token: number): Promise<Setup[]> {
    return this.prisma.setup.findMany({
      where: {
        token,
        status: { in: ['PENDING', 'ACTIVE', 'PARTIAL_BOOKED'] },
      },
      orderBy: { lockedAt: 'desc' },
    });
  }

  async findById(id: string): Promise<Setup | null> {
    return this.prisma.setup.findUnique({ where: { id } });
  }
}
