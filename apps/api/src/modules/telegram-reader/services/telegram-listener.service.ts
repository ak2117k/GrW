import { Inject, Injectable, Logger, OnApplicationBootstrap, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../../common/prisma/prisma.service';
import { sendOpsAlert } from '../../../common/utils/ops-alert';
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
import {
  CATCHUP_LIMIT,
  CATCHUP_MAX_AGE_MS,
  CATCHUP_MAX_TRIES,
  STABLE_RESET_MS,
  CONNECT_TIMEOUT_MS,
  DISCONNECT_TIMEOUT_MS,
  DOWNLOAD_TIMEOUT_MS,
  REQUEST_TIMEOUT_MS,
  STALL_ALERT_MIN_DEFAULT,
  STALL_MIN_DEFAULT,
  TelegramTimeoutError,
  envMinutes,
  recoveredAlertText,
  silentForMs,
  stalledAlertText,
  withTimeout,
} from './telegram-listener-health';
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
const DEFAULT_POLL_SEC = 6; // live pushes rarely arrive for this session (prod 2026-10-23/24), so the poll is the main path; 2026-11-25 20 → 6 s so a call is seen sooner
const MIN_POLL_SEC = 5;
const POLL_LIMIT = 5;
/** After a FLOOD_WAIT pause the poller runs at double its interval (capped) for this long. */
const FLOOD_SLOW_MS = 10 * 60_000;
const FLOOD_SLOW_CAP_SEC = 30;
/** Image backfill cadence, in time; the poll-tick modulus is derived from the interval. */
const MEDIA_BACKFILL_EVERY_SEC = 5 * 60;

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
  /** Waits before re-trying an EMPTY media download (see fetchMedia). Tests set [0, 0]. */
  private mediaRetryDelaysMs: readonly number[] = [1_500, 4_000];
  private pollTicks = 0;
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
  /** Configured poll interval (s), after the clamp. */
  private pollSec = DEFAULT_POLL_SEC;
  /** FLOOD_WAIT: no poll before this (ms epoch); doubled interval until floodSlowUntil. */
  private floodPauseUntil = 0;
  private floodSlowUntil = 0;
  private stateValue: ListenerState = 'idle';
  private lastError: string | null = null;
  private lastMessageAt: Date | null = null;
  private attempt = 0;
  private generation = 0;
  private retryTimer: NodeJS.Timeout | null = null;
  private watchdog: NodeJS.Timeout | null = null;
  private summary: NodeJS.Timeout | null = null;
  /** Owner ops alert (tests replace it). */
  private sendAlert: (key: string, text: string) => Promise<boolean> = sendOpsAlert;
  /** Raw updates of ANY type this period — tells "Telegram pushes nothing" from "pushes, but no messages". */
  private rawUpdates = 0;
  /** Liveness (2026-11-28): last successful poll round / live update / Telegram answer, ms epoch. */
  private lastProgressAt: number | null = null;
  private listeningSince: number | null = null;
  private bootAt = Date.now();
  /** Channels whose catch-up (deeper first fetch after a (re)connect) is still to run. */
  private catchUpLeft = new Set<string>();
  private catchUpStored = 0;
  /** Non-transient catch-up failures per channel; after CATCHUP_MAX_TRIES the channel is skipped (logged once). */
  private catchUpTries = new Map<string, { tries: number; network: boolean }>();
  /** Titles of channels catch-up gave up on since the last (re)connect (named in the recovery alert). */
  private catchUpBroken: string[] = [];
  /** First answer after the latest failure; the backoff resets once the link has been up STABLE_RESET_MS. */
  private stableSince: number | null = null;
  /** Live-push streak (no gap > stall threshold): pushes flowing PUSH_RECOVERY_MS close an outage on their own. */
  private lastPushAt: number | null = null;
  private pushStreakSince: number | null = null;
  /** Every round that failed for all channels after a good one logs once. */
  private pollFailing = false;
  private pollRound = 0;
  /** The current outage: alert due (> alert threshold) / sent, and posts stored since it started recovering. */
  private outageDue = false;
  private outageAlerted = false;
  private outageCaught = 0;
  private outageSince = 0;

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
    this.bootAt = Date.now();
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
    let client: TgClient | null = null;
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
      client = await this.store.withSecrets(meta.userId, async (s) =>
        this.factory.create(meta.apiId, s.apiHash, s.session),
      );
      // Only the CURRENT client counts: a replaced / timed-out client whose GramJS retry loop later connects
      // anyway must not feed pushes in, nor reset lastProgressAt / the backoff (review 2026-11-28).
      const c = client;
      c.onMessage((m) => {
        if (c === this.client) void this.handle(m);
      });
      c.onAnyUpdate?.(() => {
        if (c === this.client) this.rawUpdates++;
      });
      // Bounded in time: on a dead network GramJS connect() RESOLVES unconnected and every later request
      // (getMe in subscribeUpdates) waits forever — prod 2026-11-27 21:01 UTC the listener hung here ~18 h.
      const opening = (async () => {
        await c.connect();
        if (!c.isConnected()) throw new Error('connect finished but not connected (network unreachable?)');
        await c.subscribeUpdates?.();
      })();
      try {
        await withTimeout(opening, CONNECT_TIMEOUT_MS, 'telegram connect');
      } catch (err) {
        // If the abandoned attempt still connects later, close it again then (GramJS's retry loop ignores destroy()).
        void opening.then(
          () => (c !== this.client ? closeQuietly(c) : undefined),
          () => (c !== this.client ? closeQuietly(c) : undefined),
        );
        throw err;
      }
      if (gen !== this.generation) {
        await closeQuietly(client);
        return;
      }
      this.client = client;
      this.stateValue = 'listening';
      this.lastError = null;
      this.listeningSince = Date.now();
      this.catchUpLeft = new Set(this.enabled.keys());
      this.catchUpTries.clear();
      this.catchUpBroken = [];
      this.catchUpStored = 0;
      this.stableSince = null;
      if (!this.pollOn) this.attempt = 0; // push only: no poll round will prove the link, so trust the connect
      if (meta.status !== 'connected') await this.store.markStatus(meta.userId, 'connected', null);
      this.logger.log(`telegram-reader: listening (${this.enabled.size} channel(s))`);
      this.startPoller();
    } catch (err) {
      if (client && client !== this.client) await closeQuietly(client); // never leak a half-open client
      await this.onFailure(err, gen);
    }
  }

  /** Polling configured (TELEGRAM_POLL_SEC > 0). Liveness and outage alerts need it: push alone never proved itself on prod. */
  private get pollOn(): boolean {
    const sec = Number(this.config.get<string>('TELEGRAM_POLL_SEC') ?? DEFAULT_POLL_SEC);
    return Number.isFinite(sec) && sec > 0;
  }

  private startPoller(): void {
    const sec = Number(this.config.get<string>('TELEGRAM_POLL_SEC') ?? DEFAULT_POLL_SEC);
    this.clearPoller();
    if (!Number.isFinite(sec) || sec <= 0) return;
    this.pollSec = Math.max(MIN_POLL_SEC, sec);
    this.schedulePoll(this.generation, this.pollSec * 1000);
  }

  /**
   * Telegram answered (or a live update arrived) on the CURRENT client: the link is alive. The backoff
   * attempt resets only after the link has stayed up STABLE_RESET_MS, so a flapping link backs off.
   */
  private markProgress(now = Date.now()): void {
    this.lastProgressAt = Math.max(now, this.lastProgressAt ?? 0);
    if (this.stableSince === null) this.stableSince = now;
    else if (now - this.stableSince >= STABLE_RESET_MS) this.attempt = 0;
  }

  /** One-shot timer chain (not setInterval) so a FLOOD_WAIT can stretch the next delay. */
  private schedulePoll(gen: number, delayMs: number): void {
    this.poller = setTimeout(() => void this.pollTick(gen), delayMs);
    this.poller.unref?.();
  }

  private async pollTick(gen: number): Promise<void> {
    const started = Date.now();
    await this.pollOnce().catch(() => 0);
    if (gen !== this.generation) return; // stopped / restarted meanwhile: that run owns the timer now
    this.schedulePoll(gen, this.nextPollDelayMs(started));
  }

  /** Delay to the next round: the rest of a FLOOD_WAIT pause, else the (possibly doubled) interval from this round's start. */
  private nextPollDelayMs(roundStartedMs: number): number {
    const now = Date.now();
    if (now < this.floodPauseUntil) return this.floodPauseUntil - now;
    const base = this.pollSec * 1000;
    const interval = now < this.floodSlowUntil ? Math.max(base, Math.min(FLOOD_SLOW_CAP_SEC * 1000, base * 2)) : base;
    return Math.max(1_000, interval - (now - roundStartedMs));
  }

  /** Telegram asked us to slow down: no poll for `wait` s, then double interval for 10 min. One warning each. */
  private noteFloodWait(wait: number): void {
    this.markProgress(); // Telegram answered: alive, just asking us to wait (callers only pass the current client's floods)
    this.floodPauseUntil = Date.now() + wait * 1000;
    this.floodSlowUntil = this.floodPauseUntil + FLOOD_SLOW_MS;
    const slowSec = Math.max(this.pollSec, Math.min(FLOOD_SLOW_CAP_SEC, this.pollSec * 2));
    this.logger.warn(`telegram-reader: FLOOD_WAIT ${wait} s — polling paused ${wait} s, then every ${slowSec} s for 10 min`);
  }

  private clearPoller(): void {
    if (this.poller) clearTimeout(this.poller);
    this.poller = null;
  }

  /** Fetch the newest posts of every ticked channel; handle() stores only what is new. Public for tests. */
  async pollOnce(): Promise<number> {
    const c = this.client;
    if (!c?.recentMessages || this.polling || this.stateValue !== 'listening' || Date.now() < this.floodPauseUntil) return 0;
    const fetchRecent = c.recentMessages.bind(c);
    const round = ++this.pollRound;
    this.polling = true;
    let found = 0;
    let alive = this.enabled.size === 0;
    let lastErr: string | null = null;
    const catchingUp = this.catchUpLeft.size > 0;
    try {
      for (const chatId of this.enabled.keys()) {
        if (c !== this.client) break; // restarted meanwhile: this round belongs to a dead client
        const catchUp = this.catchUpLeft.has(chatId);
        try {
          // Every request is bounded: a request on a dead GramJS sender never settles (prod 2026-11-27).
          let msgs = await withTimeout(fetchRecent(chatId, catchUp ? CATCHUP_LIMIT : POLL_LIMIT), REQUEST_TIMEOUT_MS, 'poll');
          if (c !== this.client) break;
          alive = true;
          this.markProgress(); // per answer, not per round: a slow catch-up round (image downloads) is not a stall
          if (catchUp) {
            const oldest = Date.now() - CATCHUP_MAX_AGE_MS;
            msgs = msgs.filter((m, i) => i < POLL_LIMIT || m.date * 1000 >= oldest); // no old history re-emitted
          }
          let stored = 0;
          for (const m of msgs.reverse()) if (await this.handle(m, 'poll')) stored++;
          found += stored;
          if (catchUp) {
            this.catchUpLeft.delete(chatId);
            this.catchUpStored += stored;
          }
        } catch (err) {
          if (c !== this.client) break; // a dead client's error says nothing about the current one
          const wait = floodWaitSeconds(err);
          if (wait) {
            this.noteFloodWait(wait); // Telegram asked us to slow down: skip this round and back off (not a stall)
            break;
          }
          const answered = !!rpcCode(err);
          if (answered) {
            alive = true; // Telegram answered (e.g. CHANNEL_PRIVATE): the link itself is fine
            this.markProgress();
          }
          lastErr = describe(err);
          // A channel that keeps failing must not hold catch-up (and the recovery alert) open forever.
          // Known permanent errors drop it at once; anything else counts as a try, and after the 3rd try it is
          // dropped only if none of the tries was a timeout / network error (those are the link, not the channel).
          if (catchUp) {
            const prev = this.catchUpTries.get(chatId) ?? { tries: 0, network: false };
            const t = { tries: prev.tries + 1, network: prev.network || isNetworkError(err) };
            this.catchUpTries.set(chatId, t);
            const tries = t.tries;
            if (isPermanentChannelError(err) || (tries >= CATCHUP_MAX_TRIES && !t.network)) {
              this.catchUpLeft.delete(chatId);
              const title = this.enabled.get(chatId)?.title ?? chatId;
              this.catchUpBroken.push(title);
              this.logger.warn(`telegram-reader: catch-up skipped for "${title}" after ${tries} failed fetch(es): ${lastErr}`);
            }
          }
        }
      }
      if (alive && c === this.client) this.notePollAlive(found, catchingUp);
      else if (lastErr && !this.pollFailing && c === this.client) {
        this.pollFailing = true;
        this.logger.warn(`telegram-reader: poll got no answer from any of ${this.enabled.size} channel(s) (${lastErr}) — restarting if it lasts`);
      }
      // Every ~5 min (e.g. 50 polls of 6 s), a few images that came back empty are fetched again.
      const every = Math.max(1, Math.round(MEDIA_BACKFILL_EVERY_SEC / this.pollSec));
      if (alive && ++this.pollTicks % every === 0) await this.backfillMedia(new Date()).catch((err) => this.logger.warn(`telegram-reader: image backfill failed: ${describe(err)}`));
    } finally {
      if (round === this.pollRound) this.polling = false;
    }
    this.polledNew += found;
    return found;
  }

  /** A poll round reached Telegram: progress, catch-up bookkeeping, and the recovery alert when an outage was due. */
  private notePollAlive(found: number, catchingUp: boolean): void {
    this.markProgress();
    if (this.pollFailing) {
      this.pollFailing = false;
      this.logger.log('telegram-reader: poll answered again');
    }
    if (catchingUp && this.catchUpLeft.size === 0) {
      this.logger.log(`telegram-reader: catch-up after (re)connect stored ${this.catchUpStored} post(s) not seen before`);
    }
    if (!this.outageDue) return;
    this.outageCaught += found;
    if (this.catchUpLeft.size > 0) return; // wait until every channel has been caught up (or given up on)
    this.closeOutage();
  }

  /** The outage is over: one recovery alert, and the next outage alerts again. */
  private closeOutage(): void {
    const text = recoveredAlertText({ downSince: this.outageSince, now: Date.now(), caughtUp: this.outageCaught, broken: this.catchUpBroken });
    this.logger.log(`telegram-reader: ${text}`);
    // Best effort, once: sendOpsAlert's 30-min per-key cooldown can drop a 2nd recovery inside 30 min (accepted).
    void this.sendAlert('TELEGRAM_READER_RECOVERED', text).catch(() => false);
    this.outageDue = false;
    this.outageAlerted = false;
    this.outageCaught = 0;
  }

  async stop(): Promise<void> {
    this.clearPoller();
    this.generation++;
    this.clearRetry();
    const c = this.client;
    this.client = null;
    this.listeningSince = null;
    this.polling = false;
    this.pollRound++;
    if (c) await closeQuietly(c);
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
    // A channel un-ticked during catch-up must not keep catch-up (and the recovery alert) open.
    for (const id of [...this.catchUpLeft]) if (!this.enabled.has(id)) this.catchUpLeft.delete(id);
  }

  /**
   * Persist, then emit. `source` = 'push' (live update) or 'poll' (the safety net); only pushes count
   * as "received" so the summary still shows whether live updates flow. Returns true when something
   * new was stored (a new message or a changed edit). Public for tests.
   */
  async handle(m: TgIncomingMessage, source: 'push' | 'poll' = 'push'): Promise<boolean> {
    if (source === 'push') {
      this.received++;
      this.markProgress(); // a live update proves the link even when polls fail
      const now = Date.now();
      if (this.lastPushAt === null || now - this.lastPushAt > this.stallMs()) this.pushStreakSince = now;
      this.lastPushAt = now;
    }
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
        // The channel's high-water mark (stayed 0 for most channels before 2026-11-28). Best effort: never blocks the emit.
        await this.prisma.telegramChannel
          .updateMany({ where: { id: ch.id, lastSeenMsgId: { lt: m.tgMessageId } }, data: { lastSeenMsgId: m.tgMessageId } })
          .catch((err: unknown) => this.logger.warn(`telegram-reader: lastSeenMsgId update failed for "${ch.title}": ${describe(err)}`));
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
      // GramJS returns an EMPTY buffer, not an error, when the first request after an idle spell lands on a
      // dropped media-DC connection; the next one (which re-opened it) succeeds. Prod 2026-10-27: ~60% of
      // images were stored without the image ("empty download"), the second image of an album saved fine.
      const download = m.download;
      const once = () => withTimeout(download(choice.sizeType), DOWNLOAD_TIMEOUT_MS, 'media download'); // a hung download would stall the poll round
      let bytes = await once();
      let attempts = 1;
      for (const wait of this.mediaRetryDelaysMs) {
        if (bytes && bytes.length > 0) break;
        await new Promise((r) => setTimeout(r, wait));
        bytes = await once();
        attempts++;
      }
      if (!bytes || bytes.length === 0) return { ref: null, stored: { ...base, skipped: 'empty download', attempts } };
      if (bytes.length > DOCUMENT_MAX_BYTES) return { ref: null, stored: { ...base, skipped: `downloaded ${bytes.length} bytes > 2 MB` } };
      const dir = this.config.get<string>('TELEGRAM_MEDIA_DIR')?.trim() || DEFAULT_MEDIA_DIR;
      const ref = await saveMedia(dir, bytes, { channelId, tgMessageId: m.tgMessageId, postedAt, kind: choice.kind, mimeType: choice.mimeType });
      this.mediaSaved++;
      return {
        ref,
        stored: { ...ref, ...(choice.kind === 'photo' ? { sizeType: choice.sizeType, width: choice.w, height: choice.h } : {}), savedAt: new Date().toISOString(), ...(attempts > 1 ? { attempts } : {}) },
      };
    } catch (err) {
      this.logger.warn(`telegram-reader: media download failed (${describe(err)}) — text stored without the image`);
      return { ref: null, stored: { ...base, error: describe(err) } };
    }
  }

  /**
   * Images that came back empty (prod 2026-10-26/27: 128 of them), fetched again — a fresh message gives a
   * fresh file reference — and, when saved, handed to S with `backfill: true` so the image is read even
   * though the post is old (S's age rule still keeps an old call from being traded). Only posts S filed as
   * NOISE / not read, of the last TELEGRAM_MEDIA_BACKFILL_DAYS (3; 0 = off), each tried once, 6 a run.
   * Public for tests.
   */
  async backfillMedia(now: Date, limit = 6): Promise<number> {
    const c = this.client;
    const days = Number(this.config.get<string>('TELEGRAM_MEDIA_BACKFILL_DAYS') ?? 3);
    if (!c?.messageById || !(days > 0) || this.stateValue !== 'listening') return 0;
    const since = new Date(now.getTime() - days * 86_400_000);
    const rows = await this.prisma.$queryRaw<Array<{ id: string; channelId: string; tgChannelId: string; tgMessageId: number; postedAt: Date; rawText: string; rawPayload: Prisma.JsonValue }>>`
      SELECT m.id, m."channelId", ch."tgChannelId", m."tgMessageId", m."postedAt", m."rawText", m."rawPayload"
      FROM telegram_messages m
      JOIN telegram_channels ch ON ch.id = m."channelId"
      JOIN signal_message_classes sc ON sc.message_id = m.id
      WHERE m."hasMedia" AND m."postedAt" >= ${since}
        AND m."rawPayload"->'media'->>'skipped' = 'empty download'
        AND (m."rawPayload"->'media'->>'backfillV2') IS NULL
        AND sc.status IN ('NOISE', 'LLM_SKIPPED')
      ORDER BY m."postedAt" DESC
      LIMIT ${limit}`;
    let saved = 0;
    for (const r of rows) {
      if (!this.enabled.has(r.tgChannelId)) continue;
      const raw = (r.rawPayload && typeof r.rawPayload === 'object' && !Array.isArray(r.rawPayload) ? r.rawPayload : {}) as Record<string, unknown>;
      const prev = (raw.media && typeof raw.media === 'object' ? raw.media : {}) as Record<string, unknown>;
      let media: Record<string, unknown> = { ...prev, backfillTried: true, backfillV2: true, backfilledAt: now.toISOString() };
      let ref: TelegramMediaRef | null = null;
      try {
        const m = await withTimeout(c.messageById(r.tgChannelId, r.tgMessageId), REQUEST_TIMEOUT_MS, 'image re-fetch');
        if (!m || !m.hasMedia) media = { ...media, backfill: 'message gone or has no media now' };
        else {
          const fetched = await this.fetchMedia(m, r.channelId, r.postedAt);
          if (fetched) {
            media = { ...fetched.stored, backfillTried: true, backfillV2: true, backfilledAt: now.toISOString() };
            ref = fetched.ref;
          }
        }
      } catch (err) {
        if (floodWaitSeconds(err) || err instanceof TelegramTimeoutError) break; // slow down / link down: the rest wait for the next run (not marked tried)
        media = { ...media, backfill: `refetch failed: ${describe(err)}` };
      }
      await this.prisma.telegramMessage.update({ where: { id: r.id }, data: { rawPayload: { ...raw, media } as Prisma.InputJsonValue } });
      if (!ref) continue;
      saved++;
      const evt: TelegramMessageEvent = { messageId: r.id, channelId: r.channelId, postedAt: r.postedAt, text: r.rawText, hasMedia: true, edited: false, media: ref, backfill: true };
      this.events.emit(TELEGRAM_MESSAGE_EVENT, evt);
    }
    if (rows.length) this.logger.log(`telegram-reader: image backfill — ${saved} of ${rows.length} missed image(s) saved and sent to be read`);
    return saved;
  }

  /** One line per period: updates received (any chat) and stored messages per ticked channel. Public for tests. */
  logSummary(): string | null {
    // Printed in every state but idle/off: a dead listener used to fall silent (prod 2026-11-27: no line for ~18 h).
    if ((this.stateValue === 'idle' || !this.flagOn) && this.counts.size === 0) return null;
    const parts = [...this.counts.entries()].map(([t, n]) => `${t}=${n}`);
    const stored = [...this.counts.values()].reduce((a, b) => a + b, 0);
    const lastOk = this.lastProgressAt === null ? 'never' : `${Math.round(Math.max(0, Date.now() - this.lastProgressAt) / 1000)} s ago`;
    const line =
      `telegram-reader: last 10 min received=${this.received} (live push, any chat) polled_new=${this.polledNew} stored=${stored} images=${this.mediaSaved} updates=${this.rawUpdates} (raw, any type) from ${this.enabled.size} ticked channel(s)` +
      `${parts.length ? ': ' + parts.join(', ') : ''} (state ${this.stateValue}, last answer ${lastOk}${this.stateValue !== 'listening' && this.lastError ? `, last error ${this.lastError}` : ''})`;
    this.counts.clear();
    this.received = 0;
    this.polledNew = 0;
    this.mediaSaved = 0;
    this.rawUpdates = 0;
    this.logger.log(line);
    return line;
  }

  /**
   * Every minute, at ANY hour (channels post evenings / weekends; MCX runs to 23:30 IST): reconnect a lost
   * client, restart one that has shown no sign of life for TELEGRAM_STALL_MIN (3) min, and alert the owner
   * once when no post could be read for TELEGRAM_STALL_ALERT_MIN (15) min. Public for tests.
   */
  async checkHealth(now = Date.now()): Promise<void> {
    if (!this.flagOn) return;
    if (this.stateValue === 'listening' && this.client && !this.client.isConnected()) {
      this.logger.warn('telegram-reader: connection lost — reconnecting');
      await this.onFailure(new Error('connection lost'), this.generation);
    } else if (this.stateValue === 'listening' && this.client && this.pollOn) {
      const stallMs = this.stallMs();
      const silent = silentForMs({ now, lastProgressAt: this.lastProgressAt, listeningSince: this.listeningSince, floodPauseUntil: this.floodPauseUntil });
      if (silent > stallMs) {
        this.logger.warn(`telegram-reader: no answer from Telegram for ${Math.round(silent / 60_000)} min (no poll round, no live update) — restarting the client`);
        await this.onFailure(new Error(`stalled: no answer for ${Math.round(silent / 60_000)} min`), this.generation);
      }
    }
    await this.checkOutage(now);
  }

  private stallMs(): number {
    return envMinutes(this.config.get<string>('TELEGRAM_STALL_MIN'), STALL_MIN_DEFAULT) * 60_000;
  }

  /** One alert per outage once nothing could be read for the alert threshold; retried until Telegram takes it. */
  private async checkOutage(now: number): Promise<void> {
    if (!this.pollOn || this.stateValue === 'idle' || this.stateValue === 'off') return;
    const alertMs = envMinutes(this.config.get<string>('TELEGRAM_STALL_ALERT_MIN'), STALL_ALERT_MIN_DEFAULT) * 60_000;
    const downSince = Math.max(this.lastProgressAt ?? this.bootAt, this.floodPauseUntil);
    if (now - downSince < alertMs) {
      // Answers came back by a path that did not close the outage (e.g. live pushes while polls fail).
      if (this.outageDue && this.stateValue === 'listening') {
        const pushesFlowing =
          this.lastPushAt !== null && this.pushStreakSince !== null && now - this.lastPushAt <= this.stallMs() && now - this.pushStreakSince >= STABLE_RESET_MS;
        if (this.catchUpLeft.size === 0 || pushesFlowing) this.closeOutage();
      }
      return;
    }
    const text = stalledAlertText({ downSince, now, state: this.stateValue, lastError: this.lastError });
    if (!this.outageDue) {
      this.outageDue = true;
      this.outageSince = downSince;
      this.outageCaught = 0;
      this.logger.warn(`telegram-reader: ${text}`);
    }
    if (this.outageAlerted) return;
    // false = not delivered (unconfigured / Telegram unreachable / still in sendOpsAlert's 30-min per-key
    // cooldown after a failed try): tried again on later ticks, so a real send happens at most every 30 min.
    this.outageAlerted = await this.sendAlert('TELEGRAM_READER_STALLED', text).catch(() => false);
  }

  private async onFailure(err: unknown, gen: number): Promise<void> {
    if (gen !== this.generation) return;
    const code = rpcCode(err);
    const c = this.client;
    this.client = null;
    this.listeningSince = null;
    this.stableSince = null;
    this.lastPushAt = null;
    this.pushStreakSince = null;
    this.polling = false; // a round still waiting on the dead client must not block the next client's polls
    this.pollRound++;
    if (c) await closeQuietly(c);
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

/** Errors that mean this channel cannot be read with this account (left / banned / gone): no point retrying. */
const PERMANENT_CHANNEL_CODES = new Set(['CHANNEL_PRIVATE', 'CHANNEL_INVALID', 'CHANNEL_BANNED', 'USER_BANNED_IN_CHANNEL']);

export function isPermanentChannelError(err: unknown): boolean {
  const code = rpcCode(err);
  if (code && PERMANENT_CHANNEL_CODES.has(code)) return true;
  return err instanceof Error && err.message.includes('Could not find the input entity');
}

/** The link, not the channel: a time-out, a socket / DNS error, or GramJS refusing to send while disconnected. */
export function isNetworkError(err: unknown): boolean {
  if (err instanceof TelegramTimeoutError) return true;
  if (rpcCode(err)) return false; // Telegram answered
  const e = err as { code?: unknown; message?: unknown } | null;
  if (e && typeof e.code === 'string' && /^(ECONN|ENOTFOUND|EAI_AGAIN|ETIMEDOUT|EPIPE|ENETUNREACH|EHOSTUNREACH)/.test(e.code)) return true;
  const msg = typeof e?.message === 'string' ? e.message : '';
  return /disconnected|socket|network|ECONN|ENOTFOUND|EAI_AGAIN|ETIMEDOUT|ENETUNREACH|EHOSTUNREACH|connection (closed|lost|reset)/i.test(msg);
}

/** Close a client without ever blocking or throwing (a dead GramJS client may never finish disconnecting). */
async function closeQuietly(c: TgClient): Promise<void> {
  await withTimeout(c.disconnect(), DISCONNECT_TIMEOUT_MS, 'telegram disconnect').catch(() => undefined);
}

function describe(err: unknown): string {
  const code = rpcCode(err);
  if (code) return code;
  return err instanceof Error ? err.message.slice(0, 200) : 'unknown error';
}
