import type { InstrumentKind } from './types';

/** A strike further than this from its index's spot is not that index's (audit 2026-11-27). */
export const STRIKE_BAND = 0.15;
/** The derivative indices a mis-named option call is re-matched against, in liquidity order (the last tie-break). */
export const REMATCH_INDICES: readonly string[] = ['NIFTY', 'BANKNIFTY', 'SENSEX', 'FINNIFTY', 'MIDCPNIFTY', 'BANKEX'];
/** Strike step per index: a strike off the step cannot be that index's (controller ruling 2026-11-28). */
export const STRIKE_STEP: Readonly<Record<string, number>> = { NIFTY: 50, FINNIFTY: 50, MIDCPNIFTY: 50, BANKNIFTY: 100, BANKEX: 100, SENSEX: 100 };

export type StrikeCheck =
  | { action: 'keep' }
  | { action: 'rematch'; underlying: string; from: string; candidates: string[] }
  | { action: 'unresolved'; fits: string[] };

const distance = (strike: number, spot: number) => Math.abs(strike - spot) / spot;
const onStep = (strike: number, u: string) => {
  const step = STRIKE_STEP[u];
  return !step || Math.abs(strike / step - Math.round(strike / step)) < 1e-9;
};

/**
 * Strike sanity for an index option call: a strike > 15% from the named index's spot ("SENSEX 25850 PE" — SHRI RAM,
 * prod 2026-11-27) is re-matched against the other indices whose spot is within 15% and whose strike step the strike
 * is on. Several fit → the one whose spot is closest to the strike (in %), then liquidity order
 * NIFTY > BANKNIFTY > SENSEX > FINNIFTY > MIDCPNIFTY > BANKEX (controller ruling 2026-11-28). None → unresolved (the
 * call stays as named, as today). Only CE / PE on an index whose spot is known are checked.
 */
export function rematchStrike(
  p: { underlying: string; instrumentKind: InstrumentKind; strike: number | null },
  spots: ReadonlyMap<string, number>,
): StrikeCheck {
  if ((p.instrumentKind !== 'CE' && p.instrumentKind !== 'PE') || p.strike === null || !(p.strike > 0)) return { action: 'keep' };
  if (!REMATCH_INDICES.includes(p.underlying)) return { action: 'keep' };
  const own = spots.get(p.underlying);
  const strike = p.strike;
  if (!own || !(own > 0) || distance(strike, own) <= STRIKE_BAND) return { action: 'keep' };
  const fits = REMATCH_INDICES.filter((u) => {
    if (u === p.underlying) return false;
    const s = spots.get(u);
    return !!s && s > 0 && distance(strike, s) <= STRIKE_BAND && onStep(strike, u);
  });
  if (fits.length === 0) return { action: 'unresolved', fits };
  const ranked = [...fits].sort((a, b) => {
    const d = distance(strike, spots.get(a) as number) - distance(strike, spots.get(b) as number);
    return Math.abs(d) > 1e-12 ? d : REMATCH_INDICES.indexOf(a) - REMATCH_INDICES.indexOf(b);
  });
  return { action: 'rematch', underlying: ranked[0], from: p.underlying, candidates: ranked };
}
