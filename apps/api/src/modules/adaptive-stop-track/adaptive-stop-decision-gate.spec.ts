import {
  evaluateDecisionGate, detectSwingPivots, roundGrid, rsi, macdHistogram, type GateCandle,
} from './adaptive-stop-decision-gate';

// Existing support/extension tests run with the 15m-MACD rule OFF so they
// isolate those rules; dedicated tests below cover requireMacdBullish.
const PARAMS = { nearSupportPct: 0.6, rsiHot: 70, vwapExtPct: 1.5, requireMacdBullish: false };

// Build a same-IST-day 15m series from {h,l,c} rows starting 09:15 IST
// (03:45Z). `nowMs` is set just after the last candle closes so every bar
// counts as "closed before now".
function series(rows: { h: number; l: number; c: number }[]) {
  const base = new Date('2026-06-15T03:45:00.000Z').getTime();
  const candles: GateCandle[] = rows.map((r, i) => ({
    timestamp: new Date(base + i * 15 * 60_000),
    high: r.h, low: r.l, close: r.c, volume: 1000,
  }));
  const nowMs = base + rows.length * 15 * 60_000 + 60_000;
  return { candles, nowMs };
}

// A V-shaped session: a clean 3-bar swing low at index 6 (low 96), VWAP ≈ 99.
const V_ROWS = [
  { h: 100, l: 99, c: 99.5 }, { h: 100, l: 99, c: 99.5 }, { h: 99, l: 98, c: 98.5 },
  { h: 99, l: 98, c: 98.5 }, { h: 98, l: 97, c: 97.5 }, { h: 98, l: 97, c: 97.5 },
  { h: 97, l: 96, c: 96.5 }, // <- swing low @96
  { h: 98, l: 97, c: 97.5 }, { h: 99, l: 98, c: 98.5 }, { h: 99, l: 98, c: 98.5 },
  { h: 100, l: 99, c: 99.5 }, { h: 100, l: 99, c: 99.5 }, { h: 101, l: 100, c: 100.5 },
  { h: 101, l: 100, c: 100.5 }, { h: 102, l: 101, c: 101.5 }, { h: 102, l: 101, c: 101.5 },
];

describe('decision-gate primitives', () => {
  it('detectSwingPivots finds the 3-bar fractal swing low', () => {
    const { candles } = series(V_ROWS);
    const piv = detectSwingPivots(candles);
    expect(piv.some((p) => p.kind === 'low' && p.price === 96)).toBe(true);
  });
  it('roundGrid is price-adaptive around the spot', () => {
    expect(roundGrid(96.3)).toEqual(expect.arrayContaining([95, 100]));
  });
  it('rsi returns null below period+1 and ~100 on a monotonic rise', () => {
    expect(rsi([1, 2, 3])).toBeNull();
    expect(rsi(Array.from({ length: 20 }, (_, i) => 100 + i))).toBeCloseTo(100, 0);
  });
  it('macdHistogram: null below 26 bars, >0 on a rising series, <0 on a falling series', () => {
    expect(macdHistogram([1, 2, 3])).toBeNull();
    expect(macdHistogram(Array.from({ length: 40 }, (_, i) => 100 + i))!).toBeGreaterThan(0);
    expect(macdHistogram(Array.from({ length: 40 }, (_, i) => 200 - i))!).toBeLessThan(0);
  });
});

describe('evaluateDecisionGate — 15m MACD trend rule', () => {
  // 40 rising 15m bars (today) → MACD bullish, with a swing low near the entry.
  function risingWithDip(dipAt: number) {
    const base = new Date('2026-06-15T03:45:00.000Z').getTime();
    const rows = Array.from({ length: 40 }, (_, i) => {
      const c = 100 + i * 0.5; // steady uptrend → bullish MACD
      const dip = i === dipAt ? 1.2 : 0; // a 3-bar fractal low
      return { timestamp: new Date(base + i * 15 * 60_000), high: c + 0.3, low: c - 0.3 - dip, close: c, volume: 1000 };
    });
    return { candles: rows as GateCandle[], nowMs: base + 40 * 15 * 60_000 + 60_000 };
  }

  it('with requireMacdBullish=false the MACD does not gate', () => {
    const { candles, nowMs } = risingWithDip(36);
    const entry = candles[37].low + 0.1; // just above the recent swing low
    const r = evaluateDecisionGate(entry, candles, nowMs, { ...PARAMS, requireMacdBullish: false });
    expect(r.macdBullish).toBe(true); // rising series
    // pass/fail here is driven by support/extension, not MACD
    expect(r.skipped).toBe(false);
  });

  it('a 15m-bearish entry is REJECTED when requireMacdBullish=true', () => {
    // Falling 15m series → MACD bearish.
    const base = new Date('2026-06-15T03:45:00.000Z').getTime();
    const rows = Array.from({ length: 40 }, (_, i) => {
      const c = 200 - i * 0.5;
      return { timestamp: new Date(base + i * 15 * 60_000), high: c + 0.3, low: c - 0.3, close: c, volume: 1000 };
    }) as GateCandle[];
    const nowMs = base + 40 * 15 * 60_000 + 60_000;
    const entry = rows[39].close; // at the bottom
    const r = evaluateDecisionGate(entry, rows, nowMs, { ...PARAMS, requireMacdBullish: true });
    expect(r.macdBullish).toBe(false);
    expect(r.pass).toBe(false);
    expect(r.reason).toMatch(/15m MACD bearish/);
  });
});

describe('evaluateDecisionGate (CORE2)', () => {
  it('SKIPS (fails open) when there are too few candles', () => {
    const { candles, nowMs } = series(V_ROWS.slice(0, 4));
    const r = evaluateDecisionGate(98, candles, nowMs, PARAMS);
    expect(r.skipped).toBe(true);
    expect(r.pass).toBe(true);
  });

  it('PASSES when entry is at support and not extended', () => {
    const { candles, nowMs } = series(V_ROWS);
    const r = evaluateDecisionGate(96.3, candles, nowMs, PARAMS); // 0.3% above the 96 swing low
    expect(r.nearSupport).toBe(true);
    expect(r.notExtended).toBe(true); // below VWAP ⇒ not extended
    expect(r.pass).toBe(true);
  });

  it('REJECTS when entry is far above support (not at support)', () => {
    const { candles, nowMs } = series(V_ROWS);
    const r = evaluateDecisionGate(100, candles, nowMs, PARAMS); // ~4% above nearest support
    expect(r.nearSupport).toBe(false);
    expect(r.pass).toBe(false);
    expect(r.reason).toMatch(/not-at-support/);
  });

  it('REJECTS when entry is extended above VWAP (chasing the top)', () => {
    const { candles, nowMs } = series(V_ROWS);
    const r = evaluateDecisionGate(101.5, candles, nowMs, PARAMS); // top of range, >1.5% above VWAP
    expect(r.notExtended).toBe(false);
    expect(r.pass).toBe(false);
    expect(r.reason).toMatch(/extended/);
  });
});
