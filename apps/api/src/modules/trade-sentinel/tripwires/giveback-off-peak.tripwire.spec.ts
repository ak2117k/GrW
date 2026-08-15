import { givebackOffPeak, GIVEBACK_FRACTION } from './giveback-off-peak.tripwire';
import type { TripwireInput } from './types';

const base: TripwireInput = {
  trackerId: 't1', symbol: 'INFY', segment: 'EQ_INTRADAY', side: 'LONG',
  entryPrice: 100, qty: 100, ltp: 100, underlyingLtp: 100,
  holdingHigh: 100, holdingLow: 100,
  nearestSupport: null, nearestResistance: null,
  volumeRatio: null, oiWallNow: null, oiWallPrev: null,
  freshNewsCount: null, factorValues: {}, prevFactorValues: {},
};

describe('givebackOffPeak', () => {
  it('stays silent when the trade never went favourably', () => {
    expect(givebackOffPeak.check({ ...base, holdingHigh: 100, ltp: 95 })).toBeNull();
  });

  it('stays silent while the trade is still near its peak', () => {
    expect(givebackOffPeak.check({ ...base, holdingHigh: 120, ltp: 119 })).toBeNull();
  });

  it('fires when a long gives back more than the threshold fraction of its peak gain', () => {
    // Peak gain 20/share; giving back 60% leaves ltp at 108.
    const fire = givebackOffPeak.check({ ...base, holdingHigh: 120, ltp: 108 });
    expect(fire).not.toBeNull();
    expect(fire!.name).toBe('giveback-off-peak');
    expect(fire!.detail).toMatch(/gave back/i);
  });

  it('fires for a short measured off holdingLow', () => {
    const fire = givebackOffPeak.check({
      ...base, side: 'SHORT', holdingLow: 80, holdingHigh: 100, ltp: 92,
    });
    expect(fire).not.toBeNull();
  });

  it('uses a fraction strictly between 0 and 1', () => {
    expect(GIVEBACK_FRACTION).toBeGreaterThan(0);
    expect(GIVEBACK_FRACTION).toBeLessThan(1);
  });

  it('places its threshold at GIVEBACK_FRACTION of the peak gain', () => {
    // Derived from the constant, not from a literal, so that changing the
    // constant moves the sensor's threshold with it. Peak gain is 20/share.
    // Both probes sit one notch clear of the boundary rather than exactly on
    // it: at some fractions (0.33, for one) the boundary case turns on
    // floating-point error alone, which would make this test's pass depend on
    // the constant's binary representation instead of on the sensor's logic.
    const peakGain = 20;
    const atThreshold = base.entryPrice + peakGain * (1 - GIVEBACK_FRACTION);
    const justPast = atThreshold - peakGain * 0.05;
    const stillInside = atThreshold + peakGain * 0.05;

    expect(
      givebackOffPeak.check({ ...base, holdingHigh: 120, ltp: justPast }),
    ).not.toBeNull();
    expect(
      givebackOffPeak.check({ ...base, holdingHigh: 120, ltp: stillInside }),
    ).toBeNull();
  });

  it('stays silent when the extreme it measures off is unavailable', () => {
    // Absent data is not a signal: a null extreme must not fire, even when the
    // rest of the input would otherwise look like a large giveback.
    expect(givebackOffPeak.check({ ...base, holdingHigh: null, ltp: 108 })).toBeNull();
    expect(
      givebackOffPeak.check({ ...base, side: 'SHORT', holdingLow: null, ltp: 92 }),
    ).toBeNull();
  });

  it('stays silent on a NaN peak rather than reporting "gave back NaN% of peak"', () => {
    // `=== null` alone lets NaN through: `peakGain` becomes NaN, `NaN <= 0` is
    // false, and `givenBack < threshold` is false too — so every guard waves it
    // past and the detail string reads "gave back NaN% of peak excursion (peak
    // NaN, now 108, entry 100)". The producer chain is not trusted; that is the
    // entire point of hardening a sensor. Same defence as volumeAnomaly.
    expect(givebackOffPeak.check({ ...base, holdingHigh: NaN, ltp: 108 })).toBeNull();
    expect(
      givebackOffPeak.check({ ...base, side: 'SHORT', holdingLow: NaN, ltp: 92 }),
    ).toBeNull();
  });

  it('stays silent on an undefined peak', () => {
    const missing = undefined as unknown as number;
    expect(givebackOffPeak.check({ ...base, holdingHigh: missing, ltp: 108 })).toBeNull();
  });

  it('stays silent when the price or the entry is not a finite number', () => {
    // These make `givenBack` NaN instead, which fails the threshold test the
    // same way and fires with a fabricated percentage.
    expect(givebackOffPeak.check({ ...base, holdingHigh: 120, ltp: NaN })).toBeNull();
    expect(
      givebackOffPeak.check({ ...base, holdingHigh: 120, ltp: 108, entryPrice: NaN }),
    ).toBeNull();
  });
});
