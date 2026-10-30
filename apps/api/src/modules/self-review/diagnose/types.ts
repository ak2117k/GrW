/**
 * Diagnosis of a run's misses (docs/superpowers/plans/2026-10-21-self-review-contract.md, "Diagnose").
 */
import type { LessonScope } from '../lessons/types';

/**
 * One wrong call handed to the diagnosis — a `verification_results` row with `correct=false`,
 * plus an excerpt of what the call was made from (scorecard factors / verdict packet excerpt /
 * idea text). `inputs` is serialised and capped by the prompt builder; pass what you have.
 */
export interface MissInput {
  kind: string;
  refId: string;
  sessionDate?: string;
  symbol?: string | null;
  subject?: string | null;
  predicted: string;
  actual: string;
  score?: number | null;
  details?: unknown;
  inputs?: unknown;
}

export const MISS_CATEGORIES = [
  'THESIS_WRONG',
  'TIMING',
  'FACTOR_MISREAD',
  'NEWS_OVERWEIGHTED',
  'DATA_MISSING',
  'REGIME_SHIFT',
  'NOISE',
  'OTHER',
] as const;
export type MissCategory = (typeof MISS_CATEGORIES)[number];

/** One diagnosed group of misses (validated). */
export interface DiagnosedMiss {
  /** Only refIds that were in the input survive validation; at least one. */
  refIds: string[];
  cause: string;
  category: MissCategory;
  /** A lesson that, followed, would have avoided these misses (new or existing key). */
  lessonKey?: string;
  lessonText?: string;
  scope?: LessonScope;
  /** Existing ACTIVE lesson keys that these misses followed / would have followed (counts as wrong). */
  contradicts?: string[];
  /** A suggestion only — stream A's deterministic proposal engine decides. */
  proposalTarget?: string;
  proposedValue?: number | boolean;
  /** Scorecard factors the diagnosis blamed (checked against the scored points). */
  blamedFactors?: string[];
  /** What validation removed from this entry and why (an ungrounded lesson, an unknown target). */
  dropped?: string;
}

/**
 * Run-level context beside the misses. `signalPaper` = signal-trades' signalPaperDigest, `noiseReads` =
 * exit-noise's noiseReadDigest (null/absent = none).
 */
export interface DiagnosisContext {
  signalPaper?: unknown;
  noiseReads?: unknown;
}

export type DiagnosisStatus = 'OK' | 'SKIPPED' | 'FAILED';

/**
 * The result of `DiagnosisService.diagnose`. It never throws: `FAILED` / `SKIPPED` carry a
 * reason and no misses, and the run continues with `diagnosis = null`
 * ({@link diagnosisForRun}).
 */
export interface DiagnosisResult {
  status: DiagnosisStatus;
  misses: DiagnosedMiss[];
  reason?: string;
  /** How many misses were sent (after the cap) / dropped by the cap. */
  sent: number;
  dropped: number;
  model?: string;
  promptVersion: string;
  /** The diagnosis' read of the signal paper splits by OI verdict / judge call (observation only). */
  signalPaperAssessment?: string;
  /** The diagnosis' read of the exit noise reads' scores (observation only). */
  exitNoiseAssessment?: string;
}

/** What to store on `self_review_runs.diagnosis`: the misses on OK, else null. */
export function diagnosisForRun(
  result: DiagnosisResult | null | undefined,
): { misses: DiagnosedMiss[]; promptVersion: string; model?: string; signalPaperAssessment?: string; exitNoiseAssessment?: string } | null {
  if (!result || result.status !== 'OK') return null;
  return {
    misses: result.misses,
    promptVersion: result.promptVersion,
    model: result.model,
    ...(result.signalPaperAssessment ? { signalPaperAssessment: result.signalPaperAssessment } : {}),
    ...(result.exitNoiseAssessment ? { exitNoiseAssessment: result.exitNoiseAssessment } : {}),
  };
}
