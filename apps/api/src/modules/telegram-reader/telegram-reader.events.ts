/**
 * R -> S event (contract 2026-10-23): emitted AFTER the message row is persisted.
 * `messageId` is `TelegramMessage.id`, `channelId` is `TelegramChannel.id` (not the Telegram ids).
 * `edited` is true when an edit changed the text of an already-stored message (S dedups by messageId).
 */
export const TELEGRAM_MESSAGE_EVENT = 'telegram.message';

export interface TelegramMessageEvent {
  messageId: string;
  channelId: string;
  postedAt: Date;
  text: string;
  hasMedia: boolean;
  edited: boolean;
  /** Set when the post carried a photo / small image document that was saved (S may read it with vision). */
  media?: TelegramMediaRef | null;
  /** A missed image re-downloaded later (backfill): S reads the image even though the post is old; never traded. */
  backfill?: boolean;
}

/**
 * The post's image as R saved it on disk (TELEGRAM_MEDIA_DIR), present only when one was downloaded:
 * a photo (best readable size ≤ ~1 MB) or a small image document (≤ 2 MB). Kept forever (keep-all-data).
 */
export interface TelegramMediaRef {
  kind: 'photo' | 'image-document';
  path: string;
  sha256: string;
  mimeType: string;
  bytes: number;
}
