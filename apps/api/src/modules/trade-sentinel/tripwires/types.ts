import type { Segment, Side } from '../charges';

/**
 * What every sensor sees. Deliberately narrow: a tripwire may only look at data
 * the poller already has, because tripwires run on EVERY tick for every watched
 * position and must stay free.
 */
export interface TripwireInput {
  trackerId: string;
  symbol: string;
  segment: Segment;
  side: Side;
  entryPrice: number;
  qty: number;
  ltp: number;
  holdingHigh: number | null;
  holdingLow: number | null;
  /** Nearest support/resistance from the level book, if the symbol has one. */
  nearestSupport: number | null;
  nearestResistance: number | null;
  /** Session volume vs the 20-day average, as a ratio. Null when unavailable. */
  volumeRatio: number | null;
  /** Current OI walls and the previous snapshot, for shift detection. */
  oiWallNow: { callWall: number | null; putWall: number | null } | null;
  oiWallPrev: { callWall: number | null; putWall: number | null } | null;
  /** Headline count for this symbol in the last 30 minutes. */
  freshNewsCount: number | null;
  /** Non-stub context factors, keyed by factor name, value in [-1, 1]. */
  factorValues: Record<string, number>;
  /** The same factors as of the previous evaluation, for flip detection. */
  prevFactorValues: Record<string, number>;
}

/** A sensor firing. It reports WHAT CHANGED — never what to do about it. */
export interface TripwireFire {
  name: string;
  detail: string;
}

export interface Tripwire {
  readonly name: string;
  /** Returns a fire, or null when nothing noteworthy changed. */
  check(input: TripwireInput): TripwireFire | null;
}
