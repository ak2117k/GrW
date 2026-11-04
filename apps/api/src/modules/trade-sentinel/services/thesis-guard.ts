/**
 * THESIS GUARD (2026-11-04). Pure.
 *
 * Prod 2026-11-04, LAURUSLABS23NOV262600CE (manual NRML buy): the thesis service INFERRED "breakout above
 * PDH 2343.9, cleared and held" while the stock was at 2310 — the inference request never carried the
 * underlying at entry. The LONG invalidation sat ABOVE the price at entry, so it was breached at birth:
 * THESIS_INVALIDATION passed on the first cycle and two EXIT_NOW verdicts sold the trade 3 minutes in.
 *
 * An invalidation already crossed against the position at entry is not an invalidation — it is the model
 * misreading where the trade was. LONG: invalidation >= underlying at entry (SHORT mirrored; equality
 * counts as breached) ⇒ the invalidation is set to null, and so is the level when it is the same claim
 * (within LEVEL_SAME_CLAIM_TOLERANCE of the invalidation). The reason records what was discarded.
 *
 * Spec D14: the underlying at entry unknown (late inference, no bar stored) ⇒ the invalidation is KEPT
 * but record-only — the exit gate never lets an INFERRED thesis pass on its own (gate.ts,
 * GATE_INFERRED_THESIS_RECORD_ONLY) — and the reason says the entry context is unknown.
 *
 * THESIS_GUARD (on unless exactly "false"; rollback = "false"): the guard runs in ThesisService.infer.
 */
export type ThesisGuardDiscard = 'BREACHED_AT_ENTRY' | 'ENTRY_UNKNOWN';

export interface GuardableThesis {
  /**
   * The UNDERLYING's direction, not the position's side: a bought PE is SHORT here. The invalidation is on
   * the underlying's scale, so a LONG-PE invalidation sits ABOVE the price (exit-discipline exposureOf).
   */
  direction: 'LONG' | 'SHORT';
  levelPrice: number | null;
  invalidation: number | null;
  reason: string;
}

export interface GuardedThesis {
  levelPrice: number | null;
  invalidation: number | null;
  reason: string;
  discarded: null | ThesisGuardDiscard;
}

/** A level within 0.1% of the breached invalidation is the same claim ("cleared and held above X"). */
export const LEVEL_SAME_CLAIM_TOLERANCE = 0.001;

const fin = (x: number | null | undefined): x is number => typeof x === 'number' && Number.isFinite(x);

export function thesisGuardEnabled(env: Record<string, string | undefined> = process.env): boolean {
  return env.THESIS_GUARD !== 'false';
}

export function guardInferredThesis(t: GuardableThesis, underlyingAtEntry: number | null): GuardedThesis {
  const same: GuardedThesis = { levelPrice: t.levelPrice, invalidation: t.invalidation, reason: t.reason, discarded: null };
  if (!fin(t.invalidation)) return same;
  if (!fin(underlyingAtEntry)) {
    return {
      ...same,
      reason: `${t.reason} (underlying at entry unknown: invalidation ${t.invalidation} is record-only)`,
      discarded: 'ENTRY_UNKNOWN',
    };
  }
  const inv = t.invalidation;
  const breached = t.direction === 'LONG' ? inv >= underlyingAtEntry : inv <= underlyingAtEntry;
  if (!breached) return same;
  const sameClaim = fin(t.levelPrice) && Math.abs(t.levelPrice - inv) <= Math.abs(inv) * LEVEL_SAME_CLAIM_TOLERANCE;
  return {
    levelPrice: sameClaim ? null : t.levelPrice,
    invalidation: null,
    reason: `${t.reason} (invalidation ${inv} already breached at entry ${underlyingAtEntry}, discarded)`,
    discarded: 'BREACHED_AT_ENTRY',
  };
}
