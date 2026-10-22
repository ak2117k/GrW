/**
 * Skill of a probability model (MBM move-size) beyond its hit rate.
 *
 * A hit rate alone flatters a model on lopsided days: on 2026-10-21/22 78 of 79 windows were BIG, so
 * "always say big" also scored ~99 %. This compares the model with that majority baseline, and adds
 * ranking (AUC) and probability quality (Brier vs the base-rate forecast). With too few windows of the
 * rarer outcome the question is NOT_TESTABLE, which is said instead of a number that looks like proof.
 */
import type { SkillStats } from '../self-review.types';

/** Fewer than this many windows of the rarer outcome → not testable. */
export const MIN_MINORITY = 10;
/** AUC needed (with a Brier skill > 0) to call it an edge. */
export const EDGE_AUC = 0.6;

export interface ProbRow {
  correct: boolean | null;
  details: unknown;
}

const r3 = (x: number) => Math.round(x * 1000) / 1000;

/** The stored p and the actual outcome. The outcome is not stored; it follows from the call (p ≥ 0.5) and `correct`. */
export function probOutcome(r: ProbRow): { p: number; y: 0 | 1 } | null {
  if (r.correct === null) return null;
  const p = (r.details as { p?: unknown } | null)?.p;
  if (typeof p !== 'number' || !Number.isFinite(p)) return null;
  const callBig = p >= 0.5;
  return { p, y: (r.correct ? callBig : !callBig) ? 1 : 0 };
}

/** Mann–Whitney AUC with tie handling; null when one class is absent. */
export function auc(points: ReadonlyArray<{ p: number; y: 0 | 1 }>): number | null {
  const pos = points.filter((x) => x.y === 1).length;
  const neg = points.length - pos;
  if (pos === 0 || neg === 0) return null;
  const sorted = [...points].sort((a, b) => a.p - b.p);
  let rankSumPos = 0;
  for (let i = 0; i < sorted.length; ) {
    let j = i;
    while (j + 1 < sorted.length && sorted[j + 1].p === sorted[i].p) j++;
    const avgRank = (i + j) / 2 + 1;
    for (let k = i; k <= j; k++) if (sorted[k].y === 1) rankSumPos += avgRank;
    i = j + 1;
  }
  return (rankSumPos - (pos * (pos + 1)) / 2) / (pos * neg);
}

export function probabilitySkill(rows: readonly ProbRow[]): SkillStats {
  const pts = rows.map(probOutcome).filter((x): x is { p: number; y: 0 | 1 } => x !== null);
  const n = pts.length;
  const positives = pts.filter((x) => x.y === 1).length;
  const minority = Math.min(positives, n - positives);
  if (n === 0) {
    return { n: 0, positives: 0, baseRate: null, hitRate: null, majorityHitRate: null, auc: null, brier: null, brierBaseline: null, brierSkill: null, verdict: 'NOT_TESTABLE', note: 'no judged predictions' };
  }
  const baseRate = positives / n;
  const hits = pts.filter((x) => (x.p >= 0.5 ? 1 : 0) === x.y).length;
  const brier = pts.reduce((s, x) => s + (x.p - x.y) ** 2, 0) / n;
  const brierBaseline = baseRate * (1 - baseRate);
  const brierSkill = brierBaseline > 0 ? 1 - brier / brierBaseline : null;
  const a = auc(pts);
  const majorityHitRate = Math.max(baseRate, 1 - baseRate);
  const rarer = positives <= n - positives ? 'BIG' : 'small';
  let verdict: SkillStats['verdict'];
  let note: string;
  if (minority < MIN_MINORITY) {
    verdict = 'NOT_TESTABLE';
    note = `only ${minority} ${rarer} window(s) of ${n}; always saying "${rarer === 'BIG' ? 'small' : 'BIG'}" would score ${Math.round(majorityHitRate * 100)}%`;
  } else if (a !== null && a >= EDGE_AUC && brierSkill !== null && brierSkill > 0) {
    verdict = 'EDGE';
    note = `ranks moves (AUC ${a.toFixed(2)}) and beats the base-rate forecast (Brier skill ${brierSkill.toFixed(2)})`;
  } else {
    verdict = 'NO_EDGE';
    note = `AUC ${a === null ? '—' : a.toFixed(2)}, Brier skill ${brierSkill === null ? '—' : brierSkill.toFixed(2)}: no better than the base rate`;
  }
  return {
    n, positives, baseRate: r3(baseRate), hitRate: r3(hits / n), majorityHitRate: r3(majorityHitRate),
    auc: a === null ? null : r3(a), brier: r3(brier), brierBaseline: r3(brierBaseline),
    brierSkill: brierSkill === null ? null : r3(brierSkill), verdict, note,
  };
}
