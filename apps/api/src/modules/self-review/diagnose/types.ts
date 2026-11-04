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

/**
 * The root cause class of a diagnosed group (2026-11-04, wrong-decision loop spec goal 4 / S8). It sits beside the
 * free-text `cause` (kept: stored diagnoses, lessons and the web read it), so the field is `causeType`.
 * DATA = missing/stale/wrong input; SETTING = a tunable threshold is off; REASONING = an AI's judgement or prompt;
 * CODE_BUG = the code did what its own comment/spec says it shouldn't; NOISE = nothing could have known.
 */
export const FIX_CAUSES = ['DATA', 'SETTING', 'REASONING', 'CODE_BUG', 'NOISE'] as const;
export type FixCause = (typeof FIX_CAUSES)[number];

/** A proposed code/data fix written by the diagnosis for a CODE_BUG or DATA group (becomes a fix ticket). */
export interface TicketProposal {
  title: string;
  proposedChange: string;
  files: string[];
  testDescription: string;
}

/** One diagnosed group of misses (validated). */
export interface DiagnosedMiss {
  /** Only refIds that were in the input survive validation; at least one. */
  refIds: string[];
  cause: string;
  category: MissCategory;
  /** The cause class (absent on pre-d8 diagnoses, or when the reply's value was not one of FIX_CAUSES). */
  causeType?: FixCause;
  /** Only on CODE_BUG / DATA groups. */
  ticket?: TicketProposal;
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
 * exit-noise's noiseReadDigest, `engine` = engine-trades' engineDigest (null/absent = none).
 */
export interface DiagnosisContext {
  signalPaper?: unknown;
  noiseReads?: unknown;
  engine?: unknown;
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
  /** The diagnosis' read of the entry engine's decisions and paper trades (observation only). */
  engineAssessment?: string;
}

/** What to store on `self_review_runs.diagnosis`: the misses on OK, else null. */
export function diagnosisForRun(
  result: DiagnosisResult | null | undefined,
): { misses: DiagnosedMiss[]; promptVersion: string; model?: string; signalPaperAssessment?: string; exitNoiseAssessment?: string; engineAssessment?: string } | null {
  if (!result || result.status !== 'OK') return null;
  return {
    misses: result.misses,
    promptVersion: result.promptVersion,
    model: result.model,
    ...(result.signalPaperAssessment ? { signalPaperAssessment: result.signalPaperAssessment } : {}),
    ...(result.exitNoiseAssessment ? { exitNoiseAssessment: result.exitNoiseAssessment } : {}),
    ...(result.engineAssessment ? { engineAssessment: result.engineAssessment } : {}),
  };
}
