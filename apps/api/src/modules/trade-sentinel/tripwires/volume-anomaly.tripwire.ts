import type { Tripwire, TripwireFire, TripwireInput } from './types';

/** Session volume as a multiple of the 20-day average before this sensor speaks. */
export const VOLUME_SPIKE_RATIO = 2;

/**
 * Unusual participation. Volume alone says nothing about direction — that is
 * exactly why this is a sensor and not a rule: it tells the agent to look, and
 * the agent decides whether the surge is buyers or sellers.
 */
export const volumeAnomaly: Tripwire = {
  name: 'volume-anomaly',

  check({ volumeRatio }: TripwireInput): TripwireFire | null {
    if (volumeRatio === null) return null;
    if (volumeRatio < VOLUME_SPIKE_RATIO) return null;
    return {
      name: 'volume-anomaly',
      detail: `volume ${volumeRatio.toFixed(1)}x the 20-day average`,
    };
  },
};
