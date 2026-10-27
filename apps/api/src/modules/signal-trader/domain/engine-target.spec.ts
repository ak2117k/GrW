import { deriveEngineTargets, type EngineTargetInput } from './engine-target';

const base = (o: Partial<EngineTargetInput> = {}): EngineTargetInput => ({
  kind: 'EQ',
  side: 'BUY',
  price: 100,
  tick: 0.05,
  spot: 100,
  levels: [],
  delta: null,
  sl: 96,
  ...o,
});

describe('deriveEngineTargets', () => {
  it('EQ long: the next two resistances above the spot, nearest first', () => {
    const r = deriveEngineTargets(base({ levels: [95, 110, 106, 99] }));
    expect(r.targets).toEqual([106, 110]);
    expect(r.methods).toEqual(['level', 'level']);
  });

  it('skips a level closer than 1 R and fills the empty slot with an R multiple', () => {
    // risk 4: 102 is 0.5 R (skipped), 108 is 2 R → T1; T2 = 2.5 R = 110.
    const r = deriveEngineTargets(base({ levels: [102, 108] }));
    expect(r.targets).toEqual([108, 110]);
    expect(r.methods).toEqual(['level', 'r_multiple']);
  });

  it('no level ahead: 1.5 R and 2.5 R', () => {
    const r = deriveEngineTargets(base({ levels: [90] }));
    expect(r.targets).toEqual([106, 110]);
    expect(r.methods).toEqual(['r_multiple', 'r_multiple']);
    expect(r.detail).toContain('no level above spot');
  });

  it('an R target that would not lie beyond a level target steps one R past it', () => {
    // risk 4: level 112 (3 R) → T1; 2.5 R = 110 is behind it → T2 = 112 + 4.
    const r = deriveEngineTargets(base({ levels: [112] }));
    expect(r.targets).toEqual([112, 116]);
  });

  it('BUY CE: the underlying move to resistance × |delta| on the premium', () => {
    // spot 24000 → resistance 24100 = 100 pts × 0.5 = +50 premium; next 24200 = +100.
    const r = deriveEngineTargets(base({ kind: 'CE', price: 200, spot: 24000, levels: [24100, 24200, 23900], delta: 0.5, sl: 170 }));
    expect(r.targets).toEqual([250, 300]);
    expect(r.methods).toEqual(['level_delta', 'level_delta']);
  });

  it('BUY PE profits on a fall: supports below the spot raise the premium', () => {
    const r = deriveEngineTargets(base({ kind: 'PE', price: 150, spot: 24000, levels: [23900, 23800, 24100], delta: -0.4, sl: 130 }));
    expect(r.targets).toEqual([190, 230]);
  });

  it('option with no delta: R multiples only', () => {
    const r = deriveEngineTargets(base({ kind: 'CE', price: 200, spot: 24000, levels: [24100], delta: null, sl: 180 }));
    expect(r.targets).toEqual([230, 250]);
    expect(r.detail).toContain('no delta');
  });

  it('SELL FUT: supports below, targets move down from the entry', () => {
    const r = deriveEngineTargets(base({ kind: 'FUT', side: 'SELL', price: 5010, spot: 5000, levels: [4950, 4900, 5100], sl: 5040 }));
    expect(r.targets).toEqual([4960, 4910]);
    expect(r.methods).toEqual(['level_fut', 'level_fut']);
  });

  it('no stop and no level: nothing, with the reason', () => {
    const r = deriveEngineTargets(base({ levels: [], sl: null }));
    expect(r.targets).toEqual([]);
    expect(r.detail).toMatch(/no stop/);
  });

  it('no stop but levels: level targets without the 1 R filter', () => {
    const r = deriveEngineTargets(base({ levels: [101, 103], sl: null }));
    expect(r.targets).toEqual([101, 103]);
  });

  it('a stop on the wrong side counts as no stop', () => {
    const r = deriveEngineTargets(base({ levels: [], sl: 104 }));
    expect(r.targets).toEqual([]);
  });

  it('SELL option targets never go to zero or below', () => {
    // SELL CE premium 20, stop 30 (risk 10): 1.5 R = 5, 2.5 R = -5 → only T1.
    const r = deriveEngineTargets(base({ kind: 'CE', side: 'SELL', price: 20, spot: 24000, levels: [], delta: 0.2, sl: 30 }));
    expect(r.targets).toEqual([5]);
  });
});
