import { oiWallShift, OI_WALL_SHIFT_PCT } from './oi-wall-shift.tripwire';
import type { TripwireInput } from './types';

const base: TripwireInput = {
  trackerId: 't1',
  symbol: 'NIFTY',
  segment: 'OPT',
  side: 'LONG',
  entryPrice: 100,
  qty: 50,
  ltp: 100,
  underlyingLtp: 24100,
  holdingHigh: null,
  holdingLow: null,
  nearestSupport: null,
  nearestResistance: null,
  volumeRatio: null,
  oiWallNow: { callWall: 24200, putWall: 24000 },
  oiWallPrev: { callWall: 24200, putWall: 24000 },
  freshNewsCount: null,
  factorValues: {},
  prevFactorValues: {},
};

describe('oiWallShift', () => {
  it('stays silent when the walls have not moved', () => {
    expect(oiWallShift.check(base)).toBeNull();
  });

  it('stays silent when there is no previous snapshot to compare against', () => {
    expect(oiWallShift.check({ ...base, oiWallPrev: null })).toBeNull();
  });

  it('stays silent when the current reading has no chain, even with a previous one', () => {
    expect(oiWallShift.check({ ...base, oiWallNow: null })).toBeNull();
  });

  it('stays silent for a symbol with no chain at all', () => {
    expect(oiWallShift.check({ ...base, oiWallNow: null, oiWallPrev: null })).toBeNull();
  });

  it('stays silent when the relevant wall is missing on one side of the comparison', () => {
    expect(
      oiWallShift.check({ ...base, oiWallNow: { callWall: null, putWall: 24000 } }),
    ).toBeNull();
    expect(
      oiWallShift.check({ ...base, oiWallPrev: { callWall: null, putWall: 24000 } }),
    ).toBeNull();
  });

  it('fires when the call wall moves down against a long', () => {
    const moved = 24200 * (1 - OI_WALL_SHIFT_PCT * 2);
    const fire = oiWallShift.check({ ...base, oiWallNow: { callWall: moved, putWall: 24000 } });
    expect(fire?.name).toBe('oi-wall-shift');
    expect(fire?.detail).toMatch(/call wall/i);
  });

  it('stays silent when the call wall moves AWAY from a long', () => {
    const moved = 24200 * (1 + OI_WALL_SHIFT_PCT * 2);
    expect(
      oiWallShift.check({ ...base, oiWallNow: { callWall: moved, putWall: 24000 } }),
    ).toBeNull();
  });

  it('fires when the put wall moves up against a short', () => {
    const moved = 24000 * (1 + OI_WALL_SHIFT_PCT * 2);
    const fire = oiWallShift.check({
      ...base,
      side: 'SHORT',
      oiWallNow: { callWall: 24200, putWall: moved },
    });
    expect(fire?.name).toBe('oi-wall-shift');
    expect(fire?.detail).toMatch(/put wall/i);
  });

  it('stays silent when the put wall moves AWAY from a short', () => {
    const moved = 24000 * (1 - OI_WALL_SHIFT_PCT * 2);
    expect(
      oiWallShift.check({ ...base, side: 'SHORT', oiWallNow: { callWall: 24200, putWall: moved } }),
    ).toBeNull();
  });

  it('ignores a wall moving against the OTHER side than the position holds', () => {
    // A long only cares about the call wall above it; a put wall drifting is
    // not this sensor's business.
    const movedPut = 24000 * (1 + OI_WALL_SHIFT_PCT * 4);
    expect(
      oiWallShift.check({ ...base, oiWallNow: { callWall: 24200, putWall: movedPut } }),
    ).toBeNull();
  });
});
