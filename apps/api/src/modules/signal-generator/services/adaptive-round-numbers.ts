/**
 * Price-adaptive round-number grid. The old flat step of 50 is meaningless for
 * a ₹140 stock; real round numbers scale with price.
 */
export function adaptiveRoundStep(ltp: number): number {
  if (ltp < 50) return 1;
  if (ltp < 200) return 5;
  if (ltp < 500) return 10;
  if (ltp < 2000) return 25;
  if (ltp < 5000) return 50;
  return 100;
}

/** ±3 steps around spot, snapped to the grid. [] when ltp <= 0. */
export function adaptiveRoundNumbers(ltp: number): number[] {
  if (!(ltp > 0)) return [];
  const step = adaptiveRoundStep(ltp);
  const center = Math.round(ltp / step) * step;
  const out: number[] = [];
  for (let k = -3; k <= 3; k++) out.push(center + k * step);
  return out;
}

/**
 * Score a price's round-number significance:
 *  - 0  if not on the grid
 *  - 15 if it is a "major" round (a multiple of 5*step — e.g. a century/half-century)
 *  - 12 otherwise (ordinary grid level)
 *
 * `step` must be the value from `adaptiveRoundStep(ltp)` — the score is only
 * meaningful relative to the same grid the price was drawn from. The 1e-6
 * tolerance absorbs float accumulation from `center + k*step` in
 * `adaptiveRoundNumbers` so a grid value never reads as off-grid.
 */
export function roundScore(price: number, step: number): number {
  if (step <= 0) return 0;
  const onGrid = Math.abs(price / step - Math.round(price / step)) < 1e-6;
  if (!onGrid) return 0;
  const major = Math.abs(price / (5 * step) - Math.round(price / (5 * step))) < 1e-6;
  return major ? 15 : 12;
}
