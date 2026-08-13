import { levelBreak } from './level-break.tripwire';
import type { TripwireInput } from './types';

const base: TripwireInput = {
  trackerId: 't1', symbol: 'INFY', segment: 'EQ_INTRADAY', side: 'LONG',
  entryPrice: 100, qty: 100, ltp: 100, underlyingLtp: 100,
  holdingHigh: null, holdingLow: null,
  nearestSupport: 95, nearestResistance: 110,
  volumeRatio: null, oiWallNow: null, oiWallPrev: null,
  freshNewsCount: null, factorValues: {}, prevFactorValues: {},
};

describe('levelBreak', () => {
  it('stays silent inside the range', () => {
    expect(levelBreak.check({ ...base, ltp: 102, underlyingLtp: 102 })).toBeNull();
  });

  it('fires when a long loses its nearest support', () => {
    const fire = levelBreak.check({ ...base, ltp: 94, underlyingLtp: 94 });
    expect(fire?.name).toBe('level-break');
    expect(fire?.detail).toMatch(/support/i);
  });

  it('fires when a short loses its nearest resistance', () => {
    const fire = levelBreak.check({ ...base, side: 'SHORT', ltp: 112, underlyingLtp: 112 });
    expect(fire?.detail).toMatch(/resistance/i);
  });

  // Both sides are asserted deliberately. A LONG-only assertion passes even with
  // the absent-level guard deleted, because `price >= null` coerces to
  // `price >= 0` and stays silent by accident; the SHORT case (`price <= null`)
  // is the one that actually pins the guard.
  it('stays silent when the symbol has no level book', () => {
    const noLevels = { ...base, nearestSupport: null, nearestResistance: null };
    expect(levelBreak.check({ ...noLevels, ltp: 1, underlyingLtp: 1 })).toBeNull();
    expect(levelBreak.check({ ...noLevels, side: 'SHORT', ltp: 5000, underlyingLtp: 5000 })).toBeNull();
  });

  // SCALE HAZARD regression. An option's `ltp` is the premium (~120) while its
  // levels are strikes (~24000). Comparing the premium against a strike breaches
  // permanently, so this sensor would fire on EVERY tick for the life of the
  // position. Both tests below fail if the implementation reads `ltp`.
  it('compares the underlying against the level, not the option premium', () => {
    const optionHoldingUp = {
      ...base,
      segment: 'OPT' as const,
      ltp: 120,              // premium — far below the strike, but irrelevant here
      underlyingLtp: 24500,  // underlying is comfortably above support
      nearestSupport: 24000,
      nearestResistance: 24800,
    };
    expect(levelBreak.check(optionHoldingUp)).toBeNull();
  });

  it('stays silent when the underlying price cannot be resolved', () => {
    expect(levelBreak.check({ ...base, underlyingLtp: null, nearestSupport: 95, ltp: 1 })).toBeNull();
  });
});
