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
