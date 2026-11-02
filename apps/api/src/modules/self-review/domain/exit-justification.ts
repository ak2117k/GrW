/**
 * The owner's rule for premature exits (2026-11-02): "early exit will count only if there is more than
 * 75 % probability that the holding will go into more loss". A PAPER_EXIT / LIVE_EXIT that the price
 * recovered from (the kind's existing rule) is a MISS only when the exit was NOT justified — P(adverse)
 * at the exit < EXIT_JUSTIFIED_P (exit-noise/domain/adverse-probability). Justified and recovered anyway
 * = JUSTIFIED_UNLUCKY: recorded (details.outcome) but not a miss (correct null). A null p (nothing could
 * be read) is not justified: the exit counts exactly as before. Review only: no exit path reads this. Pure.
 */
import { EXIT_JUSTIFIED_P, isJustified, type AdverseProbability } from '../../exit-noise/domain/adverse-probability';
import type { VerificationDraft } from '../self-review.types';

export type ExitOutcome = 'MISS' | 'JUSTIFIED_UNLUCKY' | 'HELD_UP' | 'UNJUDGED';

export interface ExitJudgement {
  pAdverse: number | null;
  justified: boolean;
  outcome: ExitOutcome;
  /** The `correct` the draft carries: MISS false, HELD_UP true, JUSTIFIED_UNLUCKY / UNJUDGED null. */
  correct: boolean | null;
  note: string;
}

/**
 * @param recovered the kind's own verdict: true = the price recovered after the exit (the old miss),
 *                  false = the exit held up, null = not judgeable.
 */
export function judgeExit(adverse: AdverseProbability | null | undefined, recovered: boolean | null): ExitJudgement {
  const p = adverse?.p ?? null;
  const justified = isJustified(p);
  const pTxt = p === null ? 'p n/a' : `p ${p}`;
  if (recovered === null) return { pAdverse: p, justified, outcome: 'UNJUDGED', correct: null, note: `${pTxt}; not judgeable` };
  if (!recovered) return { pAdverse: p, justified, outcome: 'HELD_UP', correct: true, note: `${pTxt}; the exit held up` };
  if (justified) return { pAdverse: p, justified, outcome: 'JUSTIFIED_UNLUCKY', correct: null, note: `justified (p ${p} ≥ ${EXIT_JUSTIFIED_P}), recovered anyway — not a miss` };
  return {
    pAdverse: p,
    justified,
    outcome: 'MISS',
    correct: false,
    note: p === null ? `no p (nothing read at the exit) — counted as a miss as before` : `not justified (p ${p} < ${EXIT_JUSTIFIED_P}) and recovered — a miss`,
  };
}

/** The justification fields every PAPER_EXIT / LIVE_EXIT draft's details carry. */
export function justificationDetails(adverse: AdverseProbability | null | undefined, j: ExitJudgement) {
  return {
    pAdverse: j.pAdverse,
    justified: j.justified,
    outcome: j.outcome,
    justifiedP: EXIT_JUSTIFIED_P,
    pBasis: adverse?.basis ?? null,
    pFrom: adverse?.from ?? 'none',
    pParts: adverse?.parts.map((x) => ({ name: x.name, contribution: x.contribution, read: x.read, note: x.note.slice(0, 200) })) ?? [],
  };
}

export interface ExitJustificationCounts {
  exits: number;
  judged: number;
  /** Exits with a p. */
  withP: number;
  justified: number;
  /** Justified and recovered anyway (JUSTIFIED_UNLUCKY). */
  justifiedRecovered: number;
  misses: number;
  /** Misses counted without a p (nothing read). */
  missesWithoutP: number;
}

export interface ExitJustificationStats extends ExitJustificationCounts {
  byKind: Partial<Record<'PAPER_EXIT' | 'LIVE_EXIT', ExitJustificationCounts>>;
  threshold: number;
  basis: string[];
}

const fin = (x: unknown): x is number => typeof x === 'number' && Number.isFinite(x);
const zero = (): ExitJustificationCounts => ({ exits: 0, judged: 0, withP: 0, justified: 0, justifiedRecovered: 0, misses: 0, missesWithoutP: 0 });

/** Counts over PAPER_EXIT / LIVE_EXIT results (their details.outcome / pAdverse / justified). */
export function exitJustificationStats(rows: ReadonlyArray<Pick<VerificationDraft, 'kind' | 'details'>>): ExitJustificationStats {
  const total = zero();
  const byKind: ExitJustificationStats['byKind'] = {};
  const basis = new Set<string>();
  for (const r of rows) {
    if (r.kind !== 'PAPER_EXIT' && r.kind !== 'LIVE_EXIT') continue;
    const d = (r.details ?? {}) as Record<string, unknown>;
    const k = (byKind[r.kind] ??= zero());
    const p = fin(d.pAdverse) ? d.pAdverse : null;
    const outcome = typeof d.outcome === 'string' ? d.outcome : null;
    if (typeof d.pBasis === 'string') basis.add(d.pBasis);
    for (const c of [total, k]) {
      c.exits += 1;
      if (outcome && outcome !== 'UNJUDGED') c.judged += 1;
      if (p !== null) c.withP += 1;
      if (d.justified === true) c.justified += 1;
      if (outcome === 'JUSTIFIED_UNLUCKY') c.justifiedRecovered += 1;
      if (outcome === 'MISS') {
        c.misses += 1;
        if (p === null) c.missesWithoutP += 1;
      }
    }
  }
  return { ...total, byKind, threshold: EXIT_JUSTIFIED_P, basis: [...basis] };
}
