/**
 * Symbol → Angel token/exchange for backtests, so they run even when the local instrument table is
 * empty. Moved from backtest.service.ts (same entries) and shared with the data-acquisition path.
 */
export const TOKEN_MAP: Record<string, { token: string; exchange: string }> = {
  NIFTY: { token: '99926000', exchange: 'NSE' },
  BANKNIFTY: { token: '99926009', exchange: 'NSE' },
  FINNIFTY: { token: '99926037', exchange: 'NSE' },
  SENSEX: { token: '99919000', exchange: 'BSE' },
  INDIAVIX: { token: '99926017', exchange: 'NSE' },
  RELIANCE: { token: '2885', exchange: 'NSE' },
  TCS: { token: '11536', exchange: 'NSE' },
  HDFCBANK: { token: '1333', exchange: 'NSE' },
  INFY: { token: '1594', exchange: 'NSE' },
  ICICIBANK: { token: '4963', exchange: 'NSE' },
};

/** Index symbols (no '-EQ' cash row; Yahoo maps them by token). */
export const INDEX_SYMBOLS = new Set(['NIFTY', 'BANKNIFTY', 'FINNIFTY', 'SENSEX', 'INDIAVIX']);

/** mbm_bars_1m series id for a symbol, when the MBM live store carries it. */
export function mbmSeriesFor(symbol: string): string | null {
  const s = symbol.toUpperCase();
  if (s === 'NIFTY' || s === 'BANKNIFTY' || s === 'INDIAVIX') return s;
  if (['RELIANCE', 'HDFCBANK', 'ICICIBANK', 'INFY', 'TCS', 'BHARTIARTL', 'LT', 'ITC'].includes(s)) return `EQ_${s}`;
  return null;
}

export interface InstrumentLike {
  token?: string | null;
  symbol?: string | null;
  name?: string | null;
  exchange?: string | null;
}

/**
 * The instrument row that IS this symbol: exact symbol, then SYMBOL-EQ, then exact name; else the
 * first row (the previous behaviour of the backtest service, which always took rows[0]).
 */
export function pickInstrument<T extends InstrumentLike>(rows: T[], symbol: string): T | null {
  if (rows.length === 0) return null;
  const s = symbol.toUpperCase();
  return (
    rows.find((r) => (r.symbol ?? '').toUpperCase() === s) ??
    rows.find((r) => (r.symbol ?? '').toUpperCase() === `${s}-EQ`) ??
    rows.find((r) => (r.name ?? '').toUpperCase() === s) ??
    rows[0]
  );
}

export interface ResolvedInstrument {
  token: string;
  exchange: string;
  via: 'instruments' | 'token-map' | 'symbol';
}

export function resolveInstrument(rows: InstrumentLike[], symbol: string, exchange: string): ResolvedInstrument {
  const hit = pickInstrument(rows, symbol);
  if (hit?.token) return { token: hit.token, exchange: hit.exchange ?? exchange, via: 'instruments' };
  const mapped = TOKEN_MAP[symbol.toUpperCase()];
  if (mapped) return { ...mapped, via: 'token-map' };
  return { token: symbol, exchange, via: 'symbol' };
}
