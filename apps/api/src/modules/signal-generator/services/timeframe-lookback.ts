import { SR_SUPPORTED_INTERVALS } from '@td/shared';

/**
 * The set of analysable intervals has EXACTLY ONE source of truth —
 * `SR_SUPPORTED_INTERVALS` in `@td/shared` — because two hand-maintained
 * rosters (this file and the chart toolbar) drifted: `4h` was offered without
 * engine support, `1mo` was supported and unreachable. Everything below is a
 * partition of that roster, never a parallel list.
 */
const SUPPORTED_INTERVALS = new Set<string>(SR_SUPPORTED_INTERVALS);

/**
 * Which members of the roster are positional (daily and slower). Intraday and
 * positional both get the native per-timeframe S/R path, but they branch in
 * SrEvidenceService: positional candles come from Yahoo for 1w/1mo and OI
 * walls are skipped. This is the only judgement call here — membership of the
 * supported set is not.
 */
const POSITIONAL_MEMBERS = new Set<string>(['1d', '1w', '1mo']);

/** Intraday intervals that get native per-timeframe S/R. */
export const INTRADAY_INTERVALS = new Set<string>(
  SR_SUPPORTED_INTERVALS.filter((i) => !POSITIONAL_MEMBERS.has(i)),
);

/** Positional intervals (daily/weekly/monthly) — see POSITIONAL_MEMBERS. */
export const POSITIONAL_INTERVALS = new Set<string>(
  SR_SUPPORTED_INTERVALS.filter((i) => POSITIONAL_MEMBERS.has(i)),
);

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

/**
 * Any interval we natively support. Answered straight from the shared roster
 * rather than from the intraday/positional split, so an interval added to the
 * roster is supported even before anyone classifies it.
 */
export function isSupportedInterval(interval: string): boolean {
  return SUPPORTED_INTERVALS.has(interval);
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
