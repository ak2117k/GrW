/**
 * Did the broker actually convert the position? Pure (spec 2026-11-04 §5.3).
 *
 * The smartapi-javascript SDK NEVER rejects: a network error or its 7 s timeout resolves to `{}`,
 * an HTTP error to `{status:<http>, message}`, an Angel refusal to `{status:false, ...}` — and even
 * `{status:true}` only means Angel took the request. So a conversion is done ONLY when a FRESH
 * position book shows it: the symbol's open rows are all carry-forward with the full quantity.
 *
 *  - every open row of the symbol is CARRYFORWARD/NRML and |netqty| sums to `qty` ⇒ CONVERTED
 *  - any open row still INTRADAY/MIS, or a split (part converted), or a short sum ⇒ NOT_CONVERTED
 *  - no open row at all ⇒ POSITION_GONE (closed meanwhile)
 */
export type ConversionCheck = 'CONVERTED' | 'NOT_CONVERTED' | 'POSITION_GONE';

export interface BookRow {
  tradingsymbol?: unknown;
  producttype?: unknown;
  netqty?: unknown;
}

const up = (x: unknown) => String(x ?? '').trim().toUpperCase();
const num = (x: unknown) => {
  const n = Number(x);
  return Number.isFinite(n) ? n : 0;
};

export function verifyConversion(positions: ReadonlyArray<BookRow>, symbol: string, qty: number): ConversionCheck {
  const want = up(symbol);
  const rows = (Array.isArray(positions) ? positions : []).filter((r) => up(r?.tradingsymbol) === want && num(r?.netqty) !== 0);
  if (rows.length === 0) return 'POSITION_GONE';
  const carried = rows.every((r) => up(r.producttype) === 'CARRYFORWARD' || up(r.producttype) === 'NRML');
  const total = rows.reduce((s, r) => s + Math.abs(num(r.netqty)), 0);
  return carried && rows.length === 1 && total === Math.abs(qty) ? 'CONVERTED' : 'NOT_CONVERTED';
}

/** The open book row for one contract (by token and exchange), or null. Used to build the conversion request. */
export function openRowFor(positions: ReadonlyArray<Record<string, unknown>>, exchange: string, token: string): Record<string, unknown> | null {
  const rows = (Array.isArray(positions) ? positions : []).filter(
    (r) => up(r?.exchange) === up(exchange) && String(r?.symboltoken ?? '').trim() === String(token).trim() && num(r?.netqty) !== 0,
  );
  return rows.length === 1 ? rows[0] : null;
}
