/**
 * Expiry checks for derivative contracts, by IST calendar date.
 *
 * WHY: callers that hold a contract past its expiry (an OPEN paper position on
 * a 15-Oct CRUDEOIL option, say) kept asking the broker for a live quote every
 * cycle. Angel answers an expired token with an empty SUCCESS reply, so each
 * ask became an ERROR line — and never a price. A contract past expiry has no
 * live quote to ask for.
 */

const MONTHS = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];

/** Angel tradingsymbols: NIFTY28OCT2625000CE, CRUDEOIL15OCT265800PE, NIFTY28OCT26FUT. */
const OPTION_SYMBOL = /^[A-Z&-]+?(\d{2})([A-Z]{3})(\d{2})\d+(?:\.\d+)?(?:CE|PE)$/;
const FUTURE_SYMBOL = /^[A-Z&-]+?(\d{2})([A-Z]{3})(\d{2})FUT$/;

/** IST calendar date (YYYY-MM-DD) of an instant. */
export function istDateOf(d: Date): string {
  return new Date(d.getTime() + 330 * 60_000).toISOString().slice(0, 10);
}

/** The expiry date (YYYY-MM-DD) encoded in an option / future tradingsymbol, or null (equity, index, unknown). */
export function expiryFromSymbol(symbol: string | null | undefined): string | null {
  const s = String(symbol ?? '').trim().toUpperCase();
  const m = OPTION_SYMBOL.exec(s) ?? FUTURE_SYMBOL.exec(s);
  if (!m) return null;
  const mi = MONTHS.indexOf(m[2]);
  if (mi < 0) return null;
  return `20${m[3]}-${String(mi + 1).padStart(2, '0')}-${m[1]}`;
}

/**
 * True once `expiry` (a YYYY-MM-DD, or an instant read as its IST date) is
 * before today in IST. A contract is NOT expired on its own expiry day.
 */
export function isPastExpiry(expiry: string | Date | null | undefined, now: Date = new Date()): boolean {
  if (expiry == null || expiry === '') return false;
  const ymd = typeof expiry === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(expiry) ? expiry : istDateOf(new Date(expiry));
  return ymd < istDateOf(now);
}
