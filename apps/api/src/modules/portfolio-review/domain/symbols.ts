/**
 * Symbol parsing for the portfolio review. Pure, imports nothing.
 *
 * Angel tradingsymbols:
 *   options  NIFTY28JUL2623950CE, CRUDEOIL15OCT268800PE, 360ONE27OCT26900CE
 *   futures  RELIANCE28AUG26FUT, CRUDEOIL19NOV26FUT
 *   cash     IDEA-EQ, HFCL-BE (series suffix; HFCL-EQ and HFCL-BE are the same company)
 */

const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;
export const DAY_MS = 24 * 60 * 60 * 1000;

const MONTHS = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];
const DERIVATIVE = new RegExp(`^(.+?)(\\d{2})(${MONTHS.join('|')})(\\d{2})(\\d+(?:\\.\\d+)?)?(CE|PE|FUT)$`);

export interface DerivativeSymbol {
  underlying: string;
  type: 'CE' | 'PE' | 'FUT';
  /** IST calendar day of expiry, 'YYYY-MM-DD'. */
  expiry: string;
  strike: number | null;
}

export function parseDerivativeSymbol(symbol: string): DerivativeSymbol | null {
  const m = DERIVATIVE.exec(String(symbol ?? '').trim().toUpperCase());
  if (!m) return null;
  const [, underlying, dd, mon, yy, strike, type] = m;
  if (type !== 'FUT' && !strike) return null;
  const month = MONTHS.indexOf(mon) + 1;
  return {
    underlying,
    type: type as DerivativeSymbol['type'],
    expiry: `20${yy}-${String(month).padStart(2, '0')}-${dd}`,
    strike: strike ? Number(strike) : null,
  };
}

/** Cash symbol without its series suffix: HFCL-BE → HFCL, IDEA-EQ → IDEA. */
export function baseCashSymbol(symbol: string): string {
  return String(symbol ?? '').trim().toUpperCase().replace(/-(EQ|BE|BZ|BL|SM|ST|IL|E1|N\d|X\d)$/, '');
}

/** The underlying a trade belongs to (derivative underlying or the cash base symbol). */
export function underlyingOf(symbol: string): string {
  return parseDerivativeSymbol(symbol)?.underlying ?? baseCashSymbol(symbol);
}

/** 'YYYY-MM-DD' of the IST calendar day containing `d`. */
export function istDay(d: Date): string {
  return new Date(d.getTime() + IST_OFFSET_MS).toISOString().slice(0, 10);
}

/** 'YYYY-MM' of the IST month containing `d`. */
export function istMonth(d: Date): string {
  return istDay(d).slice(0, 7);
}

/** Minutes since IST midnight. */
export function istMinutes(d: Date): number {
  const t = new Date(d.getTime() + IST_OFFSET_MS);
  return t.getUTCHours() * 60 + t.getUTCMinutes();
}

/** Whole IST calendar days from `a` to `b` (b − a). */
export function istDayDiff(a: string, b: string): number {
  return Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / DAY_MS);
}

export const isDerivativeExchange = (exchange: string): boolean =>
  ['NFO', 'BFO', 'MCX', 'NCDEX', 'NCO', 'CDS'].includes(String(exchange ?? '').toUpperCase());

export const isCommodityExchange = (exchange: string): boolean =>
  ['MCX', 'NCDEX', 'NCO'].includes(String(exchange ?? '').toUpperCase());
