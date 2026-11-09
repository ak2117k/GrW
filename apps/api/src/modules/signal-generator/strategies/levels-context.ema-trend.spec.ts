import { buildIndicatorReadings } from './levels-context.strategy';

const bars = (closes: number[]) => closes.map((close) => ({ close, open: close, high: close, low: close, volume: 1 })) as never[];
const up = Array.from({ length: 160 }, (_, i) => 100 + i + 0.02 * i * i + (i % 3 === 0 ? -0.6 : 0));
const down = up.map((x) => 1000 - x);
const pullback = [...up, ...Array.from({ length: 10 }, (_, i) => up[up.length - 1] - 2 * (i + 1))];
const read = (c: number[]) => buildIndicatorReadings(bars(c) as never, c[c.length - 1], true);

describe('Indicators card trend: EMA20/80 with MACD (owner 2026-11-09)', () => {
  it('green: EMA20 above EMA80 and MACD green', () => {
    const r = read(up);
    expect(r.ema20 as number).toBeGreaterThan(r.ema80 as number);
    expect(r.trend).toBe(1);
  });
  it('red: EMA20 below EMA80 and MACD red', () => {
    expect(read(down).trend).toBe(-1);
  });
  it('EMAs up but MACD red is mixed', () => {
    const r = read(pullback);
    expect(r.ema20 as number).toBeGreaterThan(r.ema80 as number);
    expect(r.macdHistogram as number).toBeLessThan(0);
    expect(r.trend).toBe(0);
  });
  it('fewer than 80 bars has no trend', () => {
    expect(read(up.slice(0, 79))).toMatchObject({ ema80: null, trend: null });
  });
  it('the setup scoring still uses its own averages', () => {
    const r = read(up);
    expect(r.ema9 as number).toBeGreaterThan(r.ema21 as number);
    expect(r.alignment.ema).toBe(1);
  });
});

describe('Indicators card reads Heikin Ashi, like the owner charts', () => {
  it('EMA20/80 and the MACD use (O+H+L+C)/4, and the setup scoring keeps normal closes', () => {
    const candles = up.map((close) => ({ close, open: close - 8, high: close + 1, low: close - 9, volume: 1 }));
    const r = buildIndicatorReadings(candles as never, up[up.length - 1], true);
    const flat = buildIndicatorReadings(up.map((c) => ({ close: c - 4, open: c - 4, high: c - 4, low: c - 4, volume: 1 })) as never, up[up.length - 1], true);
    expect(r.ema20).toBeCloseTo(flat.ema20 as number, 6);
    expect(r.trendMacdHistogram).toBeCloseTo(flat.macdHistogram as number, 6);
    expect(r.ema9).toBeCloseTo(read(up).ema9 as number, 6);
  });
});
