import type { ExpiryHint, InstrumentKind } from './types';

/**
 * Expiry inference when a tip does not name one (most don't).
 *
 * First choice: the instrument master's listed expiries for the underlying (passed in as `listed`,
 * YYYY-MM-DD) — the nearest one that is still tradable at `postedAt`; with a month-only hint, that
 * month's LAST listed expiry; with a full date hint, that date if listed (else the nearest listed on
 * or after it).
 *
 * Fallback when the master is unavailable (the download failed, or a BFO expiry beyond the cached
 * 70-day BFO window): the exchange calendar rule as of the 2025 SEBI changes — NIFTY weekly (Tuesday), SENSEX
 * weekly (Thursday), every other NSE index / stock monthly on the last Tuesday, BANKEX monthly on the
 * last Thursday, MCX left unknown (contract-specific). Holidays shift the real date one trading day
 * earlier; the fallback does not know holidays and says so with `source: 'rule'`.
 */

export interface InferredExpiry {
  expiry: string | null;
  source: 'message' | 'master' | 'rule' | 'none';
}

const IST_OFFSET_MS = 330 * 60_000;
/** After this IST minute an expiring contract is no longer the one a new tip means. */
const EXPIRY_DAY_CUTOFF_MIN = 15 * 60 + 15;

const istParts = (at: Date) => {
  const d = new Date(at.getTime() + IST_OFFSET_MS);
  return { ymd: d.toISOString().slice(0, 10), min: d.getUTCHours() * 60 + d.getUTCMinutes() };
};

const pad = (n: number) => String(n).padStart(2, '0');
const ymdOf = (y: number, m: number, d: number) => `${y}-${pad(m)}-${pad(d)}`;

/** First YYYY-MM-DD a NEW position can still use at `at` (today until 15:15 IST, else tomorrow). */
export function earliestUsable(at: Date): string {
  const { ymd, min } = istParts(at);
  if (min < EXPIRY_DAY_CUTOFF_MIN) return ymd;
  const d = new Date(`${ymd}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}

export function inferExpiry(
  underlying: string,
  kind: InstrumentKind,
  hint: ExpiryHint | null,
  postedAt: Date,
  listed: readonly string[] | null,
): InferredExpiry {
  if (kind === 'EQ') return { expiry: null, source: 'none' };
  const from = earliestUsable(postedAt);
  const list = (listed ?? []).filter((e) => /^\d{4}-\d{2}-\d{2}$/.test(e)).sort();

  if (hint) {
    const year = hint.year ?? yearFor(hint.month, from);
    if (hint.day !== null) {
      const want = ymdOf(year, hint.month, hint.day);
      if (list.length === 0) return { expiry: want, source: 'message' };
      return { expiry: list.find((e) => e >= want) ?? want, source: 'message' };
    }
    const inMonth = list.filter((e) => e.startsWith(`${year}-${pad(hint.month)}`));
    if (inMonth.length) return { expiry: inMonth[inMonth.length - 1], source: 'message' };
    const rule = monthlyRule(underlying, year, hint.month);
    return { expiry: rule, source: rule ? 'rule' : 'none' };
  }

  if (list.length) {
    // Futures: nearest month; options: nearest listed (weekly where one exists).
    const next = list.find((e) => e >= from);
    if (next) return { expiry: next, source: 'master' };
  }
  const rule = ruleExpiry(underlying, kind, from);
  return { expiry: rule, source: rule ? 'rule' : 'none' };
}

function yearFor(month: number, from: string): number {
  const y = Number(from.slice(0, 4));
  const m = Number(from.slice(5, 7));
  return month < m ? y + 1 : y;
}

const WEEKLY: Record<string, number> = { NIFTY: 2, SENSEX: 4 };
const MONTHLY_DOW: Record<string, number> = { BANKEX: 4 };
const MCX = new Set(['CRUDEOIL', 'NATURALGAS', 'GOLD', 'SILVER', 'COPPER', 'ZINC']);

/** Calendar-rule expiry on or after `from` (YYYY-MM-DD). */
export function ruleExpiry(underlying: string, kind: InstrumentKind, from: string): string | null {
  if (MCX.has(underlying)) return null;
  const weekly = WEEKLY[underlying];
  if (weekly !== undefined && kind !== 'FUT') {
    const d = new Date(`${from}T00:00:00Z`);
    while (d.getUTCDay() !== weekly) d.setUTCDate(d.getUTCDate() + 1);
    return d.toISOString().slice(0, 10);
  }
  let y = Number(from.slice(0, 4));
  let m = Number(from.slice(5, 7));
  for (let k = 0; k < 2; k++) {
    const e = monthlyRule(underlying, y, m);
    if (e && e >= from) return e;
    m += 1;
    if (m > 12) {
      m = 1;
      y += 1;
    }
  }
  return null;
}

/** Last <expiry weekday> of the month: Tuesday for NSE, Thursday for SENSEX / BANKEX. */
export function monthlyRule(underlying: string, year: number, month: number): string | null {
  if (MCX.has(underlying)) return null;
  const dow = MONTHLY_DOW[underlying] ?? (underlying === 'SENSEX' ? 4 : 2);
  const d = new Date(Date.UTC(year, month, 0)); // last day of month
  while (d.getUTCDay() !== dow) d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString().slice(0, 10);
}
