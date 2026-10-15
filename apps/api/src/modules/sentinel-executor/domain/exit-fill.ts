// apps/api/src/modules/sentinel-executor/domain/exit-fill.ts
/**
 * E5 (exit discipline plan Task 13): what the broker's ORDER BOOK says about an
 * exit order's fill. Pure; reads rows only.
 */
const MONTHS: Record<string, number> = { JAN: 0, FEB: 1, MAR: 2, APR: 3, MAY: 4, JUN: 5, JUL: 6, AUG: 7, SEP: 8, OCT: 9, NOV: 10, DEC: 11 };
const IST_OFFSET_MS = 5.5 * 3_600_000;

/**
 * Angel order-book time (IST wall clock: `dd-MMM-yyyy HH:mm:ss` or
 * `yyyy-MM-dd HH:mm:ss`) → instant. Null for anything unparseable or impossible.
 */
export function parseAngelIstTimestamp(raw: unknown): Date | null {
  if (typeof raw !== 'string') return null;
  const s = raw.trim();
  let y: number, mo: number, d: number, h: number, mi: number, se: number;
  let m = /^(\d{2})-([A-Za-z]{3})-(\d{4}) (\d{2}):(\d{2}):(\d{2})$/.exec(s);
  if (m) {
    const mon = MONTHS[m[2].toUpperCase()];
    if (mon === undefined) return null;
    [d, mo, y, h, mi, se] = [Number(m[1]), mon, Number(m[3]), Number(m[4]), Number(m[5]), Number(m[6])];
  } else {
    m = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})$/.exec(s);
    if (!m) return null;
    [y, mo, d, h, mi, se] = [Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4]), Number(m[5]), Number(m[6])];
  }
  if (h > 23 || mi > 59 || se > 59) return null;
  const utc = Date.UTC(y, mo, d, h, mi, se) - IST_OFFSET_MS;
  const back = new Date(utc + IST_OFFSET_MS);
  if (back.getUTCDate() !== d || back.getUTCMonth() !== mo) return null; // 32-Oct, 30-Feb
  return new Date(utc);
}

export interface OrderFill { status: string; text: string; averagePrice: number | null; filledQty: number | null; fillAt: Date | null }

type Row = Record<string, unknown>;
const positive = (x: unknown): number | null => {
  if (x === null || x === undefined || (typeof x === 'string' && x.trim() === '')) return null;
  const n = Number(x);
  return Number.isFinite(n) && n > 0 ? n : null;
};

/** Our order in the book by id, with its fill (price/qty/exchange time). Null when the book has no such order. */
export function findOrderFill(rows: unknown[], orderId: string): OrderFill | null {
  const r = (rows as Row[]).find((o) => o !== null && typeof o === 'object' && String(o.orderid ?? '') === orderId);
  if (!r) return null;
  return {
    status: String(r.status ?? r.orderstatus ?? '').toLowerCase(),
    text: String(r.text ?? ''),
    averagePrice: positive(r.averageprice),
    filledQty: positive(r.filledshares),
    fillAt: parseAngelIstTimestamp(r.exchorderupdatetime) ?? parseAngelIstTimestamp(r.exchtime) ?? parseAngelIstTimestamp(r.updatetime),
  };
}
