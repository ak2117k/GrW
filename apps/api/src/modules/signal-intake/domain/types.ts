/** Signal-intake shapes (docs/superpowers/plans/2026-10-23-telegram-signals-contract.md, stream S). */

export type InstrumentKind = 'FUT' | 'CE' | 'PE' | 'EQ';
export type Side = 'BUY' | 'SELL';
export type EntryType = 'ABOVE' | 'BELOW' | 'AT' | 'RANGE';
export type Horizon = 'INTRADAY' | 'BTST' | 'POSITIONAL';
/** Market view of a signal: buying a call / future / stock or selling a put is BULL. */
export type Direction = 'BULL' | 'BEAR';

/**
 * A relative expiry written in the message: "monthly expiry" (the nearest month's last), "weekly" / "this expiry"
 * (the nearest), "next expiry" (the one after the nearest), "next week expiry" (the same on a weekly underlying;
 * none on a monthly-only one).
 */
export type RelativeExpiry = 'MONTHLY' | 'WEEKLY' | 'CURRENT' | 'NEXT' | 'NEXT_WEEK';

/**
 * An expiry written in the message: a full date, a month only (that month's last expiry), or a relative one
 * (`month` 0 and `relative` set).
 */
export interface ExpiryHint {
  day: number | null;
  /** 1–12; 0 only with `relative` (no month named). */
  month: number;
  year: number | null;
  relative?: RelativeExpiry;
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
  | 'LLM_SKIPPED'
  /** Market information (views, levels, OI notes, macro links, scenarios): items in channel_infos, never emitted. */
  | 'INFO'
  /** The channel's own results of past calls (kept to score its claims; never a signal). */
  | 'RECAP'
  /** Legacy name of INFO (rows before 2026-10-24; the one-off re-classification migrates them). */
  | 'VIEW';

export const directionOf = (kind: InstrumentKind, side: Side): Direction => {
  const bullish = kind === 'PE' ? side === 'SELL' : side === 'BUY';
  return bullish ? 'BULL' : 'BEAR';
};

/** Event payloads between streams (contract §Events). */
export const TELEGRAM_MESSAGE_EVENT = 'telegram.message';
export const SIGNAL_READY_EVENT = 'signal.ready';
export const SIGNAL_UPDATE_EVENT = 'signal.update';
/** An image post's vision read is stored (every outcome that saves a result); the AI message reader listens. */
export const SIGNAL_VISION_DONE_EVENT = 'signal.vision.done';

export interface VisionDoneEvent {
  messageId: string;
  channelId: string;
  postedAt: Date;
  /** The post's caption. */
  text: string;
  /**
   * The vision reply as stored in signal_message_classes.llm_result — for every class (NOISE / UPDATE_ORPHAN /
   * LLM_NOT_SIGNAL too) it carries the image's `description` (+ instruments / bias / levels) since 2026-11-27;
   * null when the image was not / could not be read.
   */
  reading: unknown;
  /** Set with `reading: null`: why vision did not run or did not finish (the reader then reads the caption alone). */
  skipped?: string;
}

export interface TelegramMessageEvent {
  messageId: string;
  channelId: string;
  postedAt: Date | string;
  text: string;
  hasMedia?: boolean;
  /** The post's image as stream R saved it (photo / small image document), when there is one. */
  media?: TelegramMediaRef | null;
  /** R re-downloaded an image it had missed: read it now, whatever the post's age (the age rule still stops trading). */
  backfill?: boolean;
}

/** Mirrors stream R's `TelegramMediaRef` (telegram-reader.events.ts). */
export interface TelegramMediaRef {
  kind: 'photo' | 'image-document';
  path: string;
  sha256: string;
  mimeType: string;
  bytes: number;
}

export interface SignalReadyEvent {
  signalId: string;
  /** null for a watch-fired signal (no cluster of channel calls behind it). */
  clusterId: string | null;
  agreeCount: number;
  conflict: boolean;
}

export interface SignalUpdateEvent {
  signalId: string;
  kind: UpdateKind;
  text: string;
}
