import type { Tripwire, TripwireFire, TripwireInput } from './types';

/**
 * Fraction of peak favourable excursion that must be surrendered before this
 * sensor speaks. Deliberately loose: a sensor's job is "look at this", not
 * "sell this", so a false alarm costs one agent call, not a trade.
 */
export const GIVEBACK_FRACTION = 0.4;

/**
 * MFE giveback: the trade WAS up, and has since surrendered a meaningful share
 * of that gain. Measured off holdingHigh for longs and holdingLow for shorts —
 * the running extremes the trade-tracker already maintains per tick.
 */
export const givebackOffPeak: Tripwire = {
  name: 'giveback-off-peak',

  check(input: TripwireInput): TripwireFire | null {
    const { side, entryPrice, ltp, holdingHigh, holdingLow } = input;
    const peak = side === 'LONG' ? holdingHigh : holdingLow;
    if (peak === null) return null;

    const dir = side === 'LONG' ? 1 : -1;
    const peakGain = (peak - entryPrice) * dir;
    if (peakGain <= 0) return null; // never went right — a different sensor's problem

    const currentGain = (ltp - entryPrice) * dir;
    const givenBack = peakGain - currentGain;
    if (givenBack < peakGain * GIVEBACK_FRACTION) return null;

    const pct = Math.round((givenBack / peakGain) * 100);
    return {
      name: 'giveback-off-peak',
      detail: `gave back ${pct}% of peak excursion (peak ${peak}, now ${ltp}, entry ${entryPrice})`,
    };
  },
};
