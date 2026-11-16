import {
  aggregateBars,
  multiTimeframeView,
  sanitizeBars,
  sessionBars,
  swingStructure,
  timeframeRead,
  type Bar,
  type TimeframeRead,
} from './multi-timeframe';

/** Epoch ms of an IST wall-clock time. */
const ist = (y: number, mo: number, d: number, h: number, mi: number) => Date.UTC(y, mo - 1, d, h, mi) - 330 * 60_000;
const bar = (ts: number, o: number, h: number, l: number, c: number): Bar => ({ ts, open: o, high: h, low: l, close: c });
/** Bars from a close series: open = previous close, high/low = ±spread around the body. */
const fromCloses = (closes: number[], spread = 0.1, start = 0, step = 60_000): Bar[] =>
  closes.map((c, i) => {
    const o = i ? closes[i - 1] : c;
    return bar(start + i * step, o, Math.max(o, c) + spread, Math.min(o, c) - spread, c);
  });
const series = (n: number, f: (i: number) => number) => Array.from({ length: n }, (_, i) => f(i));
const read = (r: ReturnType<typeof timeframeRead>) => {
  if (!r.available) throw new Error(`unavailable: ${r.reason}`);
  return r as TimeframeRead;
};

/** Intraday bars of `minutes` width across `sessions` NSE sessions (09:15–15:30 IST), closes from `f(globalIndex)`. */
function sessionSeries(sessions: number, minutes: number, f: (i: number) => number, exchange: 'NSE' | 'MCX' = 'NSE'): Bar[] {
  const out: Bar[] = [];
  const [open, close] = exchange === 'MCX' ? [9 * 60, 23 * 60 + 30] : [9 * 60 + 15, 15 * 60 + 30];
  let i = 0;
  let prev = f(0);
  for (let s = 0; s < sessions; s++) {
    const day = ist(2026, 1, 1, 0, 0) + s * 86_400_000;
    for (let m = open; m < close; m += minutes) {
      const c = f(i++);
      out.push(bar(day + m * 60_000, prev, Math.max(prev, c) + 0.05, Math.min(prev, c) - 0.05, c));
      prev = c;
    }
  }
  return out;
}

describe('bar hygiene + aggregation', () => {
  it('drops NaN / non-positive / high<low bars and sorts', () => {
    const t = ist(2026, 11, 16, 9, 15);
    const out = sanitizeBars([
      bar(t + 60_000, 10, 11, 9, 10.5),
      bar(t, 10, 11, 9, 10),
      bar(t + 120_000, NaN, 11, 9, 10),
      bar(t + 180_000, 10, 9, 11, 10),
      bar(t + 240_000, 0, 11, 9, 10),
    ]);
    expect(out.map((b) => b.ts)).toEqual([t, t + 60_000]);
  });

  it('builds 3m from 1m anchored at 09:15 and drops pre-open prints', () => {
    const d = (h: number, m: number) => ist(2026, 11, 16, h, m);
    const bars = [
      bar(d(8, 45), 50, 50, 50, 50),
      bar(d(9, 0), 60, 60, 60, 60),
      bar(d(9, 15), 10, 11, 9.5, 10.5),
      bar(d(9, 16), 10.5, 12, 10, 11),
      bar(d(9, 17), 11, 11.5, 8, 9),
      bar(d(9, 18), 9, 9.5, 8.5, 9.2),
      bar(d(9, 19), 9.2, 10, 9, 9.8),
      bar(d(15, 30), 70, 70, 70, 70),
    ];
    const out = aggregateBars(bars, 3, 'NSE');
    expect(out).toEqual([
      { ts: d(9, 15), open: 10, high: 12, low: 8, close: 9 },
      { ts: d(9, 18), open: 9, high: 10, low: 8.5, close: 9.8 },
    ]);
    expect(sessionBars(bars, 'NFO')).toHaveLength(5);
  });

  it('builds 30m and 1h from 15m session-anchored, last bucket partial', () => {
    const fifteen = sessionSeries(1, 15, (i) => 100 + i);
    expect(fifteen).toHaveLength(25);
    const m30 = aggregateBars(fifteen, 30);
    const h1 = aggregateBars(fifteen, 60);
    expect(m30).toHaveLength(13);
    expect(h1).toHaveLength(7);
    expect(h1[0].ts).toBe(ist(2026, 1, 1, 9, 15));
    expect(h1[1].ts).toBe(ist(2026, 1, 1, 10, 15));
    expect(h1[6].ts).toBe(ist(2026, 1, 1, 15, 15));
    expect(h1[0].open).toBe(fifteen[0].open);
    expect(h1[0].close).toBe(fifteen[3].close);
    expect(h1[0].high).toBe(Math.max(...fifteen.slice(0, 4).map((b) => b.high)));
    expect(h1[6].close).toBe(fifteen[24].close);
  });

  it('anchors MCX at 09:00 and keeps evening bars to 23:30', () => {
    const d = (h: number, m: number) => ist(2026, 11, 16, h, m);
    const out = aggregateBars(
      [bar(d(8, 59), 1, 1, 1, 1), bar(d(9, 0), 5, 6, 4, 5), bar(d(9, 59), 5, 7, 5, 6), bar(d(23, 15), 8, 8, 8, 8), bar(d(23, 30), 9, 9, 9, 9)],
      60,
      'MCX',
    );
    expect(out.map((b) => b.ts)).toEqual([d(9, 0), d(23, 0)]);
    expect(out[0]).toMatchObject({ open: 5, high: 7, close: 6 });
  });
});

describe('timeframeRead', () => {
  it('is unavailable under 100 bars', () => {
    const r = timeframeRead(fromCloses(series(50, (i) => 100 + i)), '15m');
    expect(r).toEqual({ available: false, tf: '15m', reason: 'only 50 bars (need 100)' });
  });

  it('accelerating rise: UP, MACD positive and rising, above both = BULLISH_CONFIRMED', () => {
    const r = read(timeframeRead(fromCloses(series(200, (i) => 100 * 1.002 ** i)), '1h'));
    expect(r.trend).toBe('UP');
    expect(r.macdHist).toBeGreaterThan(0);
    expect(r.histSlope).not.toBe('FALLING');
    expect(r.macdAgrees).toBe(true);
    expect(r.location).toBe('ABOVE_BOTH');
    expect(r.testing).toBeNull();
    expect(r.verdict).toBe('BULLISH_CONFIRMED');
    expect(r.close).toBe(Number((100 * 1.002 ** 199).toFixed(2)));
  });

  it('accelerating fall: BEARISH_CONFIRMED, prices under 100 keep 4 dp', () => {
    const r = read(timeframeRead(fromCloses(series(200, (i) => 50 * (2 - 1.002 ** i)), 0.01), '1d'));
    expect(r.trend).toBe('DOWN');
    expect(r.histSlope).not.toBe('RISING');
    expect(r.macdAgrees).toBe(true);
    expect(r.location).toBe('BELOW_BOTH');
    expect(r.verdict).toBe('BEARISH_CONFIRMED');
    expect(r.close).toBe(Number((50 * (2 - 1.002 ** 199)).toFixed(4)));
  });

  it('uptrend rolling over: EMAs still up but MACD disagrees', () => {
    const closes = series(150, (i) => 100 + i * 0.5).concat(series(12, (i) => 175 - (i + 1) * 1.5));
    const r = read(timeframeRead(fromCloses(closes), '30m'));
    expect(r.trend).toBe('UP');
    expect(r.macdHist).toBeLessThan(0);
    expect(r.histSlope).toBe('FALLING');
    expect(r.macdAgrees).toBe(false);
    expect(r.verdict).toBe('MIXED');
  });

  it('flags testing EMA20 when the close sits on it', () => {
    const closes = series(150, (i) => 100 + i * 0.3);
    const first = read(timeframeRead(fromCloses(closes, 1), '15m'));
    const r = read(timeframeRead(fromCloses([...closes, first.ema20], 1), '15m'));
    expect(r.testing).toBe('EMA20');
    expect(r.location).toBe('BETWEEN');
  });
});

describe('swing structure', () => {
  const zig = (drift: number) => fromCloses(series(120, (i) => 100 + drift * i + 5 * Math.sin((2 * Math.PI * i) / 10)), 0.1);

  it('higher highs + higher lows = UPTREND', () => {
    const s = swingStructure(zig(0.2));
    expect(s.kind).toBe('UPTREND');
    expect(s.lastSwingHigh).not.toBeNull();
    expect(s.lastSwingLow).not.toBeNull();
    expect(s.lastSwingHigh!).toBeGreaterThan(s.lastSwingLow!);
  });

  it('lower highs + lower lows = DOWNTREND', () => {
    expect(swingStructure(zig(-0.2)).kind).toBe('DOWNTREND');
  });

  it('flat oscillation = RANGE', () => {
    expect(swingStructure(zig(0)).kind).toBe('RANGE');
  });

  it('is attached on structure timeframes only', () => {
    const up = sessionSeries(5, 1, (i) => 100 * 1.0002 ** i);
    const v = multiTimeframeView({ exchange: 'NSE', '1m': up });
    const r3 = read(v.timeframes['3m']);
    expect(r3.structure).toBeUndefined();
  });
});

describe('multiTimeframeView', () => {
  const up1m = sessionSeries(5, 1, (i) => 100 * 1.0002 ** i);
  // Ends at the 15:00 bar so the newest 30m / 1h buckets are complete (a partial 15:15 bucket moves less).
  const up15 = sessionSeries(40, 15, (i) => 100 * 1.001 ** i).slice(0, -1);
  const updaily = fromCloses(series(250, (i) => 100 * 1.003 ** i), 0.1, 0, 86_400_000);
  const downdaily = fromCloses(series(250, (i) => 100 * (2 - 1.002 ** i)), 0.1, 0, 86_400_000);

  it('all up: every timeframe bullish-confirmed and aligned', () => {
    const v = multiTimeframeView({ exchange: 'NSE', '1m': up1m, '15m': up15, '1d': updaily });
    for (const tf of ['3m', '15m', '30m', '1h', '1d'] as const) expect(read(v.timeframes[tf]).verdict).toBe('BULLISH_CONFIRMED');
    expect(read(v.timeframes['1h']).structure?.kind).toBeDefined();
    expect(v.alignment).toMatchObject({ bullish: 5, bearish: 0, mixed: 0, unavailable: 0, higherTimeframeBias: 'BULLISH_CONFIRMED', disagreeWithDaily: [] });
    expect(v.alignment.summary).toMatch(/timeframes aligned bullish$/);
  });

  it('daily down vs intraday up: reports both and names the disagreement', () => {
    const v = multiTimeframeView({ exchange: 'NSE', '1m': up1m, '15m': up15, '1d': downdaily });
    expect(v.alignment.bullish).toBe(4);
    expect(v.alignment.bearish).toBe(1);
    expect(v.alignment.higherTimeframeBias).toBe('BEARISH_CONFIRMED');
    expect(v.alignment.disagreeWithDaily).toEqual(['1h', '30m', '15m', '3m']);
    expect(v.alignment.summary).toMatch(/^1d down, 1h up, 30m up, 15m up, 3m up — timeframes disagree$/);
  });

  it('missing inputs are unavailable with a reason, not errors', () => {
    const v = multiTimeframeView({ exchange: 'NSE', '1d': downdaily });
    expect(v.timeframes['3m']).toEqual({ available: false, tf: '3m', reason: 'no 1m bars' });
    expect(v.timeframes['1h']).toEqual({ available: false, tf: '1h', reason: 'no 15m bars' });
    expect(v.alignment.unavailable).toBe(4);
    expect(v.alignment.summary).toContain('3m n/a');
    expect(v.alignment.summary).toMatch(/timeframes aligned bearish$/);
  });

  it('too few 15m sessions leaves 1h unavailable while 15m reads', () => {
    const v = multiTimeframeView({ exchange: 'NSE', '15m': sessionSeries(8, 15, (i) => 100 + i * 0.1) });
    expect(v.timeframes['15m'].available).toBe(true);
    expect(v.timeframes['1h']).toMatchObject({ available: false, reason: 'only 56 bars (need 100)' });
  });
});
