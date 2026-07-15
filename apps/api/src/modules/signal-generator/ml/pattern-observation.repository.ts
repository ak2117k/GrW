import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../../common/prisma/prisma.service';
import type { PatternObservationInput } from './pattern-observation.types';

/** Identity of a still-PENDING observation, enough for the resolver to re-fetch its bars. */
export interface PendingObservation {
  id: string;
  token: string;
  exchange: string;
  timeframe: string;
  barTime: Date;
  /** Direction the row committed to at capture — the resolver labels against it. */
  bias: string;
}

/**
 * Persistence for {@link PatternObservation} — detected pattern instances and
 * their realized ATR-follow-through outcomes, feeding the ML pattern-quality
 * scorer.
 *
 * Deliberately NOT tenant-scoped: pattern observations are global market data
 * (same class as Signal and Candle), so the model is absent from TENANT_MODELS
 * and rows carry no userId.
 */
@Injectable()
export class PatternObservationRepository {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Insert observations, ignoring rows that collide on the unique key
   * (token, exchange, timeframe, patternName, barTime). This is what makes the
   * backfill idempotent across overlapping windows. Returns the rows written.
   */
  async saveMany(inputs: PatternObservationInput[]): Promise<number> {
    if (inputs.length === 0) return 0;
    const res = await this.prisma.patternObservation.createMany({
      data: inputs.map((i) => ({
        token: i.token,
        exchange: i.exchange,
        timeframe: i.timeframe,
        patternName: i.patternName,
        category: i.category,
        bias: i.bias,
        barTime: i.barTime,
        candleWindow: i.candleWindow as unknown as object,
        atrAtDetection: i.atrAtDetection,
        outcome: i.outcome,
        label: i.label,
      })),
      skipDuplicates: true,
    });
    return res.count;
  }

  /** Oldest still-PENDING observations, for the resolver job. */
  async findPending(limit: number): Promise<PendingObservation[]> {
    const rows = await this.prisma.patternObservation.findMany({
      where: { outcome: 'PENDING' },
      orderBy: { barTime: 'asc' },
      take: limit,
      select: {
        id: true, token: true, exchange: true, timeframe: true, barTime: true, bias: true,
      },
    });
    return rows;
  }

  /** Finalize a PENDING row once its horizon has resolved. */
  async updateOutcome(
    id: string,
    outcome: 'WIN' | 'LOSS' | 'TIMEOUT',
    label: 0 | 1 | null,
  ): Promise<void> {
    await this.prisma.patternObservation.update({
      where: { id },
      data: { outcome, label, resolvedAt: new Date() },
    });
  }
}
