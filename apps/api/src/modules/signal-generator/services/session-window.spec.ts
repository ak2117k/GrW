import { istSessionDate, mostRecentSessionBars, SESSION_LOOKBACK_DAYS } from './session-window';

/**
 * The overnight/weekend gap these helpers close.
 *
 * A session window pinned to "today 09:15 IST" is empty whenever `now` is
 * before today's open — every night, every weekend, every holiday. The book's
 * 5m replay then never runs, so spot / VWAP / today's H-L / the opening range
 * all stay at their 0 seed and every consumer downstream reads a book that
 * looks like a symbol which has never traded.
 *
 * Walking back a fixed 24h is not enough: at 03:00 on a Monday that lands on
 * Sunday. The bars have to be grouped by the session they actually belong to.
 */

/** 2026-08-07 (Friday) 09:15 IST == 03:45 UTC. */
function istBar(dayUtc: number, hourIst: number, minuteIst: number, close = 100) {
  const istOffsetMs = 5.5 * 60 * 60 * 1000;
  const ist = Date.UTC(2026, 7, dayUtc, hourIst, minuteIst, 0, 0);
  return { timestamp: new Date(ist - istOffsetMs), close, high: close, low: close, volume: 1 };
}

describe('istSessionDate', () => {
  it('groups a bar by its IST calendar day, not its UTC one', () => {
    // 03:45 UTC on the 7th is 09:15 IST on the 7th — same date either way.
    expect(istSessionDate(istBar(7, 9, 15).timestamp)).toBe('2026-08-07');
  });

  /**
   * The case UTC grouping gets wrong. 15:20 IST is 09:50 UTC — still the 7th.
   * But a naive UTC-date grouping of a pre-open bar would split a session in
   * two, and the last "session" would hold a handful of bars.
   */
  it('keeps a full trading day in one bucket', () => {
    const open = istSessionDate(istBar(7, 9, 15).timestamp);
    const close = istSessionDate(istBar(7, 15, 25).timestamp);
    expect(open).toBe(close);
  });
});

describe('mostRecentSessionBars', () => {
  it('returns only the latest session when several are present', () => {
    const bars = [
      istBar(6, 9, 15, 10),
      istBar(6, 15, 25, 11),
      istBar(7, 9, 15, 20),
      istBar(7, 15, 25, 21),
    ];
    const out = mostRecentSessionBars(bars);
    expect(out).toHaveLength(2);
    expect(out.map((b) => b.close)).toEqual([20, 21]);
  });

  /**
   * The Monday-morning case. A fixed -24h lookback from Monday 03:00 lands on
   * Sunday and finds nothing; grouping by session correctly yields Friday.
   */
  it('reaches back past a weekend to the last session that actually traded', () => {
    // Fri 7th and Mon 10th exist; Sat/Sun have no bars at all.
    const bars = [istBar(7, 9, 15, 50), istBar(7, 15, 25, 55)];
    const out = mostRecentSessionBars(bars);
    expect(out.map((b) => b.close)).toEqual([50, 55]);
  });

  it('preserves chronological order — the replay depends on it', () => {
    const bars = [istBar(7, 15, 25, 30), istBar(7, 9, 15, 10), istBar(7, 12, 0, 20)];
    expect(mostRecentSessionBars(bars).map((b) => b.close)).toEqual([10, 20, 30]);
  });

  it('is empty for an empty input rather than throwing', () => {
    expect(mostRecentSessionBars([])).toEqual([]);
  });

  it('ignores bars with an unusable timestamp instead of bucketing them together', () => {
    const bars = [
      istBar(7, 9, 15, 10),
      { timestamp: new Date(NaN), close: 99, high: 99, low: 99, volume: 1 },
    ];
    expect(mostRecentSessionBars(bars).map((b) => b.close)).toEqual([10]);
  });

  it('looks back far enough to clear a long weekend', () => {
    // Fri→Tue after a Monday holiday is a 4-day gap; the window must exceed it.
    expect(SESSION_LOOKBACK_DAYS).toBeGreaterThanOrEqual(5);
  });
});
