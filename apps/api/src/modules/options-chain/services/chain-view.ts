import type { OptionsChainEntry, OptionsChainView } from '@td/shared/types';
import type { ChainResult } from '../../market-hub/chain/chain.types';

/** The legacy path's answer, labelled with where it came from and when its prices were current. */
export interface LegacyChain {
  chain: OptionsChainEntry[];
  spotPrice: number;
  source: 'nse' | 'snapshot' | 'legacy';
  at: number;
}

const LEGACY_FRESH_MS = 60_000;

export function viewFromHub(res: ChainResult, now: number): OptionsChainView {
  if (res.kind === 'unavailable') {
    return { chain: [], spotPrice: null, at: new Date(now).toISOString(), source: 'hub', status: 'unavailable', unavailable: res.reason };
  }
  const c = res.chain;
  return { chain: c.entries, spotPrice: c.spot, at: new Date(c.at).toISOString(), source: 'hub', status: res.kind, greeks: c.greeks };
}

/** Legacy chains are labelled by their own age (the 60 s rule loadTodaysSnapshot already uses). */
export function legacyView(l: LegacyChain, now: number, marketHours: boolean): OptionsChainView {
  const status = now - l.at <= LEGACY_FRESH_MS ? 'fresh' : marketHours ? 'stale' : 'market-closed';
  return {
    chain: l.chain,
    spotPrice: l.spotPrice > 0 ? l.spotPrice : null,
    at: new Date(l.at).toISOString(),
    source: l.source,
    status,
  };
}
