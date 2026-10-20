/**
 * Seams to other streams/modules, so the engine builds and tests with fakes.
 *
 * Stream A (apps/api/src/modules/mbm/chain-watchlist.ts) provides `latestChain(symbol)`,
 * `chainHistory(symbol, sessions)` and `ChainWatchlist.add(symbols, ttlHours)`. Until it is merged the
 * module binds the stubs below: the OI factor then reads `available:false` and the watchlist add is a
 * no-op. At merge, bind SCORECARD_CHAINS / SCORECARD_WATCHLIST to adapters over A's helpers.
 */
import type { ChainSnapshotRow } from '../mbm/domain/chain-snapshot';
import type { Scorecard } from './scorecard.types';

export interface ChainReader {
  /** Newest snapshot for the underlying (index or stock), or null when none exists. */
  latest(symbol: string): Promise<ChainSnapshotRow | null>;
  /** One snapshot per prior session (oldest first), at most `sessions`. */
  history(symbol: string, sessions: number): Promise<ChainSnapshotRow[]>;
}

export interface WatchlistWriter {
  add(symbols: ReadonlyArray<{ symbol: string; exchange: string }>, ttlHours: number): Promise<void>;
}

export const SCORECARD_CHAINS = Symbol('SCORECARD_CHAINS');
export const SCORECARD_WATCHLIST = Symbol('SCORECARD_WATCHLIST');

/** Pre-merge stub: no per-symbol chain data yet ⇒ OI unavailable. */
export const UNAVAILABLE_CHAINS: ChainReader = {
  latest: async () => null,
  history: async () => [],
};

/** Pre-merge stub: registering news symbols for capture is a no-op. */
export const NOOP_WATCHLIST: WatchlistWriter = { add: async () => undefined };

/**
 * Stream C's sentinel port (`ScorecardProvider { latest(userId, trackerId) }`), implemented by
 * `ScorecardService.latest`. The orchestrator binds C's token to `ScorecardService` at merge.
 */
export interface ScorecardProviderLike {
  latest(userId: string, trackerId: string): Promise<Scorecard | null>;
}

/** The Messages seam the sentinel uses (re-declared narrowly to avoid importing the sentinel module). */
export const SCORECARD_LLM = Symbol('SCORECARD_LLM');
