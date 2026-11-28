/**
 * Append-only record of every message the API tries to send to the owner over the alert bot
 * (table `telegram_outbox`). Container logs are wiped on each deploy and successful sends were never
 * logged, so before this nobody could say what the owner had been sent (audit 2026-11-28).
 *
 * The two senders (common/utils/ops-alert.ts and exit-authority/telegram/telegram-bot.client.ts) call
 * recordTelegramSend() after each attempt. It is fire-and-forget: it returns at once, never throws,
 * and a failed or slow DB write never blocks or delays the send. Until a recorder is registered (at
 * Nest boot, by TelegramOutboxRegistrar in PrismaModule) it is a no-op, so unit tests and scripts
 * without a DB are unaffected.
 *
 * Never records the bot token: only the chat id, a short text and the outcome.
 */

export const OUTBOX_TEXT_MAX = 500;
export const OUTBOX_ERROR_MAX = 500;

export interface TelegramOutboxEntry {
  /** Which sender: 'ops' (sendOpsAlert) | 'exit-authority' (TelegramBotClient). */
  kind: string;
  /** What sent it: the ops-alert key, or the exit-authority caller (escalation, blocked-exit, ...). */
  source: string;
  /** Bot API method: sendMessage | editMessageText. */
  method: string;
  chatId: string;
  text: string;
  ok: boolean;
  error?: string | null;
  messageId?: number | null;
}

/** The row as written (text and error already cut to size, token stripped). */
export interface TelegramOutboxRow {
  kind: string;
  source: string;
  method: string;
  chatId: string;
  text: string;
  ok: boolean;
  error: string | null;
  messageId: number | null;
}

export type TelegramOutboxRecorder = (row: TelegramOutboxRow) => Promise<unknown> | unknown;

let recorder: TelegramOutboxRecorder | null = null;
let onRecordError: ((err: unknown) => void) | null = null;

/** Registers (or, with null, clears) the sink. Called once at boot. */
export function setTelegramOutboxRecorder(r: TelegramOutboxRecorder | null, onError?: (err: unknown) => void): void {
  recorder = r;
  onRecordError = onError ?? null;
}

/** The token must never reach the table, even inside an error message. */
function scrub(text: string, secrets: string[]): string {
  let out = text;
  for (const s of secrets) if (s) out = out.split(s).join('<redacted>');
  return out;
}

/** Cut by code point, never inside a surrogate pair (a lone surrogate makes the Prisma insert fail). */
function cut(text: string, max: number): string {
  return text.length <= max ? text : Array.from(text).slice(0, max).join('');
}

export function toOutboxRow(entry: TelegramOutboxEntry, secrets: string[] = []): TelegramOutboxRow {
  const id = Number(entry.messageId);
  return {
    kind: String(entry.kind).slice(0, 64),
    source: String(entry.source).slice(0, 200),
    method: String(entry.method).slice(0, 64),
    chatId: String(entry.chatId ?? '').slice(0, 64),
    text: cut(scrub(String(entry.text ?? ''), secrets), OUTBOX_TEXT_MAX),
    ok: entry.ok === true,
    error: entry.error ? cut(scrub(String(entry.error), secrets), OUTBOX_ERROR_MAX) : null,
    messageId: entry.messageId != null && Number.isInteger(id) ? id : null,
  };
}

/**
 * Fire-and-forget. Returns synchronously; the write runs in the background and its failure is
 * swallowed (reported once to onError, which must not throw either). `secrets` (the bot token) are
 * stripped from text and error before the row is built.
 */
export function recordTelegramSend(entry: TelegramOutboxEntry, secrets: string[] = []): void {
  const r = recorder;
  if (!r) return;
  const fail = (err: unknown): void => {
    try {
      onRecordError?.(err);
    } catch {
      /* never let the reporter throw into the sender */
    }
  };
  try {
    const p = r(toOutboxRow(entry, secrets));
    if (p && typeof (p as Promise<unknown>).then === 'function') (p as Promise<unknown>).then(undefined, fail);
  } catch (err) {
    fail(err);
  }
}
