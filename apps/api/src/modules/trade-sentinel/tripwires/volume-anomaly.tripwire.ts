import type { Tripwire, TripwireFire, TripwireInput } from './types';

/**
 * Last closed 15m bar volume as a multiple of its 20-bar median (the VMA20 the
 * level engine gates on — ~5 trading hours, NOT 20 days) before this sensor speaks.
 */
export const VOLUME_SPIKE_RATIO = 2;

/**
 * Unusual participation. Volume alone says nothing about direction — that is
 * exactly why this is a sensor and not a rule: it tells the agent to look, and
 * the agent decides whether the surge is buyers or sellers.
 */
export const volumeAnomaly: Tripwire = {
  name: 'volume-anomaly',

  check({ volumeRatio }: TripwireInput): TripwireFire | null {
    // Absent data is not a signal. `=== null` alone is not enough: `undefined`
    // and `NaN` both fail the threshold test below, so they would fire and hand
    // the agent "volume NaN x its 20-bar median" as evidence. Same defence the
    // volume producer already applies at index-volume.ts (`Number.isFinite`).
    if (volumeRatio === null || !Number.isFinite(volumeRatio)) return null;
    if (volumeRatio < VOLUME_SPIKE_RATIO) return null;
    return {
      name: 'volume-anomaly',
      detail: `last closed 15m bar volume ${volumeRatio.toFixed(1)}x its 20-bar median`,
    };
  },
};
