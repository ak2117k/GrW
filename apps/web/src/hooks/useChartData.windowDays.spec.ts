import { describe, it, expect } from 'vitest';
import { getHistoryRangeDays } from './useChartData';

// Approximate NSE bars per trading day (6.25h session) per interval.
const BARS_PER_TRADING_DAY: Record<string, number> = {
  '1m': 375,
  '5m': 75,
  '15m': 25,
  '30m': 13,
};

describe('getHistoryRangeDays (cold first-paint window)', () => {
  it('shrinks sub-hour initial windows so cold load needs far fewer per-day chunks', () => {
    // Sub-hour intervals are fetched one calendar-day per Angel REST chunk,
    // so the day count IS the chunk count. Keep these small for fast paint.
    expect(getHistoryRangeDays('1m')).toBe(1);
    expect(getHistoryRangeDays('5m')).toBe(3);
    expect(getHistoryRangeDays('15m')).toBe(5);
    // All sub-hour windows must stay well below the old per-day-chunk-heavy values.
    expect(getHistoryRangeDays('1m')).toBeLessThan(3);
    expect(getHistoryRangeDays('5m')).toBeLessThan(10);
    expect(getHistoryRangeDays('15m')).toBeLessThan(15);
  });

  it('keeps the previous (large) windows for hour+ intervals (single wide chunk)', () => {
    // Hour+ intervals are NOT capped to 1 day/chunk by the adapter, so a wide
    // window is still one cheap call — no need to shrink it.
    expect(getHistoryRangeDays('30m')).toBe(30);
    expect(getHistoryRangeDays('1h')).toBe(60);
    expect(getHistoryRangeDays('1d')).toBe(365);
  });

  it('still fetches enough bars to fill the ~100-bar default view', () => {
    // Even after weekends/holidays trim ~2/7 of calendar days, the window must
    // yield >=~75 bars so the default view is not starved.
    for (const tf of ['1m', '5m', '15m'] as const) {
      const days = getHistoryRangeDays(tf);
      // Roughly 5 trading days per 7 calendar days.
      const tradingDays = Math.max(1, Math.round((days * 5) / 7));
      const estBars = tradingDays * BARS_PER_TRADING_DAY[tf];
      expect(estBars).toBeGreaterThanOrEqual(75);
    }
  });

  it('cuts the 15m cold-load chunk count by ~3x vs the old 15-day window', () => {
    const oldDays = 15; // previous 15m window
    const newDays = getHistoryRangeDays('15m');
    expect(newDays).toBeLessThanOrEqual(oldDays / 3);
  });

  it('gives 1mo a decade of lookback so ~100 monthly bars fill the view', () => {
    // Server-aggregated from daily bars, so a wide window is still one fetch.
    expect(getHistoryRangeDays('1mo')).toBeGreaterThanOrEqual(365 * 8);
  });

  it('falls back to a small window for unknown timeframes', () => {
    expect(getHistoryRangeDays('7m')).toBe(3);
  });
});
