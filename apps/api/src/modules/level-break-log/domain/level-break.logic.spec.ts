import { aggregateBars, atr14, breakOutcome, detectBreaks, oiAround, type Bar, type TfBar, type ZoneLike } from './level-break.logic';

// 2026-10-23 09:15 IST = 03:45Z
const OPEN = Date.parse('2026-10-23T03:45:00Z');
const M = 60_000;
const b1 = (minFromOpen: number, close: number, hi = close + 1, lo = close - 1): Bar => ({
  ts: OPEN + minFromOpen * M,
  open: close,
  high: hi,
  low: lo,
  close,
  volume: 10,
});
const tf = (end: number, close: number): TfBar => ({ ts: end - 15 * M, end, open: close, high: close + 1, low: close - 1, close, volume: 0 });

describe('aggregateBars', () => {
  it('buckets 1m bars into session-aligned 15m bars and drops buckets not yet ended', () => {
    const bars = Array.from({ length: 40 }, (_, i) => b1(i, 100 + i));
    const now = OPEN + 40 * M; // 09:55 IST: 09:15 and 09:30 buckets ended, 09:45 has not
    const out = aggregateBars(bars, 15, now);
    expect(out).toHaveLength(2);
    expect(out[0]).toMatchObject({ ts: OPEN, end: OPEN + 15 * M, open: 100, close: 114, high: 115, low: 99, volume: 150 });
    expect(out[1].close).toBe(129);
  });

  it('clips the last 60m bar of the session at 15:30 and ignores off-session bars', () => {
    const bars = [b1(-5, 1), b1(6 * 60, 200), b1(6 * 60 + 14, 210), b1(6 * 60 + 20, 999)]; // 15:15, 15:29, 15:35
    const out = aggregateBars(bars, 60, OPEN + 7 * 60 * M);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ ts: OPEN + 6 * 60 * M, end: OPEN + (6 * 60 + 15) * M, close: 210 });
  });
});

describe('atr14', () => {
  it('is the mean true range of the last 14 bars; null when too short', () => {
    const bars = Array.from({ length: 15 }, (_, i) => ({ ts: i, open: 100, high: 105, low: 95, close: 100, volume: 0 }));
    expect(atr14(bars)).toBe(10);
    expect(atr14(bars.slice(0, 14))).toBeNull();
  });
});

describe('detectBreaks (close ≥ 0.3 ATR beyond the far edge, first break only)', () => {
  const res: ZoneLike = { type: 'resistance', upper: 22622, lower: 22570, classification: 'STRONG', touchCount: 4 };
  const sup: ZoneLike = { type: 'support', upper: 22500, lower: 22480, classification: 'MEDIUM', touchCount: 3 };
  const atr = 40;
  const end = OPEN + 30 * M;

  it('UP break of a resistance', () => {
    const out = detectBreaks([res, sup], tf(end - 15 * M, 22600), tf(end, 22640), atr);
    expect(out).toEqual([{ direction: 'UP', level: 22622, zone: res, ts: end, price: 22640, atr }]);
  });
  it('not a break when the close is inside 0.3 ATR of the edge, or the previous bar was already beyond', () => {
    expect(detectBreaks([res], tf(end - 15 * M, 22600), tf(end, 22630), atr)).toEqual([]);
    expect(detectBreaks([res], tf(end - 15 * M, 22630), tf(end, 22660), atr)).toEqual([]);
  });
  it('DOWN break of a support', () => {
    const out = detectBreaks([res, sup], tf(end - 15 * M, 22490), tf(end, 22460), atr);
    expect(out.map((b) => [b.direction, b.level])).toEqual([['DOWN', 22480]]);
  });
});

describe('oiAround', () => {
  const t = OPEN + 30 * M;
  it('OI of the 5-min bar ending at the break and of the one ending 15 min earlier', () => {
    const pts = [0, 5, 10, 15, 20, 25].map((m, i) => ({ ts: OPEN + m * M, oi: 1000 + i * 10 }));
    expect(oiAround(pts, t)).toEqual({ now: 1050, before15m: 1020, nowAt: OPEN + 25 * M });
  });
  it('null when the series does not reach the break yet (stale > 15 min)', () => {
    expect(oiAround([{ ts: OPEN - 60 * M, oi: 5 }], t)).toEqual({ now: null, before15m: null, nowAt: null });
  });
});

describe('breakOutcome', () => {
  const t = OPEN + 30 * M; // 09:45 IST break-bar end, break close 100
  const day = Array.from({ length: 375 }, (_, i) => b1(i, 100 + (i >= 30 ? (i - 29) * 0.1 : 0)));

  it('fills +15m / +60m / EOD moves signed in the break direction once the session is complete', () => {
    const o = breakOutcome({ ts: t, price: 100, direction: 'UP' }, day);
    expect(o.complete).toBe(true);
    expect(o.priceAt15m).toBeCloseTo(101.5, 5); // bar 44 close
    expect(o.move15mPts).toBeCloseTo(1.5, 5);
    expect(o.move60mPts).toBeCloseTo(6, 5);
    expect(o.moveEodPts).toBeCloseTo(34.5, 5);
    expect(o.mfeEodPts).toBeGreaterThan(o.moveEodPts!);
  });

  it('a DOWN break that rallies is a negative move', () => {
    const o = breakOutcome({ ts: t, price: 100, direction: 'DOWN' }, day);
    expect(o.move60mPts).toBeCloseTo(-6, 5);
    expect(o.maeEodPts).toBeLessThan(0);
  });

  it('partial day: +15m known, EOD pending', () => {
    const o = breakOutcome({ ts: t, price: 100, direction: 'UP' }, day.slice(0, 50));
    expect(o.complete).toBe(false);
    expect(o.priceAt15m).not.toBeNull();
    expect(o.priceAt60m).toBeNull();
    expect(o.priceEod).toBeNull();
  });
});
