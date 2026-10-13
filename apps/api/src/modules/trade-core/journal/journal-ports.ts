import type { CorpusSetup, JournalEntry, JournalRow } from './journal.types';

/** J10: how every M5 writer reaches core_journal (bound to CoreJournalService in Task 19). */
export const CORE_JOURNAL = Symbol('CORE_JOURNAL');

export interface CoreJournalPort {
  /** Best effort: never throws; buffered, written in order, retried; a drop is counted. */
  record(e: JournalEntry): void;
  /** Durable: resolves once written (or skipped as a duplicate key), rejects otherwise. */
  recordNow(e: JournalEntry): Promise<void>;
}

/** J16: told when the lifecycle closes a position (bound to CoreTradeSummaryService). */
export const CORE_POSITION_CLOSED = Symbol('CORE_POSITION_CLOSED');

export interface PositionClosedListener {
  positionClosed(userId: string, positionId: string): Promise<void>;
}

/** J5: what the intake's duplicate, cooldown and last-loss checks read (bound to CoreTradeSummaryService). */
export const CORE_TRADE_HISTORY = Symbol('CORE_TRADE_HISTORY');

export interface CoreTradeHistory {
  /** A position already carries this intent id (Review Focus 2). */
  intentSeen(intentId: string): Promise<boolean>;
  /** When this strategy last opened (first fill) a position on the token for the user, or null. */
  lastOpenedAt(userId: string, strategyId: string, token: string): Promise<Date | null>;
  /**
   * Today's (IST) last closed trade of this strategy on the token: its net P&L in rupees; 'UNKNOWN' when that
   * position has no summary and none can be written now; null when there is none.
   */
  lastClosedNetToday(userId: string, strategyId: string, token: string, now: Date): Promise<number | 'UNKNOWN' | null>;
}

/** O9 / J20: the SP3 corpus (bound to CoreCorpusWriter). */
export const CORE_CORPUS = Symbol('CORE_CORPUS');

export interface CoreCorpusPort {
  entrySetup(s: CorpusSetup): Promise<void>;
  /** Merges `patch` into the record's outcome (jsonb ||) for (source 'core', sourceId intentId). */
  outcome(intentId: string, patch: Record<string, unknown>, at: Date): Promise<void>;
}

export class NoopCorpus implements CoreCorpusPort {
  async entrySetup(_s: CorpusSetup): Promise<void> {
    return undefined;
  }

  async outcome(_intentId: string, _patch: Record<string, unknown>, _at: Date): Promise<void> {
    return undefined;
  }
}

/*
 * What the journal API (Task 17) reads from Streams B, C and E, as tokens, so Stream F imports none of
 * them. Task 19 binds each with useExisting.
 */
export const CORE_RECON_DESK = Symbol('CORE_RECON_DESK');

export interface ReconDesk {
  ack(userId: string, mismatchId: string, reason: string): Promise<{ acknowledged: string }>;
  unacked(userId: string): Promise<JournalRow[]>;
}

export const CORE_INTAKE_STATUS = Symbol('CORE_INTAKE_STATUS');

export interface IntakeStatusSource {
  status(): { mode: 'off' | 'journal' | 'paper'; users: number; pending: number; dropped: number };
}

export const CORE_JOURNAL_STATUS = Symbol('CORE_JOURNAL_STATUS');

export interface JournalStatusSource {
  status(): { pending: number; written: number; dropped: number; failures: number; lastError: string | null };
}
