import { MIN_RELATIVE_N, auc, probabilitySkill, probOutcome, relativeSkill } from './skill';

/** A stored MBM verification row: correct = (p ≥ 0.5) === actual big. */
const row = (p: number, big: boolean) => ({ correct: p >= 0.5 === big, details: { p } });

describe('probOutcome', () => {
  it('recovers the actual outcome from the call and correct', () => {
    expect(probOutcome(row(0.9, true))).toEqual({ p: 0.9, y: 1 });
    expect(probOutcome(row(0.9, false))).toEqual({ p: 0.9, y: 0 });
    expect(probOutcome(row(0.2, true))).toEqual({ p: 0.2, y: 1 });
    expect(probOutcome(row(0.2, false))).toEqual({ p: 0.2, y: 0 });
    expect(probOutcome({ correct: null, details: { p: 0.9 } })).toBeNull();
    expect(probOutcome({ correct: true, details: null })).toBeNull();
  });
});

describe('auc', () => {
  it('is 1 for perfect ranking, 0.5 for ties, null with one class', () => {
    expect(auc([{ p: 0.1, y: 0 }, { p: 0.9, y: 1 }])).toBe(1);
    expect(auc([{ p: 0.5, y: 0 }, { p: 0.5, y: 1 }])).toBe(0.5);
    expect(auc([{ p: 0.9, y: 0 }, { p: 0.1, y: 1 }])).toBe(0);
    expect(auc([{ p: 0.9, y: 1 }, { p: 0.8, y: 1 }])).toBeNull();
  });
});

describe('probabilitySkill', () => {
  it('2026-10-21/22: 78 of 79 big is NOT_TESTABLE, even with a 99% hit rate', () => {
    const rows = [...Array.from({ length: 78 }, () => row(0.9, true)), row(0.9, false)];
    const s = probabilitySkill(rows);
    expect(s.hitRate).toBeCloseTo(0.987, 3);
    expect(s.majorityHitRate).toBeCloseTo(0.987, 3);
    expect(s.verdict).toBe('NOT_TESTABLE');
    expect(s.note).toContain('only 1 small window(s) of 79');
    expect(s.note).toContain('always saying "BIG" would score 99%');
  });

  it('EDGE when it ranks well and beats the base-rate forecast on a mixed sample', () => {
    const rows = [
      ...Array.from({ length: 15 }, () => row(0.8, true)),
      ...Array.from({ length: 5 }, () => row(0.8, false)),
      ...Array.from({ length: 3 }, () => row(0.2, true)),
      ...Array.from({ length: 12 }, () => row(0.2, false)),
    ];
    const s = probabilitySkill(rows);
    expect(s.verdict).toBe('EDGE');
    expect(s.auc).toBeGreaterThan(0.6);
    expect(s.brierSkill).toBeGreaterThan(0);
  });

  it('NO_EDGE when the probabilities carry no information', () => {
    const rows = [
      ...Array.from({ length: 10 }, () => row(0.8, true)),
      ...Array.from({ length: 10 }, () => row(0.8, false)),
      ...Array.from({ length: 10 }, () => row(0.3, true)),
      ...Array.from({ length: 10 }, () => row(0.3, false)),
    ];
    const s = probabilitySkill(rows);
    expect(s.auc).toBe(0.5);
    expect(s.verdict).toBe('NO_EDGE');
  });

  it('empty input is NOT_TESTABLE with nulls', () => {
    expect(probabilitySkill([])).toMatchObject({ n: 0, verdict: 'NOT_TESTABLE', auc: null, hitRate: null });
  });
});

describe('relativeSkill (MBM_RELATIVE)', () => {
  /** A stored relative verification: the call, its ratio, the realised ratio; correct by the scorer's rule. */
  const rel = (label: string, relRatio: number, realisedRatio: number) => {
    const correct = label === 'QUIETER' ? realisedRatio < 1 : label === 'NORMAL' ? realisedRatio >= 0.8 && realisedRatio <= 1.25 : realisedRatio > 1;
    return { correct, details: { relLabel: label, relRatio, realisedRatio } };
  };

  it('nothing judged → NOT_TESTABLE', () => {
    expect(relativeSkill([{ correct: null, details: {} }])).toMatchObject({ n: 0, verdict: 'NOT_TESTABLE' });
  });

  it('too few calls → NOT_TESTABLE, with the best constant call named', () => {
    const s = relativeSkill(Array.from({ length: 10 }, () => rel('BUSIER', 1.5, 1.6)));
    expect(s).toMatchObject({ n: 10, verdict: 'NOT_TESTABLE', hitRate: 1, majorityHitRate: 1 });
    expect(s.note).toContain(`< ${MIN_RELATIVE_N}`);
  });

  it('always saying BUSIER in a busy regime scores no better than the constant call → NO_EDGE', () => {
    const rows = [...Array.from({ length: 36 }, () => rel('BUSIER', 1.6, 1.4)), ...Array.from({ length: 4 }, () => rel('BUSIER', 1.6, 0.7))];
    const s = relativeSkill(rows);
    expect(s).toMatchObject({ n: 40, hitRate: 0.9, majorityHitRate: 0.9, positives: 36, verdict: 'NO_EDGE' });
  });

  it('separating quiet drifts from spikes beats every constant call and ranks them → EDGE', () => {
    const rows = [
      ...Array.from({ length: 20 }, () => rel('QUIETER', 0.6, 0.7)),
      ...Array.from({ length: 20 }, () => rel('MUCH_BUSIER', 2.0, 2.4)),
    ];
    const s = relativeSkill(rows);
    expect(s).toMatchObject({ n: 40, hitRate: 1, majorityHitRate: 0.5, auc: 1, verdict: 'EDGE', brier: null });
    expect(s.note).toContain('AUC 1.00');
  });
});
