import { FLOOR_HARD_CONFIRM_SEC, FLOOR_HARD_REFIRE_SEC } from './config';
import {
  confirmHardFloor, hardFloorReading, hardLossBandOn, hardLossConfig, hardLossLimit, hardLossReading, hardLossTrip, underlyingAgainst, widenExitTrigger,
  type HardFloorInput, type HardLossInput, type TriggerFloorInput,
} from './hard-floor';

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

describe('hard loss exit (HARD_LOSS_EXIT_RUPEES, 2026-11-03)', () => {
  it('reads the limit from env; unset / 0 / junk = off', () => {
    expect(hardLossLimit({ HARD_LOSS_EXIT_RUPEES: '2000' })).toBe(2000);
    expect(hardLossLimit({})).toBeNull();
    expect(hardLossLimit({ HARD_LOSS_EXIT_RUPEES: '0' })).toBeNull();
    expect(hardLossLimit({ HARD_LOSS_EXIT_RUPEES: 'two' })).toBeNull();
  });
  it('trips at a net loss of the limit or more, never on a smaller loss, a profit or no P&L', () => {
    expect(hardLossTrip(-2000, 2000)).toBe(true);
    expect(hardLossTrip(-2450, 2000)).toBe(true);
    expect(hardLossTrip(-1999, 2000)).toBe(false);
    expect(hardLossTrip(300, 2000)).toBe(false);
    expect(hardLossTrip(null, 2000)).toBe(false);
    expect(hardLossTrip(-5000, null)).toBe(false);
  });
});

describe('FLOOR_BREAK_GREEN (FLOOR_LOCK_GREEN, 2026-11-04)', () => {
  /** Long NIFTY09NOV2623650PE (BEARISH exposure), prod 2026-11-04 12:19:27 IST: below the floor, still green. */
  const PE: HardFloorInput = {
    side: 'LONG', exposure: 'BEARISH', ltp: 139.05, floor: { price: 144.32, armed: true },
    netPnl: 211.82, underlying: 23759.75, bestUnderlying: 23746.75, nUnderlying: 10.41, k: 2,
  };

  it('regression 2026-11-04 23650 PE: before, +₹212 under the floor with NIFTY 1.25 N from best did NOT trip (sold later at −₹664)', () => {
    expect(hardFloorReading(PE)).toMatchObject({ trip: false, rule: null, belowFloor: true, adverseFromBestN: 1.25 });
  });

  it('regression 2026-11-04 23650 PE: with the green lock the same read trips FLOOR_BREAK_GREEN (12:19:27 +₹212, 12:20:48 +₹63)', () => {
    expect(hardFloorReading({ ...PE, lockGreen: true })).toMatchObject({ trip: true, rule: 'FLOOR_BREAK_GREEN', netRed: false });
    expect(hardFloorReading({ ...PE, lockGreen: true, ltp: 137.9, netPnl: 62.54, underlying: 23766 })).toMatchObject({ trip: true, rule: 'FLOOR_BREAK_GREEN' });
  });

  it('net exactly 0 is green; red is still GREEN_TO_RED; above the floor / unarmed never trips', () => {
    expect(hardFloorReading({ ...PE, lockGreen: true, netPnl: 0 }).rule).toBe('FLOOR_BREAK_GREEN');
    expect(hardFloorReading({ ...PE, lockGreen: true, netPnl: -664 }).rule).toBe('GREEN_TO_RED');
    expect(hardFloorReading({ ...PE, lockGreen: true, ltp: 145 }).trip).toBe(false);
    expect(hardFloorReading({ ...PE, lockGreen: true, floor: { price: 144.32, armed: false } }).trip).toBe(false);
  });

  it('unknown net P&L is not "green": only the K·N rule can trip', () => {
    expect(hardFloorReading({ ...PE, lockGreen: true, netPnl: null }).trip).toBe(false);
    expect(hardFloorReading({ ...PE, lockGreen: true, netPnl: null, underlying: 23768 }).rule).toBe('HWM_UNDERLYING_MOVE');
  });

  it('noise opinion: NOISE holds a green break (K·N and GREEN_TO_RED still apply); REAL / UNKNOWN / null trip', () => {
    const noise = { verdict: 'NOISE' as const, source: 'test' };
    expect(hardFloorReading({ ...PE, lockGreen: true, noise }).trip).toBe(false);
    expect(hardFloorReading({ ...PE, lockGreen: true, noise, underlying: 23768 }).rule).toBe('HWM_UNDERLYING_MOVE');
    expect(hardFloorReading({ ...PE, lockGreen: true, noise, netPnl: -5 }).rule).toBe('GREEN_TO_RED');
    for (const verdict of ['REAL', 'UNKNOWN'] as const) {
      expect(hardFloorReading({ ...PE, lockGreen: true, noise: { verdict, source: 'test' } }).rule).toBe('FLOOR_BREAK_GREEN');
    }
    expect(hardFloorReading({ ...PE, lockGreen: true, noise: null }).rule).toBe('FLOOR_BREAK_GREEN');
  });
});

describe('noise-aware hard loss (HARD_LOSS_CAP_RUPEES / HARD_LOSS_NOISE_N, 2026-11-04)', () => {
  const ENV = { HARD_LOSS_EXIT_RUPEES: '2000' };
  /** Long NIFTY09NOV2623750PE (BEARISH), prod 2026-11-04 11:19:30 IST: the ₹2k rule fired here at −₹2299. */
  const T1: HardLossInput = {
    netPnl: -2299.03, cfg: hardLossConfig(ENV), exposure: 'BEARISH', underlying: 23834.1,
    entryUnderlying: 23812.25, bestUnderlying: 23814.45, nUnderlying: 10.73,
  };

  it('config: defaults cap 3000 and 3 N; 0 turns a part off; junk / negative = the default', () => {
    expect(hardLossConfig(ENV)).toEqual({ limit: 2000, cap: 3000, noiseN: 3 });
    expect(hardLossConfig({ ...ENV, HARD_LOSS_CAP_RUPEES: '3500', HARD_LOSS_NOISE_N: '2.5' })).toEqual({ limit: 2000, cap: 3500, noiseN: 2.5 });
    expect(hardLossConfig({ ...ENV, HARD_LOSS_CAP_RUPEES: '0', HARD_LOSS_NOISE_N: '0' })).toEqual({ limit: 2000, cap: null, noiseN: null });
    expect(hardLossConfig({ ...ENV, HARD_LOSS_CAP_RUPEES: 'x', HARD_LOSS_NOISE_N: '-1' })).toEqual({ limit: 2000, cap: 3000, noiseN: 3 });
    expect(hardLossConfig({}).limit).toBeNull();
  });

  it('the band is on only with a cap above the limit and noiseN > 0', () => {
    expect(hardLossBandOn({ limit: 2000, cap: 3000, noiseN: 3 })).toBe(true);
    expect(hardLossBandOn({ limit: 2000, cap: 2000, noiseN: 3 })).toBe(false);
    expect(hardLossBandOn({ limit: 2000, cap: null, noiseN: 3 })).toBe(false);
    expect(hardLossBandOn({ limit: 2000, cap: 3000, noiseN: null })).toBe(false);
    expect(hardLossBandOn({ limit: null, cap: 3000, noiseN: 3 })).toBe(false);
  });

  it('regression 2026-11-04 23750 PE: −₹2299 with NIFTY 2.04 N from entry HOLDS (it was a noise stop: 137.2 low, then 184)', () => {
    expect(hardLossReading(T1)).toMatchObject({ trip: false, band: 'HOLD_UNDER_N', ref: 'ENTRY', adverse: 21.85, adverseN: 2.04 });
    // The worst minute (11:20, premium 137.6 ≈ −₹2.89k, NIFTY 23844.05 = 2.96 N): still held, still under the cap.
    expect(hardLossReading({ ...T1, netPnl: -2887, underlying: 23844.05 })).toMatchObject({ trip: false, band: 'HOLD_UNDER_N', adverseN: 2.96 });
  });

  it('in the band, ≥ 3 N against from entry exits', () => {
    expect(hardLossReading({ ...T1, underlying: 23844.5 })).toMatchObject({ trip: true, band: 'BAND_UNDERLYING', adverseN: 3.01 });
  });

  it('the cap is absolute: −₹3000 exits whatever the underlying or the noise opinion', () => {
    expect(hardLossReading({ ...T1, netPnl: -3000 })).toMatchObject({ trip: true, band: 'CAP' });
    expect(hardLossReading({ ...T1, netPnl: -3400, underlying: 23800, noise: { verdict: 'NOISE', source: 'test' } })).toMatchObject({ trip: true, band: 'CAP' });
  });

  it('no entry underlying ⇒ measured from the best point (never smaller than from entry)', () => {
    expect(hardLossReading({ ...T1, entryUnderlying: null })).toMatchObject({ trip: false, ref: 'BEST', adverse: 19.65, adverseN: 1.83 });
  });

  it('fail safe: unknown N, underlying, exposure or reference ⇒ the plain ₹2k rule trips', () => {
    expect(hardLossReading({ ...T1, nUnderlying: null })).toMatchObject({ trip: true, band: 'BAND_UNMEASURED' });
    expect(hardLossReading({ ...T1, underlying: null })).toMatchObject({ trip: true, band: 'BAND_UNMEASURED' });
    expect(hardLossReading({ ...T1, entryUnderlying: null, bestUnderlying: null })).toMatchObject({ trip: true, band: 'BAND_UNMEASURED', ref: null });
    expect(hardLossReading({ ...T1, exposure: null })).toMatchObject({ trip: true, band: 'BAND_UNMEASURED' });
  });

  it('above −₹2000, nothing; no P&L or the limit off, nothing', () => {
    expect(hardLossReading({ ...T1, netPnl: -1999, underlying: 23900 })).toMatchObject({ trip: false, band: null });
    expect(hardLossReading({ ...T1, netPnl: null }).trip).toBe(false);
    expect(hardLossReading({ ...T1, netPnl: -5000, cfg: hardLossConfig({}) }).trip).toBe(false);
  });

  it('band off (cap 0 or noiseN 0) ⇒ the plain ₹2k rule, exactly as before 2026-11-04', () => {
    expect(hardLossReading({ ...T1, cfg: hardLossConfig({ ...ENV, HARD_LOSS_CAP_RUPEES: '0' }) })).toMatchObject({ trip: true, band: 'PLAIN' });
    expect(hardLossReading({ ...T1, cfg: hardLossConfig({ ...ENV, HARD_LOSS_NOISE_N: '0' }) })).toMatchObject({ trip: true, band: 'PLAIN' });
    expect(hardLossReading({ ...T1, netPnl: -1999, cfg: hardLossConfig({ ...ENV, HARD_LOSS_NOISE_N: '0' }) }).trip).toBe(false);
  });

  it('a cap at or under the limit is the tighter plain stop (a misconfiguration never loosens it)', () => {
    const cfg = hardLossConfig({ ...ENV, HARD_LOSS_CAP_RUPEES: '1500' });
    expect(hardLossReading({ ...T1, netPnl: -1500, cfg })).toMatchObject({ trip: true, band: 'CAP' });
    expect(hardLossReading({ ...T1, netPnl: -1499, cfg }).trip).toBe(false);
  });

  it('noise opinion inside the band: REAL exits, NOISE holds to the cap, UNKNOWN = the N test', () => {
    expect(hardLossReading({ ...T1, noise: { verdict: 'REAL', source: 'test' } })).toMatchObject({ trip: true, band: 'BAND_REAL' });
    expect(hardLossReading({ ...T1, underlying: 23860, noise: { verdict: 'NOISE', source: 'test' } })).toMatchObject({ trip: false, band: 'HOLD_NOISE' });
    expect(hardLossReading({ ...T1, noise: { verdict: 'UNKNOWN', source: 'test' } })).toMatchObject({ trip: false, band: 'HOLD_UNDER_N' });
  });
});
