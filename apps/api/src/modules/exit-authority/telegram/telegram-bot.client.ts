import { Inject, Injectable, Optional } from '@nestjs/common';

/**
 * Telegram Bot API client for the exit authority's owner escalation (design §4.5 B, §4.5b).
 * Same bot and env as the ops alert sender (common/utils/ops-alert.ts): TELEGRAM_ALERT_BOT_TOKEN /
 * TELEGRAM_ALERT_CHAT_ID. Adds what ops-alert lacks: inline buttons, edit, getUpdates, answerCallbackQuery.
 *
 * The token is read from env at call time and is NEVER put in a thrown error or a log line: every
 * error text is passed through redact() before it leaves this file.
 */

export interface InlineButton {
  text: string;
  /** callback_data, ≤ 64 bytes. */
  data: string;
}

export interface TelegramCallbackQuery {
  id: string;
  data?: string;
  from?: { id: number; username?: string };
  message?: { message_id: number; chat: { id: number | string } };
}

export interface TelegramUpdate {
  update_id: number;
  callback_query?: TelegramCallbackQuery;
}

type FetchLike = (
  url: string,
  init: { method: string; headers: Record<string, string>; body: string; signal: AbortSignal },
) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;

export interface TelegramDeps {
  env?: Record<string, string | undefined>;
  fetch?: FetchLike;
}

/** Optional DI override (tests); production uses process.env + global fetch. */
export const TELEGRAM_DEPS = Symbol('TELEGRAM_DEPS');

export class TelegramApiError extends Error {
  constructor(
    readonly method: string,
    message: string,
  ) {
    super(message);
    this.name = 'TelegramApiError';
  }
}

const API = 'https://api.telegram.org';
const SEND_TIMEOUT_MS = 10_000;
const MAX_TEXT = 3_900;

@Injectable()
export class TelegramBotClient {
  constructor(@Optional() @Inject(TELEGRAM_DEPS) private readonly deps: TelegramDeps = {}) {}

  private env(): Record<string, string | undefined> {
    return this.deps?.env ?? process.env;
  }

  token(): string {
    return (this.env().TELEGRAM_ALERT_BOT_TOKEN ?? '').trim();
  }

  /** The one chat the owner escalation talks to (and the only chat whose button taps are obeyed). */
  chatId(): string {
    return (this.env().TELEGRAM_ALERT_CHAT_ID ?? '').trim();
  }

  configured(): boolean {
    return this.token() !== '' && this.chatId() !== '';
  }

  /** Sends to the configured chat; resolves the new message_id. */
  async sendMessage(text: string, buttons?: InlineButton[][]): Promise<number> {
    const result = (await this.call('sendMessage', {
      chat_id: this.chatId(),
      text: text.slice(0, MAX_TEXT),
      disable_web_page_preview: true,
      ...(buttons?.length ? { reply_markup: keyboard(buttons) } : {}),
    })) as { message_id?: unknown };
    const id = Number(result?.message_id);
    if (!Number.isFinite(id)) throw new TelegramApiError('sendMessage', 'Telegram returned no message_id');
    return id;
  }

  /** Replaces a message's text (and buttons: omitted ⇒ buttons removed). "Not modified" counts as success. */
  async editMessage(messageId: number, text: string, buttons?: InlineButton[][]): Promise<void> {
    try {
      await this.call('editMessageText', {
        chat_id: this.chatId(),
        message_id: messageId,
        text: text.slice(0, MAX_TEXT),
        disable_web_page_preview: true,
        reply_markup: keyboard(buttons ?? []),
      });
    } catch (err) {
      if (err instanceof TelegramApiError && /message is not modified/i.test(err.message)) return;
      throw err;
    }
  }

  async answerCallback(callbackQueryId: string, text?: string): Promise<void> {
    await this.call('answerCallbackQuery', {
      callback_query_id: callbackQueryId,
      ...(text ? { text: text.slice(0, 190) } : {}),
    });
  }

  /** Long poll for button taps. `timeoutSec` is Telegram's long-poll wait. */
  async getUpdates(offset: number, timeoutSec = 25): Promise<TelegramUpdate[]> {
    const result = await this.call(
      'getUpdates',
      { offset, timeout: timeoutSec, allowed_updates: ['callback_query'] },
      (timeoutSec + 10) * 1000,
    );
    return Array.isArray(result) ? (result as TelegramUpdate[]) : [];
  }

  private async call(method: string, body: Record<string, unknown>, timeoutMs = SEND_TIMEOUT_MS): Promise<unknown> {
    const token = this.token();
    if (!token) throw new TelegramApiError(method, 'TELEGRAM_ALERT_BOT_TOKEN missing');
    if ('chat_id' in body && !body.chat_id) throw new TelegramApiError(method, 'TELEGRAM_ALERT_CHAT_ID missing');
    const doFetch = this.deps?.fetch ?? (globalThis.fetch as unknown as FetchLike);
    let res: Awaited<ReturnType<FetchLike>>;
    try {
      res = await doFetch(`${API}/bot${token}/${method}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (err) {
      const e = err as Error;
      throw new TelegramApiError(method, redact(`${method} request failed: ${e?.name ?? 'Error'} ${e?.message ?? ''}`.trim(), token));
    }
    type ApiReply = { ok?: boolean; result?: unknown; description?: string };
    let parsed: ApiReply | null;
    try {
      parsed = (await res.json()) as ApiReply | null;
    } catch {
      parsed = null;
    }
    if (!res.ok || !parsed?.ok) {
      const why = parsed?.description ?? 'no description';
      throw new TelegramApiError(method, redact(`${method} failed: HTTP ${res.status} ${why}`, token));
    }
    return parsed.result;
  }
}

function keyboard(buttons: InlineButton[][]): { inline_keyboard: Array<Array<{ text: string; callback_data: string }>> } {
  return { inline_keyboard: buttons.map((row) => row.map((b) => ({ text: b.text, callback_data: b.data }))) };
}

/** Strips the bot token from any text (belt and braces: errors should never carry the URL anyway). */
export function redact(text: string, token: string): string {
  if (!token) return text;
  return text.split(token).join('<redacted>');
}
