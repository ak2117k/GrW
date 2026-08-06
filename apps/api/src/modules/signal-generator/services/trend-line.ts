import { detectSwingPivots } from './swing-pivots';

/** Candle shape the fit needs: position on the time axis plus the extremes. */
export interface TrendCandle {
  /** Unix SECONDS (what lightweight-charts uses), not milliseconds. */
  time: number;
  high: number;
  low: number;
}

export interface TrendLine {
  kind: 'uptrend' | 'downtrend';
  /** Price per SECOND — time is in unix seconds, so this is a tiny number. */
  slope: number;
  /**
   * Fitted price AT `fromTime`, not at t=0. The caller draws from `fromTime`
   * rightwards, and a t=0 intercept on a unix-seconds axis is ~1.7e9 seconds of
   * extrapolation away from the data — numerically horrible and meaningless.
   */
  intercept: number;
  /** Unix seconds of the first anchoring pivot. */
  fromTime: number;
  /** Unix seconds of the last anchoring pivot. */
  toTime: number;
  /** How many pivots the line is fitted through. */
  touches: number;
  /** Coefficient of determination, 0..1. */
  r2: number;
}

export interface TrendLineOptions {
  /** Minimum pivots on a side before it may be called a trend. Default 3. */
  minTouches?: number;
  /** Minimum fit quality. Default 0.75. */
  minR2?: number;
}

const DEFAULT_MIN_TOUCHES = 3;
const DEFAULT_MIN_R2 = 0.75;

/**
 * Fewest bars detectSwingPivots can confirm anything from: it skips the first
 * and last 3 bars, so 7 is the first length with a candidate at all.
 */
const MIN_CANDLES = 7;

interface Point {
  t: number;
  p: number;
}

/**
 * Least-squares fit of price on time for one side's pivots. Returns null for
 * any input the fit is not defined on (too few points, zero time variance).
 */
function fitSide(points: Point[], kind: 'uptrend' | 'downtrend'): TrendLine | null {
  const n = points.length;
  if (n < 2) return null;

  let sumT = 0;
  let sumP = 0;
  for (const { t, p } of points) {
    sumT += t;
    sumP += p;
  }
  const meanT = sumT / n;
  const meanP = sumP / n;

  let sTT = 0;
  let sPP = 0;
  let sTP = 0;
  for (const { t, p } of points) {
    const dt = t - meanT;
    const dp = p - meanP;
    sTT += dt * dt;
    sPP += dp * dp;
    sTP += dt * dp;
  }

  // Zero time variance means every pivot landed on the same timestamp — a
  // vertical "line". No slope exists; dividing would yield Infinity/NaN.
  if (!(sTT > 0)) return null;

  const slope = sTP / sTT;
  // Zero price variance is a perfectly flat run of pivots. r2 is undefined
  // (0/0) and the slope is 0, which contradicts both sides anyway.
  if (!(sPP > 0)) return null;

  const r2 = (sTP * sTP) / (sTT * sPP);
  if (!Number.isFinite(r2)) return null;

  const fromTime = points[0].t;
  const toTime = points[n - 1].t;

  return {
    kind,
    slope,
    intercept: meanP + slope * (fromTime - meanT),
    fromTime,
    toTime,
    touches: n,
    // Floating-point error can nudge a perfect fit a hair past 1.
    r2: r2 > 1 ? 1 : r2,
  };
}

/**
 * Fit a trend line through the swing pivots of `candles`.
 *
 * Uptrends are fitted through swing LOWS (the line price keeps bouncing off
 * from above), downtrends through swing HIGHS. A side qualifies only if it has
 * enough pivots, fits them well enough, and slopes in the direction it claims.
 *
 * `null` is a first-class, honest answer meaning "no clear trend". Drawing a
 * line through noise is worse than drawing none, so every guard below returns
 * null rather than degrading to a weaker line.
 *
 * Pure — no IO, no clock, no injection.
 */
export function fitTrendLine(
  candles: TrendCandle[],
  opts: TrendLineOptions = {},
): TrendLine | null {
  if (!Array.isArray(candles) || candles.length < MIN_CANDLES) return null;

  const minTouches = Math.max(2, Math.floor(opts.minTouches ?? DEFAULT_MIN_TOUCHES));
  const minR2 = opts.minR2 ?? DEFAULT_MIN_R2;

  const lows: Point[] = [];
  const highs: Point[] = [];
  for (const pivot of detectSwingPivots(candles)) {
    const candle = candles[pivot.index];
    const t = candle?.time;
    // A pivot whose bar carries a junk timestamp or price can't anchor
    // anything; drop it rather than let NaN poison the whole fit.
    if (!Number.isFinite(t) || !Number.isFinite(pivot.price)) continue;
    (pivot.kind === 'low' ? lows : highs).push({ t, p: pivot.price });
  }

  const up = lows.length >= minTouches ? fitSide(lows, 'uptrend') : null;
  const down = highs.length >= minTouches ? fitSide(highs, 'downtrend') : null;

  const candidates: TrendLine[] = [];
  for (const line of [up, down]) {
    if (!line) continue;
    if (line.r2 < minR2) continue;
    // A "downtrend" of rising highs is not a downtrend. Reject rather than
    // relabel: the pivot side we fitted is what defines the kind.
    if (line.kind === 'uptrend' ? !(line.slope > 0) : !(line.slope < 0)) continue;
    candidates.push(line);
  }

  if (candidates.length === 0) return null;
  // Best fit wins; more touches breaks a tie (more evidence for the same fit).
  candidates.sort((a, b) => b.r2 - a.r2 || b.touches - a.touches);
  return candidates[0];
}
