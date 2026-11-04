/**
 * Seams of the wrong-decision loop (docs/superpowers/plans/2026-11-04-self-review-wrong-decision-loop.md, stream G1).
 *
 * The run reads stream F's grading (`DecisionGradingService.gradeSession`, `DecisionGradeRepository.wrongSince`) and
 * stream G2's applied changes (`AutoApplyService.recentChanges`) through these structural ports. The classes are
 * injected by class token and @Optional (DecisionsModule is imported by SelfReviewModule; the @Global SelfReviewModule
 * exports AutoApplyService), so the run, the report and the page still work without them ("grading not loaded").
 */

/** A `decision_grades` row as G1 reads it (F's DecisionGradeRow; only the fields G1 uses are required). */
export interface DecisionGradeRowLike {
  id: string;
  sessionDate: string;
  decisionType: string;
  detector: string | null;
  refTable?: string;
  refId?: string;
  userId?: string | null;
  symbol: string | null;
  underlying?: string | null;
  mode: string;
  decidedAt?: Date | string | null;
  chosen: string;
  alternative: string;
  pnlChosen: number | null;
  pnlAlternative: number | null;
  deltaRupees: number | null;
  horizon: string;
  verdict: string;
  reason: string;
  facts?: unknown;
}

export interface GradeSessionResult {
  graded: number;
  wrong: number;
  unscorable: number;
  byType: Record<string, number>;
  error?: string;
}

export interface DecisionGradingPort {
  gradeSession(sessionDate: string, now?: Date): Promise<GradeSessionResult>;
}

export interface DecisionGradesPort {
  wrongSince(fromSessionDate: string): Promise<DecisionGradeRowLike[]>;
}

/** One applied / rolled-back setting change (G2's auto-apply `Change`; read defensively — any field may be absent). */
export interface AppliedChangeLike {
  target?: string;
  /** APPLY | ROLLBACK */
  kind?: string;
  from?: unknown;
  to?: unknown;
  session?: string;
  at?: Date | string;
  reason?: string;
}

export interface AppliedChangesPort {
  recentChanges(sinceSessionDate: string): Promise<AppliedChangeLike[]>;
}

/** The ops alert sender (tests inject a double; default `sendOpsAlert`). */
export const SELF_REVIEW_OPS_ALERT = Symbol('SELF_REVIEW_OPS_ALERT');
export type OpsAlertFn = (key: string, text: string) => Promise<boolean>;

/**
 * SELF_REVIEW_DECISION_LOOP=on|off (default on). Off ⇒ the run neither grades nor reads the ledger, writes no
 * tickets and sends no alert: exactly the pre-2026-11-04 run. Rollback: set it to off and restart the API.
 */
export function decisionLoopOn(env: Record<string, string | undefined> = process.env): boolean {
  const raw = (env.SELF_REVIEW_DECISION_LOOP ?? '').trim().toLowerCase();
  return !(raw === 'off' || raw === 'false' || raw === '0');
}
