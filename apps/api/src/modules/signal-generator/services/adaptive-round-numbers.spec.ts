import { adaptiveRoundStep, adaptiveRoundNumbers, roundScore } from './adaptive-round-numbers';

describe('adaptiveRoundNumbers', () => {
  it('picks a price-tiered step', () => {
    expect(adaptiveRoundStep(30)).toBe(1);
    expect(adaptiveRoundStep(140)).toBe(5);
    expect(adaptiveRoundStep(380)).toBe(10);
    expect(adaptiveRoundStep(1500)).toBe(25);
    expect(adaptiveRoundStep(3000)).toBe(50);
    expect(adaptiveRoundStep(9000)).toBe(100);
  });

  it('generates ±3 steps around spot on the grid', () => {
    expect(adaptiveRoundNumbers(140)).toEqual([125, 130, 135, 140, 145, 150, 155]);
  });

  it('roundScore: 12 for grid membership, 15 for a major round (multiple of 5*step)', () => {
    expect(roundScore(140, 5)).toBe(12);
    expect(roundScore(150, 5)).toBe(15);
    expect(roundScore(141, 5)).toBe(0);
  });

  it('returns [] for non-positive ltp', () => {
    expect(adaptiveRoundNumbers(0)).toEqual([]);
    expect(adaptiveRoundNumbers(-5)).toEqual([]);
  });

  it('handles exact tier boundaries with strict < (boundary falls into the next tier)', () => {
    expect(adaptiveRoundStep(50)).toBe(5);
    expect(adaptiveRoundStep(200)).toBe(10);
    expect(adaptiveRoundStep(500)).toBe(25);
    expect(adaptiveRoundStep(2000)).toBe(50);
    expect(adaptiveRoundStep(5000)).toBe(100);
  });

  it('snaps an off-center ltp to the nearest grid center', () => {
    // 143 → step 5 → center 145 → ±3 steps
    expect(adaptiveRoundNumbers(143)).toEqual([130, 135, 140, 145, 150, 155, 160]);
  });

  it('roundScore returns 0 for step <= 0', () => {
    expect(roundScore(100, 0)).toBe(0);
    expect(roundScore(100, -5)).toBe(0);
  });

  it('roundScore tolerates float accumulation from the grid', () => {
    // grid values can carry tiny float error; they must still read as on-grid
    expect(roundScore(150.0000000001, 5)).toBe(15);
    expect(roundScore(140.0000000001, 5)).toBe(12);
  });
});
