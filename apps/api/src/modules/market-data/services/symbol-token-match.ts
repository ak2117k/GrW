/**
 * One row of Angel One's scrip master. The real objects carry many more fields
 * (lotsize, expiry, strike…); only these three are load-bearing for resolving a
 * cash-equity symbol to its token.
 */
export interface ScripMasterRow {
  symbol?: string;
  token?: string;
  exch_seg?: string;
  name?: string;
}

/**
 * NSE cash series, in resolution priority. `-EQ` is the normal, liquid series and
 * must win when several exist: `-BE` is trade-to-trade (surveillance / low
 * liquidity), and resolving an order to it instead of `-EQ` would route into a
 * restricted series. Bare ('') covers the rare row with no suffix.
 */
const NSE_SERIES = ['-EQ', '', '-BE', '-BL', '-IV'] as const;

/**
 * Resolve a bare trading symbol (e.g. `NEOGEN`) to its Angel One token by an
 * EXACT, exchange-scoped match against the scrip master.
 *
 * Deliberately not a substring/fuzzy search: `NEOGEN` must resolve to NEOGEN-EQ,
 * never to a longer symbol like NEOGENAB-EQ (silently trading the wrong stock),
 * and an NSE lookup must never return a same-named BSE row. Pure and total —
 * given the same master it always returns the same answer and never throws.
 *
 * Returns null when no series matches (delisted, wrong exchange, or a typo).
 */
export function matchSymbolToken(
  master: ScripMasterRow[],
  symbol: string,
  exchange: string,
): { token: string; tradingSymbol: string } | null {
  if (!symbol) return null;
  // Strip any series the caller already appended so we control the priority.
  const base = symbol.trim().toUpperCase().replace(/-(EQ|BE|BL|IV)$/, '');
  const series = exchange === 'NSE' ? NSE_SERIES : ([''] as const);

  for (const suffix of series) {
    const want = `${base}${suffix}`;
    for (const row of master) {
      if (row?.exch_seg !== exchange) continue;
      if (row.token == null) continue;
      if (String(row.symbol ?? '').toUpperCase() !== want) continue;
      return { token: String(row.token), tradingSymbol: String(row.symbol) };
    }
  }
  return null;
}
