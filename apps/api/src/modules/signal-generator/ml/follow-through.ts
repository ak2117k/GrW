import {
  DEFAULT_FT_PARAMS,
  type FollowThroughParams,
  type FollowThroughResult,
  type OhlcvCandle,
} from './pattern-observation.types';

/**
 * ATR-follow-through label. From the detection bar at `index` (entry = its
 * close) scan the next `n` bars: WIN if price reaches entry + dir*k*ATR before
 * entry - dir*m*ATR; LOSS if the adverse level is hit first (or both in one
 * bar — conservative). If the full `n`-bar horizon exists and neither level is
 * hit → TIMEOUT. If fewer than `n` forward bars exist and nothing hit → PENDING
 * (resolve later when more bars arrive). See the design spec §4.1.
 */
export function resolveFollowThrough(
  candles: OhlcvCandle[],
  index: number,
  dir: 1 | -1,
  atrAtDetection: number,
  params: FollowThroughParams = DEFAULT_FT_PARAMS,
): FollowThroughResult {
  const entry = candles[index].close;
  const favorable = entry + dir * params.k * atrAtDetection;
  const adverse = entry - dir * params.m * atrAtDetection;

  const last = candles.length - 1;
  const horizonEnd = index + params.n;
  const scanEnd = Math.min(horizonEnd, last);

  for (let i = index + 1; i <= scanEnd; i++) {
    const c = candles[i];
    const hitFav = dir === 1 ? c.high >= favorable : c.low <= favorable;
    const hitAdv = dir === 1 ? c.low <= adverse : c.high >= adverse;
    if (hitFav && hitAdv) return { outcome: 'LOSS', label: 0, resolvedIndex: i };
    if (hitFav) return { outcome: 'WIN', label: 1, resolvedIndex: i };
    if (hitAdv) return { outcome: 'LOSS', label: 0, resolvedIndex: i };
  }

  // Nothing hit. Distinguish "full horizon seen" (TIMEOUT) from "need more bars" (PENDING).
  const haveFullHorizon = horizonEnd <= last;
  return haveFullHorizon
    ? { outcome: 'TIMEOUT', label: null, resolvedIndex: null }
    : { outcome: 'PENDING', label: null, resolvedIndex: null };
}
