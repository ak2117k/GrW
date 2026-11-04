import { SPIKE_BANK_RISE_N } from './config';
import type { NoiseOpinion, PositionSide } from './types';

const fin = (x: number | null | undefined): x is number => typeof x === 'number' && Number.isFinite(x);
const r2 = (x: number) => Math.round(x * 100) / 100;

/**
 * SPIKE BANK (owner-approved 2026-11-04). Pure.
 *
 * Prod 2026-11-04 NIFTY09NOV2623650PE (2 lots, entry 136.8): NIFTY fell ~37 points in five minutes to
 * the day low and snapped back; the premium went 141.7 → 155.6 in three minutes. The noise floor trails
 * the best by FLOOR_TRAIL_N (2 N ≈ 12 points), which left it at its arm price 144.32 — under the spike's
 * whole gain — and the snap-back took the trade from +₹2.3k to −₹664. A jump that fast is the one place
 * a 2 N trail gives back the most, so the position banks it: the trail tightens to SPIKE_BANK_TRAIL_N.
 *
 * A spike is a NEW best (better than the previous pass's best) at least `riseN` contract noise units
 * beyond the worst premium of the trailing SPIKE_BANK_WINDOW_MIN minutes (`windowWorst`: the low for a
 * long, the high for a short). N is the floor's own N (the contract's 1-minute noise unit).
 *
 * `noise` (types.ts NoiseOpinion): REAL — the jump is a genuine move ⇒ do NOT tighten, let it run.
 * NOISE / UNKNOWN / null ⇒ the code rule (bank it). Nothing supplies an opinion today.
 */
export interface SpikeInput {
  side: PositionSide;
  /** The position's best premium as of the previous pass (null: unknown ⇒ never a spike). */
  prevBest: number | null;
  /** The best premium now. */
  best: number | null;
  /** The worst premium in the trailing window (low for LONG, high for SHORT), this pass included. */
  windowWorst: number | null;
  /** The contract's 1-minute noise unit. */
  n: number | null;
  riseN?: number;
  noise?: NoiseOpinion | null;
}

export interface SpikeReading {
  spike: boolean;
  newBest: boolean;
  /** best − windowWorst in the position's favour, premium points; null when unmeasurable. */
  rise: number | null;
  riseInN: number | null;
  /** True when a REAL opinion vetoed an otherwise qualifying spike. */
  vetoed: boolean;
}

export function spikeBankReading(i: SpikeInput): SpikeReading {
  const dir = i.side === 'LONG' ? 1 : -1;
  const need = fin(i.riseN) && i.riseN > 0 ? i.riseN : SPIKE_BANK_RISE_N;
  const newBest = fin(i.prevBest) && fin(i.best) && (i.best - i.prevBest) * dir > 1e-9;
  const rise = fin(i.best) && fin(i.windowWorst) ? r2((i.best - i.windowWorst) * dir) : null;
  const n = fin(i.n) && i.n > 0 ? i.n : null;
  const riseInN = rise !== null && n !== null ? r2(rise / n) : null;
  const qualifies = newBest && rise !== null && n !== null && rise >= need * n - 1e-9;
  const vetoed = qualifies && i.noise?.verdict === 'REAL';
  return { spike: qualifies && !vetoed, newBest, rise, riseInN, vetoed };
}
