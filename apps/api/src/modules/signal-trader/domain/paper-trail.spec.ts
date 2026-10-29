import { orderedTargets, paperExitDecision, paperTrailConfig } from './paper';

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

describe('paperExitDecision — horizon-aware breakeven guard (owner 2026-10-29, ACUTAAS)', () => {
  // ACUTAAS-EQ 2026-10-29, POSITIONAL: entry 3986.06, T1 4000 (+0.35 %, ≈ 1.8 × the 1-min N 7.69), T2 4400, plan SL 3400.
  const acutaas = { side: 'BUY', product: 'DELIVERY', horizon: 'POSITIONAL' as const, minutesToClose: 200, entry: 3986.06, targets: [4000, 4400], planSl: 3400 };
  const daily = (atr: number | null, peak: number | null = null) => ({ n: atr, peak, trailN: 1, minStepN: 1, unit: 'daily ATR' });

  it('the old rule (no guard) moved the SL to entry on T1 and the 3958 wiggle stopped it: the prod failure', () => {
    expect(paperExitDecision({ ...acutaas, ltp: 4001, sl: 3400, target: 4000 })).toEqual({ exit: false, trail: expect.objectContaining({ sl: 3986.06, target: 4400 }) });
    expect(paperExitDecision({ ...acutaas, ltp: 3958, sl: 3986.06, target: 4400 })).toMatchObject({ exit: true, tag: 'MOVED_STOP', price: 3958 });
  });

  it('T1 within 1 × daily ATR of the entry: the target advances, the SL stays at the plan SL, 3958 does NOT stop it', () => {
    expect(paperExitDecision({ ...acutaas, ltp: 4001, sl: 3400, target: 4000, noise: daily(120, 4001) })).toEqual({ exit: false, trail: expect.objectContaining({ sl: 3400, target: 4400 }) });
    expect(paperExitDecision({ ...acutaas, ltp: 3958, sl: 3400, target: 4400, noise: daily(120, 4001) })).toEqual({ exit: false });
  });

  it('the held-back step is taken once the best price is 1 × daily ATR beyond the entry (target unchanged)', () => {
    expect(paperExitDecision({ ...acutaas, ltp: 4100, sl: 3400, target: 4400, noise: daily(120, 4100) })).toEqual({ exit: false });
    // 3986.06 + 120 = 4106.06; the best price since entry counts (a 30 s sweep can miss the spike itself).
    expect(paperExitDecision({ ...acutaas, ltp: 4060, sl: 3400, target: 4400, noise: daily(120, 4110) })).toEqual({
      exit: false,
      trail: expect.objectContaining({ sl: 3986.06, target: 4400 }),
    });
    expect(paperExitDecision({ ...acutaas, ltp: 4060, sl: 3986.06, target: 4400, noise: daily(120, 4110) })).toEqual({ exit: false });
  });

  it('daily ATR unreadable: the 1-min N scaled to a day (7.69 × √375 ≈ 148.9) still holds the step back', () => {
    expect(paperExitDecision({ ...acutaas, ltp: 4001, sl: 3400, target: 4000, noise: daily(148.92, 4001) })).toEqual({ exit: false, trail: expect.objectContaining({ sl: 3400, target: 4400 }) });
  });

  it('a learning trade with no SL keeps none while the step is held back', () => {
    expect(paperExitDecision({ ...acutaas, ltp: 4001, sl: null, target: 4000, noise: daily(120) })).toEqual({ exit: false, trail: expect.objectContaining({ sl: null, target: 4400 }) });
  });

  it('later steps: T2 → T1 only with the room; else the furthest earlier level that has it', () => {
    const three = { side: 'BUY', product: 'INTRADAY', minutesToClose: 200, entry: 100, targets: [101, 104, 110] };
    const n1 = (n: number) => ({ n, peak: 104, trailN: 2, minStepN: 3, unit: '1m N' });
    // T2 104 hit: T1 101 has 3 N of room (104 − 101 = 3) → SL T1.
    expect(paperExitDecision({ ...three, ltp: 104, sl: 95, target: 104, noise: n1(1) })).toEqual({ exit: false, trail: expect.objectContaining({ sl: 101, target: 110 }) });
    // N 2: T1 has no room (3 < 6), the entry neither (4 < 6) → SL stays 95.
    expect(paperExitDecision({ ...three, ltp: 104, sl: 95, target: 104, noise: n1(2) })).toEqual({ exit: false, trail: expect.objectContaining({ sl: 95, target: 110 }) });
    // N 1.3: T1 short (3 < 3.9), the entry has it (4 ≥ 3.9) → SL entry.
    expect(paperExitDecision({ ...three, ltp: 104, sl: 95, target: 104, noise: n1(1.3) })).toEqual({ exit: false, trail: expect.objectContaining({ sl: 100, target: 110 }) });
  });

  it('INTRADAY keeps the old behaviour when T1 is well clear of 3 N (the existing cases)', () => {
    const n = { n: 1, peak: 111, trailN: 2, minStepN: 3, unit: '1m N' };
    expect(paperExitDecision({ ...base, ltp: 111, sl: 90, target: 110, noise: n })).toEqual({ exit: false, trail: expect.objectContaining({ sl: 100, target: 120 }) });
  });

  it('INTRADAY with a T1 inside 3 N: the step waits for 3 N of room (same ACUTAAS numbers, 1-min N 7.69)', () => {
    const intra = { ...acutaas, product: 'INTRADAY', horizon: 'INTRADAY' as const };
    const n = (peak: number) => ({ n: 7.69, peak, trailN: 2, minStepN: 3, unit: '1m N' });
    expect(paperExitDecision({ ...intra, ltp: 4001, sl: 3400, target: 4000, noise: n(4001) })).toEqual({ exit: false, trail: expect.objectContaining({ sl: 3400, target: 4400 }) });
    // 3986.06 + 3 × 7.69 = 4009.13
    expect(paperExitDecision({ ...intra, ltp: 4010, sl: 3400, target: 4400, noise: n(4010) })).toEqual({ exit: false, trail: expect.objectContaining({ sl: 3986.06, target: 4400 }) });
  });
});

describe('paperExitDecision — positional one-target call on the daily ATR', () => {
  // Entry 500, only target 510 (2/3 of a 15-point daily ATR), plan SL 470; trail 1 × ATR, guard 1 × ATR.
  const pos = { side: 'BUY', product: 'DELIVERY', horizon: 'POSITIONAL' as const, minutesToClose: 200, entry: 500, targets: [510], planSl: 470 };
  const daily = (peak: number) => ({ n: 15, peak, trailN: 1, minStepN: 1, unit: 'daily ATR' });

  it('the target hit hands over to a daily-ATR trail; no breakeven yet, SL one ATR behind the best price', () => {
    expect(paperExitDecision({ ...pos, ltp: 511, sl: 470, target: 510, noise: daily(511) })).toEqual({ exit: false, trail: expect.objectContaining({ sl: 496, target: null }) });
    // The intraday-sized trail it replaces: 2 × a 0.5 N behind 511 → SL 510, stopped by any wiggle.
    expect(paperExitDecision({ ...pos, ltp: 511, sl: 470, target: 510, noise: { n: 0.5, peak: 511, trailN: 2 } })).toEqual({ exit: false, trail: expect.objectContaining({ sl: 510 }) });
  });

  it('a pullback above the trail holds; past 1 ATR beyond the entry the trail ratchets (floored at the entry)', () => {
    expect(paperExitDecision({ ...pos, ltp: 498, sl: 496, target: null, noise: daily(511) })).toEqual({ exit: false });
    expect(paperExitDecision({ ...pos, ltp: 520, sl: 496, target: null, noise: daily(520) })).toEqual({ exit: false, trail: expect.objectContaining({ sl: 505, target: null }) });
    expect(paperExitDecision({ ...pos, ltp: 540, sl: 505, target: null, noise: daily(540) })).toEqual({ exit: false, trail: expect.objectContaining({ sl: 525, target: null }) });
  });

  it('the trailed SL below the entry closes as MOVED_STOP (tighter than the plan SL); the plan SL as STOPPED_OUT', () => {
    expect(paperExitDecision({ ...pos, ltp: 495, sl: 496, target: null, noise: daily(511) })).toMatchObject({ exit: true, tag: 'MOVED_STOP', price: 495 });
    expect(paperExitDecision({ ...pos, ltp: 469, sl: 470, target: 510, noise: daily(505) })).toMatchObject({ exit: true, tag: 'STOPPED_OUT' });
  });
});

describe('paperTrailConfig', () => {
  it('defaults: 3 × N intraday, 1 × daily ATR carried (guard and trail); env-tunable, bad values ignored', () => {
    expect(paperTrailConfig({})).toEqual({ stepMinN: 3, stepMinAtr: 1, carriedTrailAtr: 1 });
    expect(paperTrailConfig({ PAPER_STEP_MIN_N: '2', PAPER_STEP_MIN_ATR: '0', PAPER_CARRIED_TRAIL_ATR: '1.5' })).toEqual({ stepMinN: 2, stepMinAtr: 0, carriedTrailAtr: 1.5 });
    expect(paperTrailConfig({ PAPER_STEP_MIN_N: 'x', PAPER_CARRIED_TRAIL_ATR: '0' })).toEqual({ stepMinN: 3, stepMinAtr: 1, carriedTrailAtr: 1 });
  });
});
