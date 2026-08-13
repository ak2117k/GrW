import type { Tripwire, TripwireFire, TripwireInput } from './types';

/**
 * Price has crossed the level that was standing between the position and
 * trouble: nearest support for a long, nearest resistance for a short.
 *
 * A symbol with no level book (illiquid, or not covered by the level service)
 * yields null rather than firing — an absent level is not a broken level.
 */
export const levelBreak: Tripwire = {
  name: 'level-break',

  check({ side, underlyingLtp, nearestSupport, nearestResistance }: TripwireInput): TripwireFire | null {
    // SCALE HAZARD: levels live on the UNDERLYING's scale. For an option, `ltp`
    // is the premium (~120) while a level is a strike (~24000) — comparing them
    // breaches permanently and fires every tick. Compare against `underlyingLtp`,
    // and when it is null stay silent rather than falling back to `ltp`.
    if (underlyingLtp === null) return null;

    if (side === 'LONG') {
      if (nearestSupport === null) return null;
      if (underlyingLtp >= nearestSupport) return null;
      return { name: 'level-break', detail: `lost nearest support ${nearestSupport} (now ${underlyingLtp})` };
    }

    if (nearestResistance === null) return null;
    if (underlyingLtp <= nearestResistance) return null;
    return { name: 'level-break', detail: `lost nearest resistance ${nearestResistance} (now ${underlyingLtp})` };
  },
};
