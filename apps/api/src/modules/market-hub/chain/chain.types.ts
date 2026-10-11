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
