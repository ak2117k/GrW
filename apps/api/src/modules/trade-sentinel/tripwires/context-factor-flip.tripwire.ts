import type { Tripwire, TripwireFire, TripwireInput } from './types';

/**
 * The context-scoring factors that are actually implemented. The other six
 * (fii, sector, gold, crudeOil, nasdaq, oiShift) return `isStub: true` and a
 * neutral zero — feeding those into a sign-flip check would manufacture signal
 * out of nothing, so they are excluded by name rather than by filtering at
 * runtime, which would silently start including them if a stub were filled in
 * without anyone revisiting this sensor.
 *
 * The names above are the registered factor keys exactly as `FactorResult.name`
 * spells them, so they can be matched against `factorValues` — note `crudeOil`
 * and `oiShift` are camelCase, not the kebab-case of their filenames.
 */
export const REAL_FACTORS: readonly string[] = ['greeks', 'mtfTrend', 'volatility'] as const;

/** A real factor changed sign since the last evaluation. */
export const contextFactorFlip: Tripwire = {
  name: 'context-factor-flip',

  check({ factorValues, prevFactorValues }: TripwireInput): TripwireFire | null {
    const flipped = REAL_FACTORS.filter((name) => {
      const now = factorValues[name];
      const prev = prevFactorValues[name];
      // `Number.isFinite` rather than `typeof`: NaN IS a number, and it defeats
      // every comparison below — Math.sign(NaN) is NaN, which is !== 0 and !==
      // the other sign, so a NaN factor would report a sign flip that never
      // happened. `greeks` can produce one from a malformed option-chain delta.
      if (!Number.isFinite(now) || !Number.isFinite(prev)) return false;
      return Math.sign(now) !== 0 && Math.sign(prev) !== 0 && Math.sign(now) !== Math.sign(prev);
    });

    if (flipped.length === 0) return null;
    return { name: 'context-factor-flip', detail: `factor(s) changed sign: ${flipped.join(', ')}` };
  },
};
