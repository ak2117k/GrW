import {
  aggregateBars,
  callBudget,
  canDerive,
  coverageOf,
  fetchIntervalFor,
  intervalMinutes,
  planWindows,
  readFetchCaps,
  servingIntervals,
  type Bar,
  type TradingCalendar,
} from './backtest-data.domain';
import { pickInstrument, resolveInstrument } from './instrument-resolve';

const D = (iso: string) => new Date(iso);
const DAY = 86_400_000;
/** Weekdays trade; 2024-01-26 (Republic Day, a Friday) is a holiday. */
const cal: TradingCalendar = {
  isTradingDay: (_ex, at = new Date()) => {
    const ist = new Date(at.getTime() + 5.5 * 3_600_000);
    const dow = ist.getUTCDay();
    return dow !== 0 && dow !== 6 && ist.toISOString().slice(0, 10) !== '2024-01-26';
  },
};

describe('intervals', () => {
  it('parses timeframes', () => {
    expect(['1m', '15m', '1h', '1d', '1w', 'x'].map(intervalMinutes)).toEqual([1, 15, 60, 1440, null, null]);
  });
  it('derives coarser bars from finer ones anchored at the session', () => {
    expect(canDerive('1m', '15m')).toBe(true);
    expect(canDerive('15m', '1h')).toBe(true);
    expect(canDerive('15m', '10m')).toBe(false);
    expect(canDerive('1d', '1h')).toBe(false);
  });
  it('serves the exact interval first, then the coarsest finer one, never daily-from-intraday first', () => {
    expect(servingIntervals('15m')).toEqual(['15m', '5m', '1m']);
    expect(servingIntervals('1h')).toEqual(['1h', '15m', '5m', '1m']);
    expect(servingIntervals('30m')).toEqual(['15m', '5m', '1m']);
    expect(servingIntervals('1d')).toEqual(['1d', '1h', '15m', '5m', '1m']);
  });
  it('fetches the coarsest store interval that divides the target', () => {
    expect([fetchIntervalFor('30m'), fetchIntervalFor('10m'), fetchIntervalFor('3m'), fetchIntervalFor('1d')]).toEqual(['15m', '5m', '1m', '1d']);
  });
});

describe('aggregateBars', () => {
  const bar = (iso: string, px: number): Bar => ({ timestamp: D(iso), open: px, high: px + 1, low: px - 1, close: px + 0.5, volume: 10 });
  it('rolls 1m into 15m buckets anchored at 09:15 IST and drops off-session bars', () => {
    const bars = [
      bar('2024-01-02T03:44:00Z', 1), // 09:14 IST: dropped
      bar('2024-01-02T03:45:00Z', 100),
      bar('2024-01-02T03:59:00Z', 110),
      bar('2024-01-02T04:00:00Z', 120), // 09:30 IST: next bucket
      bar('2024-01-02T10:00:00Z', 1), // 15:30 IST: dropped
    ];
    const out = aggregateBars(bars, 15);
    expect(out.map((b) => b.timestamp.toISOString())).toEqual(['2024-01-02T03:45:00.000Z', '2024-01-02T04:00:00.000Z']);
    expect(out[0]).toMatchObject({ open: 100, high: 111, low: 99, close: 110.5, volume: 20 });
  });
  it('makes one daily bar per IST session date stamped 09:15 IST', () => {
    const out = aggregateBars([bar('2024-01-02T03:45:00Z', 100), bar('2024-01-02T09:59:00Z', 105), bar('2024-01-03T03:45:00Z', 107)], 1440);
    expect(out.map((b) => b.timestamp.toISOString())).toEqual(['2024-01-02T03:45:00.000Z', '2024-01-03T03:45:00.000Z']);
    expect(out[0].close).toBe(105.5);
  });
});

describe('coverageOf (catalogue coverage maths)', () => {
  const span = { fromTs: D('2020-01-01T03:45:00Z'), toTs: D('2024-12-31T09:59:00Z') };
  it('nothing held: the whole request, newest first', () => {
    expect(coverageOf(null, D('2023-01-01'), D('2024-01-01'))).toEqual({
      complete: false,
      missing: [{ from: D('2023-01-01'), to: D('2024-01-01'), direction: 'backward' }],
    });
  });
  it('inside the span (weekend slack at both ends) is complete', () => {
    expect(coverageOf(span, D('2019-12-29'), D('2025-01-03')).complete).toBe(true);
  });
  it('a request reaching past both ends yields two pieces touching the span', () => {
    const c = coverageOf(span, D('2018-01-01'), D('2025-06-01'));
    expect(c.complete).toBe(false);
    expect(c.missing).toEqual([
      { from: D('2018-01-01'), to: span.fromTs, direction: 'backward' },
      { from: span.toTs, to: D('2025-06-01'), direction: 'forward' },
    ]);
  });
  it('a request entirely after the span includes the gap so the span stays contiguous', () => {
    const c = coverageOf(span, D('2025-06-01'), D('2025-07-01'));
    expect(c.missing).toEqual([{ from: span.toTs, to: D('2025-07-01'), direction: 'forward' }]);
  });
  it('an empty or inverted request is trivially complete', () => {
    expect(coverageOf(span, D('2025-01-01'), D('2025-01-01')).complete).toBe(true);
  });
});

describe('planWindows (acquisition chunking)', () => {
  it('sub-hour: one window per NSE session, skipping weekends and holidays, newest first when backward', () => {
    // Thu 2024-01-25 .. Mon 2024-01-29: Fri 26 is a holiday, 27/28 a weekend.
    const w = planWindows({ from: D('2024-01-24T18:30:00Z'), to: D('2024-01-29T18:30:00Z'), direction: 'backward' }, '15m', cal);
    expect(w.map((x) => x.from.toISOString())).toEqual(['2024-01-29T03:45:00.000Z', '2024-01-25T03:45:00.000Z']);
    expect(w[0].to.toISOString()).toBe('2024-01-29T10:00:00.000Z');
  });
  it('forward pieces run oldest first and clip to the piece', () => {
    const w = planWindows({ from: D('2024-01-02T06:00:00Z'), to: D('2024-01-03T05:00:00Z'), direction: 'forward' }, '1m', cal);
    expect(w).toEqual([
      { from: D('2024-01-02T06:00:00Z'), to: D('2024-01-02T10:00:00Z') },
      { from: D('2024-01-03T03:45:00Z'), to: D('2024-01-03T05:00:00Z') },
    ]);
  });
  it('1h / 1d use wide windows (365 / 1800 days)', () => {
    const piece = { from: D('2016-01-01'), to: D('2026-01-01'), direction: 'forward' as const };
    expect(planWindows(piece, '1h', cal)).toHaveLength(Math.ceil((piece.to.getTime() - piece.from.getTime()) / (365 * DAY)));
    expect(planWindows(piece, '1d', cal)).toHaveLength(3);
  });
  it('2 years of 15m costs ~one call per trading day', () => {
    const w = planWindows({ from: D('2023-01-01'), to: D('2025-01-01'), direction: 'backward' }, '15m', cal);
    expect(w.length).toBeGreaterThan(500);
    expect(w.length).toBeLessThan(530);
  });
});

describe('callBudget (caps + market-hours rule)', () => {
  const caps = { maxCallsPerRequest: 400, maxCallsPerDay: 1500, marketHoursMaxCalls: 30 };
  it('per-request cap off-hours', () => expect(callBudget(caps, 0, false)).toBe(400));
  it('small and slow in market hours (allowed, not refused)', () => expect(callBudget(caps, 0, true)).toBe(30));
  it('never past the daily cap', () => {
    expect(callBudget(caps, 1300, false)).toBe(200);
    expect(callBudget(caps, 1500, false)).toBe(0);
    expect(callBudget(caps, 2000, true)).toBe(0);
  });
  it('reads env overrides, ignoring junk', () => {
    expect(readFetchCaps({ BACKTEST_FETCH_MAX_CALLS: '50', BACKTEST_FETCH_DAILY_CALLS: 'x' })).toEqual({
      maxCallsPerRequest: 50,
      maxCallsPerDay: 1500,
      marketHoursMaxCalls: 30,
    });
  });
});

describe('instrument resolution', () => {
  it('prefers the exact symbol over a contains-match that sorts first', () => {
    const rows = [
      { token: '1', symbol: 'TATAMOTORS-BE', exchange: 'NSE' },
      { token: '2', symbol: 'TATAMOTORS-EQ', exchange: 'NSE' },
    ];
    expect(pickInstrument(rows, 'TATAMOTORS')?.token).toBe('2');
  });
  it('falls back to the token map, then the symbol itself', () => {
    expect(resolveInstrument([], 'NIFTY', 'NSE')).toEqual({ token: '99926000', exchange: 'NSE', via: 'token-map' });
    expect(resolveInstrument([], 'ZZZ', 'NSE')).toEqual({ token: 'ZZZ', exchange: 'NSE', via: 'symbol' });
  });
});
