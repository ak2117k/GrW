import { istYmd } from './night-report.logic';
import type { ModelHorizonScorecard, ModelRegimeStats, ModelScorecardView, ModelWindowStats } from './night-report.types';

/**
 * ML model scorecard: is the live NIFTY move-size model (MBM) skilful, or is it
 * just riding the base rate? Pure functions over `mbm_predictions` rows.
 *
 * The engine predicts every 5 minutes from 09:20 to 15:30 IST: 75 runs per
 * session per horizon. Fewer rows than that are skipped (stale) runs.
 */

export const MBM_RUNS_PER_SESSION = 75;
/** The windows shown, in sessions: the last one, then rolling 5 and 20. */
export const SCORECARD_WINDOWS = [1, 5, 20] as const;
/** p at or above this is a "big move" call. */
export const BIG_CALL_P = 0.5;
export const REGIMES = ['ACTIVE', 'NORMAL', 'QUIET'] as const;

export interface MbmPredictionRow {
  horizon: string;
  asOf: Date;
  p: number;
  regime: string;
  q25Bp: number | null;
  q50Bp: number | null;
  q75Bp: number | null;
  modelId: string;
  featureSet: string;
  outcomeRangeBp: number | null;
  outcomeBig: boolean | null;
}

const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);

export function median(xs: readonly number[]): number | null {
  if (xs.length === 0) return null;
  const s = [...xs].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

/** Mean squared error of p against the 0/1 outcome. */
export function brier(pairs: ReadonlyArray<{ p: number; y: boolean }>): number | null {
  return mean(pairs.map(({ p, y }) => (p - (y ? 1 : 0)) ** 2));
}

/**
 * ROC AUC by the Mann-Whitney rank sum (ties share their average rank). Null
 * when either class is absent: AUC is undefined on one class.
 */
export function auc(pairs: ReadonlyArray<{ p: number; y: boolean }>): number | null {
  const pos = pairs.filter((x) => x.y).length;
  const neg = pairs.length - pos;
  if (pos === 0 || neg === 0) return null;
  const sorted = [...pairs].sort((a, b) => a.p - b.p);
  let rankSumPos = 0;
  for (let i = 0; i < sorted.length; ) {
    let j = i;
    while (j + 1 < sorted.length && sorted[j + 1].p === sorted[i].p) j++;
    const avgRank = (i + j) / 2 + 1;
    for (let k = i; k <= j; k++) if (sorted[k].y) rankSumPos += avgRank;
    i = j + 1;
  }
  return (rankSumPos - (pos * (pos + 1)) / 2) / (pos * neg);
}

const resolvedOf = (rows: readonly MbmPredictionRow[]) =>
  rows.filter((r) => r.outcomeBig !== null && r.outcomeBig !== undefined && Number.isFinite(r.p)).map((r) => ({ p: r.p, y: r.outcomeBig as boolean, r }));

const hitRateOf = (pairs: ReadonlyArray<{ p: number; y: boolean }>) =>
  pairs.length ? pairs.filter(({ p, y }) => (p >= BIG_CALL_P) === y).length / pairs.length : null;

/**
 * One window's statistics. `sessions` are the IST dates the window covers (the
 * expected run count is `sessions.length × runsPerSession`); `rows` are that
 * window's predictions for one horizon.
 */
export function windowStats(
  rows: readonly MbmPredictionRow[],
  sessions: readonly string[],
  requested: number,
  runsPerSession = MBM_RUNS_PER_SESSION,
): ModelWindowStats {
  const expected = sessions.length * runsPerSession;
  const resolved = resolvedOf(rows);
  const baseRate = resolved.length ? resolved.filter((x) => x.y).length / resolved.length : null;
  const b = brier(resolved);
  const brierBase = baseRate === null ? null : baseRate * (1 - baseRate);
  // One class makes the base-rate Brier 0: skill is undefined, not infinite.
  const skill = b !== null && brierBase !== null && brierBase > 0 ? 1 - b / brierBase : null;
  const a = auc(resolved);

  const regimes = {} as Record<string, ModelRegimeStats>;
  // The three known regimes always show (a zero QUIET row is itself news); an unknown one only when seen.
  const extra = [...new Set(rows.map((r) => r.regime))].filter((g) => !(REGIMES as readonly string[]).includes(g));
  for (const name of [...REGIMES, ...extra]) {
    const inRegime = rows.filter((r) => r.regime === name);
    const res = resolvedOf(inRegime);
    regimes[name] = {
      predictions: inRegime.length,
      resolved: res.length,
      hitRate: hitRateOf(res),
      bigRate: res.length ? res.filter((x) => x.y).length / res.length : null,
    };
  }

  const ranged = resolved.filter((x) => x.r.outcomeRangeBp !== null && Number.isFinite(x.r.outcomeRangeBp));
  const withQ50 = ranged.filter((x) => x.r.q50Bp !== null);
  const withIqr = ranged.filter((x) => x.r.q25Bp !== null && x.r.q75Bp !== null);
  const inside = withIqr.filter((x) => x.r.outcomeRangeBp! >= x.r.q25Bp! && x.r.outcomeRangeBp! <= x.r.q75Bp!).length;

  const models = new Map<string, { modelId: string; featureSet: string; predictions: number }>();
  for (const r of rows) {
    const k = `${r.modelId}|${r.featureSet}`;
    const m = models.get(k) ?? { modelId: r.modelId, featureSet: r.featureSet, predictions: 0 };
    m.predictions++;
    models.set(k, m);
  }

  return {
    requestedSessions: requested,
    sessions: sessions.length,
    fromDate: sessions.length ? sessions[sessions.length - 1] : null,
    toDate: sessions.length ? sessions[0] : null,
    predictions: rows.length,
    expected,
    coveragePct: expected > 0 ? (100 * rows.length) / expected : null,
    resolved: resolved.length,
    hitRate: hitRateOf(resolved),
    baseRate,
    brier: b,
    brierBase,
    skill,
    auc: a,
    aucNote: a === null ? (resolved.length === 0 ? 'n/a: no outcomes yet' : 'n/a: one class only') : null,
    regimes,
    range: {
      n: withQ50.length,
      medianActualBp: median(withQ50.map((x) => x.r.outcomeRangeBp!)),
      medianQ50Bp: median(withQ50.map((x) => x.r.q50Bp!)),
      insideIqrPct: withIqr.length ? (100 * inside) / withIqr.length : null,
    },
    models: [...models.values()].sort((x, y) => y.predictions - x.predictions),
  };
}

/**
 * The scorecard per horizon over the last session and rolling 5 / 20 sessions.
 *
 * `sessionDates` are the IST dates of the closed NSE sessions, newest first (at
 * least the widest window). Sessions before the model's first prediction are
 * dropped, so a model live for two days reads as "2 sessions", not as 18 dead
 * sessions of skipped runs. A dead session after go-live still counts.
 */
export function modelScorecard(
  rows: readonly MbmPredictionRow[],
  sessionDates: readonly string[],
  instrument = 'NIFTY',
  runsPerSession = MBM_RUNS_PER_SESSION,
): ModelScorecardView {
  const byDay = (r: MbmPredictionRow) => istYmd(r.asOf);
  const known = new Set(sessionDates);
  const inSessions = rows.filter((r) => known.has(byDay(r)));
  const firstDay = inSessions.reduce<string | null>((min, r) => (min === null || byDay(r) < min ? byDay(r) : min), null);
  const live = firstDay === null ? [] : sessionDates.filter((d) => d >= firstDay);

  const horizonNames = [...new Set(inSessions.map((r) => r.horizon))].sort();
  const horizons: Record<string, ModelHorizonScorecard> = {};
  for (const h of horizonNames) {
    const mine = inSessions.filter((r) => r.horizon === h);
    horizons[h] = {
      windows: SCORECARD_WINDOWS.map((n) => {
        const days = live.slice(0, n);
        const set = new Set(days);
        return windowStats(mine.filter((r) => set.has(byDay(r))), days, n, runsPerSession);
      }),
    };
  }
  return { instrument, runsPerSession, lastSession: sessionDates[0] ?? null, liveSince: firstDay, horizons };
}
