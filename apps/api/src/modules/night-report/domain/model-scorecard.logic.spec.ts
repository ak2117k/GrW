import { auc, brier, median, modelScorecard, windowStats, type MbmPredictionRow } from './model-scorecard.logic';

const row = (over: Partial<MbmPredictionRow>): MbmPredictionRow => ({
  horizon: '30m',
  asOf: new Date('2026-10-21T04:00:00Z'), // 09:30 IST
  p: 0.7,
  regime: 'ACTIVE',
  q25Bp: 10,
  q50Bp: 20,
  q75Bp: 30,
  modelId: 'mbm-m2',
  featureSet: 'mbm-fs2',
  outcomeRangeBp: 25,
  outcomeBig: true,
  ...over,
});

/** `n` rows five minutes apart from 09:20 IST on `day`. */
const run = (day: string, n: number, over: Partial<MbmPredictionRow> = {}) =>
  Array.from({ length: n }, (_, i) => row({ asOf: new Date(Date.parse(`${day}T03:50:00Z`) + i * 5 * 60_000), ...over }));

describe('metrics', () => {
  it('auc: perfect, inverted, all ties, and undefined on one class', () => {
    const y = [false, false, true, true];
    expect(auc([0.1, 0.2, 0.8, 0.9].map((p, i) => ({ p, y: y[i] })))).toBe(1);
    expect(auc([0.9, 0.8, 0.2, 0.1].map((p, i) => ({ p, y: y[i] })))).toBe(0);
    expect(auc([0.5, 0.5, 0.5, 0.5].map((p, i) => ({ p, y: y[i] })))).toBe(0.5);
    expect(auc([{ p: 0.9, y: true }, { p: 0.1, y: true }])).toBeNull();
  });

  it('auc: a partly ordered set', () => {
    // pos {0.4, 0.8}, neg {0.3, 0.6}: pairs (0.4>0.3, 0.4<0.6, 0.8>0.3, 0.8>0.6) → 3/4
    expect(auc([{ p: 0.3, y: false }, { p: 0.6, y: false }, { p: 0.4, y: true }, { p: 0.8, y: true }])).toBe(0.75);
  });

  it('brier and median', () => {
    expect(brier([{ p: 0.8, y: true }, { p: 0.2, y: false }])).toBeCloseTo(0.04);
    expect(brier([])).toBeNull();
    expect(median([3, 1, 2])).toBe(2);
    expect(median([4, 1, 2, 3])).toBe(2.5);
    expect(median([])).toBeNull();
  });
});

describe('windowStats', () => {
  it('day one: every call ACTIVE and every outcome big — 100% hit, but no skill and no AUC', () => {
    const w = windowStats(run('2026-10-21', 75), ['2026-10-21'], 1);
    expect(w).toMatchObject({ predictions: 75, expected: 75, coveragePct: 100, resolved: 75, hitRate: 1, baseRate: 1 });
    expect(w.brierBase).toBe(0);
    expect(w.skill).toBeNull();
    expect(w.auc).toBeNull();
    expect(w.aucNote).toBe('n/a: one class only');
    expect(w.regimes.ACTIVE).toEqual({ predictions: 75, resolved: 75, hitRate: 1, bigRate: 1 });
    // QUIET is always present, even empty, so its absence is visible.
    expect(w.regimes.QUIET).toEqual({ predictions: 0, resolved: 0, hitRate: null, bigRate: null });
  });

  it('skill against the base rate when both classes are present', () => {
    const rows = [
      row({ p: 0.8, outcomeBig: true }),
      row({ p: 0.8, outcomeBig: true }),
      row({ p: 0.2, regime: 'QUIET', outcomeBig: false }),
      row({ p: 0.2, regime: 'QUIET', outcomeBig: false }),
    ];
    const w = windowStats(rows, ['2026-10-21'], 1);
    expect(w.baseRate).toBe(0.5);
    expect(w.brier).toBeCloseTo(0.04);
    expect(w.brierBase).toBeCloseTo(0.25);
    expect(w.skill).toBeCloseTo(0.84);
    expect(w.auc).toBe(1);
    expect(w.aucNote).toBeNull();
    expect(w.hitRate).toBe(1);
  });

  it('a model that predicts worse than the base rate has negative skill', () => {
    const rows = [row({ p: 0.9, outcomeBig: false }), row({ p: 0.1, outcomeBig: true })];
    expect(windowStats(rows, ['2026-10-21'], 1).skill).toBeLessThan(0);
  });

  it('QUIET hit rate: a QUIET call is right when the move stayed small', () => {
    const rows = [
      row({ p: 0.2, regime: 'QUIET', outcomeBig: false }),
      row({ p: 0.2, regime: 'QUIET', outcomeBig: false }),
      row({ p: 0.3, regime: 'QUIET', outcomeBig: true }),
      row({ p: 0.3, regime: 'QUIET', outcomeBig: null }), // not yet resolved
    ];
    const q = windowStats(rows, ['2026-10-21'], 1).regimes.QUIET;
    expect(q.predictions).toBe(4);
    expect(q.resolved).toBe(3);
    expect(q.hitRate).toBeCloseTo(2 / 3);
    expect(q.bigRate).toBeCloseTo(1 / 3);
  });

  it('coverage counts skipped runs; unresolved rows count as predictions only', () => {
    const rows = [...run('2026-10-21', 50), ...run('2026-10-21', 10, { outcomeBig: null, outcomeRangeBp: null }).map((r, i) => ({ ...r, asOf: new Date(r.asOf.getTime() + (50 + i) * 5 * 60_000) }))];
    const w = windowStats(rows, ['2026-10-21'], 1);
    expect(w.predictions).toBe(60);
    expect(w.coveragePct).toBe(80);
    expect(w.resolved).toBe(50);
  });

  it('range calibration: median actual vs median q50 and the share inside [q25, q75]', () => {
    const rows = [
      row({ outcomeRangeBp: 5, q25Bp: 10, q50Bp: 20, q75Bp: 30 }), // below
      row({ outcomeRangeBp: 15, q25Bp: 10, q50Bp: 20, q75Bp: 30 }), // inside
      row({ outcomeRangeBp: 30, q25Bp: 10, q50Bp: 18, q75Bp: 30 }), // inside (edge)
      row({ outcomeRangeBp: 40, q25Bp: 10, q50Bp: 22, q75Bp: 30 }), // above
      row({ outcomeRangeBp: null }), // unresolved range: left out
    ];
    const w = windowStats(rows, ['2026-10-21'], 1);
    expect(w.range).toEqual({ n: 4, medianActualBp: 22.5, medianQ50Bp: 20, insideIqrPct: 50 });
  });

  it('nothing resolved yet', () => {
    const w = windowStats([row({ outcomeBig: null })], ['2026-10-21'], 1);
    expect(w).toMatchObject({ resolved: 0, hitRate: null, baseRate: null, brier: null, skill: null, auc: null, aucNote: 'n/a: no outcomes yet' });
  });

  it('lists the models in use, most rows first', () => {
    const w = windowStats([row({}), row({ modelId: 'mbm-m3', featureSet: 'mbm-fs3' }), row({ modelId: 'mbm-m3', featureSet: 'mbm-fs3' })], ['2026-10-21'], 1);
    expect(w.models).toEqual([
      { modelId: 'mbm-m3', featureSet: 'mbm-fs3', predictions: 2 },
      { modelId: 'mbm-m2', featureSet: 'mbm-fs2', predictions: 1 },
    ]);
  });
});

describe('modelScorecard', () => {
  const sessions = ['2026-10-23', '2026-10-22', '2026-10-21', '2026-10-19', '2026-10-16', '2026-10-15'];

  it('builds last / 5 / 20 per horizon, clipped to the first live session; a dead session still counts', () => {
    const rows = [
      ...run('2026-10-21', 75),
      // 22 Oct: engine dead, no rows.
      ...run('2026-10-23', 60),
      ...run('2026-10-23', 75, { horizon: '60m' }),
      row({ asOf: new Date('2026-10-24T04:00:00Z') }), // not a listed session: ignored
    ];
    const s = modelScorecard(rows, sessions);
    expect(s).toMatchObject({ instrument: 'NIFTY', runsPerSession: 75, lastSession: '2026-10-23', liveSince: '2026-10-21' });
    expect(Object.keys(s.horizons)).toEqual(['30m', '60m']);

    const [last, five, twenty] = s.horizons['30m'].windows;
    expect([last.sessions, last.predictions, last.expected]).toEqual([1, 60, 75]);
    expect(last.coveragePct).toBe(80);
    expect([five.requestedSessions, five.sessions, five.predictions, five.expected]).toEqual([5, 3, 135, 225]);
    expect([five.fromDate, five.toDate]).toEqual(['2026-10-21', '2026-10-23']);
    expect(twenty).toMatchObject({ requestedSessions: 20, sessions: 3, predictions: 135 });

    // 60m went live on the 23rd but the scorecard clips on the model's first row of any horizon.
    expect(s.horizons['60m'].windows[1]).toMatchObject({ sessions: 3, predictions: 75, expected: 225 });
  });

  it('no predictions at all', () => {
    expect(modelScorecard([], sessions)).toEqual({
      instrument: 'NIFTY', runsPerSession: 75, lastSession: '2026-10-23', liveSince: null, horizons: {},
    });
  });
});
