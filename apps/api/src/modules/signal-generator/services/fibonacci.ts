import type { LevelCandidate } from '../types/evidence-level.types';

/**
 * Minimal candle shape for fib detection — high/low define the swing extremes.
 * Candles are expected oldest→newest. Pure function, no IO.
 */
export interface FibCandle {
  high: number;
  low: number;
}

const FIB_SPECS: ReadonlyArray<{ ratio: number; score: number }> = [
  { ratio: 0.382, score: 10 },
  { ratio: 0.5, score: 12 },
  { ratio: 0.618, score: 15 }, // golden ratio — strongest
];

/**
 * Fibonacci-retracement S/R levels (kind 'FIB', score 10–15).
 *
 * Takes the dominant recent swing in the window — the move between the
 * highest-high bar and the lowest-low bar (the largest high↔low excursion) —
 * and emits the 0.382 / 0.5 / 0.618 retracement levels. Direction is inferred
 * from bar order:
 *  - low before high → up-leg: retrace DOWN from the high → high - ratio*range
 *  - high before low → down-leg: retrace UP from the low  → low  + ratio*range
 *
 * The 0.618 (golden) retracement scores strongest (15), then 0.5 (12), then
 * 0.382 (10). A level landing on the live price is skipped.
 *
 * Returns [] for fewer than 2 candles or a degenerate (zero-range) swing.
 */
export function fibLevels(candles: FibCandle[], ltp: number): LevelCandidate[] {
  const out: LevelCandidate[] = [];
  if (!Array.isArray(candles) || candles.length < 2) return out;

  let idxHigh = 0;
  let idxLow = 0;
  for (let i = 1; i < candles.length; i++) {
    if (candles[i].high > candles[idxHigh].high) idxHigh = i;
    if (candles[i].low < candles[idxLow].low) idxLow = i;
  }

  const high = candles[idxHigh].high;
  const low = candles[idxLow].low;
  const range = high - low;
  if (!(range > 0)) return out;

  const upLeg = idxLow < idxHigh; // low came first → impulse up

  for (const { ratio, score } of FIB_SPECS) {
    const price = upLeg ? high - ratio * range : low + ratio * range;
    if (!(price > 0)) continue;
    if (Math.abs(price - ltp) <= 1e-6 * Math.max(1, Math.abs(ltp))) continue;
    out.push({ price, kind: 'FIB', score });
  }
  return out;
}
