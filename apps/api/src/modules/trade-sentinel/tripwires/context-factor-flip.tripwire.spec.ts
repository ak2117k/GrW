import { contextFactorFlip, REAL_FACTORS } from './context-factor-flip.tripwire';
import type { TripwireInput } from './types';

const base: TripwireInput = {
  trackerId: 't1', symbol: 'INFY', segment: 'EQ_INTRADAY', side: 'LONG',
  entryPrice: 100, qty: 100, ltp: 100, underlyingLtp: 100,
  holdingHigh: null, holdingLow: null,
  nearestSupport: null, nearestResistance: null,
  volumeRatio: null, oiWallNow: null, oiWallPrev: null,
  freshNewsCount: null, factorValues: {}, prevFactorValues: {},
};

describe('contextFactorFlip', () => {
  it('watches only the three real factors', () => {
    expect(REAL_FACTORS).toEqual(['greeks', 'mtfTrend', 'volatility']);
  });

  it('fires when a real factor changes sign', () => {
    const fire = contextFactorFlip.check({
      ...base,
      factorValues: { greeks: -0.4 },
      prevFactorValues: { greeks: 0.6 },
    });
    expect(fire?.name).toBe('context-factor-flip');
    expect(fire?.detail).toContain('greeks');
  });

  it('fires on a negative-to-positive flip too, not just positive-to-negative', () => {
    const fire = contextFactorFlip.check({
      ...base,
      factorValues: { mtfTrend: 0.3 },
      prevFactorValues: { mtfTrend: -0.3 },
    });
    expect(fire?.detail).toContain('mtfTrend');
  });

  it('names every factor that flipped, not just the first', () => {
    const fire = contextFactorFlip.check({
      ...base,
      factorValues: { greeks: -0.4, mtfTrend: -0.2, volatility: 0.5 },
      prevFactorValues: { greeks: 0.6, mtfTrend: 0.2, volatility: -0.5 },
    });
    expect(fire?.detail).toContain('greeks');
    expect(fire?.detail).toContain('mtfTrend');
    expect(fire?.detail).toContain('volatility');
  });

  it('stays silent when a real factor merely moves without changing sign', () => {
    expect(contextFactorFlip.check({
      ...base,
      factorValues: { volatility: 0.1 },
      prevFactorValues: { volatility: 0.9 },
    })).toBeNull();
  });

  it('ignores a stub factor that flips — its zero is a placeholder, not a signal', () => {
    expect(contextFactorFlip.check({
      ...base,
      factorValues: { fii: -0.5, sector: 0.5, nasdaq: -0.5 },
      prevFactorValues: { fii: 0.5, sector: -0.5, nasdaq: 0.5 },
    })).toBeNull();
  });

  it('treats a move away from zero as no flip — zero has no sign to change from', () => {
    expect(contextFactorFlip.check({
      ...base,
      factorValues: { greeks: -0.5 },
      prevFactorValues: { greeks: 0 },
    })).toBeNull();
  });

  it('treats a move to zero as no flip', () => {
    expect(contextFactorFlip.check({
      ...base,
      factorValues: { greeks: 0 },
      prevFactorValues: { greeks: -0.5 },
    })).toBeNull();
  });

  it('stays silent when the previous evaluation had no value for the factor', () => {
    expect(contextFactorFlip.check({
      ...base,
      factorValues: { greeks: -0.5 },
      prevFactorValues: {},
    })).toBeNull();
  });

  it('stays silent when the current value is missing', () => {
    expect(contextFactorFlip.check({
      ...base,
      factorValues: {},
      prevFactorValues: { greeks: -0.5 },
    })).toBeNull();
  });

  it('stays silent when both snapshots are empty', () => {
    expect(contextFactorFlip.check(base)).toBeNull();
  });

  it('does not report a flip from a NaN current value', () => {
    // NaN passes `typeof x === "number"`, and Math.sign(NaN) is NaN — which is
    // !== 0 and !== the other sign, so a typeof guard alone reports a sign
    // change that never happened. `greeks` can emit NaN from a malformed delta.
    expect(contextFactorFlip.check({
      ...base,
      factorValues: { greeks: NaN },
      prevFactorValues: { greeks: 0.6 },
    })).toBeNull();
  });

  it('does not report a flip from a NaN previous value', () => {
    expect(contextFactorFlip.check({
      ...base,
      factorValues: { greeks: 0.6 },
      prevFactorValues: { greeks: NaN },
    })).toBeNull();
  });

  it('does not report a flip when both values are NaN', () => {
    expect(contextFactorFlip.check({
      ...base,
      factorValues: { greeks: NaN },
      prevFactorValues: { greeks: NaN },
    })).toBeNull();
  });

  it('does not report a flip from an undefined value', () => {
    const missing = undefined as unknown as number;
    expect(contextFactorFlip.check({
      ...base,
      factorValues: { greeks: missing },
      prevFactorValues: { greeks: 0.6 },
    })).toBeNull();
  });
});
