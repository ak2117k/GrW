/**
 * The pattern gate (2026-11-04, wrong-decision loop spec goal 5 / S1). A diagnosed cause acts — writes a lesson or
 * a fix ticket — only when it repeats: >= 3 occurrences within <= 10 sessions, or one occurrence costing >= ₹5,000.
 * One-offs are recorded and shown, nothing more; NOISE never acts. It gates lessons and tickets only: a setting
 * moves solely through the proposal engine's own statistical evidenceGate (S1). Pure.
 */
import type { FixCause } from './types';

export const ACTIONABLE_MIN_OCCURRENCES = 3;
export const ACTIONABLE_MAX_SESSIONS = 10;
export const ACTIONABLE_MIN_COST_RUPEES = 5000;

export interface GroupStats {
  /** Distinct misses (refIds) in the group. */
  occurrences: number;
  /** Distinct IST sessions those misses came from. */
  sessions: number;
  /** The costliest single miss, ₹ (absolute); 0 when no miss had a ₹ score. */
  maxCostRupees: number;
}

export function actionable(group: GroupStats, cause?: FixCause | null): boolean {
  if (cause === 'NOISE') return false;
  if (group.maxCostRupees >= ACTIONABLE_MIN_COST_RUPEES) return true;
  return group.occurrences >= ACTIONABLE_MIN_OCCURRENCES && group.sessions >= 1 && group.sessions <= ACTIONABLE_MAX_SESSIONS;
}

/** What the gate needs to know about one miss handed to the diagnosis. */
export interface MissFacts {
  sessionDate?: string;
  /** The miss' score; ₹ for DECISION:* misses (delta per lot net), other units otherwise. */
  score?: number | null;
  kind?: string;
}

export const DECISION_KIND_PREFIX = 'DECISION:';
export const isDecisionKind = (kind: string | undefined | null): boolean => typeof kind === 'string' && kind.startsWith(DECISION_KIND_PREFIX);

/**
 * The gate's inputs for a group of refIds. Only DECISION:* scores are ₹ (the legacy kinds score in R, bp or
 * points), so only they count toward the ₹5,000 one-off rule. Unknown refIds are ignored.
 */
export function groupStats(refIds: readonly string[], facts: ReadonlyMap<string, MissFacts>): GroupStats {
  const known = [...new Set(refIds)].map((r) => facts.get(r)).filter((f): f is MissFacts => f !== undefined);
  const sessions = new Set(known.map((f) => f.sessionDate).filter((s): s is string => !!s));
  const costs = known.filter((f) => isDecisionKind(f.kind) && typeof f.score === 'number' && Number.isFinite(f.score)).map((f) => Math.abs(f.score as number));
  return { occurrences: known.length, sessions: sessions.size, maxCostRupees: costs.length ? Math.max(...costs) : 0 };
}

/** ₹ the group's DECISION:* misses cost in total (absolute), for the ticket's costRupees. */
export function groupCostRupees(refIds: readonly string[], facts: ReadonlyMap<string, MissFacts>): number {
  let sum = 0;
  for (const r of new Set(refIds)) {
    const f = facts.get(r);
    if (f && isDecisionKind(f.kind) && typeof f.score === 'number' && Number.isFinite(f.score)) sum += Math.abs(f.score);
  }
  return Math.round(sum);
}
