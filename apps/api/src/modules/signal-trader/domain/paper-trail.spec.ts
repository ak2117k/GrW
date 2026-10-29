import { orderedTargets, paperExitDecision } from './paper';

// Owner 2026-10-29: a hit target that is not the last steps the SL up (T1 → entry, T2 → T1, …);
// the last target closes; a stepped SL hit closes as MOVED_STOP.
const base = { side: 'BUY', product: 'INTRADAY', minutesToClose: 120, entry: 100, targets: [110, 120, 130] };
const at = (ltp: number, sl: number | null, target: number, over: Record<string, unknown> = {}) =>
  paperExitDecision({ ...base, ltp, sl, target, ...over });

describe('orderedTargets', () => {
  it('keeps targets beyond the entry, nearest first, either side', () => {
    expect(orderedTargets('BUY', 100, [130, 110, '120', 90, 110, null])).toEqual([110, 120, 130]);
    expect(orderedTargets('SELL', 100, [80, 90, 110])).toEqual([90, 80]);
    expect(orderedTargets('BUY', 100, undefined)).toEqual([]);
  });
});

describe('paperExitDecision — target trailing', () => {
  it('T1 hit: no exit; SL to entry, target to T2 (also on a learning trade with no SL)', () => {
    expect(at(110, 90, 110)).toEqual({ exit: false, trail: expect.objectContaining({ sl: 100, target: 120 }) });
    expect(at(111, null, 110)).toEqual({ exit: false, trail: expect.objectContaining({ sl: 100, target: 120 }) });
  });

  it('T2 hit: SL to T1, target to T3', () => {
    expect(at(120.5, 100, 120)).toEqual({ exit: false, trail: expect.objectContaining({ sl: 110, target: 130 }) });
  });

  it('the last target closes as HIT_TARGET at the target price', () => {
    expect(at(131, 110, 130)).toMatchObject({ exit: true, tag: 'HIT_TARGET', price: 130 });
  });

  it('a jump past several targets steps to the highest reached, or closes when that is the last', () => {
    expect(at(125, 90, 110)).toEqual({ exit: false, trail: expect.objectContaining({ sl: 110, target: 130 }) });
    expect(at(135, 90, 110)).toMatchObject({ exit: true, tag: 'HIT_TARGET', price: 130 });
  });

  it('the moved SL closes as MOVED_STOP at the LTP; the plan SL still as STOPPED_OUT', () => {
    expect(at(109, 110, 130)).toMatchObject({ exit: true, tag: 'MOVED_STOP', price: 109 });
    expect(at(100, 100, 120)).toMatchObject({ exit: true, tag: 'MOVED_STOP', price: 100 });
    expect(at(89, 90, 110)).toMatchObject({ exit: true, tag: 'STOPPED_OUT', price: 89 });
  });

  it('never loosens an SL already tighter than the step', () => {
    expect(at(110, 105, 110)).toEqual({ exit: false, trail: expect.objectContaining({ sl: 105, target: 120 }) });
  });

  it('a short trails downward', () => {
    const s = { side: 'SELL', targets: [90, 80] };
    expect(at(90, 110, 90, s)).toEqual({ exit: false, trail: expect.objectContaining({ sl: 100, target: 80 }) });
    expect(at(101, 100, 80, s)).toMatchObject({ exit: true, tag: 'MOVED_STOP' });
    expect(at(79, 100, 80, s)).toMatchObject({ exit: true, tag: 'HIT_TARGET', price: 80 });
  });

  it('without plan targets, or with only one, T1 exits exactly as before', () => {
    expect(at(110, 90, 110, { targets: [] })).toMatchObject({ exit: true, tag: 'HIT_TARGET', price: 110 });
    expect(at(110, 90, 110, { targets: [110] })).toMatchObject({ exit: true, tag: 'HIT_TARGET', price: 110 });
    expect(at(110, 90, 110, { targets: undefined, entry: undefined })).toMatchObject({ exit: true, tag: 'HIT_TARGET' });
  });

  it('a row target that is not one of the plan targets exits as before', () => {
    expect(at(112, 90, 112)).toMatchObject({ exit: true, tag: 'HIT_TARGET', price: 112 });
  });
});

describe('paperExitDecision — one-target calls hand over to the noise trail (owner 2026-10-29)', () => {
  const one = { side: 'BUY', product: 'INTRADAY', minutesToClose: 120, entry: 53.4, targets: [70] };
  const noise = (n: number | null, peak: number | null) => ({ n, peak, trailN: 2 });

  it('the only target hit: no exit, the target is dropped, SL = peak − trailN·N', () => {
    // ADANIPORTS 2026-10-29: T1 70 hit at 72.35; N 1.26 ⇒ SL 72.35 − 2.52 = 69.83.
    expect(paperExitDecision({ ...one, ltp: 72.35, sl: null, target: 70, noise: noise(1.26, 70.5) })).toEqual({
      exit: false,
      trail: expect.objectContaining({ sl: 69.83, target: null }),
    });
  });

  it('ratchets up with the peak and never down; closes as MOVED_STOP when hit', () => {
    expect(paperExitDecision({ ...one, ltp: 76, sl: 69.83, target: null, noise: noise(1.26, 76) })).toEqual({
      exit: false,
      trail: expect.objectContaining({ sl: 73.48, target: null }),
    });
    // Pullback above the SL: the peak is unchanged, so no move (and no exit).
    expect(paperExitDecision({ ...one, ltp: 74, sl: 73.48, target: null, noise: noise(1.26, 76) })).toEqual({ exit: false });
    expect(paperExitDecision({ ...one, ltp: 73.4, sl: 73.48, target: null, noise: noise(1.26, 76) })).toMatchObject({ exit: true, tag: 'MOVED_STOP', price: 73.4 });
  });

  it('never below the entry', () => {
    expect(paperExitDecision({ ...one, ltp: 70, sl: null, target: 70, noise: noise(10, 70) })).toEqual({
      exit: false,
      trail: expect.objectContaining({ sl: 53.4, target: null }),
    });
  });

  it('a short trails from its low', () => {
    const s = { ...one, side: 'SELL', entry: 100, targets: [90] };
    expect(paperExitDecision({ ...s, ltp: 89, sl: 105, target: 90, noise: noise(1, 89) })).toEqual({ exit: false, trail: expect.objectContaining({ sl: 91, target: null }) });
    expect(paperExitDecision({ ...s, ltp: 91.5, sl: 91, target: null, noise: noise(1, 88) })).toMatchObject({ exit: true, tag: 'MOVED_STOP' });
  });

  it('N not measured yet: the only target exits as before', () => {
    expect(paperExitDecision({ ...one, ltp: 72.35, sl: null, target: 70, noise: noise(null, 70) })).toMatchObject({ exit: true, tag: 'HIT_TARGET', price: 70 });
    expect(paperExitDecision({ ...one, ltp: 72.35, sl: null, target: 70 })).toMatchObject({ exit: true, tag: 'HIT_TARGET', price: 70 });
  });

  it('multi-target plans are unchanged: the noise trail is for one-target calls only', () => {
    expect(paperExitDecision({ ...one, targets: [70, 80], ltp: 71, sl: null, target: 70, noise: noise(1.26, 71) })).toEqual({
      exit: false,
      trail: expect.objectContaining({ sl: 53.4, target: 80 }),
    });
  });
});
