/**
 * Agent lessons (docs/superpowers/plans/2026-10-21-self-review-contract.md, "Lessons").
 *
 * A lesson is one or two imperative sentences the self-review diagnosis wrote about a
 * recurring miss, counted against later evidence. Only ACTIVE lessons with
 * `rightCount >= 2` are ever shown to an agent, and they are guidance — never an
 * override of a hard risk limit.
 */

export const LESSON_SCOPES = ['SENTINEL_LIVE', 'SENTINEL_OVERNIGHT', 'NEWS_IDEAS', 'ALL'] as const;
export type LessonScope = (typeof LESSON_SCOPES)[number];

/** A scope a consumer asks for (`ALL` lessons are included in every one of them). */
export type InjectionScope = Exclude<LessonScope, 'ALL'>;

export type LessonStatus = 'ACTIVE' | 'RETIRED';

/** An `agent_lessons` row as the service reads it. */
export interface LessonRecord {
  id: string;
  key: string;
  text: string;
  scope: string;
  rightCount: number;
  wrongCount: number;
  status: string;
  firstSeen: Date;
  lastSeen: Date;
  sourceRun: string | null;
}

/**
 * What an agent is shown. A `type`, not an `interface`, so it keeps the implicit index
 * signature the jsonb packet column needs (see `packetAsJson`).
 */
export type InjectedLesson = {
  key: string;
  text: string;
  /** Cases where following the lesson would have been right / wrong. */
  right: number;
  wrong: number;
};

/** Injection rules (contract): at most 8, each at most 400 chars, only after 2 right cases. */
export const MAX_INJECTED_LESSONS = 8;
export const LESSON_TEXT_MAX = 400;
export const MIN_RIGHT_TO_INJECT = 2;
/** Auto-retire once wrong > right after at least this many judged cases. */
export const RETIRE_MIN_CASES = 5;
/** The in-memory cache the hot paths read is refreshed at most this often. */
export const LESSON_CACHE_TTL_MS = 5 * 60_000;

/** `SELF_REVIEW_LESSONS=off|observe|on`. */
export type LessonsMode = 'off' | 'observe' | 'on';

/**
 * The synchronous, DB-free reader the sentinel packet and the news-ideas prompt use.
 * Returns [] when the flag is off or observe (observe logs what it would inject).
 */
export interface LessonsReader {
  inject(scope: InjectionScope): InjectedLesson[];
}

/** DI token for {@link LessonsReader} — provided by `SelfReviewLearningModule` (@Global). */
export const LESSONS_READER = 'SELF_REVIEW_LESSONS_READER';

/** What `upsertFromDiagnosis` did. */
export interface LessonUpsertSummary {
  created: string[];
  updated: string[];
  retired: string[];
}
