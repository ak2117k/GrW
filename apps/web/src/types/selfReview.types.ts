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
  | 'MBM_RELATIVE'
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
  /** MBM_PREDICTION: skill vs always guessing the common outcome; MBM_RELATIVE: vs always making the same relative call. */
  skill?: Partial<Record<VerificationKind | string, { session: SkillStats; rolling20: SkillStats }>>;
  /** Telegram signal trades: live vs PAPER (made when the account lacked funds), session + last 20 sessions. */
  signalTrades?: {
    session: { live: SignalTradeOutcome; paperNoFunds: SignalTradeOutcome; paperByOi?: Record<OiVerdict, PaperGrossBucket> };
    rolling20: { live: SignalTradeOutcome; paperNoFunds: SignalTradeOutcome; paperByOi?: Record<OiVerdict, PaperGrossBucket> };
  };
  /** "Noise or real?" reads at AI exits, scored on the underlying's next 30 min (observation only). */
  exitNoise?: { session: ExitNoiseStats; rolling20: ExitNoiseStats };
  /** Entry engine (stage 1): its recorded decisions and ENGINE_ENTRY paper trades, GROSS (observation only). */
  engine?: { session: EngineStats; rolling20: EngineStats };
}

/** The entry engine in a window: decisions (ENTER_CE / ENTER_PE / NO_TRADE) and its paper trades, gross ₹ of the closed ones. */
export interface EngineStats {
  decisions: number;
  enters: number;
  byAction: Record<string, number>;
  trades: number;
  closed: number;
  wins: number;
  losses: number;
  winRate: number | null;
  gross: number;
}

/** The "noise or real?" read at an AI exit (record only). */
export type NoiseVerdict = 'NOISE' | 'REAL' | 'MIXED' | 'NO_DATA';

/** Exit noise reads in a window: NOISE right = the underlying recovered ≥ 1 N within 30 min; REAL right = it kept going ≥ 1 N against. */
export interface ExitNoiseStats {
  reads: number;
  byVerdict: Record<NoiseVerdict, number>;
  scored: number;
  pending: number;
  noise: { scored: number; right: number };
  real: { scored: number; right: number };
}

/** The OI check recorded at a signal paper trade's open (record only). */
export type OiVerdict = 'AGREES' | 'AGAINST' | 'MIXED' | 'NO_DATA';

/** A signal paper bucket on the GROSS basis: side × (exit − entry) × qty of the closed trades (never the booked pnl). */
export interface PaperGrossBucket {
  n: number;
  closed: number;
  open: number;
  wins: number;
  losses: number;
  gross: number;
  openMark: number;
  winRate: number | null;
}

export interface SignalTradeOutcome {
  n: number;
  open: number;
  closed: number;
  wins: number;
  losses: number;
  noTrade: number;
  pnl: number;
  realised: number;
  winRate: number | null;
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
  /** The diagnosis' read of the signal paper trades by OI verdict / AI judge (latest run only). */
  signalPaperAssessment?: string | null;
  /** The diagnosis' read of the exit noise reads' scores (latest run only). */
  exitNoiseAssessment?: string | null;
  /** The diagnosis' read of the entry engine's decisions and paper trades (latest run only). */
  engineAssessment?: string | null;
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
