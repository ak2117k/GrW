import type { OptionGreekRow } from '../../market-hub/chain/chain.types';

const MONTHS = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];

/** '2026-10-13' → '13OCT2026' (Angel optionGreek `expirydate`). Throws on anything else. */
export function greekExpiry(ymd: string): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(ymd ?? '');
  const month = match ? Number(match[2]) : 0;
  if (!match || month < 1 || month > 12) {
    throw new Error(`greekExpiry: expected an expiry as YYYY-MM-DD (month 01-12), got '${ymd}'`);
  }
  return `${match[3]}${MONTHS[month - 1]}${match[1]}`;
}

/** A finite number, or null when the value is missing, blank or non-numeric (never a silent 0). */
const numOrNull = (v: unknown): number | null => {
  if (v == null || (typeof v === 'string' && v.trim() === '')) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

/**
 * Angel's optionGreek rows → OptionGreekRow. Field names per runtime sampling (see the legacy
 * mapOptionGreekData note in options-chain.service.ts): strikePrice, optionType, delta, gamma, theta,
 * vega, impliedVolatility (percent), tradeVolume. No LTP and no OI — those come from the quote call.
 *
 * A row is DROPPED (never zero-filled) when its strike is missing or ≤ 0, its side is not CE/PE, its
 * IV is missing, non-numeric or ≤ 0, or any of delta/gamma/theta/vega is missing or non-numeric. A
 * numeric 0 Greek is real and kept. A leg with no row here gets locally computed Greeks downstream,
 * labelled 'local', so a missing broker value is never passed off as a real 0.
 */
export function mapOptionGreeks(raw: unknown): OptionGreekRow[] {
  if (!Array.isArray(raw)) return [];
  const out: OptionGreekRow[] = [];
  for (const r of raw as Array<Record<string, unknown>>) {
    const strike = numOrNull(r?.strikePrice ?? r?.strikeprice);
    const side = String(r?.optionType ?? r?.opttype ?? '').toUpperCase();
    if (strike == null || strike <= 0 || (side !== 'CE' && side !== 'PE')) continue;
    const iv = numOrNull(r.impliedVolatility ?? r.iv);
    if (iv == null || iv <= 0) continue;
    const delta = numOrNull(r.delta);
    const gamma = numOrNull(r.gamma);
    const theta = numOrNull(r.theta);
    const vega = numOrNull(r.vega);
    if (delta == null || gamma == null || theta == null || vega == null) continue;
    out.push({ strike, optionType: side, iv, delta, gamma, theta, vega });
  }
  return out;
}
