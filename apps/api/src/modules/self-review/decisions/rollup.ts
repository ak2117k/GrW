/**
 * Read-side rollups over `decision_grades` (pure; DecisionGradeRepository applies them to DB rows).
 * One decision has up to three exit horizons — readers count DECISIONS, not horizon rows.
 */
import type { DecisionGradeRow, Horizon } from './types';

const r2 = (n: number) => Math.round(n * 100) / 100;
const key = (r: Pick<DecisionGradeRow, 'refTable' | 'refId' | 'decisionType'>) => `${r.refTable}|${r.refId}|${r.decisionType}`;

/** Longest horizon first: the decision's settled answer. */
const HORIZON_RANK: Readonly<Record<Horizon, number>> = { next1h: 5, close: 4, '60m': 3, '30m': 2, '15m': 1 };

/** WRONG rows, one per decision: the horizon where the alternative beat the choice by the most. */
export function worstPerDecision(rows: readonly DecisionGradeRow[]): DecisionGradeRow[] {
  const best = new Map<string, DecisionGradeRow>();
  for (const r of rows) {
    if (r.verdict !== 'WRONG') continue;
    const cur = best.get(key(r));
    if (!cur || (r.deltaRupees ?? -Infinity) > (cur.deltaRupees ?? -Infinity)) best.set(key(r), r);
  }
  return [...best.values()].sort((a, b) => (a.sessionDate === b.sessionDate ? (b.deltaRupees ?? 0) - (a.deltaRupees ?? 0) : a.sessionDate < b.sessionDate ? 1 : -1));
}

/**
 * ₹ per decision of the chosen action OVER the alternative (−delta, net, per lot; higher = better
 * decisions) for the given types over the given sessions. Each decision counts once, at its longest
 * scored horizon. UNSCORABLE and DETECTOR rows never count (a missing path must not drive a setting
 * change). `sessions` lists only the sessions that had ≥ 1 scored decision of these types (G2's rollback
 * compares 3 such sessions before vs after — sessions without the decision don't count, spec S4).
 */
export function perDecisionPnlOf(rows: readonly DecisionGradeRow[], types: readonly string[], sessionDates: readonly string[]): { sessions: string[]; decisions: number; perDecision: number | null } {
  const want = new Set(types);
  const inSessions = new Set(sessionDates);
  const pick = new Map<string, DecisionGradeRow>();
  for (const r of rows) {
    if (!want.has(r.decisionType) || r.decisionType === 'DETECTOR' || !inSessions.has(r.sessionDate)) continue;
    if (r.verdict === 'UNSCORABLE' || r.deltaRupees === null || !Number.isFinite(r.deltaRupees)) continue;
    const cur = pick.get(key(r));
    if (!cur || HORIZON_RANK[r.horizon] > HORIZON_RANK[cur.horizon]) pick.set(key(r), r);
  }
  const picked = [...pick.values()];
  const sessions = [...new Set(picked.map((r) => r.sessionDate))].sort();
  const sum = picked.reduce((s, r) => s - (r.deltaRupees as number), 0);
  return { sessions, decisions: picked.length, perDecision: picked.length ? r2(sum / picked.length) : null };
}
