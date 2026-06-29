import { classifyReaction, reactionTolerance, type ReactionCandle } from './sr-level-tracking.helpers';
import type { EvidenceLevel } from '../types/evidence-level.types';

const support = (price: number): EvidenceLevel => ({
  price,
  side: 'support',
  score: 70,
  kinds: ['VOLUME'],
  soft: false,
  distancePct: 1,
});

const resistance = (price: number): EvidenceLevel => ({
  price,
  side: 'resistance',
  score: 70,
  kinds: ['HISTORY'],
  soft: false,
  distancePct: 1,
});

const c = (high: number, low: number, close: number): ReactionCandle => ({ high, low, close });

describe('reactionTolerance', () => {
  it('uses 0.3*atr when atr dominates the pct floor', () => {
    // price=100 → pct floor 0.3; 0.3*atr14(5)=1.5 dominates
    expect(reactionTolerance(100, 5)).toBeCloseTo(1.5, 6);
  });

  it('falls back to the 0.3% price floor when atr is small/zero/undefined', () => {
    expect(reactionTolerance(100, 0)).toBeCloseTo(0.3, 6);
    expect(reactionTolerance(100, undefined as unknown as number)).toBeCloseTo(0.3, 6);
    expect(reactionTolerance(100, 0.1)).toBeCloseTo(0.3, 6); // 0.3*0.1=0.03 < 0.3
  });
});

describe('classifyReaction — UNTOUCHED', () => {
  it('returns UNTOUCHED when price never comes within tol of a support', () => {
    // support 100, tol with atr5 = 1.5 → zone [98.5, 101.5]. Price stays >> above.
    const candles = [c(110, 108, 109), c(112, 109, 111), c(115, 110, 114)];
    const res = classifyReaction(support(100), candles, 5);
    expect(res.touched).toBe(false);
    expect(res.reaction).toBe('UNTOUCHED');
  });

  it('returns UNTOUCHED for an empty candle set', () => {
    const res = classifyReaction(resistance(100), [], 5);
    expect(res.touched).toBe(false);
    expect(res.reaction).toBe('UNTOUCHED');
  });
});

describe('classifyReaction — support', () => {
  // support 100, atr 5 → tol 1.5; zone [98.5, 101.5]
  it('REJECTED: dips into the zone then bounces up >= tol (holds)', () => {
    const candles = [
      c(102, 99, 100), // touches zone (low 99 within [98.5,101.5]); closes at level
      c(104, 100, 103.5), // high 104 >= 100+1.5 → moved away up >= tol
    ];
    const res = classifyReaction(support(100), candles, 5);
    expect(res.touched).toBe(true);
    expect(res.reaction).toBe('REJECTED');
  });

  it('BROKE: closes decisively below by >= tol', () => {
    const candles = [
      c(101, 99, 99.5), // touches
      c(99.5, 97, 98), // close 98 <= 100-1.5 → decisive break below
    ];
    const res = classifyReaction(support(100), candles, 5);
    expect(res.touched).toBe(true);
    expect(res.reaction).toBe('BROKE');
  });

  it('a poke just under tol below (no decisive close) is NOT a break', () => {
    const candles = [
      c(101, 99, 99.2), // close 99.2 > 98.5 → not decisive (> price-tol)
      c(101, 99.5, 99.4), // still hovering, no >= tol bounce
    ];
    const res = classifyReaction(support(100), candles, 5);
    expect(res.touched).toBe(true);
    expect(res.reaction).not.toBe('BROKE');
  });
});

describe('classifyReaction — resistance', () => {
  // resistance 100, atr 5 → tol 1.5; zone [98.5, 101.5]
  it('REJECTED: pushes into the zone then falls away >= tol (holds)', () => {
    const candles = [
      c(101, 99, 100), // touches
      c(100, 96, 96.5), // low 96 <= 100-1.5 → moved away down >= tol
    ];
    const res = classifyReaction(resistance(100), candles, 5);
    expect(res.touched).toBe(true);
    expect(res.reaction).toBe('REJECTED');
  });

  it('BROKE: closes decisively above by >= tol', () => {
    const candles = [
      c(101, 99, 100.5), // touches
      c(104, 101, 103), // close 103 >= 100+1.5 → decisive break above
    ];
    const res = classifyReaction(resistance(100), candles, 5);
    expect(res.touched).toBe(true);
    expect(res.reaction).toBe('BROKE');
  });
});

describe('classifyReaction — ambiguous near-tol', () => {
  // resistance 100, atr 5 → tol 1.5. Touches and hovers: never closes >= tol
  // beyond, never falls >= tol away. Held-but-undecided → REJECTED + ambiguous.
  it('marks a touched-but-undecided level REJECTED with detail.ambiguous', () => {
    const candles = [
      c(101.4, 99.5, 100.2), // touch, close 100.2 < 101.5 (not break)
      c(101.0, 99.2, 99.5), // low 99.2 > 98.5 (move-away 0.8 < tol 1.5)
    ];
    const res = classifyReaction(resistance(100), candles, 5);
    expect(res.touched).toBe(true);
    expect(res.reaction).toBe('REJECTED');
    expect(res.detail.ambiguous).toBe(true);
  });

  it('BROKE takes precedence over a prior rejection in the window', () => {
    // support 100: bounces up >= tol first, then later closes decisively below.
    const candles = [
      c(102, 99, 101), // touch
      c(104, 100, 103), // bounce up >= tol (would be REJECTED)
      c(101, 96, 97), // later close 97 <= 98.5 → decisive break
    ];
    const res = classifyReaction(support(100), candles, 5);
    expect(res.reaction).toBe('BROKE');
  });
});
