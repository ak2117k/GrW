/**
 * Does this open position belong to the instrument currently on the chart?
 *
 * THE TWO SIDES SPELL THINGS DIFFERENTLY. The chart shows an UNDERLYING —
 * `KEI-EQ` on NSE, or `NIFTY`. The position is a broker tradingsymbol —
 * `KEI29SEP265800CE`. A plain equality test never matches for a derivative,
 * which is the whole reason the sentinel's read never reached the chart.
 *
 * The rule: strip the chart symbol's cash series suffix (`-EQ`, `-BE`) to get a
 * base, then a position matches if it IS that base, or if it STARTS with that
 * base AND THE NEXT CHARACTER IS A DIGIT.
 *
 * That digit test is the load-bearing part. Every Indian derivative
 * tradingsymbol is `<NAME><DD><MMM><YY>…` — the expiry day follows the name
 * immediately — so `KEI29SEP265800CE` matches `KEI` while `KEIL…` does not.
 * A bare `startsWith` would put KEIL's position on KEI's chart, and an overlay
 * that draws the wrong trade's entry is worse than one that draws nothing: the
 * user has no way to tell it is lying.
 */
const CASH_SERIES_SUFFIX = /-[A-Z0-9]{1,3}$/;

export function chartBaseSymbol(chartSymbol: string): string {
  return String(chartSymbol ?? '').trim().toUpperCase().replace(CASH_SERIES_SUFFIX, '');
}

export function matchesChartSymbol(positionSymbol: string, chartSymbol: string): boolean {
  const base = chartBaseSymbol(chartSymbol);
  if (!base) return false;
  const position = String(positionSymbol ?? '').trim().toUpperCase();

  // Cash on cash: `KEI-EQ` position on a `KEI` chart, or the same spelling twice.
  if (chartBaseSymbol(position) === base) return true;

  if (!position.startsWith(base)) return false;
  const next = position.charAt(base.length);
  return next >= '0' && next <= '9';
}

/** Every open position belonging to the charted instrument. */
export function positionsForChart<T extends { symbol: string }>(
  positions: readonly T[],
  chartSymbol: string,
): T[] {
  return positions.filter((p) => matchesChartSymbol(p.symbol, chartSymbol));
}
