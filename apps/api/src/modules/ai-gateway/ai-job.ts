/**
 * Every kind of LLM call the gateway knows how to route (spec §4.1).
 *
 * `sentinel.*` are live today; the rest are routed by `config/ai-routes.json`
 * and have no caller yet. `sentinel.unknown` is what a sentinel request maps to
 * when its schema is not one of the three known ones — it routes exactly like
 * the other sentinel jobs, so an unrecognised request is still served, just
 * labelled honestly in the ledger.
 */
export const AI_JOBS = [
  'sentinel.judge',
  'sentinel.overnight',
  'sentinel.thesis',
  'sentinel.unknown',
  'decision.judge',
  'review.overnight',
  'review.holdings',
  'news.impact',
  'news.profile',
  'news.audit',
  'news.curate',
  'news.label',
  'picks.next-day',
  'picks.pre-market',
  'learning.nightly',
  'strategy.draft',
] as const;

export type AiJob = (typeof AI_JOBS)[number];

export function isAiJob(value: string): value is AiJob {
  return (AI_JOBS as readonly string[]).includes(value);
}

/**
 * Lower = more urgent. Spec §4.4: position review (`sentinel.*`, `review.*`) >
 * `decision.judge` > `news.impact` > picks > learning / strategy drafting.
 * news.profile|audit|curate|label fall to 4 — below every sentinel.* / review.* job, spec §9.1.
 */
export function priorityOf(job: AiJob): number {
  if (job.startsWith('sentinel.') || job.startsWith('review.')) return 0;
  if (job === 'decision.judge') return 1;
  if (job === 'news.impact') return 2;
  if (job.startsWith('picks.')) return 3;
  return 4;
}

/** Position-review jobs — the only ones allowed into the budget reserve. */
export function isReviewJob(job: AiJob): boolean {
  return priorityOf(job) === 0;
}
