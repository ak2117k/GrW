export interface PivotCandle {
  high: number;
  low: number;
  /** Optional OHLC/volume — enables rejection-magnitude and relative-volume
   * scoring in detectWeightedPivots. detectSwingPivots ignores these. */
  open?: number;
  close?: number;
  volume?: number;
}

export interface SwingPivot {
  price: number;
  kind: 'high' | 'low';
  /**
   * Index of the candle the pivot sits on. Price alone can't anchor anything
   * to the time axis — the trend-line fit needs WHERE each swing happened, not
   * just at what price — so the detector reports position rather than every
   * caller re-deriving it (and re-implementing the fractal rule to do so).
   */
  index: number;
}

/**
 * Standalone 3-bar fractal swing-pivot detector. Mirrors the proven rule
 * inside StrongZoneDetectorService.detectPivots: index `i` is a swing high
 * when its high strictly exceeds the highs of the 3 bars on either side, and
 * a swing low when its low is strictly below the lows of the 3 bars on either
 * side. The first and last 3 bars are skipped (edges can't be confirmed).
 *
 * Used to derive evidence HISTORY candidates from per-timeframe candles on
 * non-15m intervals (the 15m path keeps using the DB-stored zone pivots).
 */
export function detectSwingPivots(candles: PivotCandle[]): SwingPivot[] {
  const pivots: SwingPivot[] = [];
  if (!Array.isArray(candles)) return pivots;

  for (let i = 3; i < candles.length - 3; i++) {
    const c = candles[i];
    const isHigh =
      c.high > candles[i - 1].high &&
      c.high > candles[i - 2].high &&
      c.high > candles[i - 3].high &&
      c.high > candles[i + 1].high &&
      c.high > candles[i + 2].high &&
      c.high > candles[i + 3].high;
    if (isHigh) {
      pivots.push({ price: c.high, kind: 'high', index: i });
      continue;
    }
    const isLow =
      c.low < candles[i - 1].low &&
      c.low < candles[i - 2].low &&
      c.low < candles[i - 3].low &&
      c.low < candles[i + 1].low &&
      c.low < candles[i + 2].low &&
      c.low < candles[i + 3].low;
    if (isLow) {
      pivots.push({ price: c.low, kind: 'low', index: i });
    }
  }
  return pivots;
}

// ---------------------------------------------------------------------------
// Weighted swing-pivot detector
// ---------------------------------------------------------------------------

export interface WeightedPivotOptions {
  /** Fractal half-width: a pivot must strictly exceed its ±strength neighbours.
   *  Default 3. Larger (5–7) filters out small wiggles. */
  strength?: number;
  /** Fractional band (of price) for counting a later bar as a retest of a
   *  level. Default 0.005 (0.5%). */
  retestTolerancePct?: number;
  /** Fractional band (of price) for collapsing near-duplicate pivots.
   *  Default 0.005 (0.5%). */
  mergeTolerancePct?: number;
  /** Retest count cap — extra retests beyond this add no score. Default 4. */
  maxRetests?: number;
}

export interface WeightedPivot {
  price: number;
  /** Graduated significance, 0..25 (comparable to the flat HISTORY=25 and the
   *  DB-zone `25 * strength/100`). */
  score: number;
  kind: 'HISTORY';
}

const DEFAULT_STRENGTH = 3;
const DEFAULT_RETEST_TOL_PCT = 0.005;
const DEFAULT_MERGE_TOL_PCT = 0.005;
const DEFAULT_MAX_RETESTS = 4;

// Score budget (sums to the 25-point HISTORY ceiling).
const W_RETEST = 10;
const W_REJECTION = 8;
const W_VOLUME = 7;
const MAX_SCORE = W_RETEST + W_REJECTION + W_VOLUME; // 25

// Normalisation references.
const VOLUME_REF = 2; // relVol of 3x the local average saturates the volume term.
const PROMINENCE_REF_PCT = 0.05; // 5% above neighbours saturates the fallback rejection term.

const clamp01 = (x: number): number => (x < 0 ? 0 : x > 1 ? 1 : x);

interface RawPivot {
  price: number;
  kind: 'high' | 'low';
  score: number;
}

function isFractalHigh(
  candles: PivotCandle[],
  i: number,
  strength: number,
): boolean {
  const h = candles[i].high;
  for (let k = i - strength; k <= i + strength; k++) {
    if (k === i) continue;
    if (!(h > candles[k].high)) return false;
  }
  return true;
}

function isFractalLow(
  candles: PivotCandle[],
  i: number,
  strength: number,
): boolean {
  const l = candles[i].low;
  for (let k = i - strength; k <= i + strength; k++) {
    if (k === i) continue;
    if (!(l < candles[k].low)) return false;
  }
  return true;
}

/** Count distinct later excursions back into a tolerance band around `price`
 *  (rising-edge detection so a multi-bar consolidation counts once). */
function countRetests(
  candles: PivotCandle[],
  fromIdx: number,
  price: number,
  tolPct: number,
  maxRetests: number,
): number {
  const tolAbs = price * tolPct;
  let count = 0;
  let inBand = false;
  for (let j = fromIdx; j < candles.length; j++) {
    const c = candles[j];
    const near = c.high >= price - tolAbs && c.low <= price + tolAbs;
    if (near) {
      if (!inBand) {
        count++;
        inBand = true;
        if (count >= maxRetests) break;
      }
    } else {
      inBand = false;
    }
  }
  return count;
}

/** Rejection sharpness 0..1: the pivot bar's wick beyond its body, relative to
 *  its range. Falls back to prominence over neighbours when OHLC is absent. */
function rejectionStrength(
  candles: PivotCandle[],
  i: number,
  price: number,
  kind: 'high' | 'low',
  strength: number,
): number {
  const c = candles[i];
  const range = c.high - c.low;
  if (c.open != null && c.close != null && range > 0) {
    const wick =
      kind === 'high'
        ? c.high - Math.max(c.open, c.close)
        : Math.min(c.open, c.close) - c.low;
    return clamp01(wick / range);
  }
  // Fallback: how far the pivot stands out above/below its neighbours.
  let sum = 0;
  let n = 0;
  for (let k = i - strength; k <= i + strength; k++) {
    if (k === i) continue;
    sum += kind === 'high' ? candles[k].high : candles[k].low;
    n++;
  }
  const ref = n > 0 ? sum / n : price;
  if (ref <= 0) return 0;
  return clamp01(Math.abs(price - ref) / (ref * PROMINENCE_REF_PCT));
}

/** Relative volume 0..1: pivot-bar volume vs the local neighbour average. */
function volumeStrength(
  candles: PivotCandle[],
  i: number,
  strength: number,
): number {
  const v = candles[i].volume;
  if (v == null) return 0;
  let sum = 0;
  let n = 0;
  for (let k = i - strength; k <= i + strength; k++) {
    if (k === i) continue;
    const vk = candles[k].volume;
    if (vk != null) {
      sum += vk;
      n++;
    }
  }
  const avg = n > 0 ? sum / n : 0;
  if (avg <= 0) return 0;
  return clamp01((v / avg - 1) / VOLUME_REF);
}

/** Collapse pivots whose prices fall within `mergeTolPct`, keeping the
 *  highest-scoring representative of each cluster. */
function mergePivots(raw: RawPivot[], mergeTolPct: number): WeightedPivot[] {
  if (raw.length === 0) return [];
  const sorted = [...raw].sort((a, b) => a.price - b.price);
  const out: WeightedPivot[] = [];
  let best = sorted[0];
  let clusterRef = sorted[0].price;
  for (let i = 1; i < sorted.length; i++) {
    const p = sorted[i];
    if (Math.abs(p.price - clusterRef) <= clusterRef * mergeTolPct) {
      if (p.score > best.score) best = p;
      clusterRef = p.price; // walk the band so a gentle drift stays one cluster
    } else {
      out.push({ price: best.price, score: best.score, kind: 'HISTORY' });
      best = p;
      clusterRef = p.price;
    }
  }
  out.push({ price: best.price, score: best.score, kind: 'HISTORY' });
  return out;
}

/**
 * Weighted swing-pivot detector. Like detectSwingPivots but with a configurable
 * fractal width and a graduated 0..25 significance score per level, combining:
 *   - retest count   (how often price returned to the level — capped),
 *   - rejection sharpness (wick beyond the body, or prominence as fallback),
 *   - relative volume on the pivot bar.
 * Near-duplicate levels are merged, keeping the strongest. Pure, no IO.
 */
export function detectWeightedPivots(
  candles: PivotCandle[],
  opts: WeightedPivotOptions = {},
): WeightedPivot[] {
  if (!Array.isArray(candles)) return [];
  const strength = Math.max(1, Math.floor(opts.strength ?? DEFAULT_STRENGTH));
  const retestTol = opts.retestTolerancePct ?? DEFAULT_RETEST_TOL_PCT;
  const mergeTol = opts.mergeTolerancePct ?? DEFAULT_MERGE_TOL_PCT;
  const maxRetests = Math.max(
    1,
    Math.floor(opts.maxRetests ?? DEFAULT_MAX_RETESTS),
  );

  // Need at least one fully-flanked bar.
  if (candles.length < strength * 2 + 1) return [];

  const raw: RawPivot[] = [];
  for (let i = strength; i < candles.length - strength; i++) {
    const high = isFractalHigh(candles, i, strength);
    const low = !high && isFractalLow(candles, i, strength);
    if (!high && !low) continue;

    const kind: 'high' | 'low' = high ? 'high' : 'low';
    const price = high ? candles[i].high : candles[i].low;

    const retest01 =
      countRetests(candles, i + strength + 1, price, retestTol, maxRetests) /
      maxRetests;
    const rejection01 = rejectionStrength(candles, i, price, kind, strength);
    const volume01 = volumeStrength(candles, i, strength);

    const score = Math.min(
      MAX_SCORE,
      retest01 * W_RETEST + rejection01 * W_REJECTION + volume01 * W_VOLUME,
    );
    raw.push({ price, kind, score });
  }

  return mergePivots(raw, mergeTol);
}
