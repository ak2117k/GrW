/** Intraday intervals that get native per-timeframe S/R. */
export const INTRADAY_INTERVALS = new Set(['1m', '3m', '5m', '15m', '30m', '1h']);

/**
 * Positional intervals (daily/weekly/monthly). Like intraday they get the
 * native per-timeframe S/R path, but their candle source and assembly differ
 * (weekly/monthly come from Yahoo; OI walls are skipped — see SrEvidenceService).
 */
export const POSITIONAL_INTERVALS = new Set(['1d', '1w', '1mo']);

/** Days of history to fetch per interval — tuned for ~200-400 bars (NSE ~6.25h/day). */
const LOOKBACK_DAYS: Record<string, number> = {
  '1m': 1,
  '3m': 2,
  '5m': 5,
  '15m': 10,
  '30m': 20,
  '1h': 45,
  // Positional windows — deep history so MAs/fib/profile have enough bars.
  '1d': 900, // ~2.5yr of daily bars
  '1w': 1825, // ~5yr of weekly bars
  '1mo': 5475, // ~15yr of monthly bars
};

export function isIntradayInterval(interval: string): boolean {
  return INTRADAY_INTERVALS.has(interval);
}

/** Positional (1d/1w/1mo) check. */
export function isPositionalInterval(interval: string): boolean {
  return POSITIONAL_INTERVALS.has(interval);
}

/** Any interval we natively support — intraday OR positional. */
export function isSupportedInterval(interval: string): boolean {
  return isIntradayInterval(interval) || isPositionalInterval(interval);
}

/**
 * Normalise an interval to its canonical form. Callers may pass Yahoo-style
 * `1M` for monthly; we use `1mo` internally. Everything else passes through.
 */
export function normalizeInterval(interval: string): string {
  return interval === '1M' ? '1mo' : interval;
}

/** Lookback window in days; unknown intervals fall back to the proven 15m window. */
export function lookbackDaysFor(interval: string): number {
  return LOOKBACK_DAYS[interval] ?? LOOKBACK_DAYS['15m'];
}
