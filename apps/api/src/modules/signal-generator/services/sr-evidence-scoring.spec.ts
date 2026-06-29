import { scoreAndCluster, capLevelsPerSide } from './sr-evidence-scoring';
import type { EvidenceLevel, LevelCandidate } from '../types/evidence-level.types';

const ATR = 2;
const LTP = 100;

describe('scoreAndCluster', () => {
  it('keeps a candidate at/above the floor (35) and sides it correctly', () => {
    const cands: LevelCandidate[] = [{ price: 105, kind: 'VOLUME', score: 38 }];
    const out = scoreAndCluster(cands, LTP, ATR, { softRoundGrid: [] });
    expect(out).toHaveLength(1);
    expect(out[0].side).toBe('resistance');
    expect(out[0].score).toBe(38);
    expect(out[0].kinds).toEqual(['VOLUME']);
    expect(out[0].soft).toBe(false);
    expect(out[0].distancePct).toBeCloseTo(5, 5);
  });

  it('drops a candidate below the floor (a naked round number)', () => {
    const cands: LevelCandidate[] = [{ price: 105, kind: 'ROUND', score: 12 }];
    const out = scoreAndCluster(cands, LTP, ATR, { softRoundGrid: [] });
    expect(out.filter((l) => !l.soft)).toHaveLength(0);
  });

  it('clusters confluence: round + volume at the same price sum above floor', () => {
    const cands: LevelCandidate[] = [
      { price: 105, kind: 'ROUND', score: 12 },
      { price: 105.1, kind: 'VOLUME', score: 30 },
    ];
    const out = scoreAndCluster(cands, LTP, ATR, { softRoundGrid: [] });
    const kept = out.filter((l) => !l.soft);
    expect(kept).toHaveLength(1);
    expect(kept[0].score).toBe(42);
    expect(kept[0].kinds.sort()).toEqual(['ROUND', 'VOLUME']);
  });

  it('caps cluster score at 100', () => {
    const cands: LevelCandidate[] = [
      { price: 105, kind: 'VOLUME', score: 40 },
      { price: 105, kind: 'HISTORY', score: 25 },
      { price: 105, kind: 'OI_CALL', score: 30 },
      { price: 105, kind: 'ROUND', score: 15 },
    ];
    const out = scoreAndCluster(cands, LTP, ATR, { softRoundGrid: [] });
    expect(out[0].score).toBe(100);
  });

  it('adds a soft round number on a side that has no kept level', () => {
    const cands: LevelCandidate[] = [{ price: 95, kind: 'VOLUME', score: 38 }];
    const out = scoreAndCluster(cands, LTP, ATR, { softRoundGrid: [90, 100, 110, 120] });
    const res = out.find((l) => l.side === 'resistance')!;
    expect(res.soft).toBe(true);
    expect(res.price).toBe(110);
    expect(res.kinds).toEqual(['ROUND']);
  });

  it('does not add a soft level when the side already has a kept level', () => {
    const cands: LevelCandidate[] = [{ price: 105, kind: 'VOLUME', score: 38 }];
    const out = scoreAndCluster(cands, LTP, ATR, { softRoundGrid: [110, 120] });
    expect(out.filter((l) => l.side === 'resistance' && l.soft)).toHaveLength(0);
  });

  it('does not chain-drift: spread-out candidates beyond tol stay separate', () => {
    // ATR 2 → tol = max(0.6, 0.3) = 0.6. 105.0 / 105.5 / 106.0 each 0.5 apart →
    // 105.0+105.5 merge (anchor 105.0, 105.5 within 0.6), but 106.0 is 1.0 from
    // anchor 105.0 → new cluster. Without the anchor fix all three would merge.
    const cands: LevelCandidate[] = [
      { price: 105.0, kind: 'VOLUME', score: 38 },
      { price: 105.5, kind: 'VOLUME', score: 38 },
      { price: 106.0, kind: 'VOLUME', score: 38 },
    ];
    const out = scoreAndCluster(cands, LTP, ATR, { softRoundGrid: [] });
    const res = out.filter((l) => l.side === 'resistance' && !l.soft);
    expect(res.length).toBe(2); // {105.0,105.5} and {106.0}
  });

  it('never merges across the ltp: support + resistance within tol stay separate', () => {
    // 99.7 (support) and 100.3 (resistance) are 0.6 apart (== tol) but on
    // opposite sides of ltp 100 → must NOT merge, and both must be kept.
    const cands: LevelCandidate[] = [
      { price: 99.7, kind: 'VOLUME', score: 38 },
      { price: 100.3, kind: 'VOLUME', score: 40 },
    ];
    const out = scoreAndCluster(cands, LTP, ATR, { softRoundGrid: [] });
    const real = out.filter((l) => !l.soft);
    expect(real).toHaveLength(2);
    expect(real.some((l) => l.side === 'resistance')).toBe(true);
    expect(real.some((l) => l.side === 'support')).toBe(true);
  });

  it('respects a custom floor override', () => {
    const cands: LevelCandidate[] = [{ price: 105, kind: 'VOLUME', score: 38 }];
    const out = scoreAndCluster(cands, LTP, ATR, { softRoundGrid: [], floor: 50 });
    expect(out.filter((l) => !l.soft)).toHaveLength(0);
  });

  it('pure-soft: no candidates → a soft round number on each side from the grid', () => {
    const out = scoreAndCluster([], LTP, ATR, { softRoundGrid: [90, 100, 110] });
    expect(out.filter((l) => l.soft && l.side === 'resistance')).toHaveLength(1);
    expect(out.filter((l) => l.soft && l.side === 'support')).toHaveLength(1);
    expect(out.find((l) => l.side === 'resistance')!.price).toBe(110);
    expect(out.find((l) => l.side === 'support')!.price).toBe(90);
  });
});

describe('capLevelsPerSide', () => {
  const mk = (price: number, side: EvidenceLevel['side'], score: number, soft = false): EvidenceLevel => ({
    price,
    side,
    score,
    kinds: ['HISTORY'],
    soft,
    distancePct: ((price - LTP) / LTP) * 100,
  });

  it('keeps only the top-N highest-scored non-soft levels per side', () => {
    // 4 resistances + 4 supports, distinct scores; cap to 2 per side.
    const levels = [
      mk(101, 'resistance', 40), mk(102, 'resistance', 80),
      mk(103, 'resistance', 60), mk(104, 'resistance', 20),
      mk(99, 'support', 35), mk(98, 'support', 90),
      mk(97, 'support', 50), mk(96, 'support', 10),
    ];
    const out = capLevelsPerSide(levels, 2);
    const res = out.filter((l) => l.side === 'resistance').map((l) => l.score).sort((a, b) => b - a);
    const sup = out.filter((l) => l.side === 'support').map((l) => l.score).sort((a, b) => b - a);
    expect(res).toEqual([80, 60]); // dropped 40 and 20
    expect(sup).toEqual([90, 50]); // dropped 35 and 10
  });

  it('always retains soft fallback levels even when over the cap', () => {
    const levels = [
      mk(102, 'resistance', 80), mk(103, 'resistance', 60), mk(104, 'resistance', 40),
      mk(110, 'resistance', 0, true), // soft fallback
    ];
    const out = capLevelsPerSide(levels, 1);
    expect(out.filter((l) => !l.soft).map((l) => l.score)).toEqual([80]); // top 1 hard
    expect(out.some((l) => l.soft && l.price === 110)).toBe(true); // soft kept
  });

  it('preserves input ordering (nearest-first) of the kept levels', () => {
    const levels = [
      mk(101, 'resistance', 40), mk(102, 'resistance', 80), mk(103, 'resistance', 60),
    ];
    const out = capLevelsPerSide(levels, 2);
    // Kept the 80 and 60 (drop 40); original order had 102 before 103.
    expect(out.map((l) => l.price)).toEqual([102, 103]);
  });

  it('is a no-op when each side already has <= N levels', () => {
    const levels = [mk(102, 'resistance', 80), mk(98, 'support', 70)];
    expect(capLevelsPerSide(levels, 3)).toEqual(levels);
  });
});
