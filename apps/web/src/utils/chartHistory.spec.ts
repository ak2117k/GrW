import { describe, it, expect } from 'vitest';
import {
  prependOlderCandles,
  type ChartCandle,
} from './chartHistory';

const TF = 60; // 1-minute bars, in seconds

/** Build a candle with deterministic OHLCV derived from its real time. */
function candle(time: number): ChartCandle {
  return {
    time,
    open: time,
    high: time + 1,
    low: time - 1,
    close: time + 0.5,
    volume: time % 1000,
  };
}

/**
 * Build a compressed existing series + real map from contiguous real candles,
 * laid out so the first bar's compressed time equals its real time (mirrors the
 * `compressTimes` output for a gap-free chunk).
 */
function buildExisting(realTimes: number[]): {
  compressed: ChartCandle[];
  map: Map<number, number>;
} {
  const compressed: ChartCandle[] = [];
  const map = new Map<number, number>();
  let offset = 0;
  let prevReal = realTimes[0];
  for (let i = 0; i < realTimes.length; i++) {
    const real = realTimes[i];
    if (i > 0) {
      const gap = real - prevReal;
      if (gap > TF * 2) offset += gap - TF;
    }
    prevReal = real;
    const compressedTime = real - offset;
    compressed.push({ ...candle(real), time: compressedTime });
    map.set(compressedTime, real);
  }
  return { compressed, map };
}

describe('prependOlderCandles', () => {
  it('1. contiguous older prepend steps back by exactly tfSec', () => {
    // Existing: real 1000,1060,1120 -> contiguous, compressed == real.
    const { compressed, map } = buildExisting([1000, 1060, 1120]);
    // Older contiguous: real 820,880,940 (all strictly older than 1000).
    const older = [candle(820), candle(880), candle(940)];

    const result = prependOlderCandles(compressed, map, older, TF);

    expect(result.prependedCount).toBe(3);
    // Newest older bar (real 940) sits at firstExistingCompressed - tfSec.
    const firstExisting = compressed[0].time; // 1000
    const prepended = result.candles.slice(0, 3);
    expect(prepended[2].time).toBe(firstExisting - TF); // 940
    expect(prepended[1].time).toBe(firstExisting - TF * 2); // 880
    expect(prepended[0].time).toBe(firstExisting - TF * 3); // 820

    // Map extended with the new compressed->real entries.
    expect(result.realTimeMap.get(firstExisting - TF)).toBe(940);
    expect(result.realTimeMap.get(firstExisting - TF * 2)).toBe(880);
    expect(result.realTimeMap.get(firstExisting - TF * 3)).toBe(820);

    // Existing entries preserved in the map.
    expect(result.realTimeMap.get(1000)).toBe(1000);
    expect(result.realTimeMap.get(1060)).toBe(1060);
    expect(result.realTimeMap.get(1120)).toBe(1120);

    // Ascending by compressed time, OHLCV preserved.
    const times = result.candles.map((c) => c.time);
    expect(times).toEqual([...times].sort((a, b) => a - b));
    expect(prepended[2].close).toBe(candle(940).close);
  });

  it('2. a gap > 2*tfSec inside the older chunk collapses to one tfSec step', () => {
    const { compressed, map } = buildExisting([1000, 1060]);
    // Older: real 700, then a big jump to 940 (gap 240 = 4*TF > 2*TF).
    // Internal step between them must collapse to a single tfSec.
    const older = [candle(700), candle(940)];

    const result = prependOlderCandles(compressed, map, older, TF);

    expect(result.prependedCount).toBe(2);
    const firstExisting = compressed[0].time; // 1000
    const prepended = result.candles.slice(0, 2);
    // Newest older (940) at firstExisting - tfSec.
    expect(prepended[1].time).toBe(firstExisting - TF); // 940
    // The big internal gap collapses to a single tfSec step, NOT 240.
    expect(prepended[0].time).toBe(firstExisting - TF * 2); // 880, not 700-ish
    expect(prepended[1].time - prepended[0].time).toBe(TF);

    // Map still records the true real times.
    expect(result.realTimeMap.get(prepended[1].time)).toBe(940);
    expect(result.realTimeMap.get(prepended[0].time)).toBe(700);
  });

  it('3. dedupes older candles overlapping existing real times and each other', () => {
    const { compressed, map } = buildExisting([1000, 1060]);
    const older = [
      candle(940),
      candle(940), // intra-chunk duplicate
      candle(1000), // overlaps existing real time -> dropped
      candle(1060), // overlaps existing real time -> dropped
      candle(880),
    ];

    const result = prependOlderCandles(compressed, map, older, TF);

    // Only 880 and 940 survive.
    expect(result.prependedCount).toBe(2);
    const firstExisting = compressed[0].time; // 1000
    const prepended = result.candles.slice(0, 2);
    expect(result.realTimeMap.get(prepended[1].time)).toBe(940);
    expect(result.realTimeMap.get(prepended[0].time)).toBe(880);
    expect(prepended[1].time).toBe(firstExisting - TF);
    expect(prepended[0].time).toBe(firstExisting - TF * 2);

    // Total candle count = 2 existing + 2 new.
    expect(result.candles.length).toBe(4);
  });

  it('4. empty older input is a no-op', () => {
    const { compressed, map } = buildExisting([1000, 1060, 1120]);
    const result = prependOlderCandles(compressed, map, [], TF);

    expect(result.prependedCount).toBe(0);
    expect(result.candles).toBe(compressed); // same reference contents
    expect(result.candles).toEqual(compressed);
    // Map is a copy but equal.
    expect(result.realTimeMap).not.toBe(map);
    expect([...result.realTimeMap.entries()]).toEqual([...map.entries()]);
  });

  it('4b. all older candles too new (>= anchor) is also a no-op', () => {
    const { compressed, map } = buildExisting([1000, 1060]);
    const older = [candle(1000), candle(1120), candle(2000)];
    const result = prependOlderCandles(compressed, map, older, TF);
    expect(result.prependedCount).toBe(0);
    expect(result.candles).toBe(compressed);
  });

  it('5. existing bars compressed times and map entries are unchanged', () => {
    // Existing series WITH an internal collapsed gap to be thorough.
    const { compressed, map } = buildExisting([1000, 1060, 5000, 5060]);
    const snapshot = compressed.map((c) => ({ ...c }));
    const mapSnapshot = [...map.entries()];

    const older = [candle(820), candle(880), candle(940)];
    const result = prependOlderCandles(compressed, map, older, TF);

    // Each existing bar appears unchanged, in order, at the tail.
    const tail = result.candles.slice(result.prependedCount);
    expect(tail.length).toBe(snapshot.length);
    for (let i = 0; i < snapshot.length; i++) {
      expect(tail[i].time).toBe(snapshot[i].time);
      expect(tail[i].open).toBe(snapshot[i].open);
      expect(tail[i].close).toBe(snapshot[i].close);
    }

    // Original existing inputs were not mutated.
    for (let i = 0; i < snapshot.length; i++) {
      expect(compressed[i].time).toBe(snapshot[i].time);
    }
    // All existing map entries still present and correct in the result map.
    for (const [k, v] of mapSnapshot) {
      expect(result.realTimeMap.get(k)).toBe(v);
    }
  });

  it('handles empty existing series by compressing the chunk from its own first real time', () => {
    const empty: ChartCandle[] = [];
    const older = [candle(700), candle(760), candle(940)]; // gap 760->940 collapses
    const result = prependOlderCandles(empty, new Map(), older, TF);

    expect(result.prependedCount).toBe(3);
    // Newest (940) anchored at its own real time.
    const c = result.candles;
    expect(c[2].time).toBe(940);
    expect(c[1].time).toBe(940 - TF); // collapsed step
    expect(c[0].time).toBe(940 - TF * 2);
    expect(result.realTimeMap.get(c[2].time)).toBe(940);
    expect(result.realTimeMap.get(c[0].time)).toBe(700);
  });
});
