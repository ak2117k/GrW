import type { ExitReason } from '../lifecycle/lifecycle.types';
import type { Vehicle } from '../strategies/blocks/block-types';

/**
 * Spec §8.1 journal types, plus three M5 rulings: RECON_ACK (J12), DAILY_LOSS_LATCHED (J13),
 * PRICE_FOLLOWUP (J14). The migration's CHECK mirrors this list (journal-migration.spec.ts).
 */
export const JOURNAL_TYPES = [
  'ALERT_RECEIVED',
  'INTENT_SKIPPED',
  'RISK_VERDICT',
  'ORDER_PLACED',
  'ORDER_STATE',
  'FILL',
  'STOP_MOVED',
  'EXIT_DECIDED',
  'POSITION_STATE',
  'BLIND',
  'RECOVERY_STOP',
  'KILL_SWITCH',
  'LIMIT_CHANGED',
  'RECON_MISMATCH',
  'RECON_ACK',
  'DAILY_LOSS_LATCHED',
  'PRICE_FOLLOWUP',
] as const;
export type JournalType = (typeof JOURNAL_TYPES)[number];

/** Why an intent did not become an order (INTENT_SKIPPED payload.reason). */
export const SKIP_REASONS = [
  'MIN_SCORE',
  'COOLDOWN',
  'LAST_LOSS',
  'HISTORY_UNKNOWN',
  'NO_PRICE_SOURCE',
  'NO_FRESH_PRICE',
  'STALE_ENTRY',
  'STALE_ALERT',
  'GATE',
  'GATE_UNKNOWN',
  'PAPER_SETTINGS_MISSING',
  'SIZE_ZERO',
  'VEHICLE_UNSUPPORTED',
  'RISK_REJECT',
  'OPEN_REFUSED',
  'ENTRIES_DRY_RUN',
  'INTERNAL_ERROR',
] as const;
export type SkipReason = (typeof SKIP_REASONS)[number];

/** What a writer hands the journal. `at` is the event time (it also decides the IST day). */
export interface JournalEntry {
  userId: string;
  type: JournalType;
  at: Date;
  positionId?: string | null;
  strategyId?: string | null;
  strategyVersionId?: string | null;
  intentId?: string | null;
  symbol?: string | null;
  /** JSON-serialisable. */
  payload: Record<string, unknown>;
  priceUsed?: number | null;
  priceAgeMs?: number | null;
  /** Unique when set: a second write with the same key is skipped (J11). */
  dedupeKey?: string | null;
}

export interface JournalRow {
  id: string;
  userId: string;
  type: JournalType;
  positionId: string | null;
  strategyId: string | null;
  strategyVersionId: string | null;
  intentId: string | null;
  symbol: string | null;
  payload: Record<string, unknown>;
  priceUsed: number | null;
  priceAgeMs: number | null;
  dedupeKey: string | null;
  /** IST date, YYYY-MM-DD. */
  istDay: string;
  createdAt: Date;
}

/** Spec §8.2. Money is a 2-dp string (M3 convention), prices 4 dp; null where it cannot be computed. */
export interface TradeSummary {
  id: string;
  userId: string;
  positionId: string;
  intentId: string;
  strategyId: string;
  strategyVersionId: string;
  vehicle: Vehicle;
  exchange: string;
  token: string;
  symbol: string;
  side: 'BUY' | 'SELL';
  qty: number;
  entryAvgPrice: string;
  exitAvgPrice: string;
  openedAt: Date;
  closedAt: Date;
  grossPnl: string;
  charges: string;
  mtfInterest: string;
  netPnl: string;
  initialRisk: string | null;
  rMultiple: string | null;
  mfePrice: string | null;
  maePrice: string | null;
  mfeRupees: string | null;
  maeRupees: string | null;
  holdMinutes: number;
  exitReason: ExitReason;
  /** IST date of the close, YYYY-MM-DD. */
  istDay: string;
  createdAt: Date;
}

export type NewTradeSummary = Omit<TradeSummary, 'id' | 'createdAt'>;

/** SP3 spec §5.1 outcome keys the close fills (numbers, rupees). */
export interface CorpusOutcome {
  netPnl: number;
  grossPnl: number;
  fees: number;
  win: boolean;
  rMultiple: number | null;
  mfe: number | null;
  mae: number | null;
  holdMins: number;
}

/** One core setup for ai_decision_records (SP3 spec §5.1), kind ENTRY_SETUP. */
export interface CorpusSetup {
  intentId: string;
  userId: string;
  decidedAt: Date;
  symbol: string;
  exchange: string;
  vehicle: Vehicle;
  direction: 'LONG' | 'SHORT';
  strategyKey: string;
  strategyVersionId: string;
  setupGroupKey: string;
  evidence: Record<string, unknown>;
  ruleScore: number | null;
  decision: { taken: boolean; reason: string };
  /** MBM M3: the market-behaviour gate's answer when it applied (→ features / featureSet / mlScore). */
  mbm?: { features: Record<string, unknown>; featureSet: string; mlScore: number };
}
