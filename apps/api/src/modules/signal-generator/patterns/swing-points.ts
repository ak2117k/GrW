/**
 * Swing-point (pivot) detection — the KEYSTONE of chart-pattern detection.
 *
 * A "swing high" is a candle whose HIGH is strictly greater than the highs of the
 * `strength` candles on BOTH sides. A "swing low" mirrors that with lows. Almost
 * every chart pattern (double top/bottom, head-and-shoulders, triangles, trend
 * lines) is expressed in terms of these pivots — so this is the primitive we build
 * first. See docs/learning/pattern-detection/01-swing-points.md.
 */

/** Minimal candle shape the pattern engine works on. */
export interface Candle {
  time: number; // epoch ms (or any monotonically increasing index)
  open: number;
  high: number;
  low: number;
  close: number;
}

export type SwingKind = 'HIGH' | 'LOW';

export interface SwingPoint {
  /** Index into the input candle array. */
  index: number;
  time: number;
  /** The pivot price: the candle's high (for HIGH) or low (for LOW). */
  price: number;
  kind: SwingKind;
}

/**
 * Find all swing highs and lows in `candles`.
 *
 * @param candles  ordered oldest → newest.
 * @param strength how many candles on EACH side a pivot must strictly beat
 *                 (a.k.a. lookback). Bigger = fewer, more significant pivots;
 *                 smaller = more, noisier pivots. Default 2.
 *
 * A candle at index `i` is a swing HIGH when, for every neighbour j in
 * [i-strength, i+strength] (j ≠ i): candles[j].high < candles[i].high. The
 * comparison is STRICT (`<`), so a run of equal highs produces NO pivot — this
 * avoids a flat top registering several times.
 *
 * The first and last `strength` candles can never be pivots (they lack a full
 * window on one side), so they are skipped.
 */
export function findSwingPoints(candles: Candle[], strength = 2): SwingPoint[] {
  if (strength < 1) throw new Error('strength must be >= 1');
  const swings: SwingPoint[] = [];

  for (let i = strength; i < candles.length - strength; i++) {
    const c = candles[i];
    let isHigh = true;
    let isLow = true;

    for (let j = i - strength; j <= i + strength; j++) {
      if (j === i) continue;
      // A single neighbour ≥ the candidate high disqualifies a swing HIGH.
      if (candles[j].high >= c.high) isHigh = false;
      // A single neighbour ≤ the candidate low disqualifies a swing LOW.
      if (candles[j].low <= c.low) isLow = false;
      if (!isHigh && !isLow) break; // early exit — can't be either
    }

    if (isHigh) swings.push({ index: i, time: c.time, price: c.high, kind: 'HIGH' });
    if (isLow) swings.push({ index: i, time: c.time, price: c.low, kind: 'LOW' });
  }

  return swings;
}

/** Just the swing highs, in order. */
export function swingHighs(candles: Candle[], strength = 2): SwingPoint[] {
  return findSwingPoints(candles, strength).filter((s) => s.kind === 'HIGH');
}

/** Just the swing lows, in order. */
export function swingLows(candles: Candle[], strength = 2): SwingPoint[] {
  return findSwingPoints(candles, strength).filter((s) => s.kind === 'LOW');
}
