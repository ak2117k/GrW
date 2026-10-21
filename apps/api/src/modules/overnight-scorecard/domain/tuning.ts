/**
 * Self-review tuning of the scorecard (docs/superpowers/plans/2026-10-21-self-review-contract.md):
 *  - `scorecard.factor.<name>.weight` (0–1.5, default 1): points × weight, rounded and clamped to −2..+2;
 *  - `scorecard.factor.news.requireConfirmation` (default false): the news factor's POSITIVE points
 *    count only when indicators or oi (available) is ≥ 0 in the same scorecard.
 * A tuned factor keeps its pre-tuning points in `rawPoints` (and its `weight`), so the self-review
 * keeps judging the factor itself, not the knob. Untuned factors are returned unchanged.
 */
import { NEWS_CONFIRMATION_TARGET, STOCK_MOVE_POINTS_TARGET, weightTarget, type TuningReader } from '../../self-review/tuning/tunables';
import type { FactorScore } from '../scorecard.types';
import { clampPoints } from './scoring';

export function applyTuning(factors: readonly FactorScore[], tuning: TuningReader): FactorScore[] {
  const requireConfirmation = tuning.get<boolean>(NEWS_CONFIRMATION_TARGET, false) === true;
  const confirmed = factors.some((f) => (f.name === 'indicators' || f.name === 'oi') && f.available && f.points >= 0);
  return factors.map((f) => {
    if (!f.available) return f;
    const w = tuning.get<number>(weightTarget(f.name), 1);
    const weight = Number.isFinite(w) && w >= 0 && w <= 1.5 ? w : 1;
    let points: number = f.points;
    let reason = f.reason;
    if (f.name === 'news' && requireConfirmation && points > 0 && !confirmed) {
      points = 0;
      reason = `${reason} (unconfirmed: neither indicators nor oi ≥ 0 — counted 0)`;
    }
    if (weight !== 1) {
      points = clampPoints(points * weight);
      reason = `${reason} (×${weight} weight)`;
    }
    if (points === f.points && weight === 1) return f;
    return { ...f, points: clampPoints(points), reason, rawPoints: f.points, weight };
  });
}

/**
 * `scorecard.stockMove.points` (0–1, default 0): whether the stock big-move model's bucket counts in
 * the expected-move (mood) factor. Anything but exactly 1 is shadow (0).
 */
export function stockMovePointsSetting(tuning: TuningReader): 0 | 1 {
  return tuning.get<number>(STOCK_MOVE_POINTS_TARGET, 0) === 1 ? 1 : 0;
}
