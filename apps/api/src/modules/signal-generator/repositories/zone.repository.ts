import { Injectable, Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../../common/prisma/prisma.service';
import { StrongZone, ZoneScoreBreakdown } from '../types/zone.types';

/**
 * Persistence-side repository for the StrongZone detector output.
 *
 * The detector is the source of truth — these rows are a read-side
 * cache so the chart overlay (and any other consumer) can fetch zones
 * without re-running the detector. Refreshed via {@link upsertMany}
 * which deletes the previous set for the token and inserts the new
 * one inside a transaction so consumers never observe a partial set.
 *
 * All writes are best-effort: the detector logs and swallows any
 * thrown error so a DB hiccup never breaks zone detection itself.
 */
@Injectable()
export class ZoneRepository {
  private readonly logger = new Logger(ZoneRepository.name);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Replace every zone for `token` with the supplied set in a single
   * transaction. Pass an empty array to clear the cache for the token.
   */
  async upsertMany(token: string, zones: StrongZone[]): Promise<number> {
    try {
      const data = zones.map((z) => ({
        token: z.token,
        symbol: z.symbol,
        exchange: z.exchange,
        type: z.type,
        upper: z.upper,
        lower: z.lower,
        isLine: z.isLine,
        strength: z.strength,
        classification: z.classification,
        touchCount: z.touchCount,
        lastTouchTimestamp: new Date(z.lastTouchTimestamp),
        scoreBreakdown: z.scoreBreakdown as unknown as Prisma.InputJsonValue,
        computedAt: new Date(z.computedAt),
        expiresAt: new Date(z.expiresAt),
      }));

      const result = await this.prisma.$transaction(async (tx) => {
        await tx.zone.deleteMany({ where: { token } });
        if (data.length === 0) return 0;
        const inserted = await tx.zone.createMany({ data });
        return inserted.count;
      });

      return result;
    } catch (err) {
      this.logger.warn(
        `upsertMany(${token}) failed: ${err instanceof Error ? err.message : err}`,
      );
      // Re-throw so the caller's try/catch can decide what to do; the
      // detector wraps this in its own try/catch and returns the
      // in-memory zones regardless.
      throw err;
    }
  }

  /**
   * Return non-expired zones for the given token, ordered as the chart
   * wants to render them (resistance descending, support descending —
   * i.e. top of price ladder first within each group).
   */
  async findActiveByToken(token: string): Promise<StrongZone[]> {
    const rows = await this.prisma.zone.findMany({
      where: { token, expiresAt: { gt: new Date() } },
      orderBy: [{ type: 'asc' }, { upper: 'desc' }],
    });

    return rows.map((r) => ({
      id: r.id,
      token: r.token,
      symbol: r.symbol,
      exchange: r.exchange,
      type: r.type as StrongZone['type'],
      upper: r.upper,
      lower: r.lower,
      isLine: r.isLine,
      strength: r.strength,
      classification: r.classification as StrongZone['classification'],
      touchCount: r.touchCount,
      lastTouchTimestamp: r.lastTouchTimestamp.getTime(),
      scoreBreakdown: r.scoreBreakdown as unknown as ZoneScoreBreakdown,
      computedAt: r.computedAt.getTime(),
      expiresAt: r.expiresAt.getTime(),
    }));
  }
}
