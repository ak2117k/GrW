// apps/api/src/modules/sentinel-executor/domain/confirmation.spec.ts
import { EMPTY_CONFIRM, stepConfirm, type ConfirmState } from './confirmation';

const CFG = { ticks: 2, ms: 1000, gapResetMs: 5000 };
const BELOW = { op: 'BELOW' as const, price: 8930 };
/** Feed [price, at] ticks; return the fire flags. */
function feed(ticks: Array<[number, number]>, level: { op: 'BELOW' | 'ABOVE'; price: number } = BELOW, cfg = CFG): boolean[] {
  let s: ConfirmState = EMPTY_CONFIRM;
  return ticks.map(([price, at]) => {
    const r = stepConfirm(s, { price, at }, level, cfg);
    s = r.state;
    return r.fire;
  });
}

describe('stepConfirm (D2: 2 ticks AND ≥ 1 s)', () => {
  it('one tick beyond never fires (one bad print never sells)', () => {
    expect(feed([[8920, 0]])).toEqual([false]);
  });

  it('two ticks inside 1 s do not fire; the next one beyond after 1 s does', () => {
    expect(feed([[8920, 0], [8921, 300], [8919, 1000]])).toEqual([false, false, true]);
  });

  it('two ticks ≥ 1 s apart fire on the second', () => {
    expect(feed([[8920, 0], [8925, 1200]])).toEqual([false, true]);
  });

  it('touching the level is not crossing it (strict)', () => {
    expect(feed([[8930, 0], [8930, 2000]])).toEqual([false, false]);
  });

  it('flapping resets: beyond, back, beyond — the clock restarts', () => {
    expect(feed([[8920, 0], [8935, 600], [8920, 1100], [8920, 1500], [8920, 2200]])).toEqual([false, false, false, false, true]);
  });

  it('a gap > 5 s between accepted ticks restarts confirmation (feed reconnect)', () => {
    expect(feed([[8920, 0], [8920, 6000]])).toEqual([false, false]);
    expect(feed([[8920, 0], [8920, 6000], [8920, 7100]])).toEqual([false, false, true]);
  });

  it('an out-of-order tick restarts confirmation', () => {
    expect(feed([[8920, 2000], [8920, 1000], [8920, 3000]])).toEqual([false, false, true]);
  });

  it('ABOVE mirrors BELOW', () => {
    expect(feed([[9001, 0], [9002, 1000]], { op: 'ABOVE', price: 9000 })).toEqual([false, true]);
    expect(feed([[8999, 0], [8999, 1000]], { op: 'ABOVE', price: 9000 })).toEqual([false, false]);
  });

  it('confirmTicks 1 with ms 0 fires on the first tick (owner may configure it)', () => {
    expect(feed([[8920, 0]], BELOW, { ticks: 1, ms: 0, gapResetMs: 5000 })).toEqual([true]);
  });
});
