import { describe, it, expect } from 'vitest';
import { estimatedValue, maxAffordable, riskReward } from './order-math';

describe('estimatedValue', () => {
  it('multiplies qty by price', () => {
    expect(estimatedValue(10, 100)).toBe(1000);
  });

  it('returns 0 when price is 0', () => {
    expect(estimatedValue(10, 0)).toBe(0);
  });

  it('returns 0 when qty is 0', () => {
    expect(estimatedValue(0, 100)).toBe(0);
  });

  it('returns 0 for negative inputs', () => {
    expect(estimatedValue(-5, 100)).toBe(0);
    expect(estimatedValue(10, -100)).toBe(0);
  });
});

describe('maxAffordable', () => {
  it('floors remaining / price', () => {
    expect(maxAffordable(1050, 100)).toBe(10);
  });

  it('returns 0 when price is 0 (no divide-by-zero)', () => {
    expect(maxAffordable(1000, 0)).toBe(0);
  });

  it('never returns negative', () => {
    expect(maxAffordable(-1000, 100)).toBe(0);
  });

  it('returns 0 when remaining is less than price', () => {
    expect(maxAffordable(50, 100)).toBe(0);
  });
});

describe('riskReward — BUY', () => {
  it('computes risk, reward, rr and pcts', () => {
    const r = riskReward({ entry: 100, sl: 90, target: 130, qty: 10, side: 'BUY' });
    expect(r.riskAmt).toBe(100); // (100-90)*10
    expect(r.rewardAmt).toBe(300); // (130-100)*10
    expect(r.rr).toBe(3); // 300/100
    expect(r.slPct).toBeCloseTo(10); // |100-90|/100*100
    expect(r.tgtPct).toBeCloseTo(30); // |130-100|/100*100
  });

  it('clamps negative risk to 0 when SL is above entry', () => {
    const r = riskReward({ entry: 100, sl: 110, target: 130, qty: 10, side: 'BUY' });
    expect(r.riskAmt).toBe(0);
    expect(r.rr).toBeNull(); // risk leg is 0
    expect(r.slPct).toBeCloseTo(10); // pct is absolute distance regardless of side
  });
});

describe('riskReward — SELL', () => {
  it('inverts the legs', () => {
    const r = riskReward({ entry: 100, sl: 110, target: 70, qty: 10, side: 'SELL' });
    expect(r.riskAmt).toBe(100); // (110-100)*10
    expect(r.rewardAmt).toBe(300); // (100-70)*10
    expect(r.rr).toBe(3);
    expect(r.slPct).toBeCloseTo(10);
    expect(r.tgtPct).toBeCloseTo(30);
  });

  it('clamps negative reward to 0 when target is above entry', () => {
    const r = riskReward({ entry: 100, sl: 110, target: 130, qty: 10, side: 'SELL' });
    expect(r.rewardAmt).toBe(0);
    expect(r.rr).toBeNull();
  });
});

describe('riskReward — missing legs', () => {
  it('missing SL → riskAmt 0, slPct null, rr null', () => {
    const r = riskReward({ entry: 100, target: 130, qty: 10, side: 'BUY' });
    expect(r.riskAmt).toBe(0);
    expect(r.slPct).toBeNull();
    expect(r.rewardAmt).toBe(300);
    expect(r.tgtPct).toBeCloseTo(30);
    expect(r.rr).toBeNull();
  });

  it('missing target → rewardAmt 0, tgtPct null, rr null', () => {
    const r = riskReward({ entry: 100, sl: 90, qty: 10, side: 'BUY' });
    expect(r.rewardAmt).toBe(0);
    expect(r.tgtPct).toBeNull();
    expect(r.riskAmt).toBe(100);
    expect(r.slPct).toBeCloseTo(10);
    expect(r.rr).toBeNull();
  });

  it('both missing → all zero/null', () => {
    const r = riskReward({ entry: 100, qty: 10, side: 'BUY' });
    expect(r.riskAmt).toBe(0);
    expect(r.rewardAmt).toBe(0);
    expect(r.rr).toBeNull();
    expect(r.slPct).toBeNull();
    expect(r.tgtPct).toBeNull();
  });

  it('pcts are null when entry is 0', () => {
    const r = riskReward({ entry: 0, sl: 90, target: 130, qty: 10, side: 'BUY' });
    expect(r.slPct).toBeNull();
    expect(r.tgtPct).toBeNull();
  });
});
