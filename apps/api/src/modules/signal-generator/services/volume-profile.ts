import type { LevelCandidate } from '../types/evidence-level.types';

const NODES_PER_SIDE = 5;
const VALUE_AREA_PCT = 0.7;

export interface ProfileCandle {
  high: number;
  low: number;
  close: number;
  volume: number;
  /**
   * Bar time in unix SECONDS. Optional and ignored by every profile/level
   * computation here — it is carried so callers that need POSITION (the
   * trend-line fit) can work off the very same bars as the levels instead of
   * fetching a second, possibly different, series.
   */
  time?: number;
}

export interface VolumeNode {
  price: number;  // bucket center
  volume: number; // total volume in the bucket
  score: number;  // 0–40 volume evidence score
}

interface BucketProfile {
  byBucket: Map<number, number>; // bucketIndex → volume
  bucket: number;                // bucket width (price units)
  totalVol: number;
}

/**
 * Build a volume-by-price histogram from 5m candles. Each candle's volume is
 * spread UNIFORMLY across the price buckets its high–low range spans (v2 — v1
 * dumped the whole bar at its typical price, mis-placing a wide bar's volume at
 * a single price it barely traded at). Range distribution puts volume where it
 * actually changed hands, which sharpens the POC / value-area / node prices.
 *
 * bucket = max(0.1*atr14, 0.0025*ltp). Returns null for < 10 candles, a
 * non-positive ltp/bucket, or an empty histogram (insufficient profile).
 */
function buildProfile(
  candles: ProfileCandle[],
  atr14: number,
  ltp: number,
): BucketProfile | null {
  if (candles.length < 10 || !(ltp > 0)) return null;
  // `ltp > 0` already guarantees a positive bucket; the `!(bucket > 0)` guard
  // remains only to reject a NaN bucket from a NaN atr14 (Math.max propagates NaN).
  const bucket = Math.max(0.1 * atr14, 0.0025 * ltp);
  if (!(bucket > 0)) return null;

  const byBucket = new Map<number, number>();
  for (const k of candles) {
    const vol = Number(k.volume) || 0;
    const hi = Number(k.high);
    const lo = Number(k.low);
    let idxLo = Math.round(Math.min(lo, hi) / bucket);
    let idxHi = Math.round(Math.max(lo, hi) / bucket);
    if (!Number.isFinite(idxLo) || !Number.isFinite(idxHi)) {
      // Fall back to the typical price if high/low are unusable.
      const typical = (k.high + k.low + k.close) / 3;
      idxLo = idxHi = Math.round(typical / bucket);
      if (!Number.isFinite(idxLo)) continue;
    }
    const span = idxHi - idxLo + 1; // buckets the bar covers (>= 1)
    const per = vol / span;         // uniform share per bucket
    for (let i = idxLo; i <= idxHi; i++) {
      byBucket.set(i, (byBucket.get(i) ?? 0) + per);
    }
  }
  if (byBucket.size === 0) return null;

  const totalVol = [...byBucket.values()].reduce((a, b) => a + b, 0);
  return { byBucket, bucket, totalVol };
}

/**
 * Volume-by-price nodes around `ltp`. Volume is range-distributed (see
 * buildProfile), each bucket scored 0–40 by how far it exceeds the average
 * bucket volume (>=3x → ~40). Returns up to NODES_PER_SIDE (5) nodes on EACH
 * side of `ltp` — up to 10 total — selected by descending volume within each
 * side, so the support side is never starved when all heavy volume sits
 * overhead. The average used for scoring stays global (all buckets) so scores
 * remain honest and cross-side comparable. Order: above-side nodes first, then
 * below-side; within a side, descending volume. `scoreAndCluster` re-sorts by
 * price, so callers must not rely on this order.
 *
 * Returns [] for < 10 candles (insufficient profile).
 */
export function computeVolumeNodes(
  candles: ProfileCandle[],
  atr14: number,
  ltp: number,
): VolumeNode[] {
  const profile = buildProfile(candles, atr14, ltp);
  if (!profile) return [];
  const { byBucket, bucket, totalVol } = profile;

  const avgVol = totalVol / byBucket.size;
  const nodes: VolumeNode[] = [...byBucket.entries()].map(([idx, volume]) => ({
    price: idx * bucket,
    volume,
    score: avgVol > 0 ? 40 * Math.min(volume / avgVol / 3, 1) : 0,
  }));

  // Select the strongest nodes on EACH side of the live price, not the global
  // top-N. Volume is the biggest single evidence contributor; when price sits
  // low in its range every heavy-volume bucket is overhead, which would starve
  // the support side. `avgVol` above stays global so scores remain honest and
  // cross-side comparable — a small support node still scores low.
  const byVolumeDesc = (a: VolumeNode, b: VolumeNode) => b.volume - a.volume;
  const above = nodes.filter((n) => n.price > ltp).sort(byVolumeDesc).slice(0, NODES_PER_SIDE);
  const below = nodes.filter((n) => n.price < ltp).sort(byVolumeDesc).slice(0, NODES_PER_SIDE);
  return [...above, ...below];
}

/**
 * Institutional volume-profile reference levels from the range-distributed
 * histogram:
 *  - POC (Point of Control): the single highest-volume bucket, score ~40.
 *  - Value Area (VAH / VAL): the price band holding VALUE_AREA_PCT (70%) of
 *    total volume, grown outward from the POC one bucket at a time (always
 *    taking the heavier of the two adjacent buckets), score ~20 each.
 *
 * Returns plain `LevelCandidate`s (price + kind + score) — NOT sided; the
 * assembly (`scoreAndCluster`) assigns support/resistance later. A level is
 * skipped when it sits on the LTP bucket. VAL is omitted when it collapses onto
 * VAH (value area is a single bucket). Returns [] for < 10 candles or no volume.
 */
export function computeProfileLevels(
  candles: ProfileCandle[],
  atr14: number,
  ltp: number,
): LevelCandidate[] {
  const profile = buildProfile(candles, atr14, ltp);
  if (!profile) return [];
  const { byBucket, bucket, totalVol } = profile;
  if (!(totalVol > 0)) return [];

  // Buckets ordered low → high price (index).
  const sorted = [...byBucket.entries()].sort((a, b) => a[0] - b[0]);

  // Point of Control: the heaviest bucket.
  let pocPos = 0;
  for (let i = 1; i < sorted.length; i++) {
    if (sorted[i][1] > sorted[pocPos][1]) pocPos = i;
  }

  // Grow the value area outward from the POC until it holds 70% of volume,
  // always absorbing the heavier of the two adjacent buckets.
  const target = VALUE_AREA_PCT * totalVol;
  let lo = pocPos;
  let hi = pocPos;
  let acc = sorted[pocPos][1];
  while (acc < target && (lo > 0 || hi < sorted.length - 1)) {
    const belowVol = lo > 0 ? sorted[lo - 1][1] : -1;
    const aboveVol = hi < sorted.length - 1 ? sorted[hi + 1][1] : -1;
    if (aboveVol >= belowVol) {
      hi += 1;
      acc += sorted[hi][1];
    } else {
      lo -= 1;
      acc += sorted[lo][1];
    }
  }

  const pocIdx = sorted[pocPos][0];
  const valIdx = sorted[lo][0];
  const vahIdx = sorted[hi][0];
  const ltpIdx = Math.round(ltp / bucket);

  const out: LevelCandidate[] = [];
  const push = (idx: number, kind: 'POC' | 'VALUE_AREA', score: number) => {
    if (idx === ltpIdx) return; // a level on the LTP bucket is not an S/R reference
    out.push({ price: idx * bucket, kind, score });
  };
  push(pocIdx, 'POC', 40);
  push(vahIdx, 'VALUE_AREA', 20);
  if (valIdx !== vahIdx) push(valIdx, 'VALUE_AREA', 20);
  return out;
}
