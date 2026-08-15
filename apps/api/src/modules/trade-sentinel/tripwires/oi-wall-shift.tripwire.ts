import type { Tripwire, TripwireFire, TripwireInput } from './types';

/** Fractional move in a wall strike before the shift counts as meaningful. */
export const OI_WALL_SHIFT_PCT = 0.002;

/**
 * The walls moved against the position. A call wall descending toward a long
 * means writers are capping the upside closer than they were; a put wall rising
 * toward a short means the same in reverse.
 *
 * Requires a previous snapshot (see OiWallSnapshotService). Without one — first
 * sighting, or a cash symbol with no chain — this stays silent rather than
 * inventing a comparison.
 */
export const oiWallShift: Tripwire = {
  name: 'oi-wall-shift',

  check({ side, oiWallNow, oiWallPrev }: TripwireInput): TripwireFire | null {
    if (!oiWallNow || !oiWallPrev) return null;

    if (side === 'LONG') {
      const { callWall } = oiWallNow;
      const prev = oiWallPrev.callWall;
      if (callWall === null || prev === null) return null;
      // A strike is a positive price. `=== null` alone lets a NaN through, and a
      // zero or negative `prev` makes the ratio Infinity — both clear the 0.2%
      // threshold and fire, handing the agent "call wall fell 0 -> NaN". Same
      // `Number.isFinite` defence as volumeAnomaly and newsHit.
      if (!Number.isFinite(callWall) || !(prev > 0)) return null;
      const moved = (prev - callWall) / prev;
      if (moved < OI_WALL_SHIFT_PCT) return null;
      return {
        name: 'oi-wall-shift',
        detail: `call wall fell ${prev} -> ${callWall}, capping upside closer`,
      };
    }

    const { putWall } = oiWallNow;
    const prev = oiWallPrev.putWall;
    if (putWall === null || prev === null) return null;
    // See the LONG arm above: NaN passes `=== null`, and a non-positive `prev`
    // divides to Infinity, which clears the threshold.
    if (!Number.isFinite(putWall) || !(prev > 0)) return null;
    const moved = (putWall - prev) / prev;
    if (moved < OI_WALL_SHIFT_PCT) return null;
    return {
      name: 'oi-wall-shift',
      detail: `put wall rose ${prev} -> ${putWall}, floor rising against the short`,
    };
  },
};
