import { MIN_NOISE_BARS, noiseFromBars, scaledUnderlyingNoise, sessionBarsOnly } from './noise';
import type { MinuteBar } from './types';

const T0 = Date.parse('2026-10-14T10:09:00Z');
/** n bars, each high-low = w, closes continuous (no gaps). */
const flatBars = (n: number, w = 4, base = 100): MinuteBar[] =>
  Array.from({ length: n }, (_, i) => ({ ts: T0 + i * 60_000, open: base, high: base + w / 2, low: base - w / 2, close: base }));

describe('noiseFromBars (R2)', () => {
  it('>= 14 bars: mean of the last 14 true ranges', () => {
    expect(noiseFromBars(flatBars(20))).toEqual({ n: 4, method: 'atr14-1m', bars: 20, at: new Date(T0 + 20 * 60_000).toISOString() });
  });
  it('true range includes the gap from the previous close', () => {
    const bars = flatBars(14);
    bars[13] = { ts: bars[13].ts, open: 105, high: 106, low: 104, close: 105 }; // prev close 100 ⇒ TR = 6
    expect(noiseFromBars(bars)!.n).toBeCloseTo((13 * 4 + 6) / 14, 9);
  });
  it('5–13 bars: (max high − min low)/√bars', () => {
    const bars = [100, 102, 104, 106, 110].map((c, i) => ({ ts: T0 + i * 60_000, open: c, high: c, low: c, close: c }));
    expect(noiseFromBars(bars)).toMatchObject({ method: 'range-sqrt-1m', bars: 5 });
    expect(noiseFromBars(bars)!.n).toBeCloseTo(10 / Math.sqrt(5), 9);
  });
  it('fewer than MIN_NOISE_BARS (5) valid bars ⇒ null: a 1–4 bar range is not a noise unit (it would arm a floor ticks below the peak)', () => {
    expect(MIN_NOISE_BARS).toBe(5);
    const tiny = (n: number) => Array.from({ length: n }, (_, i) => ({ ts: T0 + i * 60_000, open: 101, high: 101.05, low: 100.95, close: 101 }));
    for (const n of [1, 2, 3, 4]) expect(noiseFromBars(tiny(n))).toBeNull();
    expect(noiseFromBars(tiny(5))).toMatchObject({ method: 'range-sqrt-1m', bars: 5 });
    // Invalid bars do not count toward the minimum.
    expect(noiseFromBars([...tiny(4), { ts: T0 + 9 * 60_000, open: NaN, high: 1, low: 0.5, close: 1 }])).toBeNull();
  });
  it('no bars, invalid bars, or zero range ⇒ null', () => {
    expect(noiseFromBars([])).toBeNull();
    expect(noiseFromBars([{ ts: T0, open: NaN, high: 1, low: 0.5, close: 1 }])).toBeNull();
    expect(noiseFromBars([{ ts: T0, open: 1, high: 0.5, low: 1, close: 1 }])).toBeNull(); // high < low
    expect(noiseFromBars(flatBars(20, 0))).toBeNull();
  });
  it('sorts by ts (input order does not matter)', () => {
    expect(noiseFromBars(flatBars(20).reverse())!.n).toBe(4);
  });
});

describe('scaledUnderlyingNoise (R3)', () => {
  it('daily ATR14 / √(session minutes); default 375; bad minutes fall back to 375', () => {
    expect(scaledUnderlyingNoise(316, 'x', 870)).toEqual({ n: 316 / Math.sqrt(870), method: 'atr14-daily-scaled', bars: 0, at: 'x' });
    expect(scaledUnderlyingNoise(300, 'x')!.n).toBeCloseTo(300 / Math.sqrt(375), 9);
    expect(scaledUnderlyingNoise(300, 'x', 0)!.n).toBeCloseTo(300 / Math.sqrt(375), 9);
    expect(scaledUnderlyingNoise(0, 'x', 870)).toBeNull();
  });
  it.each([null, undefined, 0, -1, NaN])('%s ⇒ null', (v) => expect(scaledUnderlyingNoise(v as never, 'x')).toBeNull());
});

describe('sessionBarsOnly (2026-11-05: NSE pre-open bars 09:00–09:14 tripled the morning noise unit)', () => {
  const ist = (hhmm: string) => Date.parse(`2026-11-05T${hhmm}:00+05:30`);
  const bar = (hhmm: string, low = 24000, high = 24010) => ({ ts: ist(hhmm), open: low, high, low, close: high });
  const bars = [bar('09:00', 23608, 24580), bar('09:14'), bar('09:15'), bar('15:29'), bar('15:30')];
  it('NSE / NFO keep 09:15–15:29 only', () => {
    expect(sessionBarsOnly(bars, 'NSE').map((b) => b.ts)).toEqual([ist('09:15'), ist('15:29')]);
    expect(sessionBarsOnly(bars, 'NFO')).toHaveLength(2);
  });
  it('MCX keeps its 09:00 open; an unknown exchange keeps everything', () => {
    expect(sessionBarsOnly(bars, 'MCX')).toHaveLength(5);
    expect(sessionBarsOnly(bars, null)).toHaveLength(5);
  });
  it('the pre-open bar no longer inflates N', () => {
    // 09:23 IST: 8 session bars, under ATR14, so the range path — where the 09:00 bar did the damage.
    const morning = [bar('09:00', 23608, 24580), ...Array.from({ length: 8 }, (_, i) => bar(`09:${String(15 + i).padStart(2, '0')}`))];
    const all = noiseFromBars(morning)!.n;
    const session = noiseFromBars(sessionBarsOnly(morning, 'NSE'))!.n;
    expect(session).toBeLessThan(all / 5);
  });
});
