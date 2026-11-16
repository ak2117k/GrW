import { AsyncLocalStorage } from 'node:async_hooks';

/**
 * Who a broker HISTORY call is for (2026-11-16). The owner's Angel account is throttled at times and every
 * getCandleData on it goes through one paced queue (UserFeedSession.paceHistorical). Work done for a REAL
 * open position runs inside `asLive(...)`; its history calls then jump ahead of background work (paper
 * sentinel, research capture, backfills) in that queue. The pacing itself is unchanged.
 */
const store = new AsyncLocalStorage<'live'>();

export function asLive<T>(fn: () => T): T {
  return store.run('live', fn);
}

export function isLiveHistorical(): boolean {
  return store.getStore() === 'live';
}
