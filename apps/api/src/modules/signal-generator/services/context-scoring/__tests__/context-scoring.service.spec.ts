import { ContextScoringService } from '../context-scoring.service';
import type { ContextFactor, FactorInput, FactorResult } from '../types';

function makeFactor(name: string, weight: number, value: number, isStub = false): ContextFactor {
  return {
    name,
    weight,
    compute: jest.fn().mockResolvedValue({
      value,
      tier: isStub ? 'NEUTRAL_STUB' : 'NEUTRAL',
      isStub,
    } as FactorResult),
  };
}

function makeThrowingFactor(name: string, weight: number): ContextFactor {
  return {
    name,
    weight,
    compute: jest.fn().mockRejectedValue(new Error('boom')),
  };
}

const baseInput: FactorInput = {
  side: 'BUY',
  token: '99926000',
  symbol: 'NIFTY',
  exchange: 'NSE',
  setupContext: {} as never,
};

describe('ContextScoringService', () => {
  it('aggregates weighted-sum × 100 across all factors', async () => {
    const svc = new ContextScoringService([
      makeFactor('a', 0.5, 0.6), // contributes 30
      makeFactor('b', 0.5, 0.4), // contributes 20
    ]);
    const result = await svc.score(baseInput);
    expect(result.contextScore).toBe(50);
    expect(result.contextFactors).toHaveLength(2);
  });

  it('clamps the final score to [-100, +100]', async () => {
    const svc = new ContextScoringService([
      makeFactor('a', 1.0, 1.5), // raw 150 → clamped to 100
    ]);
    const result = await svc.score(baseInput);
    expect(result.contextScore).toBe(100);

    const svc2 = new ContextScoringService([
      makeFactor('a', 1.0, -1.5), // raw -150 → clamped to -100
    ]);
    const result2 = await svc2.score(baseInput);
    expect(result2.contextScore).toBe(-100);
  });

  it('computes coverage as realWeight / totalWeight', async () => {
    const svc = new ContextScoringService([
      makeFactor('real1', 0.20, 0, false),
      makeFactor('real2', 0.10, 0, false),
      makeFactor('stub1', 0.30, 0, true),
      makeFactor('stub2', 0.40, 0, true),
    ]);
    const result = await svc.score(baseInput);
    expect(result.contextCoverage).toBeCloseTo(0.30, 2);
  });

  it('treats a throwing factor as a stub for that call', async () => {
    const svc = new ContextScoringService([
      makeThrowingFactor('boom', 0.5),
      makeFactor('ok', 0.5, 0.4),
    ]);
    const result = await svc.score(baseInput);
    expect(result.contextScore).toBe(20); // ok contributes 20, boom 0
    expect(result.contextFactors[0].isStub).toBe(true);
    expect(result.contextFactors[0].tier).toBe('NEUTRAL_STUB');
    expect(result.contextFactors[0].detail).toEqual({ error: 'boom' });
  });

  it('derives contextTier from contextScore via the documented bands', async () => {
    const svc = (val: number) =>
      new ContextScoringService([makeFactor('a', 1.0, val)]);

    expect((await svc(0.7).score(baseInput)).contextTier).toBe('STRONG_BULL');
    expect((await svc(0.3).score(baseInput)).contextTier).toBe('BULL');
    expect((await svc(0.0).score(baseInput)).contextTier).toBe('NEUTRAL');
    expect((await svc(-0.3).score(baseInput)).contextTier).toBe('BEAR');
    expect((await svc(-0.7).score(baseInput)).contextTier).toBe('STRONG_BEAR');
  });

  it('per-factor contribution is round(weight × value × 100)', async () => {
    const svc = new ContextScoringService([
      makeFactor('a', 0.20, 0.5), // 10
      makeFactor('b', 0.15, -0.3), // -4.5 → JS Math.round(-4.5) === -4
    ]);
    const result = await svc.score(baseInput);
    expect(result.contextFactors[0].contribution).toBe(10);
    // round(-4.5) in JavaScript = -4 (rounds toward +Infinity)
    expect(result.contextFactors[1].contribution).toBe(-4);
  });
});
