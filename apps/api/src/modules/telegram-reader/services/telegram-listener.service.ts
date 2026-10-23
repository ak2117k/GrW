import { Inject, Injectable, Logger, OnApplicationBootstrap, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../../common/prisma/prisma.service';
import {
  SESSION_DEAD_CODES,
  TG_CLIENT_FACTORY,
  TgClient,
  TgClientFactory,
  TgIncomingMessage,
  floodWaitSeconds,
  rpcCode,
} from '../client/telegram-client.port';
import { TELEGRAM_MESSAGE_EVENT, TelegramMediaRef, TelegramMessageEvent } from '../telegram-reader.events';
import { DEFAULT_MEDIA_DIR, DOCUMENT_MAX_BYTES, chooseMedia, saveMedia } from './telegram-media';
import { TelegramSessionStore } from './telegram-session.store';

export type ListenerState = 'off' | 'idle' | 'connecting' | 'listening' | 'backoff' | 'revoked';

/** TELEGRAM_READER=on|off (default on — inert until a session exists). */
export function readerEnabled(raw: string | undefined): boolean {
  const v = (raw ?? 'on').trim().toLowerCase();
  return !(v === 'off' || v === 'false' || v === '0');
}

export const BACKOFF_MIN_MS = 5_000;
export const BACKOFF_MAX_MS = 5 * 60_000;
const WATCHDOG_MS = 60_000;
/** Every 10 min, so a deaf listener shows quickly (2026-10-23: 28 quiet minutes were indistinguishable from no feed). */
const SUMMARY_MS = 10 * 60_000;
/** Polling safety net: newest posts of every ticked channel this often (TELEGRAM_POLL_SEC, 0 = off). */
const DEFAULT_POLL_SEC = 60;
const POLL_LIMIT = 5;

/** Exponential backoff for attempt n (0-based), capped. */
export function backoffMs(attempt: number): number {
  return Math.min(BACKOFF_MAX_MS, BACKOFF_MIN_MS * 2 ** Math.max(0, attempt));
}

interface EnabledChannel {
  id: string;
  title: string;
}

/**
 * Listens to the owner's enabled channels through the owner's own Telegram session.
 * Every message from an ENABLED channel is persisted to telegram_messages (unique per
 * channel + Telegram message id) and only then emitted as `telegram.message`. Edits update the
 * stored row and re-emit (edited: true) only when the text changed. Fail-soft: errors are logged
 * and retried with backoff; FLOOD_WAIT waits the time Telegram asks for; a revoked session stops
 * the listener and marks the row so the owner reconnects.
 */
@Injectable()
export class TelegramListenerService implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger(TelegramListenerService.name);
  private client: TgClient | null = null;
  private userId: string | null = null;
  private enabled = new Map<string, EnabledChannel>(); // tgChannelId -> channel
  private counts = new Map<string, number>(); // channel title -> messages this period
  /** Every update the client delivered this period, ticked channel or not — proves the feed is alive. */
  private received = 0;
  /** Messages found by the poller that push had not delivered (stored this period). */
  private polledNew = 0;
  /** Images saved to TELEGRAM_MEDIA_DIR this period. */
  private mediaSaved = 0;
  private poller: NodeJS.Timeout | null = null;
  private polling = false;
  private stateValue: ListenerState = 'idle';
  private lastError: string | null = null;
  private lastMessageAt: Date | null = null;
  private attempt = 0;
  private generation = 0;
  private retryTimer: NodeJS.Timeout | null = null;
  private watchdog: NodeJS.Timeout | null = null;
  private summary: NodeJS.Timeout | null = null;

  constructor(
    private readonly config: ConfigService,
    private readonly prisma: PrismaService,
    private readonly events: EventEmitter2,
    private readonly store: TelegramSessionStore,
    @Inject(TG_CLIENT_FACTORY) private readonly factory: TgClientFactory,
  ) {}

  get flagOn(): boolean {
    return readerEnabled(this.config.get<string>('TELEGRAM_READER'));
  }

  status(): { state: ListenerState; lastError: string | null; lastMessageAt: Date | null; channels: number } {
    return {
      state: this.flagOn ? this.stateValue : 'off',
      lastError: this.lastError,
      lastMessageAt: this.lastMessageAt,
      channels: this.enabled.size,
    };
  }

  /** The live client (for the channel picker), or null when not listening. */
  liveClient(): TgClient | null {
    return this.client && this.client.isConnected() ? this.client : null;
  }

  async onApplicationBootstrap(): Promise<void> {
    if (!this.flagOn) {
      this.logger.log('telegram-reader: TELEGRAM_READER=off — not listening');
      return;
    }
    this.summary = setInterval(() => this.logSummary(), SUMMARY_MS);
    this.summary.unref?.();
    this.watchdog = setInterval(() => void this.checkHealth(), WATCHDOG_MS);
    this.watchdog.unref?.();
    void this.start();
  }

  async onModuleDestroy(): Promise<void> {
    if (this.summary) clearInterval(this.summary);
    if (this.watchdog) clearInterval(this.watchdog);
    await this.stop();
  }

  /** (Re)open the client from the stored session. Never throws. */
  async start(): Promise<void> {
    if (!this.flagOn) return;
    const gen = ++this.generation;
    this.clearRetry();
    try {
      const owner = this.config.get<string>('HUB_OWNER_USER_ID')?.trim() || null;
      const meta = await this.store.findListenable(owner);
      if (!meta) {
        this.stateValue = 'idle';
        return;
      }
      this.stateValue = 'connecting';
      this.userId = meta.userId;
      await this.refreshChannels();
      const client = await this.store.withSecrets(meta.userId, async (s) =>
        this.factory.create(meta.apiId, s.apiHash, s.session),
      );
      client.onMessage((m) => void this.handle(m));
      await client.connect();
      await client.subscribeUpdates?.();
      if (gen !== this.generation) {
        await client.disconnect().catch(() => undefined);
        return;
      }
      this.client = client;
      this.stateValue = 'listening';
      this.lastError = null;
      this.attempt = 0;
      if (meta.status !== 'connected') await this.store.markStatus(meta.userId, 'connected', null);
      this.logger.log(`telegram-reader: listening (${this.enabled.size} channel(s))`);
      this.startPoller();
    } catch (err) {
      await this.onFailure(err, gen);
    }
  }

  private startPoller(): void {
    const sec = Number(this.config.get<string>('TELEGRAM_POLL_SEC') ?? DEFAULT_POLL_SEC);
    if (this.poller) clearInterval(this.poller);
    this.poller = null;
    if (!Number.isFinite(sec) || sec <= 0) return;
    this.poller = setInterval(() => void this.pollOnce(), Math.max(15, sec) * 1000);
    this.poller.unref?.();
  }

  /** Fetch the newest posts of every ticked channel; handle() stores only what is new. Public for tests. */
  async pollOnce(): Promise<number> {
    const c = this.client;
    if (!c?.recentMessages || this.polling || this.stateValue !== 'listening') return 0;
    this.polling = true;
    let found = 0;
    try {
      for (const chatId of this.enabled.keys()) {
        try {
          const msgs = await c.recentMessages(chatId, POLL_LIMIT);
          for (const m of msgs.reverse()) if (await this.handle(m, 'poll')) found++;
        } catch (err) {
          const wait = floodWaitSeconds(err);
          if (wait) break; // Telegram asked us to slow down: skip this round
        }
      }
    } finally {
      this.polling = false;
    }
    this.polledNew += found;
    return found;
  }

  async stop(): Promise<void> {
    if (this.poller) clearInterval(this.poller);
    this.poller = null;
    this.generation++;
    this.clearRetry();
    const c = this.client;
    this.client = null;
    if (c) await c.disconnect().catch(() => undefined);
    if (this.stateValue !== 'revoked') this.stateValue = 'idle';
  }

  async restart(): Promise<void> {
    await this.stop();
    this.stateValue = 'idle';
    await this.start();
  }

  /** Reload the enabled-channel set (after the owner changes the picker). */
  async refreshChannels(): Promise<void> {
    if (!this.userId) {
      const owner = this.config.get<string>('HUB_OWNER_USER_ID')?.trim() || null;
      const meta = await this.store.findListenable(owner);
      this.userId = meta?.userId ?? null;
    }
    if (!this.userId) {
      this.enabled = new Map();
      return;
    }
    const rows = await this.prisma.telegramChannel.findMany({
      where: { userId: this.userId, enabled: true },
      select: { id: true, tgChannelId: true, title: true },
    });
    this.enabled = new Map(rows.map((r) => [r.tgChannelId, { id: r.id, title: r.title }]));
  }

  /**
   * Persist, then emit. `source` = 'push' (live update) or 'poll' (the safety net); only pushes count
   * as "received" so the summary still shows whether live updates flow. Returns true when something
   * new was stored (a new message or a changed edit). Public for tests.
   */
  async handle(m: TgIncomingMessage, source: 'push' | 'poll' = 'push'): Promise<boolean> {
    if (source === 'push') this.received++;
    const ch = this.enabled.get(m.chatId);
    if (!ch) return false;
    try {
      const postedAt = new Date(m.date * 1000);
      const editedAt = m.editDate ? new Date(m.editDate * 1000) : null;
      const existing = await this.prisma.telegramMessage.findUnique({
        where: { channelId_tgMessageId: { channelId: ch.id, tgMessageId: m.tgMessageId } },
        select: { id: true, rawText: true, rawPayload: true },
      });
      let messageId: string;
      let edited = false;
      let media: TelegramMediaRef | null = null;
      let raw: Prisma.InputJsonValue;
      if (existing) {
        if (existing.rawText === m.text) return false; // duplicate delivery or a no-op edit
        // A caption edit keeps the image saved with the original post (never re-downloaded).
        const prev = (existing.rawPayload ?? {}) as { media?: { path?: string } & Record<string, unknown> };
        if (prev.media?.path) media = prev.media as unknown as TelegramMediaRef;
        raw = (prev.media ? { ...m.raw, media: prev.media } : m.raw) as Prisma.InputJsonValue;
        await this.prisma.telegramMessage.update({
          where: { id: existing.id },
          data: { rawText: m.text, hasMedia: m.hasMedia, editedAt: editedAt ?? new Date(), rawPayload: raw },
        });
        messageId = existing.id;
        edited = true;
      } else {
        const fetched = m.hasMedia ? await this.fetchMedia(m, ch.id, postedAt) : null;
        media = fetched?.ref ?? null;
        raw = (fetched ? { ...m.raw, media: fetched.stored } : m.raw) as Prisma.InputJsonValue;
        try {
          const row = await this.prisma.telegramMessage.create({
            data: {
              channelId: ch.id,
              tgMessageId: m.tgMessageId,
              rawText: m.text,
              postedAt,
              parseStatus: 'pending',
              rawPayload: raw,
              hasMedia: m.hasMedia,
              editedAt: m.edited ? editedAt : null,
            },
            select: { id: true },
          });
          messageId = row.id;
        } catch (err) {
          if ((err as { code?: string }).code === 'P2002') return false; // raced a duplicate delivery
          throw err;
        }
      }
      this.lastMessageAt = new Date();
      this.counts.set(ch.title, (this.counts.get(ch.title) ?? 0) + 1);
      const evt: TelegramMessageEvent = {
        messageId,
        channelId: ch.id,
        postedAt,
        text: m.text,
        hasMedia: m.hasMedia,
        edited,
        ...(media ? { media } : {}),
      };
      this.events.emit(TELEGRAM_MESSAGE_EVENT, evt);
      return true;
    } catch (err) {
      this.logger.warn(`telegram-reader: could not store a message from "${ch.title}": ${describe(err)}`);
      return false;
    }
  }

  /**
   * Download a photo / small image document and save it under TELEGRAM_MEDIA_DIR (kept forever). Never
   * throws: a skipped or failed download is recorded in rawPayload.media with the reason, the text is
   * stored either way. TELEGRAM_MEDIA_DOWNLOAD=off records the media kind only.
   */
  private async fetchMedia(
    m: TgIncomingMessage,
    channelId: string,
    postedAt: Date,
  ): Promise<{ ref: TelegramMediaRef | null; stored: Record<string, unknown> } | null> {
    const info = m.media ?? null;
    if (!info) return null;
    const choice = chooseMedia(info);
    const base = { kind: info.kind, mimeType: info.mimeType };
    if (!choice.fetch) return { ref: null, stored: { ...base, skipped: choice.reason } };
    if (!readerEnabled(this.config.get<string>('TELEGRAM_MEDIA_DOWNLOAD'))) return { ref: null, stored: { ...base, skipped: 'TELEGRAM_MEDIA_DOWNLOAD=off' } };
    if (!m.download) return { ref: null, stored: { ...base, skipped: 'client cannot download' } };
    try {
      const bytes = await m.download(choice.sizeType);
      if (!bytes || bytes.length === 0) return { ref: null, stored: { ...base, skipped: 'empty download' } };
      if (bytes.length > DOCUMENT_MAX_BYTES) return { ref: null, stored: { ...base, skipped: `downloaded ${bytes.length} bytes > 2 MB` } };
      const dir = this.config.get<string>('TELEGRAM_MEDIA_DIR')?.trim() || DEFAULT_MEDIA_DIR;
      const ref = await saveMedia(dir, bytes, { channelId, tgMessageId: m.tgMessageId, postedAt, kind: choice.kind, mimeType: choice.mimeType });
      this.mediaSaved++;
      return {
        ref,
        stored: { ...ref, ...(choice.kind === 'photo' ? { sizeType: choice.sizeType, width: choice.w, height: choice.h } : {}), savedAt: new Date().toISOString() },
      };
    } catch (err) {
      this.logger.warn(`telegram-reader: media download failed (${describe(err)}) — text stored without the image`);
      return { ref: null, stored: { ...base, error: describe(err) } };
    }
  }

  /** One line per period: updates received (any chat) and stored messages per ticked channel. Public for tests. */
  logSummary(): string | null {
    if (this.stateValue !== 'listening' && this.counts.size === 0) return null;
    const parts = [...this.counts.entries()].map(([t, n]) => `${t}=${n}`);
    const stored = [...this.counts.values()].reduce((a, b) => a + b, 0);
    const line =
      `telegram-reader: last 10 min received=${this.received} (live push, any chat) polled_new=${this.polledNew} stored=${stored} images=${this.mediaSaved} from ${this.enabled.size} ticked channel(s)` +
      `${parts.length ? ': ' + parts.join(', ') : ''} (state ${this.stateValue})`;
    this.counts.clear();
    this.received = 0;
    this.polledNew = 0;
    this.mediaSaved = 0;
    this.logger.log(line);
    return line;
  }

  private async checkHealth(): Promise<void> {
    if (this.stateValue === 'listening' && this.client && !this.client.isConnected()) {
      this.logger.warn('telegram-reader: connection lost — reconnecting');
      await this.onFailure(new Error('connection lost'), this.generation);
    }
  }

  private async onFailure(err: unknown, gen: number): Promise<void> {
    if (gen !== this.generation) return;
    const code = rpcCode(err);
    const c = this.client;
    this.client = null;
    if (c) await c.disconnect().catch(() => undefined);
    this.lastError = code ?? describe(err);
    if (code && SESSION_DEAD_CODES.has(code)) {
      this.stateValue = 'revoked';
      this.logger.error(`telegram-reader: session no longer valid (${code}) — reconnect it in Settings`);
      if (this.userId) await this.store.markStatus(this.userId, 'revoked', code).catch(() => undefined);
      return;
    }
    const flood = floodWaitSeconds(err);
    const delay = flood !== null ? (flood + 1) * 1000 : backoffMs(this.attempt++);
    this.stateValue = 'backoff';
    this.logger.warn(`telegram-reader: ${this.lastError}; retrying in ${Math.round(delay / 1000)} s`);
    this.clearRetry();
    this.retryTimer = setTimeout(() => void this.start(), delay);
    this.retryTimer.unref?.();
  }

  private clearRetry(): void {
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = null;
  }
}

function describe(err: unknown): string {
  const code = rpcCode(err);
  if (code) return code;
  return err instanceof Error ? err.message.slice(0, 200) : 'unknown error';
}
