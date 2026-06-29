import { describe, it, expect } from 'vitest';
import { computeSessionVWAP, type VWAPCandle } from './computeVWAP';

/**
 * Helper: build a candle for a given IST date+time.
 * Times converted to Unix seconds (UTC).
 *
 * IST 09:15 on 2026-05-15 = UTC 03:45 on 2026-05-15.
 */
function candle(
  istDate: string,
  istHHMM: string,
  ohlc: [number, number, number, number],
  volume: number,
): VWAPCandle {
  const [hh, mm] = istHHMM.split(':').map(Number);
  // Build UTC date for IST (subtract 5:30).
  const [yyyy, MM, dd] = istDate.split('-').map(Number);
  const utcMs = Date.UTC(yyyy, MM - 1, dd, hh - 5, mm - 30);
  const correctedMs = utcMs < 0 ? utcMs + 24 * 60 * 60 * 1000 : utcMs;
  return {
    time: Math.floor(correctedMs / 1000),
    open: ohlc[0],
    high: ohlc[1],
    low: ohlc[2],
    close: ohlc[3],
    volume,
  } as VWAPCandle & { open: number };
}

describe('computeSessionVWAP', () => {
  it('returns null for first candle when volume is zero', () => {
    const c = candle('2026-05-15', '09:15', [100, 100, 100, 100], 0);
    expect(computeSessionVWAP([c])).toEqual([null]);
  });

  it('one candle, one volume → typical price', () => {
    // typical = (102+98+100)/3 = 100
    const c = candle('2026-05-15', '09:15', [100, 102, 98, 100], 1000);
    const [v] = computeSessionVWAP([c]);
    expect(v).toBeCloseTo(100, 6);
  });

  it('within a single session, VWAP weights candles by volume', () => {
    // Two candles, same day. Candle A typical=100 × volume 1000.
    // Candle B typical=110 × volume 1000. VWAP after B = (100*1000 + 110*1000)/2000 = 105.
    const a = candle('2026-05-15', '09:15', [100, 100, 100, 100], 1000);
    const b = candle('2026-05-15', '09:30', [110, 110, 110, 110], 1000);
    const result = computeSessionVWAP([a, b]);
    expect(result[0]).toBeCloseTo(100, 6);
    expect(result[1]).toBeCloseTo(105, 6);
  });

  it('resets accumulators when the IST date changes (the actual session-reset bug fix)', () => {
    // Day 1: typical=100, volume=1000. VWAP = 100.
    // Day 2: typical=200, volume=1000. VWAP MUST be 200, NOT 150 (which is
    // what the buggy cumulative version returned).
    const day1 = candle('2026-05-14', '09:15', [100, 100, 100, 100], 1000);
    const day2 = candle('2026-05-15', '09:15', [200, 200, 200, 200], 1000);
    const result = computeSessionVWAP([day1, day2]);
    expect(result[0]).toBeCloseTo(100, 6);
    expect(result[1]).toBeCloseTo(200, 6); // session reset → not 150
  });

  it('handles three sessions, accumulator resets each time', () => {
    const d1 = candle('2026-05-13', '14:00', [50, 50, 50, 50], 100);
    const d2a = candle('2026-05-14', '09:15', [100, 100, 100, 100], 500);
    const d2b = candle('2026-05-14', '10:00', [120, 120, 120, 120], 500);
    const d3 = candle('2026-05-15', '09:15', [200, 200, 200, 200], 1000);
    const result = computeSessionVWAP([d1, d2a, d2b, d3]);
    expect(result[0]).toBeCloseTo(50, 6);
    expect(result[1]).toBeCloseTo(100, 6);
    expect(result[2]).toBeCloseTo(110, 6); // (100*500 + 120*500)/1000 = 110
    expect(result[3]).toBeCloseTo(200, 6); // fresh session, single bar
  });

  it('zero-volume bars do not move VWAP but stay accumulated', () => {
    // First bar has volume — sets the anchor. Second has zero volume —
    // VWAP should stay at the first bar's typical price.
    const a = candle('2026-05-15', '09:15', [100, 100, 100, 100], 1000);
    const b = candle('2026-05-15', '09:16', [105, 105, 105, 105], 0);
    const result = computeSessionVWAP([a, b]);
    expect(result[0]).toBeCloseTo(100, 6);
    expect(result[1]).toBeCloseTo(100, 6);
  });
});
