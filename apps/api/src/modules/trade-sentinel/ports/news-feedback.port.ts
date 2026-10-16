import type { NewsIgnoredKind } from '../../news-events/context-types';

export interface JudgeFeedback {
  articleId: string; tag: string; symbol: string; kind: NewsIgnoredKind; reason: string; verdictId: string | null; trackerId: string;
}
/** Fire-and-forget: never throws, never awaited by the cycle. */
export interface NewsFeedbackSink { recordJudge(rows: readonly JudgeFeedback[]): void }
export const NEWS_FEEDBACK = 'SENTINEL_NEWS_FEEDBACK';
