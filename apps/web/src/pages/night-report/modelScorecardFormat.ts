import type { ModelHorizonScorecard, ModelRegimeStats, ModelWindowStats } from '@/types/nightReport.types';

/**
 * Pure view logic for the "ML model scorecard" section: is the live NIFTY move-size
 * model (MBM) skilful, or riding the base rate? No React, no DOM.
 */

type BadgeVariant = 'success' | 'warning' | 'danger' | 'neutral' | 'info';

/** Skill within ±this of zero is "no better than the base rate". */
export const SKILL_EPSILON = 0.02;
/** Below this many sessions every verdict is "too early". */
export const MIN_SESSIONS = 5;
/** Coverage below this calls out the skipped runs in the verdict. */
export const COVERAGE_WARN_PCT = 90;

const DASH = '—';
const ok = (n: number | null | undefined): n is number => n != null && Number.isFinite(n);
const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/** A 0..1 rate as a whole percent ("93%"). */
export function rate(x: number | null | undefined): string {
  return ok(x) ? `${Math.round(x * 100)}%` : DASH;
}

/** A signed skill with a real minus sign ("+0.12", "−0.08"). */
export function signedSkill(x: number | null | undefined): string {
  if (!ok(x)) return DASH;
  const s = x.toFixed(2);
  if (s === '0.00' || s === '-0.00') return '0.00';
  return x > 0 ? `+${s}` : `−${s.slice(1)}`;
}

/** Column heading: "Last session", "5 sessions", "20 sessions (3 live)". */
export function windowHeading(w: Pick<ModelWindowStats, 'requestedSessions' | 'sessions'>): string {
  const base = w.requestedSessions === 1 ? 'Last session' : `${w.requestedSessions} sessions`;
  return w.sessions < w.requestedSessions && w.requestedSessions > 1 ? `${base} (${w.sessions} live)` : base;
}

/** "70/75 (93%)": predictions made against the runs expected; the gap is skipped runs. */
export function coverageCell(w: Pick<ModelWindowStats, 'predictions' | 'expected' | 'coveragePct'>): string {
  if (w.expected === 0) return DASH;
  return `${w.predictions}/${w.expected} (${ok(w.coveragePct) ? Math.round(w.coveragePct) : 0}%)`;
}

/** "0.180 vs 0.250 base". */
export function brierCell(w: Pick<ModelWindowStats, 'brier' | 'brierBase'>): string {
  if (!ok(w.brier)) return DASH;
  return `${w.brier.toFixed(3)} vs ${ok(w.brierBase) ? w.brierBase.toFixed(3) : DASH} base`;
}

/** AUC to two places, or why there is none ("n/a: one class only"). */
export function aucCell(w: Pick<ModelWindowStats, 'auc' | 'aucNote'>): string {
  return ok(w.auc) ? w.auc.toFixed(2) : w.aucNote ?? 'n/a';
}

/** "12 · hit 83% · big 17%", or "none" when the regime was never called. */
export function regimeCell(r: ModelRegimeStats | undefined): string {
  if (!r || r.predictions === 0) return 'none';
  if (r.resolved === 0) return `${r.predictions} · unresolved`;
  return `${r.resolved} · hit ${rate(r.hitRate)} · big ${rate(r.bigRate)}`;
}

/** Median actual range against median predicted q50: "32 vs 28 bp". */
export function rangeCell(w: Pick<ModelWindowStats, 'range'>): string {
  const { medianActualBp: a, medianQ50Bp: q } = w.range;
  if (!ok(a) || !ok(q)) return DASH;
  return `${Math.round(a)} vs ${Math.round(q)} bp`;
}

/** Share of outcomes inside the predicted [q25, q75] (ideally near 50%). */
export function insideIqrCell(w: Pick<ModelWindowStats, 'range'>): string {
  const x = w.range.insideIqrPct;
  return ok(x) ? `${Math.round(x)}% of ${w.range.n}` : DASH;
}

/** "mbm-m2 / mbm-fs2" for the models behind a horizon, most rows first. */
export function modelLine(h: ModelHorizonScorecard): string {
  const widest = h.windows[h.windows.length - 1];
  const models = widest?.models ?? [];
  if (models.length === 0) return 'No model';
  return models.map((m) => `${m.modelId} / ${m.featureSet}`).join(', ');
}

/**
 * The one-line plain-English verdict for a horizon, judged on its widest window.
 * Too little data says so ("Too early: 1 session, one class only") before any
 * claim of skill; QUIET calls and skipped runs are appended because a model that
 * only ever says ACTIVE on big days can post a perfect hit rate with no skill.
 */
export function modelVerdict(h: ModelHorizonScorecard): { text: string; variant: BadgeVariant } {
  const w = h.windows[h.windows.length - 1];
  if (!w || w.predictions === 0) return { text: 'No predictions in the window', variant: 'danger' };
  const sessions = plural(w.sessions, 'session', 'sessions');

  let head: string;
  let variant: BadgeVariant;
  if (w.resolved === 0) {
    head = `Too early: ${sessions}, no outcomes resolved yet`;
    variant = 'neutral';
  } else if (!ok(w.auc) || !ok(w.skill)) {
    head = `Too early: ${sessions}, one class only`;
    variant = 'neutral';
  } else if (w.sessions < MIN_SESSIONS) {
    head = `Too early: ${sessions} (skill ${signedSkill(w.skill)})`;
    variant = 'neutral';
  } else if (w.skill > SKILL_EPSILON) {
    head = `Beats base rate (skill ${signedSkill(w.skill)})`;
    variant = 'success';
  } else if (w.skill < -SKILL_EPSILON) {
    head = `Worse than base rate (skill ${signedSkill(w.skill)})`;
    variant = 'danger';
  } else {
    head = `No better than base rate (skill ${signedSkill(w.skill)})`;
    variant = 'warning';
  }

  const parts = [head];
  const quiet = w.regimes.QUIET;
  parts.push(quiet && quiet.resolved > 0 ? `QUIET hit ${rate(quiet.hitRate)} of ${quiet.resolved}` : 'no QUIET calls yet');
  if (ok(w.coveragePct) && w.coveragePct < COVERAGE_WARN_PCT) parts.push(`${Math.round(100 - w.coveragePct)}% runs skipped`);
  return { text: parts.join(' · '), variant };
}
