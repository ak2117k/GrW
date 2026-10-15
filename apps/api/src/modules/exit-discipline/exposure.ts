import type { Exposure, PositionSide } from './types';

export type ContractKind = 'CE' | 'PE' | 'FUT' | 'CASH';

/** From the broker tradingsymbol: `…9000CE`, `…24000PE`, `…FUT`; anything else is cash. */
export function contractKindOf(symbol: string): ContractKind {
  const s = String(symbol ?? '').toUpperCase().trim();
  if (/\d(CE)$/.test(s)) return 'CE';
  if (/\d(PE)$/.test(s)) return 'PE';
  if (/FUT$/.test(s)) return 'FUT';
  return 'CASH';
}

/** A put flips the direction: long PE / short CE are hurt by a RISING underlying. */
export function exposureOf(symbol: string, side: PositionSide): Exposure {
  const put = contractKindOf(symbol) === 'PE';
  const long = side === 'LONG';
  return long !== put ? 'BULLISH' : 'BEARISH';
}
