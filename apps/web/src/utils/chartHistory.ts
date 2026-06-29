/**
 * Pure utilities for the stock-chart "infinite history scroll" feature.
 *
 * The chart uses a gap-compressed time axis (see `useChartData.ts`'s
 * `compressTimes`): walking time-sorted candles, any inter-candle gap LARGER
 * THAN 2× the timeframe is collapsed down to a single timeframe, so overnight /
 * weekend / holiday gaps become one-bar visual breaks. Each plotted candle
 * carries a COMPRESSED time, plus a Map<compressedTime, realTime> for labelling.
 *
 * `prependOlderCandles` adds OLDER candles to the FRONT of an already-compressed
 * series WITHOUT changing the existing bars' compressed times (so the chart view
 * does not reflow). It matches the exact gap semantics of `compressTimes`.
 */

export interface ChartCandle {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export interface PrependResult {
  /** [newly-compressed older bars, ...existing], ascending by compressed time. */
  candles: ChartCandle[];
  /** Copy of existing map, extended with the new bars' compressedTime->realTime. */
  realTimeMap: Map<number, number>;
  /** How many older bars were added at the front. */
  prependedCount: number;
}

/**
 * Compute the per-bar compressed STEP for a real-time-ascending chunk using the
 * same rule as `compressTimes`: the step from the previous bar to this one is
 * the real gap, UNLESS that gap exceeds 2× the timeframe, in which case it
 * collapses to exactly one timeframe.
 *
 * Returns one step per bar (the first bar's step is 0 — it is the anchor).
 */
function compressedSteps(realAscending: ChartCandle[], tfSec: number): number[] {
  const steps: number[] = [];
  for (let i = 0; i < realAscending.length; i++) {
    if (i === 0) {
      steps.push(0);
      continue;
    }
    const gap = realAscending[i].time - realAscending[i - 1].time;
    steps.push(gap > tfSec * 2 ? tfSec : gap);
  }
  return steps;
}

/**
 * Add OLDER candles to the front of an already-compressed series without
 * shifting any existing bar's compressed time.
 *
 * @param existingCompressed ascending; each `.time` is the COMPRESSED time.
 * @param existingRealMap    compressedTime -> realTime for existing bars.
 * @param olderRealCandles   each `.time` is REAL unix-second time; may
 *                           duplicate/overlap; unsorted.
 * @param tfSec              timeframe in seconds.
 */
export function prependOlderCandles(
  existingCompressed: ChartCandle[],
  existingRealMap: Map<number, number>,
  olderRealCandles: ChartCandle[],
  tfSec: number,
): PrependResult {
  // Always return a fresh copy of the map so callers never mutate the original.
  const realTimeMap = new Map<number, number>(existingRealMap);

  // The real-time anchor that older bars must stay strictly older than.
  let existingOldestReal: number | null = null;
  for (const real of existingRealMap.values()) {
    if (existingOldestReal === null || real < existingOldestReal) {
      existingOldestReal = real;
    }
  }

  // 1. Keep only candles strictly older than the existing anchor.
  // 2. Dedupe by real time (also drops intra-chunk duplicates).
  // 3. Sort ascending by real time.
  const byRealTime = new Map<number, ChartCandle>();
  for (const c of olderRealCandles) {
    if (existingOldestReal !== null && c.time >= existingOldestReal) continue;
    if (byRealTime.has(c.time)) continue; // first occurrence wins
    byRealTime.set(c.time, c);
  }
  const older = Array.from(byRealTime.values()).sort((a, b) => a.time - b.time);

  if (older.length === 0) {
    return {
      candles: existingCompressed,
      realTimeMap,
      prependedCount: 0,
    };
  }

  // Compress the older chunk AMONG ITSELF to get relative spacing (steps).
  const steps = compressedSteps(older, tfSec);

  // Determine where the NEWEST older bar's compressed time should land.
  //   - If there is an existing series, it sits exactly tfSec before the
  //     existing first bar's compressed time.
  //   - Otherwise (empty existing series — secondary case), lay the chunk out
  //     like an initial load: newest older bar's compressed time == its own
  //     real time, so earlier bars step back from there.
  const anchorCompressedForNewest =
    existingCompressed.length > 0
      ? existingCompressed[0].time - tfSec
      : older[older.length - 1].time;

  // Walk the older bars from newest -> oldest, stepping the compressed time
  // back by each bar's step. `steps[i]` is the spacing between older[i-1] and
  // older[i]; moving from bar i to bar i-1 subtracts steps[i].
  const olderCompressed: ChartCandle[] = new Array(older.length);
  let compressedTime = anchorCompressedForNewest;
  for (let i = older.length - 1; i >= 0; i--) {
    olderCompressed[i] = { ...older[i], time: compressedTime };
    realTimeMap.set(compressedTime, older[i].time);
    if (i > 0) {
      compressedTime -= steps[i];
    }
  }

  return {
    candles: [...olderCompressed, ...existingCompressed],
    realTimeMap,
    prependedCount: olderCompressed.length,
  };
}
