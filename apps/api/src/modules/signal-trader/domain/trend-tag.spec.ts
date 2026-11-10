import { classifyTrend, mergeTrendBars, TREND_MIN_BARS, type TrendBar } from './trend-tag';

const NOW = new Date('2026-11-10T09:00:00Z');
const Q = 15 * 60_000;
const T0 = NOW.getTime() - 400 * Q;

/** Bars from a close path (oldest first), 15 minutes apart. */
const barsOf = (closes: number[]): TrendBar[] =>
  closes.map((c, i) => ({ ts: T0 + i * Q, open: c - 0.1, high: c + 0.3, low: c - 0.4, close: c }));
const up = (n: number) => Array.from({ length: n }, (_, i) => 100 + 0.01 * i * i);
const down = (n: number) => Array.from({ length: n }, (_, i) => 1000 - 0.01 * i * i);
const classify = (kind: 'CE' | 'PE' | 'FUT' | 'EQ', side: 'BUY' | 'SELL', closes: number[]) =>
  classifyTrend({ kind, side, bars: barsOf(closes), now: NOW, source: 'test' });

describe('classifyTrend — WITH / AGAINST the 15m EMA20/80 + MACD trend (record only)', () => {
  it('uptrend: a bullish call (BUY CE, SELL PE, BUY FUT, BUY EQ) is WITH, a bearish one AGAINST', () => {
    for (const [k, s] of [['CE', 'BUY'], ['PE', 'SELL'], ['FUT', 'BUY'], ['EQ', 'BUY']] as const) {
      const r = classify(k, s, up(200));
      expect(r).toMatchObject({ tag: 'WITH', direction: 'BULL', trend: 'UP' });
    }
    for (const [k, s] of [['PE', 'BUY'], ['CE', 'SELL'], ['FUT', 'SELL']] as const) {
      expect(classify(k, s, up(200))).toMatchObject({ tag: 'AGAINST', direction: 'BEAR', trend: 'UP' });
    }
  });

  it('downtrend: BUY PE is WITH, BUY CE AGAINST', () => {
    expect(classify('PE', 'BUY', down(200))).toMatchObject({ tag: 'WITH', trend: 'DOWN' });
    expect(classify('CE', 'BUY', down(200))).toMatchObject({ tag: 'AGAINST', trend: 'DOWN' });
  });

  it('EMA20 still above EMA80 but the MACD histogram turned red ⇒ MIXED', () => {
    const closes = up(200);
    const last = closes[closes.length - 1];
    for (let i = 1; i <= 6; i++) closes.push(last - 4 * i);
    const r = classify('CE', 'BUY', closes);
    expect(r.ema20! > r.ema80!).toBe(true);
    expect(r.macdHist!).toBeLessThan(0);
    expect(r).toMatchObject({ tag: 'MIXED', trend: 'MIXED' });
    expect(classify('PE', 'BUY', closes).tag).toBe('MIXED');
  });

  it('carries the raw numbers, timeframe, candle count and computedAt', () => {
    const r = classify('CE', 'BUY', up(200));
    expect(r).toMatchObject({ timeframe: '15m', price: 'heikin-ashi close', candleCount: 200, computedAt: NOW.toISOString(), source: 'test' });
    expect(typeof r.ema20).toBe('number');
    expect(typeof r.ema80).toBe('number');
    expect(typeof r.macdHist).toBe('number');
    expect(r.lastBarAt).toBe(new Date(T0 + 199 * Q).toISOString());
    expect(r.reason).toBeUndefined();
  });

  it(`fewer than ${TREND_MIN_BARS} bars ⇒ UNKNOWN with the reason, no numbers`, () => {
    const r = classify('CE', 'BUY', up(TREND_MIN_BARS - 1));
    expect(r).toMatchObject({ tag: 'UNKNOWN', trend: null, ema20: null, ema80: null, macdHist: null, candleCount: TREND_MIN_BARS - 1 });
    expect(r.reason).toContain(`need ${TREND_MIN_BARS}`);
    expect(classify('CE', 'BUY', [])).toMatchObject({ tag: 'UNKNOWN', candleCount: 0, lastBarAt: null });
  });
});

describe('mergeTrendBars', () => {
  it('the hub bucket wins over the stored one, sorted, and only closed bars are kept', () => {
    const t = NOW.getTime();
    const older: TrendBar[] = [
      { ts: t - 3 * Q, open: 1, high: 2, low: 1, close: 1 },
      { ts: t - 2 * Q, open: 1, high: 2, low: 1, close: 1 },
    ];
    const hub: TrendBar[] = [
      { ts: t - Q, open: 3, high: 4, low: 3, close: 3 }, // closed exactly now
      { ts: t - 2 * Q, open: 2, high: 3, low: 2, close: 2 },
      { ts: t - 5 * 60_000, open: 9, high: 9, low: 9, close: 9 }, // still forming
      { ts: t - 4 * Q, open: 0, high: 0, low: 0, close: 0 }, // bad row
    ];
    const m = mergeTrendBars(older, hub, NOW);
    expect(m.map((b) => [b.ts, b.close])).toEqual([[t - 3 * Q, 1], [t - 2 * Q, 2], [t - Q, 3]]);
  });
});
