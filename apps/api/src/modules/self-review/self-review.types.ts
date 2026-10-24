/** Self-review loop types (docs/superpowers/plans/2026-10-21-self-review-contract.md). */

export const VERIFICATION_KINDS = [
  'SCORECARD_TOTAL',
  'SCORECARD_FACTOR',
  'OVERNIGHT_VERDICT',
  'LIVE_EXIT',
  'NEWS_IDEA',
  'MBM_PREDICTION',
  /** The MBM relative reading (QUIETER / NORMAL / BUSIER / MUCH_BUSIER vs the last 10 sessions), 2026-10-23. */
  'MBM_RELATIVE',
  'STOCK_MOVE',
  'TRADE_SETUP',
  /** A parsed Telegram channel tip (signal-intake, stream S, 2026-10-23): target 1 before the SL. */
  'CHANNEL_SIGNAL',
  /** A Telegram INFO item (market view of a channel, 2026-10-24): its bias vs the next session's / 5 sessions' close-to-close move. */
  'CHANNEL_INFO',
  /** A news-impact model call (2026-10-24): its direction vs the +60 m (INTRADAY) / close-to-next-close (DAYS) move. */
  'NEWS_IMPACT',
] as const;
export type VerificationKind = (typeof VERIFICATION_KINDS)[number];

/** One scored call, as the scorers produce it (a `verification_results` row minus run/id). */
export interface VerificationDraft {
  sessionDate: string;
  kind: VerificationKind;
  refId: string;
  subject: string | null;
  symbol: string | null;
  predicted: string;
  actual: string;
  correct: boolean | null;
  score: number | null;
  details: Record<string, unknown> | null;
}

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
  /** Hit rate over the last 5 / 20 closed sessions (this one included). */
  rolling5: number | null;
  rolling20: number | null;
}

export interface NotableItem {
  kind: VerificationKind;
  refId: string;
  symbol: string | null;
  why: string;
}

export interface RunSummary {
  session: string;
  byKind: Partial<Record<VerificationKind, KindStats>>;
  byFactor: Record<string, FactorStats>;
  notable: NotableItem[];
  /**
   * Skill vs the majority baseline, session and rolling 20: MBM_PREDICTION (probability model) and
   * MBM_RELATIVE (the relative reading vs always making the same relative call).
   */
  skill?: Partial<Record<VerificationKind, { session: SkillStats; rolling20: SkillStats }>>;
  /** CHANNEL_SIGNAL per Telegram channel id: this session + rolling 20 sessions (shown on stream X's page). */
  byChannel?: Record<string, ChannelStats>;
  /** Telegram signal trades: live vs PAPER (no funds), session S and rolling 20 (domain/signal-trades.ts). */
  signalTrades?: import('./domain/signal-trades').SignalTradesSummary;
  /** NEWS_IMPACT: hit rates by news source and by material type + mean |move| per called magnitude, session and rolling 20. */
  news?: { session: import('./domain/news-impact-scorer').NewsImpactSummary; rolling20: import('./domain/news-impact-scorer').NewsImpactSummary };
}

export interface ChannelStats {
  n: number;
  right: number;
  wrong: number;
  hitRate: number | null;
  /** Hit rate over the last 20 closed sessions (this one included); null when nothing was judgeable. */
  rolling20: number | null;
  rolling20Right: number;
  rolling20Wrong: number;
  /** CHANNEL_INFO (the channel's market views): this session and rolling 20 sessions. Absent when it has none. */
  infoN?: number;
  infoRight?: number;
  infoWrong?: number;
  infoHitRate?: number | null;
  infoRolling20?: number | null;
  infoRolling20Right?: number;
  infoRolling20Wrong?: number;
}

/** domain/skill.ts — hit rate alone is not evidence when one outcome dominates. */
export interface SkillStats {
  n: number;
  positives: number;
  baseRate: number | null;
  hitRate: number | null;
  /** Hit rate of always predicting the more common outcome. */
  majorityHitRate: number | null;
  auc: number | null;
  brier: number | null;
  /** Brier of always forecasting the base rate. */
  brierBaseline: number | null;
  /** 1 − brier / brierBaseline; > 0 = better probabilities than the base rate. */
  brierSkill: number | null;
  verdict: 'NOT_TESTABLE' | 'EDGE' | 'NO_EDGE';
  note: string;
}

export type ProposalStatus = 'PENDING' | 'APPROVED' | 'REJECTED' | 'APPLIED' | 'EXPIRED';

export interface ProposalEvidence {
  n: number;
  right: number;
  wrong: number;
  examples: Array<{ refId: string; symbol: string | null; sessionDate: string }>;
}

export interface ProposalDraft {
  key: string;
  target: string;
  currentValue: number | boolean;
  proposedValue: number | boolean;
  rationale: string;
  evidence: ProposalEvidence;
}
