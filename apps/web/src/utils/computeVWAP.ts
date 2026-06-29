/**
 * Session VWAP — Volume Weighted Average Price that resets at the start of
 * every IST trading day. The chart's previous implementation cumulated
 * across the whole loaded dataset, so on a 5-day 15-min window the VWAP
 * line drifted toward the multi-day weighted average instead of showing
 * what intraday traders actually use as a reference.
 *
 * Session detection: convert each candle's start time to IST date
 * (yyyy-mm-dd) and reset the accumulators when the date changes. India
 * doesn't observe DST so a static +5:30 offset would suffice, but
 * Intl.DateTimeFormat handles edge cases (leap seconds, future TZ
 * changes) defensively.
 *
 * Behavior across timeframes:
 *   - Intraday (1m / 5m / 15m / 1h)  → standard session VWAP, resets at 9:15 IST
 *   - Daily and higher               → each candle is its own session, so
 *                                       VWAP collapses to the typical price.
 *                                       The line is effectively flat per bar.
 *                                       Not "wrong", just not useful — chart
 *                                       platforms typically hide VWAP at
 *                                       daily+ for this reason.
 *
 * Pure function — no chart dependencies, easy to unit test.
 */
export interface VWAPCandle {
  /** Unix seconds (matches lightweight-charts' Time format). */
  time: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

/** Cached IST date formatter. Reused across calls. */
const IST_DATE_FORMATTER = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Asia/Kolkata',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});

/**
 * Returns one VWAP value per input candle (or null when no volume has
 * accumulated yet in the current session — extremely rare in practice,
 * happens only when the first candle of a session has zero volume).
 *
 * Typical price = (high + low + close) / 3. Cumulative within the
 * session: Σ(typical × volume) / Σ(volume).
 */
export function computeSessionVWAP(candles: VWAPCandle[]): (number | null)[] {
  let cumPV = 0;
  let cumV = 0;
  let lastDateKey: string | null = null;
  return candles.map((c) => {
    const dateKey = IST_DATE_FORMATTER.format(new Date(c.time * 1000));
    if (dateKey !== lastDateKey) {
      cumPV = 0;
      cumV = 0;
      lastDateKey = dateKey;
    }
    const typical = (c.high + c.low + c.close) / 3;
    cumPV += typical * c.volume;
    cumV += c.volume;
    return cumV > 0 ? cumPV / cumV : null;
  });
}
