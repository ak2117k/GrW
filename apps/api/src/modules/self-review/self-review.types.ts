/** Self-review loop types (docs/superpowers/plans/2026-10-21-self-review-contract.md). */

export const VERIFICATION_KINDS = [
  'SCORECARD_TOTAL',
  'SCORECARD_FACTOR',
  'OVERNIGHT_VERDICT',
  'LIVE_EXIT',
  'NEWS_IDEA',
  'MBM_PREDICTION',
  'STOCK_MOVE',
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
