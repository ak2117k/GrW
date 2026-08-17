import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../../common/prisma/prisma.service';

/**
 * One open position, with whatever the sentinel last concluded about it.
 *
 * Shaped for the CHART, not for the pipeline: it carries the three prices a
 * chart can draw (entry, green floor, last) plus the agent's own words, and
 * nothing the caller would have to join a second query to use.
 */
export interface WatchedPosition {
  trackerId: string;
  /** Broker tradingsymbol — `KEI29SEP265800CE` for a derivative. */
  symbol: string;
  exchange: string;
  token: string;
  /** Positive for long, negative for short — the broker's own sign. */
  qty: number;
  entryPrice: number;
  lastLtp: number | null;
  entryTime: Date;
  verdict: {
    verdict: string;
    confidence: string;
    thesisStatus: string;
    reason: string;
    invalidationPoint: string | null;
    evidence: string[];
    netPnl: number;
    greenFloor: number | null;
    triggeredBy: string[];
    at: Date;
  } | null;
  thesis: {
    direction: string;
    reason: string;
    levelPrice: number | null;
    targetPrice: number | null;
    invalidation: number | null;
    source: string;
  } | null;
}

/**
 * The chart's read model: every OPEN position for one tenant, each with its
 * most recent verdict and its thesis.
 *
 * POSITIONS ONLY — holdings are outside the sentinel's remit (see
 * `RosterService`), and a chart offering an agent's read on an instrument the
 * agent never watched would be inventing one.
 */
@Injectable()
export class WatchedPositionRepository {
  constructor(private readonly prisma: PrismaService) {}

  async listForUser(userId: string): Promise<WatchedPosition[]> {
    const trackers = await this.prisma.tradeTracker.findMany({
      where: { userId, status: 'OPEN', kind: 'POSITION' },
      select: {
        id: true,
        symbol: true,
        exchange: true,
        token: true,
        qty: true,
        entryPrice: true,
        lastLtp: true,
        entryTime: true,
      },
      orderBy: { entryTime: 'asc' },
    });
    if (trackers.length === 0) return [];

    const ids = trackers.map((t) => t.id);

    // Newest verdict per tracker. Fetched as one query over all of them rather
    // than one query per position: five positions on a chart poll is five round
    // trips to a remote database, and the page re-polls.
    const verdicts = await this.prisma.sentinelVerdict.findMany({
      where: { trackerId: { in: ids } },
      orderBy: { createdAt: 'desc' },
    });
    const theses = await this.prisma.sentinelThesis.findMany({
      where: { trackerId: { in: ids } },
    });

    const latestVerdict = new Map<string, (typeof verdicts)[number]>();
    // `verdicts` is newest-first, so the FIRST one seen per tracker is the
    // latest — do not overwrite on subsequent hits.
    for (const v of verdicts) if (!latestVerdict.has(v.trackerId)) latestVerdict.set(v.trackerId, v);
    const thesisFor = new Map(theses.map((t) => [t.trackerId, t]));

    return trackers.map((t) => {
      const v = latestVerdict.get(t.id);
      const th = thesisFor.get(t.id);
      return {
        trackerId: t.id,
        symbol: t.symbol,
        exchange: t.exchange,
        token: t.token,
        qty: t.qty,
        entryPrice: t.entryPrice,
        lastLtp: t.lastLtp,
        entryTime: t.entryTime,
        verdict: v
          ? {
              verdict: v.verdict,
              confidence: v.confidence,
              thesisStatus: v.thesisStatus,
              reason: v.reason,
              invalidationPoint: v.invalidationPoint,
              evidence: Array.isArray(v.evidence) ? (v.evidence as string[]) : [],
              netPnl: v.netPnl,
              greenFloor: v.greenFloor,
              triggeredBy: Array.isArray(v.triggeredBy) ? (v.triggeredBy as string[]) : [],
              at: v.createdAt,
            }
          : null,
        thesis: th
          ? {
              direction: th.direction,
              reason: th.reason,
              levelPrice: th.levelPrice,
              targetPrice: th.targetPrice,
              invalidation: th.invalidation,
              source: th.source,
            }
          : null,
      };
    });
  }
}
