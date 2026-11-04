/**
 * What auto-apply reads from stream F (self-review/decisions, DecisionGradeRepository.perDecisionPnl):
 * ₹ per graded decision of `types`, net per lot, over `sessionDates`. `sessions` lists only the sessions
 * that had ≥ 1 such decision. Bound @Optional(): absent ⇒ nothing can be watched ⇒ nothing is auto-applied.
 */
export interface DecisionPnlPort {
  perDecisionPnl(types: string[], sessionDates: string[]): Promise<{ sessions: string[]; decisions: number; perDecision: number | null }>;
}

export const DECISION_PNL = Symbol('DECISION_PNL');

/** SELF_REVIEW_AUTO_APPLY=on|off (default on; owner 2026-11-04). off ⇒ today's behaviour: PENDING waits for the owner. */
export interface AutoApplyConfig {
  enabled: boolean;
}

export const AUTO_APPLY_CONFIG = Symbol('AUTO_APPLY_CONFIG');

/**
 * ROLLBACK: SELF_REVIEW_AUTO_APPLY=off + restart (no apply, no automatic rollback; changes already applied
 * stay until the owner changes them). Off only for the exact words off|false|0.
 */
export function parseAutoApplyConfig(env: Record<string, string | undefined>): AutoApplyConfig {
  const raw = (env.SELF_REVIEW_AUTO_APPLY ?? '').trim().toLowerCase();
  return { enabled: !(raw === 'off' || raw === 'false' || raw === '0') };
}
