/**
 * The decision ledger (docs/superpowers/plans/2026-11-04-self-review-wrong-decision-loop.md, stream F):
 * every trade decision graded in real ₹ per lot, net of charges, against the other choice. One row per
 * (refTable, refId, decisionType, horizon) in `decision_grades`. G1 (investigator / report) and G2
 * (auto-apply rollback) read these rows only through DecisionGradeRepository.
 */

export const DECISION_TYPES = [
  'ENTRY_TAKE', 'ENTRY_SKIP', 'ENTRY_BLOCKED', 'SIZE', 'EXIT', 'HOLD', 'GATED_EXIT', 'FLOOR', 'SPIKE_BANK',
  'HARD_LOSS', 'LADDER', 'CARRY', 'CARRY_EXIT', 'THESIS', 'DETECTOR',
  // 2026-11-05: a re-entry watch SIGNAL (reentry_watch_decisions, paper), graded like ENTRY_TAKE.
  'REENTRY',
] as const;
export type DecisionType = (typeof DECISION_TYPES)[number];

export const DETECTORS = ['LIVE_NOT_PLACED', 'INPUT_MISSING', 'EVENT_NO_ACTION', 'THESIS_CONTRADICTS_DATA'] as const;
export type DetectorKind = (typeof DETECTORS)[number];

export type Horizon = '15m' | '30m' | '60m' | 'close' | 'next1h';
export type GradeVerdict = 'RIGHT' | 'WRONG' | 'UNSCORABLE';
export type GradeMode = 'live' | 'paper';

/** What a grader returns for one horizon. ₹ per lot, net of charges; delta = alternative − chosen. */
export interface Grade {
  horizon: Horizon;
  pnlChosen: number | null;
  pnlAlternative: number | null;
  deltaRupees: number | null;
  verdict: GradeVerdict;
  reason: string;
}

/** A row about to be upserted (the table row without id / createdAt). */
export interface DecisionGradeDraft {
  sessionDate: string;
  decisionType: DecisionType;
  detector: DetectorKind | null;
  refTable: string;
  refId: string;
  userId: string | null;
  symbol: string | null;
  underlying: string | null;
  mode: GradeMode;
  decidedAt: Date;
  chosen: string;
  alternative: string;
  pnlChosen: number | null;
  pnlAlternative: number | null;
  deltaRupees: number | null;
  horizon: Horizon;
  verdict: GradeVerdict;
  reason: string;
  facts: Record<string, unknown>;
}

/** `decision_grades` as G1 / G2 read it. */
export interface DecisionGradeRow extends DecisionGradeDraft {
  id: string;
  createdAt: Date;
}

/** A 1-minute bar on the contract's own price scale; `ts` = bar START, ms epoch. */
export interface Bar {
  ts: number;
  high: number;
  low: number;
  close: number;
}

export interface GradeSessionResult {
  graded: number;
  wrong: number;
  unscorable: number;
  byType: Record<string, number>;
  /** Set when the run failed (fail-soft: the counts are then whatever was written, usually zeros). */
  error?: string;
  /** Set when the run was skipped on purpose (SELF_REVIEW_DECISION_LOOP=off). */
  skipped?: string;
}
