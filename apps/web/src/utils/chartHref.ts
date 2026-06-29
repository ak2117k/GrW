/**
 * Build the Charts-page deep link for a symbol. Used by SymbolChartLink wherever
 * a symbol should be clickable (watch, ungated, swing, intraday, rejections).
 *
 * - `token` is optional: omitted from the URL when null/undefined/empty. The
 *   Charts page resolves the token from the symbol when it's missing (e.g.
 *   rejection rows, which carry no token).
 * - `exchange` defaults to NSE (every Chartink-sourced symbol is an NSE equity);
 *   the Charts page also defaults to NSE, but we set it explicitly for clarity.
 */
export function buildChartHref(
  symbol: string,
  token?: string | null,
  exchange?: string | null,
): string {
  const params = new URLSearchParams();
  params.set('symbol', symbol);
  if (token) params.set('token', token);
  params.set('exchange', exchange || 'NSE');
  return `/charts?${params.toString()}`;
}
