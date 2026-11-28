import { MCX_UNDERLYINGS } from './mcx-underlyings';
import type { ExpiryHint, InstrumentKind } from './types';

/**
 * Expiry inference when a tip does not name one (most don't).
 *
 * First choice: the instrument master's listed expiries for the underlying (passed in as `listed`,
 * YYYY-MM-DD) — the nearest one that is still tradable at `postedAt`; with a month-only hint, that
 * month's LAST live expiry; with a full date hint, exactly that date (a holiday-shifted nominal day maps to
 * the listed one 1–2 days earlier; anything else is a mismatch, never another listed expiry).
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
  /**
   * Set when the post NAMES an expiry the master does not list as live (audit 2026-11-28). `expiry` is then the
   * named date itself (or the named month's calendar monthly / last day) — never another listed contract — so
   * the trader's exact-expiry resolve refuses it. (Edge: a month-only hint posted after the cutoff on that month's
   * last expiry day keeps a date that is still listed; that is the contract the post named.)
   */
  mismatch?: string;
  /**
   * A named day that is not listed, taken as the one listed expiry of the same month 1–2 calendar days earlier
   * (an exchange holiday moves an expiry earlier; ruling 2026-11-28). Only when the named day is the underlying's
   * normal expiry weekday (and, for a monthly-only underlying, in the last week of the month); never on MCX.
   */
  expiryShifted?: { named: string; listed: string };
}

export interface InferOptions {
  /** The contract's segment (NFO / BFO / MCX): MCX has its own session cutoff and never holiday-shifts. */
  exchange?: string | null;
}

const IST_OFFSET_MS = 330 * 60_000;
/** After this IST minute an expiring NSE / BSE contract is no longer the one a new tip means. */
const EXPIRY_DAY_CUTOFF_MIN = 15 * 60 + 15;
/** MCX trades its expiring contract until the session close (23:30 IST; 23:55 in the US winter — 23:30 is the safe one). */
const MCX_EXPIRY_DAY_CUTOFF_MIN = 23 * 60 + 30;

const istParts = (at: Date) => {
  const d = new Date(at.getTime() + IST_OFFSET_MS);
  return { ymd: d.toISOString().slice(0, 10), min: d.getUTCHours() * 60 + d.getUTCMinutes() };
};

const pad = (n: number) => String(n).padStart(2, '0');
const ymdOf = (y: number, m: number, d: number) => `${y}-${pad(m)}-${pad(d)}`;

/** First YYYY-MM-DD a NEW position can still use at `at` (today until 15:15 IST — 23:30 on MCX — else tomorrow). */
export function earliestUsable(at: Date, exchange?: string | null): string {
  const { ymd, min } = istParts(at);
  if (min < (exchange === 'MCX' ? MCX_EXPIRY_DAY_CUTOFF_MIN : EXPIRY_DAY_CUTOFF_MIN)) return ymd;
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
  opts: InferOptions = {},
): InferredExpiry {
  if (kind === 'EQ') return { expiry: null, source: 'none' };
  const mcx = opts.exchange === 'MCX' || MCX_UNDERLYINGS.has(underlying);
  // A post with no named expiry keeps the default 15:15 cutoff on every exchange (on an MCX expiry evening the next
  // contract, as before). Only a NAMED day / month uses MCX's session close (re-review 2026-11-29).
  const from = earliestUsable(postedAt);
  const list = (listed ?? []).filter((e) => /^\d{4}-\d{2}-\d{2}$/.test(e)).sort();

  if (hint && hint.month >= 1 && hint.month <= 12) {
    const nFrom = mcx ? earliestUsable(postedAt, 'MCX') : from;
    return namedExpiry(underlying, kind, hint, nFrom, list, mcx);
  }

  const live = list.filter((e) => e >= from);
  if (hint?.relative) return relativeExpiry(underlying, kind, hint.relative, from, list, live);

  if (list.length) {
    // Futures: nearest month; options: nearest listed (weekly where one exists).
    const next = list.find((e) => e >= from);
    if (next) return { expiry: next, source: 'master' };
  }
  const rule = ruleExpiry(underlying, kind, from);
  return { expiry: rule, source: rule ? 'rule' : 'none' };
}

/** A day + month or month-only hint (`from`: the first usable day for a named expiry on this exchange). */
function namedExpiry(underlying: string, kind: InstrumentKind, hint: ExpiryHint, from: string, list: readonly string[], mcx: boolean): InferredExpiry {
  const live = list.filter((e) => e >= from);
  const shown = () => (live.length ? live.slice(0, 6).join(', ') : 'none');
  const year = hint.year ?? yearFor(hint.month, from);
  if (hint.day !== null) {
    // The named day exactly: a day the master does not list is a mismatch, never the next listed one. A listed
    // day is kept even after the cutoff on that day (the post names it; the market clock decides).
    const want = ymdOf(year, hint.month, hint.day);
    if (list.length === 0) return { expiry: want, source: 'message' };
    if (list.includes(want)) return { expiry: want, source: 'message' };
    const shifted = mcx ? null : holidayShift(want, list, from);
    if (shifted) return { expiry: shifted, source: 'message', expiryShifted: { named: want, listed: shifted } };
    const why = want < from ? 'has already expired' : 'is not listed';
    return { expiry: want, source: 'message', mismatch: `named expiry ${want} ${why} for ${underlying} ${kind} (live: ${shown()})` };
  }
  const month = `${year}-${pad(hint.month)}`;
  const inMonth = live.filter((e) => e.startsWith(month));
  if (inMonth.length) return { expiry: inMonth[inMonth.length - 1], source: 'message' };
  const rule = monthlyRule(underlying, year, hint.month);
  if (list.length === 0) return { expiry: rule, source: rule ? 'rule' : 'none' };
  // Listed, but nothing live in the named month: name that month's calendar monthly (or its last day) so no
  // listed contract of another month is picked.
  const want = rule ?? ymdOf(year, hint.month, new Date(Date.UTC(year, hint.month, 0)).getUTCDate());
  return { expiry: want, source: 'message', mismatch: `named expiry month ${month} has no live ${underlying} ${kind} expiry (live: ${shown()})` };
}

/** The underlying lists more than one expiry in some month (a weekly series). */
const hasWeeklies = (list: readonly string[]) => {
  const months = list.map((e) => e.slice(0, 7));
  return months.some((m, i) => months.indexOf(m) !== i);
};

/**
 * "weekly" / "this expiry" → the nearest live; "next expiry" → the one after it; "next week expiry" → the same on a
 * weekly underlying, a mismatch on a monthly-only one (never next month's); "monthly" → the last live expiry in the
 * nearest live expiry's month. Without the master: the calendar rule, source 'rule'.
 */
function relativeExpiry(
  underlying: string,
  kind: InstrumentKind,
  r: NonNullable<ExpiryHint['relative']>,
  from: string,
  list: readonly string[],
  live: readonly string[],
): InferredExpiry {
  if (live.length) {
    if (r === 'NEXT_WEEK' && !hasWeeklies(list)) {
      // A monthly-only underlying has no next week's expiry: the day after the nearest is never listed.
      return { expiry: dayAfter(live[0]), source: 'message', mismatch: `"next week expiry" named but ${underlying} ${kind} has no weekly expiries (live: ${live.slice(0, 3).join(', ')})` };
    }
    if (r === 'NEXT' || r === 'NEXT_WEEK') {
      if (live[1]) return { expiry: live[1], source: 'message' };
      // Only one live: name the calendar's next one (never the nearest), so nothing listed matches.
      const next = ruleExpiry(underlying, kind, dayAfter(live[0])) ?? dayAfter(live[0]);
      return { expiry: next, source: 'message', mismatch: `"next expiry" named but only ${live[0]} is live for ${underlying} ${kind}` };
    }
    if (r === 'MONTHLY') {
      const month = live[0].slice(0, 7);
      const inMonth = live.filter((e) => e.startsWith(month));
      return { expiry: inMonth[inMonth.length - 1], source: 'message' };
    }
    return { expiry: live[0], source: 'message' };
  }
  const near = ruleExpiry(underlying, kind, from);
  if (!near) return { expiry: null, source: 'none' };
  if (r === 'NEXT_WEEK' && (WEEKLY[underlying] === undefined || kind === 'FUT')) {
    return { expiry: dayAfter(near), source: 'message', mismatch: `"next week expiry" named but ${underlying} ${kind} has no weekly expiries` };
  }
  if (r === 'NEXT' || r === 'NEXT_WEEK') {
    const next = ruleExpiry(underlying, kind, dayAfter(near));
    return { expiry: next, source: next ? 'rule' : 'none' };
  }
  if (r === 'MONTHLY') {
    const m = monthlyRule(underlying, Number(near.slice(0, 4)), Number(near.slice(5, 7)));
    return { expiry: m, source: m ? 'rule' : 'none' };
  }
  return { expiry: near, source: 'rule' };
}

const dowOf = (ymd: string) => new Date(`${ymd}T00:00:00Z`).getUTCDay();

/** The weekday most of the listed expiries fall on (holiday-shifted ones are the exception). */
function normalExpiryWeekday(list: readonly string[]): number | null {
  const n = new Array<number>(7).fill(0);
  for (const e of list) n[dowOf(e)]++;
  const best = Math.max(...n);
  return best > 0 ? n.indexOf(best) : null;
}

/**
 * The one listed (and still usable) expiry 1–2 calendar days before a named day, in the same month; else null.
 * The named day must be the underlying's normal expiry weekday (from the master) — "by DEC 31" / "till 2 DEC" /
 * SENSEX's "03 DEC" on a NIFTY call are not holiday shifts — and, for a monthly-only underlying, in the last
 * week of its month.
 * Known residual (accepted, re-review 2026-11-29): a commentary date that happens to fall on a shifted nominal
 * expiry day ("target by 26 JAN" on NIFTY, a Tuesday) still shifts to that listed expiry (25-Jan).
 */
function holidayShift(want: string, list: readonly string[], from: string): string | null {
  if (dowOf(want) !== normalExpiryWeekday(list)) return null;
  if (!hasWeeklies(list)) {
    const y = Number(want.slice(0, 4));
    const m = Number(want.slice(5, 7));
    const lastDay = new Date(Date.UTC(y, m, 0)).getUTCDate();
    if (Number(want.slice(8, 10)) <= lastDay - 7) return null;
  }
  const back = (n: number) => {
    const d = new Date(`${want}T00:00:00Z`);
    d.setUTCDate(d.getUTCDate() - n);
    return d.toISOString().slice(0, 10);
  };
  const hits = [back(1), back(2)].filter((e) => e.slice(0, 7) === want.slice(0, 7) && e >= from && list.includes(e));
  return hits.length === 1 ? hits[0] : null;
}

function dayAfter(ymd: string): string {
  const d = new Date(`${ymd}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}

function yearFor(month: number, from: string): number {
  const y = Number(from.slice(0, 4));
  const m = Number(from.slice(5, 7));
  return month < m ? y + 1 : y;
}

const WEEKLY: Record<string, number> = { NIFTY: 2, SENSEX: 4 };
const MONTHLY_DOW: Record<string, number> = { BANKEX: 4 };

/** Calendar-rule expiry on or after `from` (YYYY-MM-DD). */
export function ruleExpiry(underlying: string, kind: InstrumentKind, from: string): string | null {
  if (MCX_UNDERLYINGS.has(underlying)) return null;
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
  if (MCX_UNDERLYINGS.has(underlying)) return null;
  const dow = MONTHLY_DOW[underlying] ?? (underlying === 'SENSEX' ? 4 : 2);
  const d = new Date(Date.UTC(year, month, 0)); // last day of month
  while (d.getUTCDay() !== dow) d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString().slice(0, 10);
}
