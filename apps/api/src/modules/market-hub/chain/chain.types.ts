import type { OptionsChainEntry } from '@td/shared/types';
import type { HubExchange, InstrumentRef } from '../hub.types';

export type OptionSide = 'CE' | 'PE';

/** Where a chain's Greeks came from; 'none' = no Greeks available for any leg. */
export type ChainGreeksSource = 'broker' | 'local' | 'none';

/** One contract's Greeks from Angel's optionGreek (IV in PERCENT, e.g. 13.36). */
export interface OptionGreekRow {
  strike: number;
  optionType: OptionSide;
  iv: number;
  delta: number;
  gamma: number;
  theta: number;
  vega: number;
}

/** One option contract from the DB instrument master (strike in rupees). */
export interface ChainContract {
  instrumentId: string;
  ref: InstrumentRef;
  strike: number;
  optionType: OptionSide;
  lotSize: number;
}

/** A built chain. `entries` is the shared wire shape, so snapshots and legacy readers share it. */
export interface HubChain {
  underlying: string;
  /** YYYY-MM-DD */
  expiry: string;
  /** NFO or MCX: the venue whose session decides fresh / market-closed. */
  exchange: HubExchange;
  spot: number | null;
  /** ms epoch the prices were current (the quote call's completion). */
  at: number;
  greeks: ChainGreeksSource;
  entries: OptionsChainEntry[];
}

/** One OI snapshot row (`oi_snapshots`). */
export interface OiRow {
  instrumentId: string;
  oi: number;
  oiChange: number | null;
  volume: number;
  at: Date;
}

/** Why a chain could not be built (REST 503 reason). */
export type ChainUnavailable = 'no-contracts' | 'throttled' | 'busy' | 'no-session' | 'error';

export type ChainResult =
  | { kind: 'fresh'; chain: HubChain }
  | { kind: 'stale'; chain: HubChain; ageMs: number }
  | { kind: 'market-closed'; chain: HubChain }
  | { kind: 'unavailable'; reason: ChainUnavailable };

export interface ChainRequest {
  /** A screen (GET /api/options/chain): renews the 2-min refresh watch and marks the underlying viewed today. */
  screen?: boolean;
}

export interface HubChains {
  chain(underlying: string, expiry: string, opts?: ChainRequest): Promise<ChainResult>;
  expiries(underlying: string): Promise<string[]>;
  optionLtp(underlying: string, expiry: string, strike: number, type: OptionSide): Promise<number | null>;
}

export interface ChainStatus {
  builds: number;
  buildP95Ms: number;
  cacheHits: number;
  greeksLocal: number;
  unavailable: Record<ChainUnavailable, number>;
  baselineFailures: number;
  watched: number;
  held: number;
  viewedToday: number;
  snapshot: { enabled: boolean; rowsToday: number; failures: number; lastAt: Record<string, number> };
}
