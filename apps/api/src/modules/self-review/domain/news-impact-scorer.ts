/**
 * NEWS_IMPACT (2026-10-24): every analysed news cluster with an affected symbol / index, judged on
 * the reaction the news-impact module recorded (news_reactions). INTRADAY: the +60 m move; DAYS:
 * close-to-next-close; beyond the noise band in the called direction → right, the other way → wrong,
 * else null (WEEKS / NEUTRAL / no bars → null). refId = news_reactions.id, subject = material type.
 *
 * The summary adds hit rates by news source (the source that broke the story) and by material type,
 * and a magnitude sanity check: mean |move %| per called magnitude (HIGH should move more than LOW).
 */
import { judgeReaction, type ReactionRow } from '../../news-impact/domain/reaction';
import type { VerificationDraft } from '../self-review.types';

export type NewsImpactVerifyRow = ReactionRow;

export function scoreNewsImpact(r: NewsImpactVerifyRow): VerificationDraft | null {
  if (!r.judgeSession) return null;
  const v = judgeReaction(r);
  const actual =
    v.status === 'NO_DATA'
      ? 'no bars to judge'
      : v.status === 'NOT_JUDGED_WEEKS'
        ? 'horizon weeks: recorded, not judged'
        : `${r.horizon === 'INTRADAY' ? '+60m' : 'close-to-next-close'} ${v.movePct !== null && v.movePct >= 0 ? '+' : ''}${v.movePct}% (band ±${v.band}) — ${v.status.toLowerCase()}`;
  return {
    sessionDate: r.judgeSession,
    kind: 'NEWS_IMPACT',
    refId: r.id,
    subject: r.materialType,
    symbol: r.symbol,
    predicted: `${r.direction} ${r.magnitude} ${r.horizon} ${r.symbol}: ${r.oneLine}`.slice(0, 300),
    actual,
    correct: v.correct,
    score: v.correct === null ? null : v.correct ? 1 : -1,
    details: {
      status: v.status,
      move: v.move,
      movePct: v.movePct,
      band: v.band,
      magnitude: r.magnitude,
      horizon: r.horizon,
      direction: r.direction,
      firstSource: r.firstSource,
      sources: r.sources,
      clusterId: r.clusterId,
      headline: r.headline.slice(0, 200),
    },
  };
}

export interface HitStats {
  n: number;
  right: number;
  wrong: number;
  hitRate: number | null;
}

export interface NewsImpactSummary {
  bySource: Record<string, HitStats>;
  byMaterialType: Record<string, HitStats>;
  /** Mean |move %| per called magnitude (judgeable moves only, priced or not). */
  magnitudeSanity: Record<string, { n: number; meanAbsMovePct: number | null }>;
  /** True when mean |move| rises LOW < MED < HIGH over the magnitudes that have data; null with < 2 magnitudes. */
  magnitudeOrdered: boolean | null;
}

type Row = Pick<VerificationDraft, 'subject' | 'correct'> & { details: unknown };

function add(m: Record<string, HitStats>, key: string, correct: boolean | null): void {
  const s = (m[key] ??= { n: 0, right: 0, wrong: 0, hitRate: null });
  s.n++;
  if (correct === true) s.right++;
  if (correct === false) s.wrong++;
  s.hitRate = s.right + s.wrong > 0 ? Math.round((s.right / (s.right + s.wrong)) * 1000) / 1000 : null;
}

/** Over NEWS_IMPACT rows (a session or a rolling window). */
export function newsImpactSummary(rows: readonly Row[]): NewsImpactSummary {
  const bySource: Record<string, HitStats> = {};
  const byMaterialType: Record<string, HitStats> = {};
  const moves: Record<string, number[]> = {};
  for (const r of rows) {
    const d = (r.details ?? {}) as Record<string, unknown>;
    add(bySource, typeof d.firstSource === 'string' ? d.firstSource : 'unknown', r.correct);
    add(byMaterialType, r.subject ?? 'unknown', r.correct);
    const mag = typeof d.magnitude === 'string' ? d.magnitude : null;
    if (mag && typeof d.movePct === 'number' && Number.isFinite(d.movePct)) (moves[mag] ??= []).push(Math.abs(d.movePct));
  }
  const magnitudeSanity: NewsImpactSummary['magnitudeSanity'] = {};
  for (const m of ['LOW', 'MED', 'HIGH']) {
    const xs = moves[m] ?? [];
    magnitudeSanity[m] = { n: xs.length, meanAbsMovePct: xs.length ? Math.round((xs.reduce((a, b) => a + b, 0) / xs.length) * 1000) / 1000 : null };
  }
  const means = ['LOW', 'MED', 'HIGH'].map((m) => magnitudeSanity[m].meanAbsMovePct).filter((x): x is number => x !== null);
  const magnitudeOrdered = means.length < 2 ? null : means.every((x, i) => i === 0 || x >= means[i - 1]);
  return { bySource, byMaterialType, magnitudeSanity, magnitudeOrdered };
}
