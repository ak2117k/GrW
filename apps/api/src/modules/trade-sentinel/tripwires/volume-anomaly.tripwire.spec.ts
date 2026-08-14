import { volumeAnomaly, VOLUME_SPIKE_RATIO } from './volume-anomaly.tripwire';
import type { TripwireInput } from './types';

const base: TripwireInput = {
  trackerId: 't1', symbol: 'INFY', segment: 'EQ_INTRADAY', side: 'LONG',
  entryPrice: 100, qty: 100, ltp: 100, underlyingLtp: 100,
  holdingHigh: null, holdingLow: null,
  nearestSupport: null, nearestResistance: null,
  volumeRatio: 1, oiWallNow: null, oiWallPrev: null,
  freshNewsCount: null, factorValues: {}, prevFactorValues: {},
};

describe('volumeAnomaly', () => {
  it('stays silent at normal volume', () => {
    expect(volumeAnomaly.check({ ...base, volumeRatio: 1.2 })).toBeNull();
  });

  it('fires on a volume spike', () => {
    const fire = volumeAnomaly.check({ ...base, volumeRatio: VOLUME_SPIKE_RATIO + 0.5 });
    expect(fire?.name).toBe('volume-anomaly');
  });

  it('stays silent — not fires — when volume data is unavailable', () => {
    expect(volumeAnomaly.check({ ...base, volumeRatio: null })).toBeNull();
  });

  it('stays silent on a NaN ratio rather than reporting "volume NaN x the 20-day average"', () => {
    // NaN < VOLUME_SPIKE_RATIO is false, so a threshold test alone would fire
    // and hand the agent a fabricated volume reading as evidence.
    expect(volumeAnomaly.check({ ...base, volumeRatio: NaN })).toBeNull();
  });

  it('stays silent on an undefined ratio', () => {
    const missing = undefined as unknown as number;
    expect(volumeAnomaly.check({ ...base, volumeRatio: missing })).toBeNull();
  });
});
