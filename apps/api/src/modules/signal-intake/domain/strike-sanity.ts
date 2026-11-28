import type { InstrumentKind } from './types';

/** A strike further than this from its index's spot is not that index's (audit 2026-11-27). */
export const STRIKE_BAND = 0.15;
/** The derivative indices a mis-named option call is re-matched against. */
export const REMATCH_INDICES: readonly string[] = ['NIFTY', 'BANKNIFTY', 'SENSEX', 'FINNIFTY', 'MIDCPNIFTY', 'BANKEX'];

export type StrikeCheck = { action: 'keep' } | { action: 'rematch'; underlying: string; from: string } | { action: 'unresolved'; fits: string[] };

const within = (strike: number, spot: number) => Math.abs(strike - spot) / spot <= STRIKE_BAND;

/**
 * Strike sanity for an index option call: a strike > 15% from the named index's spot ("SENSEX 25850 PE" — SHRI RAM,
 * prod 2026-11-27) is re-matched against the other indices whose spot is within 15%. Exactly one fit → that index;
 * none or several → unresolved (the call stays as named and resolves as it does today). Only CE / PE on an index
 * whose spot is known are checked.
 */
export function rematchStrike(
  p: { underlying: string; instrumentKind: InstrumentKind; strike: number | null },
  spots: ReadonlyMap<string, number>,
): StrikeCheck {
  if ((p.instrumentKind !== 'CE' && p.instrumentKind !== 'PE') || p.strike === null || !(p.strike > 0)) return { action: 'keep' };
  if (!REMATCH_INDICES.includes(p.underlying)) return { action: 'keep' };
  const own = spots.get(p.underlying);
  if (!own || !(own > 0) || within(p.strike, own)) return { action: 'keep' };
  const fits = REMATCH_INDICES.filter((u) => {
    if (u === p.underlying) return false;
    const s = spots.get(u);
    return !!s && s > 0 && within(p.strike as number, s);
  });
  return fits.length === 1 ? { action: 'rematch', underlying: fits[0], from: p.underlying } : { action: 'unresolved', fits };
}
