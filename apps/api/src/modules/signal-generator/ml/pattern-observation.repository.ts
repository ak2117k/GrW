import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../../common/prisma/prisma.service';
import type { PatternObservationInput } from './pattern-observation.types';

/** Identity of a still-PENDING observation, enough for the resolver to re-fetch its bars. */
export interface PendingObservation {
  id: string;
  token: string;
  exchange: string;
  timeframe: string;
  /**
   * The ANCHOR bar — the row's identity, not necessarily the bar it is labelled
   * from. A CHART pattern is not detectable at its own anchor, so the resolver
   * must shift to the decision bar; see `category`.
   */
  barTime: Date;
  /** Direction the row committed to at capture — the resolver labels against it. */
  bias: string;
  /**
   * CHART or CANDLESTICK. Selected because it is what tells the resolver the
   * DETECTION LAG: a CHART pattern only becomes detectable
   * `CHART_DETECTION_LAG_BARS` after its anchor, and the assembler labelled it
   * from that decision bar at capture. Without this the resolver would label from
   * `barTime` and put a second, more optimistic yardstick in the same table —
   * affecting exactly the rows that went PENDING, i.e. the live ones.
   */
  category: string;
  /**
   * ATR at the detection bar, as stored at capture. The resolver labels against
   * THIS value rather than recomputing one: Wilder ATR is recursive with an SMA
   * seed, so an ATR recomputed from the resolver's own (differently-sized)
   * lookback window would not equal the `atrAtDetection` the row carries as a
   * feature. Reusing the stored number keeps each row's feature and its label on
   * the same yardstick by construction.
   */
  atrAtDetection: number;
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
        // Absent context → SQL NULL (DbNull), not a JSON `null` literal, so
        // training can filter on `IS NULL`. Only live-edge (scan) rows carry it.
        detectionContext:
          i.detectionContext == null
            ? Prisma.DbNull
            : (i.detectionContext as unknown as Prisma.InputJsonValue),
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
        category: true, atrAtDetection: true,
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
