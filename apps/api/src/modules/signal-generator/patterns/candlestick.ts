/**
 * Candlestick pattern detection — single- and two-candle reversal signals.
 *
 * Where swing points describe the SHAPE of a trend, candlestick patterns describe
 * the INTENT of a single bar (or an adjacent pair): who won the session, buyers or
 * sellers, and by how much. We express every pattern purely in terms of four
 * geometric measures — body, range, upper wick, lower wick — so the rules stay
 * transparent and tunable. See docs/learning/pattern-detection/02-candlestick.md.
 */

import type { Candle } from './swing-points';

export type CandlestickPatternName =
  | 'BULLISH_ENGULFING'
  | 'BEARISH_ENGULFING'
  | 'HAMMER'
  | 'SHOOTING_STAR'
  | 'DOJI';

/** Directional lean a detected pattern implies. */
export type Bias = 'BULLISH' | 'BEARISH' | 'NEUTRAL';

export interface CandlestickPattern {
  name: CandlestickPatternName;
  /** Index of the SIGNAL candle (last candle of the pattern) in the input array. */
  index: number;
  /** Convenience mirror of `candles[index].time`. */
  time: number;
  bias: Bias;
}

export interface CandlestickOptions {
  /** body <= this * range ⇒ doji. Default 0.1. */
  dojiBodyRatio?: number;
  /** The long wick must be >= this * body. Default 2. */
  wickBodyRatio?: number;
  /** The short (opposite) wick must be <= this * body. Default 1. */
  oppositeWickBodyRatio?: number;
}

// --- Geometry helpers -------------------------------------------------------
// Exported so tests and humans can reason about each measure independently.

/** Absolute size of the real body (open→close distance). */
export function body(c: Candle): number {
  return Math.abs(c.close - c.open);
}

/** Full high→low span of the candle. */
export function range(c: Candle): number {
  return c.high - c.low;
}

/** Wick above the body: high minus the higher of open/close. */
export function upperWick(c: Candle): number {
  return c.high - Math.max(c.open, c.close);
}

/** Wick below the body: the lower of open/close minus low. */
export function lowerWick(c: Candle): number {
  return Math.min(c.open, c.close) - c.low;
}

/** Close above open — buyers won the session. */
export function isBullish(c: Candle): boolean {
  return c.close > c.open;
}

/** Close below open — sellers won the session. */
export function isBearish(c: Candle): boolean {
  return c.close < c.open;
}

// --- Detectors --------------------------------------------------------------

/**
 * Engulfing: a two-candle reversal where `curr`'s body fully swallows `prev`'s.
 *
 * BULLISH_ENGULFING — a down candle followed by a bigger up candle that opens at
 * or below the prior close and closes at or above the prior open. BEARISH_ENGULFING
 * is the mirror. In both cases `body(curr) > body(prev)` is required, so a small
 * inside bar can never "engulf" its larger neighbour.
 *
 * `index` is the position of `curr` (the signal candle) in the series.
 */
export function detectEngulfing(prev: Candle, curr: Candle, index: number): CandlestickPattern | null {
  // Bullish: prev down, curr up, curr body spans prev body, and curr is bigger.
  if (
    isBearish(prev) &&
    isBullish(curr) &&
    curr.close >= prev.open &&
    curr.open <= prev.close &&
    body(curr) > body(prev)
  ) {
    return { name: 'BULLISH_ENGULFING', index, time: curr.time, bias: 'BULLISH' };
  }

  // Bearish: prev up, curr down, curr body spans prev body, and curr is bigger.
  if (
    isBullish(prev) &&
    isBearish(curr) &&
    curr.open >= prev.close &&
    curr.close <= prev.open &&
    body(curr) > body(prev)
  ) {
    return { name: 'BEARISH_ENGULFING', index, time: curr.time, bias: 'BEARISH' };
  }

  return null;
}

/**
 * Hammer / shooting star: a single candle with one long wick and a small body.
 *
 * A HAMMER (bullish) has a long lower wick and a negligible upper wick — sellers
 * pushed price down intrasession but buyers reclaimed it. A SHOOTING_STAR (bearish)
 * is the vertical mirror. We require a real body (`body > 0`); a zero-body bar is
 * doji territory, handled separately.
 */
export function detectHammerOrStar(
  c: Candle,
  index: number,
  opts?: CandlestickOptions,
): CandlestickPattern | null {
  const { wickBodyRatio = 2, oppositeWickBodyRatio = 1 } = opts ?? {};
  const b = body(c);
  if (b <= 0) return null; // no real body ⇒ not a hammer/star

  // Hammer: long lower wick, short upper wick.
  if (lowerWick(c) >= wickBodyRatio * b && upperWick(c) <= oppositeWickBodyRatio * b) {
    return { name: 'HAMMER', index, time: c.time, bias: 'BULLISH' };
  }

  // Shooting star: long upper wick, short lower wick.
  if (upperWick(c) >= wickBodyRatio * b && lowerWick(c) <= oppositeWickBodyRatio * b) {
    return { name: 'SHOOTING_STAR', index, time: c.time, bias: 'BEARISH' };
  }

  return null;
}

/**
 * Doji: open and close are near-identical, so the body is a sliver of the range.
 * Signals indecision (NEUTRAL bias). We guard against a zero-range flat bar, which
 * would make the ratio test meaningless.
 */
export function detectDoji(c: Candle, index: number, opts?: CandlestickOptions): CandlestickPattern | null {
  const { dojiBodyRatio = 0.1 } = opts ?? {};
  if (range(c) > 0 && body(c) <= dojiBodyRatio * range(c)) {
    return { name: 'DOJI', index, time: c.time, bias: 'NEUTRAL' };
  }
  return null;
}

/**
 * Scan an entire series for every candlestick pattern.
 *
 * For each adjacent pair we test engulfing; for each individual candle we test doji
 * then hammer/star. Multiple patterns MAY co-occur on the same index (e.g. a doji
 * that is also the second bar of an engulfing) — each hit is included. Results stay
 * ordered by `index` ascending.
 */
export function findCandlestickPatterns(candles: Candle[], opts?: CandlestickOptions): CandlestickPattern[] {
  const hits: CandlestickPattern[] = [];

  for (let i = 0; i < candles.length; i++) {
    // Two-candle: engulfing needs a predecessor.
    if (i >= 1) {
      const eng = detectEngulfing(candles[i - 1], candles[i], i);
      if (eng) hits.push(eng);
    }
    // Single-candle checks on the same bar.
    const doji = detectDoji(candles[i], i, opts);
    if (doji) hits.push(doji);
    const hammer = detectHammerOrStar(candles[i], i, opts);
    if (hammer) hits.push(hammer);
  }

  return hits;
}
