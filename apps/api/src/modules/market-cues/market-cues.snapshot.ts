import {
  COMMODITY_CUE_KEYS,
  US_CUE_KEYS,
  type CommodityCueKey,
  type CommodityQuote,
  type CueRecord,
  type MarketCuesSnapshot,
  type UsCueKey,
  type UsQuote,
} from './market-cues.types';

/**
 * A snapshot in which every cue is unavailable for one stated reason — for a
 * consumer that cannot reach the service at all (not wired into the process,
 * or it threw). Pure; imports only types.
 */
export function unavailableSnapshot(reason: string): MarketCuesSnapshot {
  const none = <T>(): CueRecord<T> => ({
    values: null,
    sourceTime: null,
    fetchedAt: null,
    basis: '',
    source: 'market-cues',
    status: 'unavailable',
    reason,
  });
  const us = {} as Record<UsCueKey, CueRecord<UsQuote>>;
  for (const k of US_CUE_KEYS) us[k] = none<UsQuote>();
  const commodities = {} as Record<CommodityCueKey, CueRecord<CommodityQuote>>;
  for (const k of COMMODITY_CUE_KEYS) commodities[k] = none<CommodityQuote>();
  return { enabled: false, us, commodities, fiiDii: none(), fiiOi: none(), gift: none(), preOpen: none() };
}
