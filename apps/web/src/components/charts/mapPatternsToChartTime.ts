import type { PatternMarker } from '@/hooks/usePatterns';

/**
 * A pattern with its REAL epoch-MS times resolved onto the chart's
 * gap-compressed time axis.
 *
 *  - `anchorTime`  — compressed time of the anchor candle (`pattern.time`), or
 *                    null when that candle is outside the displayed window.
 *  - `pointTimes`  — compressed times of the chart-pattern peaks/troughs
 *                    (`pattern.points`); only successfully-mapped points are
 *                    kept, in input order.
 */
export interface MappedPattern {
  pattern: PatternMarker;
  anchorTime: number | null;
  pointTimes: number[];
}

/**
 * The chart plots candles on a gap-COMPRESSED time axis and keeps a
 * `Map<compressedTime, realUnixSeconds>` (`realTimeMap`) to translate back.
 * Backend pattern times are REAL epoch MILLISECONDS, so to place a marker we
 * must go MS → real seconds → compressed time.
 *
 * We invert `realTimeMap` once into `realSeconds → compressedTime`, then for
 * each pattern time:
 *   1. try an exact hit on the real bar-start second, else
 *   2. find the bar whose real start is the largest value ≤ the pattern second
 *      and accept it only when the pattern falls INSIDE that bar
 *      (`sec - barStart < tfSec`).
 * `tfSec` (the timeframe in seconds) is derived from the smallest gap between
 * consecutive real bar-starts — the map already encodes it, so callers don't
 * pass it. Patterns that resolve to nothing in the window are dropped, never
 * crash.
 *
 * Pure + deterministic so it can be unit-tested in isolation.
 */
export function mapPatternsToChartTime(
  patterns: PatternMarker[],
  realTimeMap: Map<number, number>,
): MappedPattern[] {
  const resolver = buildChartTimeResolver(realTimeMap);

  const out: MappedPattern[] = [];
  for (const p of patterns) {
    const anchorTime = resolver.resolveMs(p.time);

    const pointTimes: number[] = [];
    for (const ptMs of p.points ?? []) {
      const c = resolver.resolveMs(ptMs);
      if (c !== null) pointTimes.push(c);
    }

    // Drop patterns that have no anchor AND no points inside the window.
    if (anchorTime === null && pointTimes.length === 0) continue;
    out.push({ pattern: p, anchorTime, pointTimes });
  }
  return out;
}

/**
 * Resolves ONE real epoch-MS timestamp onto the chart's gap-compressed time
 * axis, using the exact same MS→real-seconds→compressed logic the pattern
 * overlay uses (bar-inside tolerance included). Build it once per render from
 * the current `realTimeMap`, then call `resolveMs` per timestamp.
 *
 * Shared so other overlays (e.g. trade markers) place elements on the SAME
 * bars the pattern markers land on — a single source of truth for the mapping.
 */
export interface ChartTimeResolver {
  /** Real epoch MS → compressed chart time, or null when outside the window. */
  resolveMs: (epochMs: number) => number | null;
}

export function buildChartTimeResolver(
  realTimeMap: Map<number, number>,
): ChartTimeResolver {
  // Invert compressed→real into real→compressed.
  const realToCompressed = new Map<number, number>();
  for (const [compressed, real] of realTimeMap) {
    realToCompressed.set(real, compressed);
  }
  const sortedReals = [...realToCompressed.keys()].sort((a, b) => a - b);
  const tfSec = deriveTfSec(sortedReals);

  return {
    resolveMs: (epochMs: number) =>
      resolveSec(Math.round(epochMs / 1000), realToCompressed, sortedReals, tfSec),
  };
}

/** Smallest positive gap between consecutive real bar-starts = the timeframe. */
function deriveTfSec(sortedReals: number[]): number | null {
  let min: number | null = null;
  for (let i = 1; i < sortedReals.length; i++) {
    const d = sortedReals[i] - sortedReals[i - 1];
    if (d > 0 && (min === null || d < min)) min = d;
  }
  return min;
}

/**
 * Resolve one real second to a compressed time. Exact hit wins; otherwise the
 * second must fall inside the last bar that starts at or before it. Returns
 * null when it lands outside the displayed window (or the map is too small to
 * establish a bar width for a non-exact match).
 */
function resolveSec(
  sec: number,
  realToCompressed: Map<number, number>,
  sortedReals: number[],
  tfSec: number | null,
): number | null {
  const direct = realToCompressed.get(sec);
  if (direct !== undefined) return direct;
  if (tfSec === null) return null;

  // Largest real bar-start ≤ sec (sortedReals is ascending).
  let bar: number | null = null;
  for (const r of sortedReals) {
    if (r <= sec) bar = r;
    else break;
  }
  if (bar !== null && sec - bar < tfSec) {
    return realToCompressed.get(bar) ?? null;
  }
  return null;
}
