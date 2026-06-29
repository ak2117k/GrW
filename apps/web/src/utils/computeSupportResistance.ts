/**
 * Auto-detect major support/resistance levels from a candle history using
 * fractal pivot detection + price clustering + recency-weighted ranking.
 *
 * Designed to run in the browser on whatever candle window the chart already
 * has loaded; no API calls and no extra state.
 *
 * Algorithm:
 *  1. Identify N-bar pivot highs (high greater than its N neighbors on
 *     each side) and pivot lows (low less than neighbors). N scales with
 *     timeframe — see pickWindow() — so 5m and 1d charts get equally
 *     meaningful pivots in real-world terms instead of bar-count terms.
 *  2. Cluster nearby pivots — multiple swings touching roughly the same
 *     price collapse into one level whose strength = number of touches.
 *     Tolerance is auto-derived from the visible price range so the same
 *     code works for stocks at ₹50 and ₹50,000.
 *  3. Rank by a recency-weighted score: a level touched 4 times long ago
 *     can lose to a level touched 3 times recently. Stale levels stop
 *     mattering because the market has already broken through them.
 *  4. Return the strongest few above and below the current price.
 */

export interface SRLevel {
  price: number;
  type: 'resistance' | 'support';
  touches: number;
  /** Bar index of the most recent pivot in this cluster (0..candles.length-1). */
  latestIdx: number;
  /** Composite score used for ranking. Higher = stronger level. */
  score: number;
}

interface CandleLike {
  high: number;
  low: number;
}

export interface SROptions {
  /** Bars on each side that the pivot must dominate. Auto-picked from timeframe if omitted. */
  pivotWindow?: number;
  /** Cluster tolerance as a fraction of the visible price range (0.005 = 0.5%). Auto-picked if omitted. */
  clusterFraction?: number;
  /** Max levels returned per side (above + below). */
  maxPerSide?: number;
  /** Minimum touches required before a cluster is considered an S/R level. */
  minTouches?: number;
  /** Timeframe string ('1m', '5m', '15m', '1h', '4h', '1d', '1w'). Used to pick pivotWindow / clusterFraction. */
  timeframe?: string;
  /**
   * Recency weight in [0, 1]. 0 = ignore recency (touches alone),
   * 1 = newest level gets 2× the weight of the oldest. Default 0.5.
   */
  recencyWeight?: number;
}

/**
 * Pick a sensible pivotWindow for each common timeframe. The numbers aim to
 * make each pivot "look back" a similar amount of real-world time:
 *
 *   1m  → ±20 min,  5m  → ±50 min,  15m → ±105 min,  30m → ±180 min,
 *   1h  → ±5 hrs,   4h  → ±16 hrs,  1d  → ±3 days,   1w → ±2 weeks
 *
 * Looser on shorter timeframes (filters noise), tighter on higher
 * timeframes (each bar already represents lots of real time).
 */
function pickWindow(timeframe: string | undefined): number {
  switch (timeframe) {
    case '1m':
      return 20;
    case '5m':
      return 10;
    case '15m':
      return 7;
    case '30m':
      return 6;
    case '1h':
      return 5;
    case '4h':
      return 4;
    case '1d':
      return 3;
    case '1w':
      return 2;
    default:
      return 5;
  }
}

/**
 * Pick a sensible cluster tolerance for each timeframe. Tighter on lower
 * timeframes where pivots are more numerous and closely-spaced, looser on
 * higher timeframes where each pivot represents a larger price swing.
 */
function pickClusterFraction(timeframe: string | undefined): number {
  switch (timeframe) {
    case '1m':
    case '5m':
      return 0.003;
    case '15m':
    case '30m':
      return 0.004;
    case '1h':
      return 0.005;
    case '4h':
    case '1d':
      return 0.008;
    case '1w':
      return 0.012;
    default:
      return 0.005;
  }
}

export function computeSupportResistance(
  candles: CandleLike[],
  currentPrice: number,
  opts: SROptions = {},
): SRLevel[] {
  const N = opts.pivotWindow ?? pickWindow(opts.timeframe);
  const clusterFraction = opts.clusterFraction ?? pickClusterFraction(opts.timeframe);
  const maxPerSide = opts.maxPerSide ?? 3;
  const minTouches = opts.minTouches ?? 2;
  const recencyWeight = opts.recencyWeight ?? 0.5;

  if (candles.length < 2 * N + 1 || !Number.isFinite(currentPrice) || currentPrice <= 0) {
    return [];
  }

  // Tolerance from price-range — keeps the cluster-merging logic
  // dimensionless so it works across price scales.
  let minP = Infinity;
  let maxP = -Infinity;
  for (const c of candles) {
    if (c.high > maxP) maxP = c.high;
    if (c.low < minP) minP = c.low;
  }
  const range = maxP - minP;
  if (!Number.isFinite(range) || range <= 0) return [];
  const tolerance = range * clusterFraction;

  // Pivot detection — track index alongside price so cluster ranking can
  // weight recent pivots above stale ones.
  const pivotHighs: { price: number; idx: number }[] = [];
  const pivotLows: { price: number; idx: number }[] = [];

  for (let i = N; i < candles.length - N; i++) {
    let isHigh = true;
    let isLow = true;
    const refHigh = candles[i].high;
    const refLow = candles[i].low;
    for (let j = i - N; j <= i + N; j++) {
      if (j === i) continue;
      if (candles[j].high >= refHigh) isHigh = false;
      if (candles[j].low <= refLow) isLow = false;
      if (!isHigh && !isLow) break;
    }
    if (isHigh) pivotHighs.push({ price: refHigh, idx: i });
    if (isLow) pivotLows.push({ price: refLow, idx: i });
  }

  type Cluster = { price: number; touches: number; latestIdx: number };
  const clusterPivots = (pivots: { price: number; idx: number }[]): Cluster[] => {
    if (pivots.length === 0) return [];
    const sorted = [...pivots].sort((a, b) => a.price - b.price);
    const clusters: Cluster[] = [];
    let bucket = { sum: sorted[0].price, count: 1, latestIdx: sorted[0].idx };
    for (let i = 1; i < sorted.length; i++) {
      const avg = bucket.sum / bucket.count;
      if (sorted[i].price - avg <= tolerance) {
        bucket.sum += sorted[i].price;
        bucket.count += 1;
        if (sorted[i].idx > bucket.latestIdx) bucket.latestIdx = sorted[i].idx;
      } else {
        clusters.push({
          price: bucket.sum / bucket.count,
          touches: bucket.count,
          latestIdx: bucket.latestIdx,
        });
        bucket = { sum: sorted[i].price, count: 1, latestIdx: sorted[i].idx };
      }
    }
    clusters.push({
      price: bucket.sum / bucket.count,
      touches: bucket.count,
      latestIdx: bucket.latestIdx,
    });
    return clusters;
  };

  // Recency factor: oldest pivot index gets (1 - recencyWeight),
  // newest gets (1 + recencyWeight). With default 0.5 → range [0.5, 1.5].
  // A level touched 4 times at the chart's left edge scores 4×0.5 = 2.0,
  // a level touched 3 times near the right edge scores 3×1.5 = 4.5 → wins.
  // This is what makes "stale levels stop mattering".
  const maxIdx = candles.length - 1;
  const scoreCluster = (c: Cluster): number => {
    if (maxIdx <= 0) return c.touches;
    const normalized = c.latestIdx / maxIdx; // 0 at oldest, 1 at newest
    const factor = 1 + (normalized * 2 - 1) * recencyWeight;
    return c.touches * factor;
  };

  const highClusters = clusterPivots(pivotHighs).filter((c) => c.touches >= minTouches);
  const lowClusters = clusterPivots(pivotLows).filter((c) => c.touches >= minTouches);

  // Suppress levels that overlap with current price (anything within one
  // tolerance step). Those would just clutter the chart on top of the
  // live bar and rarely correspond to a meaningful boundary.
  const tooClose = (price: number) => Math.abs(price - currentPrice) < tolerance;

  const resistance = highClusters
    .filter((c) => c.price > currentPrice && !tooClose(c.price))
    .map((c) => ({ ...c, score: scoreCluster(c) }))
    .sort((a, b) => b.score - a.score)
    .slice(0, maxPerSide)
    .map(
      (c): SRLevel => ({
        price: c.price,
        type: 'resistance',
        touches: c.touches,
        latestIdx: c.latestIdx,
        score: c.score,
      }),
    );

  const support = lowClusters
    .filter((c) => c.price < currentPrice && !tooClose(c.price))
    .map((c) => ({ ...c, score: scoreCluster(c) }))
    .sort((a, b) => b.score - a.score)
    .slice(0, maxPerSide)
    .map(
      (c): SRLevel => ({
        price: c.price,
        type: 'support',
        touches: c.touches,
        latestIdx: c.latestIdx,
        score: c.score,
      }),
    );

  return [...resistance, ...support];
}
