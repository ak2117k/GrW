import { describe, expect, it } from 'vitest';
import type { ModelHorizonScorecard, ModelWindowStats } from '@/types/nightReport.types';
import {
  aucCell,
  brierCell,
  coverageCell,
  insideIqrCell,
  modelLine,
  modelVerdict,
  rangeCell,
  rate,
  regimeCell,
  signedSkill,
  windowHeading,
} from './modelScorecardFormat';

const empty = { predictions: 0, resolved: 0, hitRate: null, bigRate: null };

const win = (over: Partial<ModelWindowStats> = {}): ModelWindowStats => ({
  requestedSessions: 20,
  sessions: 12,
  fromDate: '2026-10-01',
  toDate: '2026-10-21',
  predictions: 1800,
  expected: 1800,
  coveragePct: 100,
  resolved: 1700,
  hitRate: 0.71,
  baseRate: 0.45,
  brier: 0.218,
  brierBase: 0.2475,
  skill: 0.12,
  auc: 0.68,
  aucNote: null,
  regimes: {
    ACTIVE: { predictions: 600, resolved: 580, hitRate: 0.7, bigRate: 0.7 },
    NORMAL: { predictions: 900, resolved: 850, hitRate: 0.6, bigRate: 0.45 },
    QUIET: { predictions: 300, resolved: 270, hitRate: 0.81, bigRate: 0.19 },
  },
  range: { n: 1700, medianActualBp: 31.6, medianQ50Bp: 28.2, insideIqrPct: 47.9 },
  models: [{ modelId: 'mbm-m2', featureSet: 'mbm-fs2', predictions: 1800 }],
  ...over,
});

const horizon = (over: Partial<ModelWindowStats> = {}): ModelHorizonScorecard => ({
  windows: [win({ requestedSessions: 1, sessions: 1 }), win({ requestedSessions: 5, sessions: 5 }), win(over)],
});

describe('model scorecard cells', () => {
  it('rates, skill and headings', () => {
    expect(rate(0.934)).toBe('93%');
    expect(rate(null)).toBe('—');
    expect(signedSkill(0.1234)).toBe('+0.12');
    expect(signedSkill(-0.08)).toBe('−0.08');
    expect(signedSkill(-0.001)).toBe('0.00');
    expect(signedSkill(null)).toBe('—');
    expect(windowHeading({ requestedSessions: 1, sessions: 1 })).toBe('Last session');
    expect(windowHeading({ requestedSessions: 5, sessions: 5 })).toBe('5 sessions');
    expect(windowHeading({ requestedSessions: 20, sessions: 3 })).toBe('20 sessions (3 live)');
  });

  it('coverage, brier, auc', () => {
    expect(coverageCell({ predictions: 70, expected: 75, coveragePct: 93.33 })).toBe('70/75 (93%)');
    expect(coverageCell({ predictions: 0, expected: 0, coveragePct: null })).toBe('—');
    expect(brierCell({ brier: 0.218, brierBase: 0.25 })).toBe('0.218 vs 0.250 base');
    expect(brierCell({ brier: null, brierBase: null })).toBe('—');
    expect(aucCell({ auc: 0.684, aucNote: null })).toBe('0.68');
    expect(aucCell({ auc: null, aucNote: 'n/a: one class only' })).toBe('n/a: one class only');
  });

  it('regimes and range calibration', () => {
    expect(regimeCell({ predictions: 300, resolved: 270, hitRate: 0.81, bigRate: 0.19 })).toBe('270 · hit 81% · big 19%');
    expect(regimeCell({ predictions: 4, resolved: 0, hitRate: null, bigRate: null })).toBe('4 · unresolved');
    expect(regimeCell(empty)).toBe('none');
    expect(regimeCell(undefined)).toBe('none');
    expect(rangeCell(win())).toBe('32 vs 28 bp');
    expect(rangeCell(win({ range: { n: 0, medianActualBp: null, medianQ50Bp: null, insideIqrPct: null } }))).toBe('—');
    expect(insideIqrCell(win())).toBe('48% of 1700');
  });

  it('model line', () => {
    expect(modelLine(horizon())).toBe('mbm-m2 / mbm-fs2');
    expect(
      modelLine(horizon({ models: [{ modelId: 'm3', featureSet: 'fs3', predictions: 9 }, { modelId: 'm2', featureSet: 'fs2', predictions: 1 }] })),
    ).toBe('m3 / fs3, m2 / fs2');
    expect(modelLine(horizon({ models: [] }))).toBe('No model');
  });
});

describe('modelVerdict', () => {
  it('day one: every outcome big, all ACTIVE — too early, not "100% right"', () => {
    const v = modelVerdict(
      horizon({
        sessions: 1, hitRate: 1, baseRate: 1, brierBase: 0, skill: null, auc: null, aucNote: 'n/a: one class only',
        regimes: { ACTIVE: { predictions: 75, resolved: 75, hitRate: 1, bigRate: 1 }, NORMAL: empty, QUIET: empty },
      }),
    );
    expect(v).toEqual({ text: 'Too early: 1 session, one class only · no QUIET calls yet', variant: 'neutral' });
  });

  it('beats, matches or trails the base rate once there are enough sessions', () => {
    expect(modelVerdict(horizon())).toEqual({ text: 'Beats base rate (skill +0.12) · QUIET hit 81% of 270', variant: 'success' });
    expect(modelVerdict(horizon({ skill: 0.01 })).text).toBe('No better than base rate (skill +0.01) · QUIET hit 81% of 270');
    expect(modelVerdict(horizon({ skill: 0.01 })).variant).toBe('warning');
    expect(modelVerdict(horizon({ skill: -0.08 }))).toMatchObject({ text: 'Worse than base rate (skill −0.08) · QUIET hit 81% of 270', variant: 'danger' });
  });

  it('few sessions stay "too early" even with both classes', () => {
    expect(modelVerdict(horizon({ sessions: 3 })).text).toBe('Too early: 3 sessions (skill +0.12) · QUIET hit 81% of 270');
  });

  it('calls out skipped runs, unresolved windows and an empty window', () => {
    expect(modelVerdict(horizon({ coveragePct: 72.4 })).text).toBe('Beats base rate (skill +0.12) · QUIET hit 81% of 270 · 28% runs skipped');
    expect(modelVerdict(horizon({ sessions: 1, resolved: 0, skill: null, auc: null })).text).toBe(
      'Too early: 1 session, no outcomes resolved yet · QUIET hit 81% of 270',
    );
    expect(modelVerdict(horizon({ predictions: 0 }))).toEqual({ text: 'No predictions in the window', variant: 'danger' });
    expect(modelVerdict({ windows: [] }).variant).toBe('danger');
  });
});
