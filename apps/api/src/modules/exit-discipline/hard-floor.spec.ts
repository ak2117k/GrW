import { FLOOR_HARD_CONFIRM_SEC, FLOOR_HARD_REFIRE_SEC } from './config';
import { confirmHardFloor, hardFloorReading, underlyingAgainst, widenExitTrigger, type HardFloorInput, type TriggerFloorInput } from './hard-floor';

/** Long CRUDEOILM 9350 PE (BEARISH exposure: a RISING underlying hurts), 2026-10-29 numbers. */
const BASE: HardFloorInput = {
  side: 'LONG', exposure: 'BEARISH', ltp: 375, floor: { price: 376.8, armed: true },
  netPnl: 115, underlying: 9545, bestUnderlying: 9531, nUnderlying: 12.5, k: 2,
};

describe('underlyingAgainst', () => {
  it('is + when the underlying moved against the exposure, − when with it, null when unknown', () => {
    expect(underlyingAgainst('BEARISH', 9531, 9556)).toBe(25);
    expect(underlyingAgainst('BULLISH', 9531, 9556)).toBe(-25);
    expect(underlyingAgainst('BULLISH', 9020, 9003)).toBe(17);
    expect(underlyingAgainst(null, 9531, 9556)).toBeNull();
    expect(underlyingAgainst('BEARISH', null, 9556)).toBeNull();
  });
});

describe('hardFloorReading', () => {
  it('a green trade below the floor with the underlying < K·N from the best point does NOT trip', () => {
    expect(hardFloorReading(BASE)).toEqual({ trip: false, rule: null, belowFloor: true, netRed: false, adverseFromBest: 14, adverseFromBestN: 1.12 });
  });

  it('GREEN_TO_RED: floor broken and net red after charges', () => {
    expect(hardFloorReading({ ...BASE, ltp: 368, netPnl: -26 })).toMatchObject({ trip: true, rule: 'GREEN_TO_RED', netRed: true });
  });

  it('HWM_UNDERLYING_MOVE: still green, but the underlying is K·N against from the best point', () => {
    const r = hardFloorReading({ ...BASE, underlying: 9556 });
    expect(r).toMatchObject({ trip: true, rule: 'HWM_UNDERLYING_MOVE', netRed: false, adverseFromBest: 25, adverseFromBestN: 2 });
    expect(hardFloorReading({ ...BASE, underlying: 9556, k: 2.5 }).trip).toBe(false);
  });

  it('never trips above the floor, on an unarmed floor, or with the floor unknown — however red or far the underlying', () => {
    const hurt = { netPnl: -400, underlying: 9650 };
    expect(hardFloorReading({ ...BASE, ...hurt, ltp: 377 }).trip).toBe(false);
    expect(hardFloorReading({ ...BASE, ...hurt, floor: { price: 376.8, armed: false } }).trip).toBe(false);
    expect(hardFloorReading({ ...BASE, ...hurt, floor: { price: null, armed: true } }).trip).toBe(false);
  });

  it('an unmeasurable K·N (no best underlying, no N) leaves only GREEN_TO_RED', () => {
    expect(hardFloorReading({ ...BASE, underlying: 9600, bestUnderlying: null })).toMatchObject({ trip: false, adverseFromBest: null });
    expect(hardFloorReading({ ...BASE, underlying: 9600, nUnderlying: null })).toMatchObject({ trip: false, adverseFromBestN: null });
    expect(hardFloorReading({ ...BASE, netPnl: -1, nUnderlying: null }).rule).toBe('GREEN_TO_RED');
  });

  it('SHORT: the floor is broken ABOVE it', () => {
    const short: HardFloorInput = { ...BASE, side: 'SHORT', exposure: 'BEARISH', ltp: 101, floor: { price: 100, armed: true }, netPnl: -5 };
    expect(hardFloorReading(short)).toMatchObject({ trip: true, rule: 'GREEN_TO_RED' });
    expect(hardFloorReading({ ...short, ltp: 99.5 }).trip).toBe(false);
  });
});

describe('confirmHardFloor', () => {
  const T0 = 1_000_000;
  it('fires on the SECOND consecutive trip at least FLOOR_HARD_CONFIRM_SEC after the first — never on one read', () => {
    const a = confirmHardFloor(null, true, T0);
    expect(a.fire).toBe(false);
    const tooSoon = confirmHardFloor(a.memo, true, T0 + (FLOOR_HARD_CONFIRM_SEC - 1) * 1000);
    expect(tooSoon.fire).toBe(false);
    const b = confirmHardFloor(tooSoon.memo, true, T0 + 30_000);
    expect(b).toEqual({ fire: true, memo: { since: T0, reads: 3, firedAt: T0 + 30_000 } });
  });

  it('an untripped read resets the run', () => {
    const a = confirmHardFloor(null, true, T0);
    const off = confirmHardFloor(a.memo, false, T0 + 30_000);
    expect(off.memo).toEqual({ since: null, reads: 0, firedAt: null });
    expect(confirmHardFloor(off.memo, true, T0 + 60_000).fire).toBe(false);
  });

  it('stays quiet for FLOOR_HARD_REFIRE_SEC after a fire, then fires again if still tripped', () => {
    let m = confirmHardFloor(confirmHardFloor(null, true, T0).memo, true, T0 + 30_000).memo;
    for (let t = T0 + 60_000; t < T0 + 30_000 + FLOOR_HARD_REFIRE_SEC * 1000; t += 30_000) {
      const r = confirmHardFloor(m, true, t);
      expect(r.fire).toBe(false);
      m = r.memo;
    }
    expect(confirmHardFloor(m, true, T0 + 30_000 + FLOOR_HARD_REFIRE_SEC * 1000).fire).toBe(true);
  });
});

/** Long SENSEX 74500 CE (BULLISH), prod 2026-10-30: arm 74485.6, best 74495.69, N 26.48, judge set BELOW 74459.1. */
describe('widenExitTrigger — no AI stop inside noise', () => {
  const T: TriggerFloorInput = {
    instrument: 'UNDERLYING', op: 'BELOW', price: 74459.1, exposure: 'BULLISH',
    floorArmUnderlying: 74485.6, bestUnderlying: 74495.69, underlyingNow: 74476.09, nUnderlying: 26.48, k: 2,
  };

  it('a 1 N stop under the arm point is pushed out to 2 N (74432.64) — the 74458 dip no longer sells', () => {
    expect(widenExitTrigger(T)).toEqual({ price: 74432.64, widenedFrom: 74459.1, ref: 74485.6 });
  });

  it('a stop already 2 N or more away is left alone', () => {
    expect(widenExitTrigger({ ...T, price: 74400 })).toEqual({ price: 74400, widenedFrom: null, ref: 74485.6 });
  });

  it('no arm point: the best point is the reference, then the underlying the judge saw', () => {
    expect(widenExitTrigger({ ...T, floorArmUnderlying: null }).price).toBe(74442.73);
    expect(widenExitTrigger({ ...T, floorArmUnderlying: null, bestUnderlying: null }).price).toBe(74423.13);
  });

  it('bearish exposure mirrors: a protective ABOVE level is pushed up', () => {
    const pe = { ...T, exposure: 'BEARISH' as const, op: 'ABOVE' as const, floorArmUnderlying: 9547, nUnderlying: 12.5, price: 9555 };
    expect(widenExitTrigger(pe)).toEqual({ price: 9572, widenedFrom: 9555, ref: 9547 });
  });

  it('passes unchanged: a PREMIUM trigger, a take-profit-side level, an unknown N or exposure', () => {
    expect(widenExitTrigger({ ...T, instrument: 'PREMIUM' }).widenedFrom).toBeNull();
    expect(widenExitTrigger({ ...T, op: 'ABOVE', price: 74600 }).widenedFrom).toBeNull();
    expect(widenExitTrigger({ ...T, nUnderlying: null }).widenedFrom).toBeNull();
    expect(widenExitTrigger({ ...T, exposure: null }).widenedFrom).toBeNull();
  });
});
