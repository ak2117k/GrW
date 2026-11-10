import { SHADOW_HOLD_MAX_P, exitShadow, isFloorHard, positionFollow, shadowGate } from './exit-shadow';

const MIN = 60_000;
const EXIT = new Date('2026-11-06T08:20:00Z');
const pt = (min: number, price: number) => ({ at: new Date(EXIT.getTime() + min * MIN), price });

describe('shadowGate: the gate the exit-floor replay left open (2026-11-10)', () => {
  it('holds only on a NOISE read with p under 0.40', () => {
    expect(shadowGate('NOISE', 0.31)).toMatchObject({ wouldHold: true });
    expect(shadowGate('NOISE', SHADOW_HOLD_MAX_P).wouldHold).toBe(false);
    expect(shadowGate('NOISE', null)).toMatchObject({ wouldHold: false, why: 'read NOISE but no p' });
    expect(shadowGate('REAL', 0.1).wouldHold).toBe(false);
    expect(shadowGate('MIXED', 0.1).wouldHold).toBe(false);
    expect(shadowGate('NO_DATA', null).wouldHold).toBe(false);
  });
});

describe('isFloorHard', () => {
  it('reads the floor from the exit reason', () => {
    expect(isFloorHard('FLOOR_HARD_EXIT (code): net -2,000 hard loss')).toBe(true);
    expect(isFloorHard('Thesis broken — underlying below VWAP')).toBe(false);
    expect(isFloorHard(null)).toBe(false);
  });
});

describe('exitShadow', () => {
  it('keeps p, its parts and the gate as known at the exit', () => {
    const s = exitShadow(EXIT, 'NOISE', { p: 0.27, basis: 'heuristic-v1', from: 'noise-read', parts: [{ name: 'MOVE', contribution: -0.5, read: true, note: '1 N from the best' }] }, true);
    expect(s).toMatchObject({ at: EXIT.toISOString(), p: 0.27, from: 'noise-read', floorHard: true, gate: { wouldHold: true } });
    expect(s.parts).toEqual([{ name: 'MOVE', contribution: -0.5, read: true, note: '1 N from the best' }]);
  });
  it('no read at all: p null and no hold', () => {
    expect(exitShadow(EXIT, 'NO_DATA', null, false)).toMatchObject({ p: null, from: 'none', gate: { wouldHold: false } });
  });
});

describe('positionFollow: the position priced 30 / 60 min after the exit', () => {
  // NIFTY 24750CE 11-06: sold at 120, the premium ran on (the replay's +11k "if held" case, in miniature).
  const path = [pt(-1, 119), pt(3, 118), pt(15, 125), pt(29, 131), pt(45, 150), pt(59, 141), pt(70, 200)];

  it('a long (bought) option: + = holding made more', () => {
    expect(positionFollow(true, EXIT, 120, path)).toEqual({
      exitPrice: 120, after30m: 131, after60m: 141, best60m: 150, worst60m: 118, hold30mPerUnit: 11, hold60mPerUnit: 21, points: 5,
    });
  });
  it('a short position reads the other way', () => {
    expect(positionFollow(false, EXIT, 120, path)).toMatchObject({ best60m: 118, worst60m: 150, hold30mPerUnit: -11, hold60mPerUnit: -21 });
  });
  it('a mark with no point near it is null (snapshots every ~3 min)', () => {
    const f = positionFollow(true, EXIT, 120, [pt(3, 118), pt(20, 125)]);
    expect(f).toMatchObject({ after30m: null, after60m: null, hold60mPerUnit: null, best60m: 125, points: 2 });
  });
  it('points before the exit or after 61 min are not read', () => {
    expect(positionFollow(true, EXIT, 120, [pt(0, 1), pt(62, 500)]).points).toBe(0);
  });
});
