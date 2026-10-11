import type { OptionGreekRow } from '../../market-hub/chain/chain.types';

const MONTHS = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];

/** '2026-10-13' → '13OCT2026' (Angel optionGreek `expirydate`). */
export function greekExpiry(ymd: string): string {
  const [y, m, d] = ymd.split('-');
  return `${d}${MONTHS[Number(m) - 1]}${y}`;
}

const num = (v: unknown): number => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};

/**
 * Angel's optionGreek rows → OptionGreekRow. Field names per runtime sampling (see the legacy
 * mapOptionGreekData note in options-chain.service.ts): strikePrice, optionType, delta, gamma, theta,
 * vega, impliedVolatility (percent), tradeVolume. No LTP and no OI — those come from the quote call.
 */
export function mapOptionGreeks(raw: unknown): OptionGreekRow[] {
  if (!Array.isArray(raw)) return [];
  const out: OptionGreekRow[] = [];
  for (const r of raw as Array<Record<string, unknown>>) {
    const strike = num(r?.strikePrice ?? r?.strikeprice);
    const side = String(r?.optionType ?? r?.opttype ?? '').toUpperCase();
    if (strike <= 0 || (side !== 'CE' && side !== 'PE')) continue;
    out.push({
      strike,
      optionType: side,
      iv: num(r.impliedVolatility ?? r.iv),
      delta: num(r.delta),
      gamma: num(r.gamma),
      theta: num(r.theta),
      vega: num(r.vega),
    });
  }
  return out;
}
