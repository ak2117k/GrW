import { US_CUE_KEYS, type CueRecord, type MarketCuesSnapshot, type UsCueKey, type UsQuote } from './market-cues.types';

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
  return { enabled: false, us, fiiDii: none(), fiiOi: none(), gift: none(), preOpen: none() };
}
