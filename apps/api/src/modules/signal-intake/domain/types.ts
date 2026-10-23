/** Signal-intake shapes (docs/superpowers/plans/2026-10-23-telegram-signals-contract.md, stream S). */

export type InstrumentKind = 'FUT' | 'CE' | 'PE' | 'EQ';
export type Side = 'BUY' | 'SELL';
export type EntryType = 'ABOVE' | 'BELOW' | 'AT' | 'RANGE';
export type Horizon = 'INTRADAY' | 'BTST' | 'POSITIONAL';
/** Market view of a signal: buying a call / future / stock or selling a put is BULL. */
export type Direction = 'BULL' | 'BEAR';

/** An expiry written in the message: a full date, or a month only (that month's last expiry). */
export interface ExpiryHint {
  day: number | null;
  /** 1–12 */
  month: number;
  year: number | null;
}

export interface ParsedSignal {
  underlying: string;
  instrumentKind: InstrumentKind;
  strike: number | null;
  expiryHint: ExpiryHint | null;
  side: Side;
  entryType: EntryType;
  entryLow: number;
  entryHigh: number;
  sl: number | null;
  targets: number[];
  qty: number | null;
  horizon: Horizon;
  tags: string[];
  confidence: number;
}

export type UpdateKind = 'SL_HIT' | 'TARGET_HIT' | 'EXIT' | 'PARTIAL_EXIT' | 'TRAIL_SL' | 'CANCEL';

export interface ParsedUpdate {
  /** The strongest kind found (SL_HIT > EXIT > TARGET_HIT > PARTIAL_EXIT > TRAIL_SL > CANCEL). */
  kind: UpdateKind;
  kinds: UpdateKind[];
  targetIndex: number | null;
  /** Underlying / strike named in the update, when any (used to pick the signal it refers to). */
  underlying: string | null;
  strike: number | null;
}

/** Classification of one Telegram message, kept per messageId (keep-all-data rule). */
export type MessageStatus =
  | 'NOISE'
  | 'SIGNAL'
  | 'UPDATE'
  | 'UPDATE_ORPHAN'
  | 'DUPLICATE'
  | 'LLM_PENDING'
  | 'LLM_NOT_SIGNAL'
  | 'LLM_FAILED'
  | 'LLM_SKIPPED';

export const directionOf = (kind: InstrumentKind, side: Side): Direction => {
  const bullish = kind === 'PE' ? side === 'SELL' : side === 'BUY';
  return bullish ? 'BULL' : 'BEAR';
};

/** Event payloads between streams (contract §Events). */
export const TELEGRAM_MESSAGE_EVENT = 'telegram.message';
export const SIGNAL_READY_EVENT = 'signal.ready';
export const SIGNAL_UPDATE_EVENT = 'signal.update';

export interface TelegramMessageEvent {
  messageId: string;
  channelId: string;
  postedAt: Date | string;
  text: string;
  hasMedia?: boolean;
}

export interface SignalReadyEvent {
  signalId: string;
  clusterId: string;
  agreeCount: number;
  conflict: boolean;
}

export interface SignalUpdateEvent {
  signalId: string;
  kind: UpdateKind;
  text: string;
}
