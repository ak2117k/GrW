/** Intraday intervals that get native per-timeframe S/R. */
export const INTRADAY_INTERVALS = new Set(['1m', '3m', '5m', '15m', '30m', '1h']);

/** Days of history to fetch per interval — tuned for ~200-400 bars (NSE ~6.25h/day). */
const LOOKBACK_DAYS: Record<string, number> = {
  '1m': 1,
  '3m': 2,
  '5m': 5,
  '15m': 10,
  '30m': 20,
  '1h': 45,
};

export function isIntradayInterval(interval: string): boolean {
  return INTRADAY_INTERVALS.has(interval);
}

/** Lookback window in days; unknown intervals fall back to the proven 15m window. */
export function lookbackDaysFor(interval: string): number {
  return LOOKBACK_DAYS[interval] ?? LOOKBACK_DAYS['15m'];
}
