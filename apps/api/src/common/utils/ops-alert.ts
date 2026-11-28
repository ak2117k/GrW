/**
 * Owner-facing ops alert over the existing Telegram ops bot (the one the deploy
 * unit already uses: TELEGRAM_ALERT_BOT_TOKEN / TELEGRAM_ALERT_CHAT_ID).
 *
 * For failures that otherwise only reach a log nobody watches during market
 * hours (prod 2026-10-19: every AI exit failed AG8001 all day, silently).
 * Never throws, never logs the token, and sends each `key` at most once per
 * cooldown so a failure loop cannot spam the chat. Unconfigured: logged as NOT SENT, once per cooldown.
 * Every attempt (sent, failed or unconfigured) is also written to telegram_outbox (./telegram-outbox.ts).
 */
import { Logger } from '@nestjs/common';
import { recordTelegramSend } from './telegram-outbox';

const logger = new Logger('OpsAlert');
export const OPS_ALERT_COOLDOWN_MS = 30 * 60_000;
const lastSent = new Map<string, number>();

type Env = Record<string, string | undefined>;
type Fetch = (url: string, init: { method: string; headers: Record<string, string>; body: string; signal: AbortSignal }) => Promise<{ ok: boolean; status: number; json?: () => Promise<unknown> }>;

/** Resolves true when Telegram accepted the message. */
export async function sendOpsAlert(
  key: string,
  text: string,
  deps: { env?: Env; fetch?: Fetch; now?: () => number } = {},
): Promise<boolean> {
  const env = deps.env ?? process.env;
  const token = (env.TELEGRAM_ALERT_BOT_TOKEN ?? '').trim();
  const chatId = (env.TELEGRAM_ALERT_CHAT_ID ?? '').trim();
  const now = (deps.now ?? Date.now)();
  const prev = lastSent.get(key);
  if (prev !== undefined && now - prev < OPS_ALERT_COOLDOWN_MS) return false;
  lastSent.set(key, now);
  // Every attempt past the cooldown goes to the telegram_outbox audit table (fire-and-forget, never blocks).
  const record = (ok: boolean, error: string | null, messageId: number | null = null): void =>
    recordTelegramSend({ kind: 'ops', source: key, method: 'sendMessage', chatId, text, ok, error, messageId }, [token]);
  if (!token || !chatId) {
    logger.warn(`[ops-alert] ${key} NOT SENT (TELEGRAM_ALERT_BOT_TOKEN / TELEGRAM_ALERT_CHAT_ID not set): ${text.slice(0, 300)}`);
    record(false, 'not configured');
    return false;
  }
  try {
    const res = await (deps.fetch ?? (globalThis.fetch as unknown as Fetch))(
      `https://api.telegram.org/bot${token}/sendMessage`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ chat_id: chatId, text: text.slice(0, 3500), disable_web_page_preview: true }),
        signal: AbortSignal.timeout(10_000),
      },
    );
    const reply = await readReply(res);
    if (!res.ok) {
      logger.warn(`[ops-alert] ${key}: Telegram answered HTTP ${res.status}`);
      record(false, `HTTP ${res.status}${reply?.description ? ` ${reply.description}` : ''}`);
    } else {
      const id = Number(reply?.result?.message_id);
      record(true, null, Number.isInteger(id) ? id : null);
    }
    return res.ok;
  } catch (err) {
    logger.warn(`[ops-alert] ${key}: send failed (${err instanceof Error ? err.name : 'error'})`);
    record(false, `send failed: ${err instanceof Error ? `${err.name} ${err.message}` : 'error'}`);
    return false;
  }
}

/** The Bot API JSON reply, if the response has one (message_id, error description); null otherwise. */
async function readReply(res: { json?: () => Promise<unknown> }): Promise<{ result?: { message_id?: unknown }; description?: string } | null> {
  if (typeof res.json !== 'function') return null;
  try {
    return (await res.json()) as { result?: { message_id?: unknown }; description?: string } | null;
  } catch {
    return null;
  }
}

/** Tests only. */
export function __resetOpsAlerts(): void {
  lastSent.clear();
}
