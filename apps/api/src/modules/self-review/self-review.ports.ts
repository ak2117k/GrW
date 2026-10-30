/**
 * Seams to stream B (diagnose/** and lessons/**). Stream A injects these with `@Optional()`, so the
 * run works — verify, summarise, propose — before or without B. B binds them in its module:
 *
 *   { provide: SELF_REVIEW_DIAGNOSIS, useExisting: DiagnosisService }
 *   { provide: SELF_REVIEW_LESSONS, useExisting: LessonsService }
 */
import type { VerificationDraft } from './self-review.types';

/** One wrong call handed to the diagnosis (the stored result, with its id). */
export type DiagnosisMiss = VerificationDraft & { id?: string };

export interface DiagnosisMissOut {
  refIds: string[];
  cause: string;
  category?: string;
  lessonKey?: string;
  lessonText?: string;
  scope?: string;
  proposalTarget?: string;
  proposedValue?: unknown;
}

export interface DiagnosisOutput {
  misses: DiagnosisMissOut[];
  /** The diagnosis' read of the signal paper trades split by OI verdict / AI judge call (observation only). */
  signalPaperAssessment?: string;
  /** The diagnosis' read of the exit noise reads' scores (observation only). */
  exitNoiseAssessment?: string;
}

export interface DiagnosisPort {
  /** One batched LLM call; persists `self_review_runs.diagnosis` / `ai_call_id` and upserts lessons. */
  diagnose(runId: string, misses: DiagnosisMiss[], context?: { signalPaper?: unknown; noiseReads?: unknown }): Promise<DiagnosisOutput | null>;
}

export interface LessonsPort {
  retire?(id: string, by?: string): Promise<unknown>;
}

export const SELF_REVIEW_DIAGNOSIS = Symbol('SELF_REVIEW_DIAGNOSIS');
export const SELF_REVIEW_LESSONS = Symbol('SELF_REVIEW_LESSONS');

/** Contract: the wrong calls of S handed to the diagnosis are capped at 15. */
export const DIAGNOSIS_MISS_CAP = 15;

/**
 * The night report's `selfReview` section reads `latest()` through this token (exported by the
 * @Global SelfReviewModule, injected `@Optional()`), so night-report needs no import of this module.
 */
export const SELF_REVIEW_REPORT = Symbol('SELF_REVIEW_REPORT');
export interface SelfReviewReportSource {
  latest(): Promise<unknown>;
}
