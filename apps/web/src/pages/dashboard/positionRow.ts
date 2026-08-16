/**
 * Is this position a DERIVATIVE — i.e. is the thing traded different from the
 * thing whose chart carries the structure?
 *
 * It decides whether the positions row offers TWO charts (the underlying on the
 * symbol, the contract on the P&L) or one. On cash both ends would resolve to
 * the same instrument, and a row that renders two links to one destination
 * teaches the reader that its two ends differ when they do not.
 *
 * Compared by SYMBOL, not by an exchange allowlist. `exchange === 'NFO'` is true
 * of every equity derivative and false of MCX futures, BSE's BFO and currency's
 * CDS, so an allowlist is a list that silently goes stale as segments are added.
 * The broker already tells us the underlying's name; the honest question is
 * whether it differs from what was traded.
 */
const CASH_SERIES_SUFFIX = /-[A-Z0-9]{1,3}$/;

export function isDerivative(position: {
  symbol: string;
  underlyingSymbol: string | null;
}): boolean {
  // No underlying reported means no second chart to offer. Guessing one out of
  // the tradingsymbol would send the link somewhere the broker never claimed.
  if (!position.underlyingSymbol) return false;
  const traded = position.symbol.trim().toUpperCase().replace(CASH_SERIES_SUFFIX, '');
  return traded !== position.underlyingSymbol.trim().toUpperCase();
}
