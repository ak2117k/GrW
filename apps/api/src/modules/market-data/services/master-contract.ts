import type { UpsertInstrumentInput } from '../repositories/market-data.repository';

/**
 * Turning Angel One's scrip-master rows into instrument rows, for DERIVATIVES.
 *
 * The refresh persisted cash equities only, on the stated grounds that F&O
 * contracts "carry strike/expiry/optionType that this flat upsert shape cannot
 * represent". That is no longer true — `UpsertInstrumentInput` and the
 * `Instrument` model both carry all three — and the omission was breaking three
 * subsystems at once:
 *
 *   - the sentinel could not map an option token to its underlying, losing 12
 *     of 24 packet fields on every derivative position;
 *   - `OptionsChainService.getExpiries` had no expiry source, so OI walls
 *     never worked and the `oiWallShift` tripwire has never fired;
 *   - no expiry meant no theta reasoning on a near-dated option.
 *
 * See docs/superpowers/specs/2026-08-17-derivative-instrument-master-design.md.
 */

/**
 * Angel's segment labels for derivatives we persist.
 *
 * NFO AND MCX ONLY, and the omissions are a sizing decision rather than an
 * oversight. Measured against the live master: NFO 35,282 and MCX 16,699 live
 * contracts, against BFO 40,880 and CDS 9,703. Including all four would take
 * the table from 23,239 rows to 102,564 — and every active row is boot memory,
 * because `InstrumentService` primes a token cache from all of them at startup.
 *
 * BFO (BSE derivatives) and CDS (currency) are excluded because no position has
 * ever been held in either. Add a segment here the day that stops being true —
 * nothing else needs to change.
 */
export const DERIVATIVE_SEGMENTS = new Set(['NFO', 'MCX']);

const MONTHS: Record<string, number> = {
  JAN: 0, FEB: 1, MAR: 2, APR: 3, MAY: 4, JUN: 5,
  JUL: 6, AUG: 7, SEP: 8, OCT: 9, NOV: 10, DEC: 11,
};

/**
 * Angel writes expiries as `28AUG2025`, and sometimes `28AUG25`.
 *
 * Built at LOCAL midnight, matching how `OptionsChainService` already reads
 * these — that service has an explicit note about not using `toISOString()` on
 * them, because a local-midnight date shifts to the previous day once the UTC
 * offset crosses midnight, and a Monday expiry silently becomes Sunday.
 *
 * Returns null rather than an Invalid Date: a contract whose expiry cannot be
 * read must be skipped, not stored with a date nobody can trust.
 */
export function parseMasterExpiry(raw: unknown): Date | null {
  const text = String(raw ?? '').trim().toUpperCase();
  const m = /^(\d{1,2})([A-Z]{3})(\d{2}|\d{4})$/.exec(text);
  if (!m) return null;

  const day = Number(m[1]);
  const month = MONTHS[m[2]];
  if (month === undefined) return null;
  // A two-digit year is 20xx: this master carries no pre-2000 contracts.
  const year = m[3].length === 2 ? 2000 + Number(m[3]) : Number(m[3]);

  const date = new Date(year, month, day);
  if (Number.isNaN(date.getTime())) return null;
  // Reject a rolled-over date — `new Date(2026, 1, 31)` silently becomes March.
  if (date.getDate() !== day || date.getMonth() !== month) return null;
  return date;
}

/**
 * Angel quotes strikes in PAISE — `580000` is ₹5,800.
 *
 * Storing the raw number would put a KEI 5800 strike at 580000 on a chart whose
 * price axis runs near 5,800, and every comparison against spot would read as
 * astronomically out of the money.
 */
export function parseMasterStrike(raw: unknown): number | null {
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return null;
  return n / 100;
}

/** `OPTIDX`/`OPTSTK` carry CE or PE; futures carry neither. */
export function parseOptionType(symbol: string, instrumentType: string): string | null {
  if (!/^OPT/i.test(instrumentType)) return null;
  const m = /(CE|PE)$/i.exec(String(symbol ?? '').trim());
  return m ? m[1].toUpperCase() : null;
}

/**
 * One master row → an instrument row, or null to skip it.
 *
 * Skips anything that is not a live derivative: wrong segment, no expiry, an
 * expiry already past, or a missing symbol/token. `today` is injected so the
 * expiry cut-off is testable without freezing the clock.
 */
export function toDerivativeInput(
  row: Record<string, unknown>,
  today: Date = new Date(),
): UpsertInstrumentInput | null {
  const exchange = String(row?.exch_seg ?? '').trim().toUpperCase();
  if (!DERIVATIVE_SEGMENTS.has(exchange)) return null;

  const symbol = String(row?.symbol ?? '').trim();
  const token = String(row?.token ?? '').trim();
  if (!symbol || !token) return null;

  const expiry = parseMasterExpiry(row?.expiry);
  if (!expiry) return null;

  // EXPIRED CONTRACTS ARE NEVER WRITTEN. The master carries every strike of
  // every past expiry; without this bound the table would grow without limit
  // and the boot cache with it. Compared at local midnight so a contract
  // expiring TODAY is still live — it trades until the close.
  const midnight = new Date(today.getFullYear(), today.getMonth(), today.getDate());
  if (expiry < midnight) return null;

  const instrumentType = String(row?.instrumenttype ?? '').trim();

  return {
    symbol,
    token,
    // THE FIELD THAT UNBLOCKS THE SENTINEL. Angel puts the UNDERLYING here —
    // `KEI` for `KEI29SEP265800CE` — and `resolveUnderlying` already reads
    // `.name`. It was finding no row at all, not a row with a bad name.
    name: String(row?.name ?? symbol).trim() || symbol,
    exchange,
    segment: exchange,
    lotSize: Number.parseInt(String(row?.lotsize ?? '1'), 10) || 1,
    tickSize: Number.parseFloat(String(row?.tick_size ?? '0.05')) || 0.05,
    expiry,
    strike: parseMasterStrike(row?.strike) ?? undefined,
    optionType: parseOptionType(symbol, instrumentType) ?? undefined,
  };
}
