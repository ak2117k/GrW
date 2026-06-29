import { Injectable, Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../../common/prisma/prisma.service';

/** One persisted S/R level snapshot, pre-reaction. */
export interface SrLevelObservationInput {
  token: string;
  exchange: string;
  interval: string;
  price: number;
  side: string; // 'resistance' | 'support'
  kinds: string[];
  score: number;
  ltpAtSnapshot: number;
  atr14?: number | null;
}

/** Reaction verdict written back by the evaluation pass. */
export interface MarkEvaluatedInput {
  touched: boolean;
  reaction: string; // 'REJECTED' | 'BROKE' | 'UNTOUCHED'
  detail?: unknown;
  evaluatedAt?: Date;
}

/** Per-evidence-kind hold-rate aggregate. */
export interface KindHoldRate {
  n: number;
  touched: number;
  rejected: number;
  broke: number;
  /** rejected / (rejected + broke); null when no decisive (rejected+broke) rows. */
  holdRate: number | null;
}

/**
 * Persistence for {@link SrLevelObservation} — snapshots of evidence-weighted
 * S/R levels and their later-evaluated reactions. Read by the calibration
 * script (scripts/sr-hold-rate.mjs) to weight evidence kinds by how often
 * price actually respects the levels they produce.
 *
 * Aggregation is done in-memory (kinds is a String[]; Prisma cannot groupBy
 * array elements), tallying each row once per kind it carries.
 */
@Injectable()
export class SrLevelObservationRepository {
  private readonly logger = new Logger(SrLevelObservationRepository.name);

  constructor(private readonly prisma: PrismaService) {}

  /** Bulk-insert snapshots. Returns the number of rows written. */
  async recordMany(observations: SrLevelObservationInput[]): Promise<number> {
    if (observations.length === 0) return 0;
    const data = observations.map((o) => ({
      token: o.token,
      exchange: o.exchange,
      interval: o.interval,
      price: o.price,
      side: o.side,
      kinds: o.kinds,
      score: o.score,
      ltpAtSnapshot: o.ltpAtSnapshot,
      atr14: o.atr14 ?? null,
    }));
    const res = await this.prisma.srLevelObservation.createMany({ data });
    return res.count;
  }

  /**
   * Unevaluated snapshots taken before `cutoff` (i.e. old enough that the
   * grace window has elapsed). Oldest first so the evaluator drains a backlog
   * in order.
   */
  async findUnevaluatedBefore(cutoff: Date, limit = 200) {
    return this.prisma.srLevelObservation.findMany({
      where: { reaction: null, snapshotAt: { lt: cutoff } },
      orderBy: { snapshotAt: 'asc' },
      take: limit, // cap per pass so the evaluator can't starve the shared historical-fetch budget
    });
  }

  /** Write the reaction verdict for one observation. */
  async markEvaluated(id: string, input: MarkEvaluatedInput): Promise<void> {
    await this.prisma.srLevelObservation.update({
      where: { id },
      data: {
        evaluatedAt: input.evaluatedAt ?? new Date(),
        touched: input.touched,
        reaction: input.reaction,
        reactionDetail:
          input.detail === undefined
            ? undefined
            : (input.detail as Prisma.InputJsonValue),
      },
    });
  }

  /**
   * Per-kind hold-rate aggregation over evaluated observations. Each row is
   * counted once for every evidence kind it carries.
   */
  async holdRateByKind(): Promise<Record<string, KindHoldRate>> {
    const rows = await this.prisma.srLevelObservation.findMany({
      where: { reaction: { not: null } },
      select: { kinds: true, touched: true, reaction: true },
    });

    const out: Record<string, KindHoldRate> = {};
    for (const r of rows) {
      for (const kind of r.kinds ?? []) {
        const agg = (out[kind] ??= { n: 0, touched: 0, rejected: 0, broke: 0, holdRate: null });
        agg.n += 1;
        if (r.touched) agg.touched += 1;
        if (r.reaction === 'REJECTED') agg.rejected += 1;
        else if (r.reaction === 'BROKE') agg.broke += 1;
      }
    }
    for (const agg of Object.values(out)) {
      const decisive = agg.rejected + agg.broke;
      agg.holdRate = decisive > 0 ? agg.rejected / decisive : null;
    }
    return out;
  }
}
