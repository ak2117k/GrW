import { rollTo15m } from '../../entry-engine/domain/entry-gates';
import * as fx from '../../market-hub/testing/banknifty-2026-11-23-preopen';
import { classifyTrend, mergeTrendBars, NO_SESSION_BAR_YET, TREND_MIN_BARS, type TrendBar } from './trend-tag';

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

describe('session bars only — 2026-11-23 BANKNIFTY pre-open (prod bug)', () => {
  const m1 = [...fx.syntheticHistory(fx.PRIOR_DAYS), ...fx.BANKNIFTY_23NOV_1M];
  const at = (t: string) => new Date(fx.ist(`2026-11-23 ${t}`));
  /** What hub15mBars returns: candles_1m epoch-rolled to 15m (no session filter), closed by `now` (mergeTrendBars). */
  const hub = (now: Date) => rollTo15m(m1.filter((b) => b.ts + 60_000 <= now.getTime()), now);
  const tag = (now: Date, exchange?: string) => classifyTrend({ kind: 'CE', side: 'BUY', bars: hub(now), now, source: 'fixture', exchange });

  it('before the fix the 09:21 tag reads the junk 09:00 pre-open bucket as its newest closed bar', () => {
    const old = tag(at('09:21'));
    expect(old.lastBarAt).toBe(new Date(fx.ist('2026-11-23 09:00')).toISOString());
    expect(hub(at('09:21')).find((b) => b.ts === fx.ist('2026-11-23 09:00'))).toMatchObject({ high: 65489.6, low: 63795.7 });
  });

  it('after the fix at 09:21 (NSE line): no pre-open / off-hours bucket, the reading is from the previous session and says so', () => {
    const r = tag(at('09:21'), 'NSE');
    expect(r.lastBarAt).toBe(new Date(fx.ist('2026-11-20 15:15')).toISOString());
    expect(r.candleCount).toBe(125); // 5 sessions × 25 buckets — the 02:00 / post-close flat buckets are gone
    expect(r.tag).not.toBe('UNKNOWN');
    expect(r.note).toContain(NO_SESSION_BAR_YET);
  });

  it('at 09:31 the newest bar is the 09:15 session bucket and there is no note', () => {
    const r = tag(at('09:31'), 'NSE');
    expect(r.lastBarAt).toBe(new Date(fx.ist('2026-11-23 09:15')).toISOString());
    expect(r.note).toBeUndefined();
  });

  it('too few prior-session bars before 09:30 ⇒ UNKNOWN "no closed session 15m bar yet"', () => {
    const now = at('09:21');
    const few = rollTo15m([...fx.syntheticHistory(['2026-11-20']), ...fx.BANKNIFTY_23NOV_1M].filter((b) => b.ts + 60_000 <= now.getTime()), now);
    const r = classifyTrend({ kind: 'CE', side: 'BUY', bars: few, now, source: 'fixture', exchange: 'NSE' });
    expect(r.tag).toBe('UNKNOWN');
    expect(r.reason).toContain(NO_SESSION_BAR_YET);
    expect(r.reason).toContain('25 completed 15m bars, need 120');
  });

  it('MCX keeps its 09:00 bucket (session opens 09:00)', () => {
    const now = new Date(fx.ist('2026-11-23 09:16'));
    const bars = Array.from({ length: 130 }, (_, i) => ({ ts: fx.ist('2026-11-23 09:00') - (129 - i) * Q, open: 100, high: 101, low: 99, close: 100 + i }));
    const r = classifyTrend({ kind: 'FUT', side: 'BUY', bars, now, source: 'fixture', exchange: 'MCX' });
    expect(r.lastBarAt).toBe(new Date(fx.ist('2026-11-23 09:00')).toISOString());
    expect(r.note).toBeUndefined();
  });
});
