import type { Tripwire, TripwireFire, TripwireInput } from './types';

/**
 * The context-scoring factors that are actually implemented. The other six
 * (fii, sector, gold, crude-oil, nasdaq, oi-shift) return `isStub: true` and a
 * neutral zero — feeding those into a sign-flip check would manufacture signal
 * out of nothing, so they are excluded by name rather than by filtering at
 * runtime, which would silently start including them if a stub were filled in
 * without anyone revisiting this sensor.
 */
export const REAL_FACTORS = ['greeks', 'mtfTrend', 'volatility'];

/** A real factor changed sign since the last evaluation. */
export const contextFactorFlip: Tripwire = {
  name: 'context-factor-flip',

  check({ factorValues, prevFactorValues }: TripwireInput): TripwireFire | null {
    const flipped = REAL_FACTORS.filter((name) => {
      const now = factorValues[name];
      const prev = prevFactorValues[name];
      if (typeof now !== 'number' || typeof prev !== 'number') return false;
      return Math.sign(now) !== 0 && Math.sign(prev) !== 0 && Math.sign(now) !== Math.sign(prev);
    });

    if (flipped.length === 0) return null;
    return { name: 'context-factor-flip', detail: `factor(s) changed sign: ${flipped.join(', ')}` };
  },
};
