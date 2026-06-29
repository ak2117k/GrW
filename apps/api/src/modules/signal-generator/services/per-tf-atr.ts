export interface AtrCandle {
  high: number;
  low: number;
  close: number;
}

/**
 * ATR(period) computed from a candle array via Wilder smoothing.
 *
 * True Range = max(high-low, |high-prevClose|, |low-prevClose|).
 * Seeds with the simple average of the first `period` TRs, then applies
 * Wilder smoothing for the remainder. Returns 0 when there are not enough
 * candles (need at least period+1 to form `period` true ranges).
 *
 * The unit returned is the per-timeframe ATR — used as the price tolerance
 * unit for intraday S/R so zone widths auto-scale to the selected timeframe.
 */
export function computeAtrFromCandles(candles: AtrCandle[], period = 14): number {
  if (!Array.isArray(candles) || candles.length <= period) return 0;

  const trueRanges: number[] = [];
  for (let i = 1; i < candles.length; i++) {
    const c = candles[i];
    const prevClose = candles[i - 1].close;
    const tr = Math.max(
      c.high - c.low,
      Math.abs(c.high - prevClose),
      Math.abs(c.low - prevClose),
    );
    trueRanges.push(tr);
  }
  if (trueRanges.length < period) return 0;

  // Wilder smoothing: seed with the SMA of the first `period` TRs.
  let atr = trueRanges.slice(0, period).reduce((s, tr) => s + tr, 0) / period;
  for (let i = period; i < trueRanges.length; i++) {
    atr = (atr * (period - 1) + trueRanges[i]) / period;
  }
  return atr;
}
