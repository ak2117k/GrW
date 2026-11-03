/**
 * TARGET_LADDER (exit-discipline/target-ladder.ts): where a REAL position's targets come from. Type-only port,
 * so the cycle's import graph stays free of the signal-trader domain and of Prisma.
 *
 * Absent (the paper cycle, specs, TARGET_LADDER=off) ⇒ no ladder anywhere: every packet and every exit exactly
 * as before. `mode` observe ⇒ targets computed and shown on the packet, never exited.
 */
import type { LadderMode, LadderSource } from '../../exit-discipline/target-ladder';
import type { PositionSide } from '../../exit-discipline/types';

export interface LadderPlanRequest {
  trackerId: string;
  userId: string;
  symbol: string;
  side: PositionSide;
  entry: number;
  /** The underlying now, and the level-book lines on its scale (nearest support / resistance), for level targets. */
  spot: number | null;
  levels: number[];
  /** The default stop when the position has none on record (target-ladder.ts defaultLadderStop); null = unknown yet. */
  fallbackStop: number | null;
}

export interface LadderPlan {
  /** Nearest first; [] = the position has a plan without targets (no ladder). */
  targets: number[];
  /** The stop the targets were sized from; null for a signal plan that carries none. */
  riskStop: number | null;
  source: LadderSource;
  detail: string;
}

export interface LadderPlanReader {
  readonly mode: Exclude<LadderMode, 'off'>;
  /** The position's targets, or null when they cannot be set yet (retried later). Never rejects on a data gap. */
  planFor(req: LadderPlanRequest): Promise<LadderPlan | null>;
}

export const LADDER_PLANS = 'SENTINEL_LADDER_PLANS';
