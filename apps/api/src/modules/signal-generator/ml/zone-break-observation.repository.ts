import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../../common/prisma/prisma.service';
import type { HitRateStats } from './zone-break-hit-rate';

/** Direction of the break. UP = through resistance, DOWN = through support. */
export type ZoneBreakSide = 'UP' | 'DOWN';

/** Resolution state of a row. PENDING = the horizon has not produced enough bars yet. */
export type ZoneBreakOutcomeName = 'WIN' | 'LOSS' | 'TIMEOUT' | 'PENDING';

/** Volume regime at the break. UNKNOWN when there was no reading — never 0. */
export type ZoneBreakVolumeBucket = 'LOW' | 'NORMAL' | 'HIGH' | 'UNKNOWN';

/**
 * A confirmed break, as observed. Carries no outcome: capture is LIVE-EDGE only,
 * so every row is born PENDING and is labelled later by the resolver. Keeping
 * `outcome`/`label` off this type makes it impossible for a caller to write a
 * pre-judged row.
 */
export interface ZoneBreakCaptureInput {
  token: string;
  exchange: string;
  timeframe: string;
  side: ZoneBreakSide;
  /** The break bar — the row's identity. A confirmed break is actionable at its own close. */
  barTime: Date;
  // --- Cohort key ---
  zoneClassification: 'STRONG' | 'MEDIUM' | 'WEAK';
  touchCount: number;
  volumeBucket: ZoneBreakVolumeBucket;
  htfAgreed: boolean;
  // --- Geometry at detection, in ATR units so it is comparable across symbols ---
  atrAtDetection: number;
  /** |target - entry| / atr. Becomes `k` when the row is labelled. */
  targetDistAtr: number;
  /** |entry - stop| / atr. Becomes `m` when the row is labelled. */
  stopDistAtr: number;
  targetSource: string;
}

/**
 * Identity of a still-PENDING break, plus everything the resolver needs to
 * reproduce the yardstick this row was measured with.
 *
 * `atrAtDetection`, `targetDistAtr` and `stopDistAtr` are all here for the same
 * reason: each projection resolves against ITS OWN target distance, not a shared
 * constant. A resolver that recomputed any of them from its own (differently
 * sized) window would label the row against a geometry it never stored — which
 * is precisely why these rows do not live in `pattern_observations`, where
 * k is fixed at 1.5 ATR for every row.
 */
export interface PendingZoneBreak {
  id: string;
  token: string;
  exchange: string;
  timeframe: string;
  side: string;
  barTime: Date;
  atrAtDetection: number;
  targetDistAtr: number;
  stopDistAtr: number;
}

/**
 * The cohort a break is grouped by when its own symbol has too little resolved
 * history. Every field is part of the key — a STRONG zone broken on HIGH volume
 * with the higher timeframe agreeing is a different animal from a WEAK one
 * broken on no volume against the HTF, and averaging them would produce a number
 * that describes neither.
 */
export interface ZoneBreakCohort {
  timeframe: string;
  zoneClassification: string;
  volumeBucket: string;
  htfAgreed: boolean;
}

/** Outcomes that count as evidence. PENDING is excluded — the break is still open. */
const RESOLVED_OUTCOMES = ['WIN', 'LOSS', 'TIMEOUT'];

/**
 * Persistence for {@link ZoneBreakObservation} — confirmed zone breaks and how
 * they resolved against their own projected target, feeding the measured
 * hit-rate on `ProjectionBox`.
 *
 * Deliberately NOT tenant-scoped: a zone break is global market data (same class
 * as Candle and PatternObservation), so the model is absent from TENANT_MODELS
 * and rows carry no userId.
 *
 * See docs/superpowers/specs/2026-08-10-projection-zones-design.md §3.4.
 */
@Injectable()
export class ZoneBreakObservationRepository {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Insert breaks as PENDING, ignoring rows that collide on the unique key
   * (token, exchange, timeframe, side, barTime). That is what makes the backfill
   * idempotent across overlapping windows, and what stops a re-rendered chart
   * from double-counting one break into the hit-rate it then displays.
   *
   * `outcome` is hard-coded to PENDING rather than taken from the input: the
   * only path that may write an outcome is {@link updateOutcome}, after the
   * horizon has actually produced the bars.
   */
  async saveMany(inputs: ZoneBreakCaptureInput[]): Promise<number> {
    if (inputs.length === 0) return 0;
    const res = await this.prisma.zoneBreakObservation.createMany({
      data: inputs.map((i) => ({
        token: i.token,
        exchange: i.exchange,
        timeframe: i.timeframe,
        side: i.side,
        barTime: i.barTime,
        zoneClassification: i.zoneClassification,
        touchCount: i.touchCount,
        volumeBucket: i.volumeBucket,
        htfAgreed: i.htfAgreed,
        atrAtDetection: i.atrAtDetection,
        targetDistAtr: i.targetDistAtr,
        stopDistAtr: i.stopDistAtr,
        targetSource: i.targetSource,
        outcome: 'PENDING',
        label: null,
      })),
      skipDuplicates: true,
    });
    return res.count;
  }

  /** Oldest still-PENDING breaks, for the resolver job. */
  async findPending(limit: number): Promise<PendingZoneBreak[]> {
    const rows = await this.prisma.zoneBreakObservation.findMany({
      where: { outcome: 'PENDING' },
      orderBy: { barTime: 'asc' },
      take: limit,
      select: {
        id: true, token: true, exchange: true, timeframe: true, side: true, barTime: true,
        // All three are the row's stored yardstick; see PendingZoneBreak.
        atrAtDetection: true, targetDistAtr: true, stopDistAtr: true,
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
    await this.prisma.zoneBreakObservation.update({
      where: { id },
      data: { outcome, label, resolvedAt: new Date() },
    });
  }

  /**
   * Resolved tally for one symbol on one timeframe — the `[token, exchange,
   * timeframe]` index, one grouped read.
   *
   * Grouped rather than two counts on purpose: `wins` and `sample` must come
   * from the SAME snapshot, or a break resolving between two queries could
   * produce `wins > sample` and a hit-rate above 100%.
   */
  async statsForSymbol(token: string, exchange: string, timeframe: string): Promise<HitRateStats> {
    const groups = await this.prisma.zoneBreakObservation.groupBy({
      by: ['outcome'],
      where: { token, exchange, timeframe, outcome: { in: RESOLVED_OUTCOMES } },
      _count: { _all: true },
    });
    return tally(groups);
  }

  /**
   * Resolved tally for a cohort — the `[timeframe, zoneClassification,
   * volumeBucket]` index, with `htfAgreed` filtered on top. One grouped read.
   */
  async statsForCohort(cohort: ZoneBreakCohort): Promise<HitRateStats> {
    const groups = await this.prisma.zoneBreakObservation.groupBy({
      by: ['outcome'],
      where: {
        timeframe: cohort.timeframe,
        zoneClassification: cohort.zoneClassification,
        volumeBucket: cohort.volumeBucket,
        htfAgreed: cohort.htfAgreed,
        outcome: { in: RESOLVED_OUTCOMES },
      },
      _count: { _all: true },
    });
    return tally(groups);
  }
}

/** Collapse a groupBy-outcome result into wins/sample. */
function tally(groups: Array<{ outcome: string; _count: { _all: number } }>): HitRateStats {
  let wins = 0;
  let sample = 0;
  for (const g of groups ?? []) {
    const n = g._count?._all ?? 0;
    sample += n;
    if (g.outcome === 'WIN') wins += n;
  }
  return { wins, sample };
}
