import { evaluateLossReentry, REQUIRED_MOMENTUM_FACTORS } from './loss-reentry';

// A breakdown where all four required momentum factors pass.
function passingBreakdown(): Array<{ name: string; passed: boolean }> {
  return REQUIRED_MOMENTUM_FACTORS.map((name) => ({ name, passed: true }));
}

const base = {
  score: 85,
  breakdown: passingBreakdown(),
  currentPrice: 110,
  priorEntryPrice: 100,
  priorRecoveryCount: 0,
};

describe('evaluateLossReentry', () => {
  it('admits when score > 80, all momentum factors pass, price reclaimed, cap free', () => {
    expect(evaluateLossReentry(base)).toEqual({ allow: true, reason: expect.any(String) });
  });

  it('blocks when score is not strictly above 80 (80 fails)', () => {
    const r = evaluateLossReentry({ ...base, score: 80 });
    expect(r.allow).toBe(false);
    expect(r.reason).toMatch(/score/i);
  });

  it('blocks when a required momentum factor failed', () => {
    const breakdown = passingBreakdown().map((c) =>
      c.name === 'ADX trend strength' ? { ...c, passed: false } : c,
    );
    const r = evaluateLossReentry({ ...base, breakdown });
    expect(r.allow).toBe(false);
    expect(r.reason).toMatch(/ADX trend strength/);
  });

  it('blocks when a required momentum factor is absent from the breakdown', () => {
    const breakdown = passingBreakdown().filter((c) => c.name !== 'VWAP relationship');
    const r = evaluateLossReentry({ ...base, breakdown });
    expect(r.allow).toBe(false);
    expect(r.reason).toMatch(/VWAP relationship/);
  });

  it('blocks when current price has not reclaimed the prior entry price', () => {
    const r = evaluateLossReentry({ ...base, currentPrice: 99.99, priorEntryPrice: 100 });
    expect(r.allow).toBe(false);
    expect(r.reason).toMatch(/price|reclaim|entry/i);
  });

  it('admits when current price exactly equals the prior entry price (>= reclaim)', () => {
    expect(evaluateLossReentry({ ...base, currentPrice: 100, priorEntryPrice: 100 }).allow).toBe(true);
  });

  it('blocks when a recovery re-entry already happened today (cap = 1)', () => {
    const r = evaluateLossReentry({ ...base, priorRecoveryCount: 1 });
    expect(r.allow).toBe(false);
    expect(r.reason).toMatch(/cap|already|recover/i);
  });
});
