import { expectedLatestBar, multiTimeframeView, staleReason, withTodayDaily, type Bar } from './multi-timeframe';

const IST = 330 * 60_000;
/** Epoch ms of an IST wall-clock time. */
const ist = (ymd: string, hh: number, mm = 0) => Date.parse(`${ymd}T00:00:00Z`) - IST + (hh * 60 + mm) * 60_000;
const bar = (ts: number, c = 100): Bar => ({ ts, open: c, high: c + 1, low: c - 1, close: c });

describe('multi-timeframe staleness guard (F3, 2026-11-16)', () => {
  // 2026-11-16 is a Monday; 2026-11-13 the Friday before.
  it('expected latest bar: now inside the session, else the previous weekday close', () => {
    expect(expectedLatestBar(ist('2026-11-16', 13, 0), 'NSE')).toBe(ist('2026-11-16', 13, 0));
    expect(expectedLatestBar(ist('2026-11-16', 8, 30), 'NSE')).toBe(ist('2026-11-13', 15, 30));
    expect(expectedLatestBar(ist('2026-11-16', 18, 0), 'NSE')).toBe(ist('2026-11-16', 15, 30));
  });
  it('1m/15m bars from a previous session during market hours are stale; fresh ones are not', () => {
    const now = ist('2026-11-16', 13, 0);
    expect(staleReason('1m', [bar(ist('2026-11-13', 15, 29))], now, 'NSE')).toMatch(/^stale: newest 1m bar is 2026-11-13 15:29 IST/);
    expect(staleReason('1m', [bar(ist('2026-11-16', 12, 55))], now, 'NSE')).toBeNull();
    expect(staleReason('15m', [bar(ist('2026-11-16', 12, 30))], now, 'NSE')).toBeNull();
    expect(staleReason('15m', [bar(ist('2026-11-11', 15, 15))], now, 'NSE')).toMatch(/^stale/);
  });
  it('pre-open Monday: Friday-close bars are fresh', () => {
    const now = ist('2026-11-16', 8, 30);
    expect(staleReason('1m', [bar(ist('2026-11-13', 15, 29))], now, 'NSE')).toBeNull();
    expect(staleReason('1d', [bar(ist('2026-11-13', 0, 0))], now, 'NSE')).toBeNull();
  });
  it('daily: missing the previous session is stale', () => {
    expect(staleReason('1d', [bar(ist('2026-11-11', 0, 0))], ist('2026-11-16', 13, 0), 'NSE')).toMatch(/^stale: newest daily bar is 2026-11-11/);
  });
  it("today's forming daily bar is built from today's in-session 15m bars", () => {
    const now = ist('2026-11-16', 10, 1);
    const daily = [bar(ist('2026-11-13', 0, 0), 100)];
    const m15 = [bar(ist('2026-11-16', 9, 0), 50), bar(ist('2026-11-16', 9, 15), 101), bar(ist('2026-11-16', 9, 30), 103), bar(ist('2026-11-16', 9, 45), 102)];
    const out = withTodayDaily(daily, m15, 'NSE', now);
    expect(out).toHaveLength(2);
    expect(out[1]).toEqual({ ts: ist('2026-11-16', 0, 0), open: 101, high: 104, low: 100, close: 102 }); // the 09:00 pre-open print is dropped
    expect(withTodayDaily(out, m15, 'NSE', now)).toHaveLength(2);
  });
  it('the view reports every timeframe of a stale source as unavailable with the reason, and names the newest bars', () => {
    const now = ist('2026-11-16', 13, 0);
    const old15 = Array.from({ length: 200 }, (_, i) => bar(ist('2026-11-11', 9, 15) - (200 - i) * 15 * 60_000, 100 + i * 0.1));
    const v = multiTimeframeView({ exchange: 'NSE', '15m': old15, now });
    for (const tf of ['15m', '30m', '1h'] as const) {
      expect(v.timeframes[tf]).toMatchObject({ available: false, reason: expect.stringMatching(/^stale/) });
    }
    expect(v.lastBarIst?.['15m']).toBeTruthy();
    expect(v.alignment.unavailable).toBe(5);
  });
  it('without now the view is exactly as before (no staleness, no lastBarIst)', () => {
    const v = multiTimeframeView({ exchange: 'NSE' });
    expect(v.lastBarIst).toBeUndefined();
  });
});

describe('staleness is judged on session bars (2026-11-24)', () => {
  it("Monday 09:20: Friday's close plus a 09:10 pre-open copy is stale (the copy is not a session bar)", () => {
    const now = ist('2026-11-16', 9, 20);
    const one = [bar(ist('2026-11-13', 15, 29)), bar(ist('2026-11-16', 9, 10))];
    const v = multiTimeframeView({ exchange: 'NSE', '1m': one, now });
    expect(v.timeframes['3m']).toMatchObject({ available: false, reason: expect.stringMatching(/^stale: newest 1m bar is 2026-11-13 15:29/) });
  });
  it('18:00: flat post-close copies do not matter, the 15:29 bar is fresh', () => {
    const now = ist('2026-11-16', 18, 0);
    const one = [bar(ist('2026-11-16', 15, 29)), bar(ist('2026-11-16', 17, 59))];
    const v = multiTimeframeView({ exchange: 'NSE', '1m': one, now });
    expect(v.timeframes['3m']).not.toMatchObject({ reason: expect.stringMatching(/^stale/) });
  });
});
