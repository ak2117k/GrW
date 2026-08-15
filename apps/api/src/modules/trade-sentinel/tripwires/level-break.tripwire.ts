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
    //
    // Absent data is not a signal, and `=== null` alone is not enough: a NaN
    // passes it, and every comparison below is false against NaN, so the sensor
    // fires with "lost nearest support 95 (now NaN)". Same `Number.isFinite`
    // defence as volumeAnomaly and newsHit — the level book is exactly the
    // producer chain that is not trusted here.
    if (underlyingLtp === null || !Number.isFinite(underlyingLtp)) return null;

    if (side === 'LONG') {
      if (nearestSupport === null || !Number.isFinite(nearestSupport)) return null;
      if (underlyingLtp >= nearestSupport) return null;
      return { name: 'level-break', detail: `lost nearest support ${nearestSupport} (now ${underlyingLtp})` };
    }

    if (nearestResistance === null || !Number.isFinite(nearestResistance)) return null;
    if (underlyingLtp <= nearestResistance) return null;
    return { name: 'level-break', detail: `lost nearest resistance ${nearestResistance} (now ${underlyingLtp})` };
  },
};
