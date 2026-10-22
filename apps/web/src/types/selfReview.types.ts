/**
 * Wire shapes of `/api/self-review/*` and the night report's `selfReview`
 * section, copied from docs/superpowers/plans/2026-10-21-self-review-contract.md
 * and the Prisma models (verification_results, self_review_runs, agent_lessons,
 * tuning_proposals). The web builds against the contract only. Times are ISO UTC;
 * session dates are IST 'YYYY-MM-DD'.
 */

export type VerificationKind =
  | 'SCORECARD_TOTAL'
  | 'SCORECARD_FACTOR'
  | 'OVERNIGHT_VERDICT'
  | 'LIVE_EXIT'
  | 'NEWS_IDEA'
  | 'MBM_PREDICTION'
  | 'STOCK_MOVE';

export interface KindStats {
  n: number;
  right: number;
  wrong: number;
  nullCount: number;
  /** right / (right + wrong); null when nothing was judgeable. */
  hitRate: number | null;
}

export interface FactorStats {
  n: number;
  right: number;
  wrong: number;
  hitRate: number | null;
  rolling5?: number | null;
  rolling20?: number | null;
}

export interface NotableCall {
  kind: VerificationKind | string;
  refId: string;
  symbol: string | null;
  why: string;
}

export interface SelfReviewSummary {
  session: string;
  byKind: Partial<Record<VerificationKind | string, KindStats>>;
  byFactor?: Record<string, FactorStats>;
  notable?: NotableCall[];
  /** Probability models (MBM_PREDICTION): skill vs always guessing the common outcome. */
  skill?: Partial<Record<VerificationKind | string, { session: SkillStats; rolling20: SkillStats }>>;
}

export interface SkillStats {
  n: number;
  positives: number;
  baseRate: number | null;
  hitRate: number | null;
  majorityHitRate: number | null;
  auc: number | null;
  brier: number | null;
  brierBaseline: number | null;
  brierSkill: number | null;
  verdict: 'NOT_TESTABLE' | 'EDGE' | 'NO_EDGE';
  note: string;
}

export type RunStatus = 'RUNNING' | 'DONE' | 'FAILED';

export interface SelfReviewRun {
  id: string;
  sessionDate: string;
  startedAt: string;
  finishedAt: string | null;
  status: RunStatus | string;
  summary: SelfReviewSummary | null;
  error?: string | null;
}

/** One diagnosed miss from the run's LLM diagnosis. */
export interface SelfReviewMiss {
  refIds: string[];
  cause: string;
  category?: string | null;
  kind?: VerificationKind | string | null;
  symbol?: string | null;
  lessonKey?: string | null;
  lessonText?: string | null;
  scope?: string | null;
  proposalTarget?: string | null;
  proposedValue?: unknown;
}

export type LessonScope = 'SENTINEL_LIVE' | 'SENTINEL_OVERNIGHT' | 'NEWS_IDEAS' | 'ALL';
export type LessonStatus = 'ACTIVE' | 'RETIRED';

export interface AgentLesson {
  id: string;
  key: string;
  text: string;
  scope: LessonScope | string;
  rightCount: number;
  wrongCount: number;
  status: LessonStatus | string;
  firstSeen: string;
  lastSeen: string;
  sourceRun?: string | null;
}

export type ProposalStatus = 'PENDING' | 'APPROVED' | 'REJECTED' | 'APPLIED' | 'EXPIRED';

export interface ProposalExample {
  refId: string;
  symbol?: string | null;
  sessionDate?: string | null;
}

export interface ProposalEvidence {
  n: number;
  right: number;
  wrong: number;
  examples?: ProposalExample[];
}

export interface TuningProposal {
  id: string;
  key: string;
  target: string;
  currentValue: unknown;
  proposedValue: unknown;
  rationale: string;
  evidence: ProposalEvidence;
  status: ProposalStatus | string;
  createdAt: string;
  decidedAt: string | null;
  decidedBy: string | null;
  sourceRun?: string | null;
}

export interface VerificationResult {
  id: string;
  runId: string;
  sessionDate: string;
  kind: VerificationKind | string;
  refId: string;
  subject: string | null;
  symbol: string | null;
  predicted: string;
  actual: string;
  correct: boolean | null;
  score: number | null;
  details?: unknown;
  createdAt: string;
}

/** `GET /api/self-review/latest`; also the night report's `selfReview` section. */
export interface SelfReviewLatest {
  run: SelfReviewRun | null;
  summary: SelfReviewSummary | null;
  misses: SelfReviewMiss[];
  /** Lessons created by this run (objects or bare keys, depending on the API build). */
  lessonsAdded: Array<AgentLesson | string> | number;
  proposalsPending: number;
}
