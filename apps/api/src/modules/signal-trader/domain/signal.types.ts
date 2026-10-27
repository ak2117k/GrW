/**
 * The shapes stream X consumes from stream S (contract §Data, §Events). Declared here, not imported:
 * the two modules meet only through the event payloads and the database, so X compiles whether or
 * not S's Prisma models exist yet. Rows are read defensively (see SignalTraderRepository.signal).
 */

/** S → X: a parsed signal joined/created a cluster. A corroborating re-emit carries a higher agreeCount. */
export interface SignalReadyEvent {
  signalId: string;
  clusterId: string | null;
  agreeCount: number;
  conflict: boolean;
}

/**
 * S → X: a follow-up from a channel about an earlier signal ("SL hit", "exit now", "book profit",
 * "trail SL to …"). Information for the sentinel only — NEVER an automatic exit.
 */
export interface SignalUpdateEvent {
  signalId?: string | null;
  channelId?: string | null;
  /** e.g. SL_HIT | EXIT_NOW | TARGET_HIT | SL_REVISED | OTHER */
  kind?: string | null;
  price?: number | null;
  text?: string | null;
  postedAt?: string | Date | null;
}

export const SIGNAL_READY = 'signal.ready';
export const SIGNAL_UPDATE = 'signal.update';

export type InstrumentKind = 'FUT' | 'CE' | 'PE' | 'EQ';
export type EntryType = 'ABOVE' | 'BELOW' | 'AT' | 'RANGE';
export type Side = 'BUY' | 'SELL';

/** A TradeSignal row (contract §Data), normalised. */
export type SignalHorizon = 'INTRADAY' | 'BTST' | 'POSITIONAL';

export interface SignalView {
  id: string;
  channelId: string | null;
  receivedAt: Date | null;
  underlying: string;
  instrumentKind: InstrumentKind;
  strike: number | null;
  /** YYYY-MM-DD (IST calendar date) or null = nearest live expiry. */
  expiry: string | null;
  side: Side;
  entryLow: number;
  entryHigh: number;
  entryType: EntryType;
  sl: number | null;
  targets: number[];
  qty: number | null;
  confidence: number | null;
  rawText: string;
  /** INTRADAY (default) | BTST | POSITIONAL (the parser's read; a swing pick is held overnight in paper). */
  horizon?: SignalHorizon;
}

export interface ClusterView {
  id: string;
  underlying: string | null;
  direction: string | null;
  agreeCount: number;
  conflict: boolean;
  channelIds: string[];
}

/** Per-channel rolling stats from the self-review summary (`byChannel`), when present. */
export type ChannelStats = Record<string, unknown> | null;
