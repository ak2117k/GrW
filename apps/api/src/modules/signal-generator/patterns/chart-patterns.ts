/**
 * Chart-pattern detection — multi-swing reversal structures (double top / bottom).
 *
 * Where candlestick patterns read a single bar's intent and swing points mark the
 * pivots, chart patterns describe the SHAPE a sequence of pivots traces out. A
 * double top is two peaks of near-equal height separated by a valley (the
 * "neckline"); price confirming the pattern means a later candle CLOSES back
 * through that neckline. A double bottom is the vertical mirror. Everything here is
 * expressed in terms of the swing highs/lows from Lesson 01, so the rules stay
 * geometric and tunable. See docs/learning/pattern-detection/03-chart-patterns.md.
 */

import type { Candle, SwingPoint } from './swing-points';
import { swingHighs, swingLows } from './swing-points';

export type ChartPatternName = 'DOUBLE_TOP' | 'DOUBLE_BOTTOM';

/** Directional lean a completed chart pattern implies. */
export type ChartBias = 'BULLISH' | 'BEARISH';

export interface ChartPattern {
  name: ChartPatternName;
  /** DOUBLE_TOP ⇒ 'BEARISH', DOUBLE_BOTTOM ⇒ 'BULLISH'. */
  bias: ChartBias;
  /** First peak (top) or trough (bottom). */
  first: SwingPoint;
  /** Second peak (top) or trough (bottom). */
  second: SwingPoint;
  /** The opposite-kind swing sitting BETWEEN `first` and `second`. */
  neckline: SwingPoint;
  /** Convenience mirror of `neckline.price`. */
  necklinePrice: number;
  /** Did a candle AFTER `second` close beyond the neckline (breakout/breakdown)? */
  confirmed: boolean;
  /** Index of the confirming candle, or null if price never broke the neckline. */
  confirmIndex: number | null;
}

export interface ChartPatternOptions {
  /** Passed straight to swingHighs/swingLows. Bigger ⇒ fewer, weightier pivots. Default 3. */
  strength?: number;
  /** |p1 - p2| / p1 <= this ⇒ the two peaks/troughs count as "equal height". Default 0.02 (2%). */
  priceTolerance?: number;
  /** Neckline depth vs the peaks/troughs must be >= this to be a real pattern. Default 0.03 (3%). */
  minDepthRatio?: number;
}

/**
 * Detect every double TOP in `candles`.
 *
 * For each consecutive pair of swing highs (H1, H2) we take the LOWEST swing low
 * between them as the neckline, then demand two things: the peaks are of near-equal
 * height (`priceTolerance`), and they sit far enough above the neckline
 * (`minDepthRatio`) so a trivial wobble isn't mistaken for a top. Confirmation is
 * the first later candle to CLOSE below the neckline — a breakdown. Bias is BEARISH.
 */
export function findDoubleTops(candles: Candle[], opts?: ChartPatternOptions): ChartPattern[] {
  const { strength = 3, priceTolerance = 0.02, minDepthRatio = 0.03 } = opts ?? {};
  const highs = swingHighs(candles, strength);
  const lows = swingLows(candles, strength);
  const patterns: ChartPattern[] = [];

  for (let i = 0; i < highs.length - 1; i++) {
    const first = highs[i];
    const second = highs[i + 1];

    // Neckline = the deepest swing low strictly between the two peaks.
    const between = lows.filter((l) => l.index > first.index && l.index < second.index);
    if (between.length === 0) continue; // no valley ⇒ not a double top
    const neckline = between.reduce((lowest, l) => (l.price < lowest.price ? l : lowest));

    // Equal-height test: the two peaks must be within tolerance of each other.
    if (Math.abs(first.price - second.price) / first.price > priceTolerance) continue;

    // Depth test: the SHALLOWER peak must clear the neckline by minDepthRatio.
    const depth = (Math.min(first.price, second.price) - neckline.price) / neckline.price;
    if (depth < minDepthRatio) continue;

    // Confirmation: first candle after the second peak to close BELOW the neckline.
    let confirmed = false;
    let confirmIndex: number | null = null;
    for (let k = second.index + 1; k < candles.length; k++) {
      if (candles[k].close < neckline.price) {
        confirmed = true;
        confirmIndex = k;
        break;
      }
    }

    patterns.push({
      name: 'DOUBLE_TOP',
      bias: 'BEARISH',
      first,
      second,
      neckline,
      necklinePrice: neckline.price,
      confirmed,
      confirmIndex,
    });
  }

  return patterns;
}

/**
 * Detect every double BOTTOM in `candles` — the mirror of {@link findDoubleTops}.
 *
 * Consecutive swing lows (L1, L2) form the troughs; the HIGHEST swing high between
 * them is the neckline. The equal-height test runs on the troughs and the depth
 * test measures how far the neckline sits ABOVE the shallower trough. Confirmation
 * is the first later candle to CLOSE above the neckline — a breakout up. Bias BULLISH.
 */
export function findDoubleBottoms(candles: Candle[], opts?: ChartPatternOptions): ChartPattern[] {
  const { strength = 3, priceTolerance = 0.02, minDepthRatio = 0.03 } = opts ?? {};
  const lows = swingLows(candles, strength);
  const highs = swingHighs(candles, strength);
  const patterns: ChartPattern[] = [];

  for (let i = 0; i < lows.length - 1; i++) {
    const first = lows[i];
    const second = lows[i + 1];

    // Neckline = the highest swing high strictly between the two troughs.
    const between = highs.filter((h) => h.index > first.index && h.index < second.index);
    if (between.length === 0) continue; // no peak ⇒ not a double bottom
    const neckline = between.reduce((highest, h) => (h.price > highest.price ? h : highest));

    // Equal-height test: the two troughs must be within tolerance of each other.
    if (Math.abs(first.price - second.price) / first.price > priceTolerance) continue;

    // Depth test: the neckline must sit above the SHALLOWER trough by minDepthRatio.
    const depth = (neckline.price - Math.max(first.price, second.price)) / neckline.price;
    if (depth < minDepthRatio) continue;

    // Confirmation: first candle after the second trough to close ABOVE the neckline.
    let confirmed = false;
    let confirmIndex: number | null = null;
    for (let k = second.index + 1; k < candles.length; k++) {
      if (candles[k].close > neckline.price) {
        confirmed = true;
        confirmIndex = k;
        break;
      }
    }

    patterns.push({
      name: 'DOUBLE_BOTTOM',
      bias: 'BULLISH',
      first,
      second,
      neckline,
      necklinePrice: neckline.price,
      confirmed,
      confirmIndex,
    });
  }

  return patterns;
}

/**
 * Scan a series for every chart pattern: all double tops followed by all double
 * bottoms. Ordering is tops-then-bottoms (not interleaved by index) so callers can
 * reason about the two structures separately.
 */
export function findChartPatterns(candles: Candle[], opts?: ChartPatternOptions): ChartPattern[] {
  return findDoubleTops(candles, opts).concat(findDoubleBottoms(candles, opts));
}
