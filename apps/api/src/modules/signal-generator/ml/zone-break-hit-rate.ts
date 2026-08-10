/**
 * Hit-rate scoping — the decision of WHOSE history a projection's percentage is
 * allowed to speak for.
 *
 * Pure and container-free: it takes two already-counted tallies and picks one.
 * The DB reads that produce those tallies live in
 * {@link ZoneBreakObservationRepository}; the choice between them lives here so
 * it can be tested without a database and reused anywhere.
 *
 * Two rules are load-bearing, and both exist because a projection that overstates
 * its own evidence is worse than one that admits it has none:
 *
 *  1. A percentage NEVER travels without its sample size. {@link HitRate} has no
 *     shape in which `pct` exists and `sample` does not.
 *  2. No history means `null` — not 0%, not 50%, not a prior. `null` is a
 *     first-class answer meaning "no measured history yet", and the UI is
 *     required to say exactly that.
 *
 * See docs/superpowers/specs/2026-08-10-projection-zones-design.md §3.4.
 */

/**
 * Resolved observations required before a symbol may be scored on its OWN
 * history. Below this, the symbol's number is noise and the cohort — same
 * timeframe, same zone classification, same volume regime, same HTF agreement —
 * is the more honest estimator.
 */
export const SYMBOL_SCOPE_MIN_SAMPLE = 30;

/** Which population a hit-rate was measured over. */
export type HitRateScope = 'symbol' | 'cohort';

/** A tally of resolved observations. `wins` must never exceed `sample`. */
export interface HitRateStats {
  /** Rows whose outcome is WIN. */
  wins: number;
  /**
   * RESOLVED rows only (WIN + LOSS + TIMEOUT). PENDING rows are not evidence —
   * counting them would dilute the percentage with breaks nobody has seen the
   * end of yet.
   */
  sample: number;
}

/** A measured hit-rate. `pct` cannot exist without `sample` — see rule 1 above. */
export interface HitRate {
  /** 0-100, rounded to one decimal. */
  pct: number;
  /** Resolved observations behind `pct`. */
  sample: number;
  scope: HitRateScope;
}

/**
 * Turn a tally into a reportable {@link HitRate}, or `null` when it cannot be
 * one. Returns null for an empty sample (0/0 is not 0%), for a negative or
 * non-finite tally, and for the impossible `wins > sample`, which indicates the
 * two counts came from different queries and must not be blended into a number
 * that looks authoritative.
 */
export function toHitRate(stats: HitRateStats | null | undefined, scope: HitRateScope): HitRate | null {
  if (!stats) return null;
  const { wins, sample } = stats;
  if (!Number.isFinite(wins) || !Number.isFinite(sample)) return null;
  if (sample <= 0 || wins < 0 || wins > sample) return null;
  return { pct: Math.round((wins / sample) * 1000) / 10, sample, scope };
}

/**
 * Pick the scope a projection's hit-rate is reported at.
 *
 * Symbol-specific when at least {@link SYMBOL_SCOPE_MIN_SAMPLE} resolved
 * observations exist for this (token, timeframe); otherwise the cohort; and
 * `null` when neither has anything — which is not a failure, it is the platform
 * saying it has not measured this yet.
 *
 * Note the asymmetry, which is deliberate: the symbol scope has a floor, the
 * cohort does not. Falling back to a one-row cohort is still honest because the
 * `sample` rides along and a reader can discount a `sample: 1` for themselves —
 * whereas silently reporting a thin SYMBOL number would imply a specificity the
 * data has not earned.
 */
export function selectHitRate(
  symbol: HitRateStats | null | undefined,
  cohort: HitRateStats | null | undefined,
): HitRate | null {
  if (symbol && symbol.sample >= SYMBOL_SCOPE_MIN_SAMPLE) {
    const measured = toHitRate(symbol, 'symbol');
    if (measured) return measured;
  }
  return toHitRate(cohort, 'cohort');
}
