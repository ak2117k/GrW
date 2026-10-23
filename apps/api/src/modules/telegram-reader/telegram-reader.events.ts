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
}
