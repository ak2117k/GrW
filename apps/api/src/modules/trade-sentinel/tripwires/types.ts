import type { Segment, Side } from '../charges';

/**
 * What every sensor sees. Deliberately narrow: a tripwire may only look at data
 * the poller already has, because tripwires run on EVERY tick for every watched
 * position and must stay free.
 *
 * SCALE HAZARD — read before comparing a price against a level. Two different
 * price scales live in this struct. `ltp` is always the watched contract's OWN
 * price, which for an OPT position is the premium (e.g. 120) and for a FUT
 * position is the futures price. But `nearestSupport`, `nearestResistance` and
 * the OI wall strikes are always on the UNDERLYING's scale (e.g. 24000).
 * Comparing the two directly on a derivatives position is meaningless and will
 * read as a permanent breach on every tick. Any sensor that compares a price
 * against a level or a wall MUST use `underlyingLtp` when it is non-null, and
 * fall back to `ltp` only for cash segments where the two coincide. Sensors that
 * compare a price against the position's own entry or extremes (giveback, for
 * one) are premium-vs-premium and correctly stay on `ltp`.
 */
export interface TripwireInput {
  trackerId: string;
  symbol: string;
  segment: Segment;
  side: Side;
  entryPrice: number;
  qty: number;
  ltp: number;
  /**
   * Price of the UNDERLYING instrument, on the same scale as the level and
   * OI-wall fields below. For `EQ_DELIVERY`/`EQ_INTRADAY` this is the same
   * number as `ltp`; for `OPT`/`FUT` it is the spot the contract derives from,
   * whereas `ltp` is the contract's own price (the premium, for an option).
   * Null when the underlying's price is unavailable — in which case a sensor
   * that needs it must stay silent rather than fall back to `ltp`.
   */
  underlyingLtp: number | null;
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
