/** Strip the NSE series suffix so an NSE `RELIANCE-EQ` matches a bare BSE `RELIANCE`. */
function bareSymbol(symbol: string): string {
  return String(symbol ?? '').toUpperCase().replace(/-(EQ|BE|BL|IV)$/, '');
}

/**
 * Collapse NSE/BSE duplicates in a symbol-search result set, preferring NSE —
 * the behaviour Angel One's search has.
 *
 * A stock listed on both exchanges arrives as two rows with DIFFERENT tokens
 * (RELIANCE = NSE 2885 vs BSE 500325), so a token-level dedup leaves both and the
 * user can pick the BSE one by accident — which then keys the chart, trades, and
 * markers off the wrong token. This drops the BSE row whenever an NSE row exists
 * for the same bare symbol. A genuinely BSE-only stock is kept; NFO/MCX/index
 * rows never collide with equity bare symbols and pass through untouched. Order
 * is preserved. Pure.
 */
export function dedupePreferNse<T extends { symbol: string; exchange: string }>(rows: T[]): T[] {
  const nseSymbols = new Set(
    rows.filter((r) => r.exchange === 'NSE').map((r) => bareSymbol(r.symbol)),
  );
  return rows.filter((r) => !(r.exchange === 'BSE' && nseSymbols.has(bareSymbol(r.symbol))));
}
