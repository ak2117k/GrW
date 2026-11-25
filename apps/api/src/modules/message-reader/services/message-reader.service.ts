import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { agentsOn } from '../../ai-gateway/agents/agent-registry';
import { prefilter } from '../../signal-intake/domain/prefilter';
import { SIGNAL_VISION_DONE_EVENT, TELEGRAM_MESSAGE_EVENT, type TelegramMessageEvent, type VisionDoneEvent } from '../../signal-intake/domain/types';
import { textHash, type VocabularySource } from '../../signal-intake/services/signal-intake.service';
import { SignalVocabularyService } from '../../signal-intake/services/signal-vocabulary.service';
import { parseAgrees } from '../domain/parse-compare';
import type { ReaderCall, ReadKind } from '../domain/reading.types';
import { MESSAGE_READER_CONFIG, type MessageReaderConfig } from '../message-reader.config';
import { MessageReaderRepository, type ReadingWrite } from '../repositories/message-reader.repository';
import { MessageReaderLlm } from './message-reader-llm.service';
import { ReaderPacketService } from './reader-packet.service';

export const MESSAGE_READER_NOW = Symbol('MESSAGE_READER_NOW');
export const MESSAGE_READER_AGENTS_ON = Symbol('MESSAGE_READER_AGENTS_ON');

export type ReaderStore = Pick<MessageReaderRepository, 'upsertReading' | 'readingOf' | 'cachedByHash' | 'ruleClassOf' | 'channelTitle'>;
export type ReaderPacketPort = Pick<ReaderPacketService, 'build'>;
export type ReaderLlmPort = Pick<MessageReaderLlm, 'read'>;

export interface ReadJob {
  messageId: string;
  channelId: string;
  postedAt: Date;
  /** When the reader got the post (or the vision result): queued latency is measured from here. */
  receivedAt: Date;
  text: string;
  imageReading?: unknown;
}

interface QueuedJob extends ReadJob {
  hash: string;
  attempt: 1 | 2;
}

/** Reads in flight at once; matches the reading agent's signal.read limit (the agent is the hard gate). */
export const READER_MAX_IN_FLIGHT = 8;
/** A forwarded duplicate within this window copies the earlier reading. */
const CACHE_WINDOW_MS = 15 * 60_000;
const IST_OFFSET_MS = 330 * 60_000;
const MAX_UNDERLYINGS = 3;

const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));
const istClock = (d: Date) => `${new Date(d.getTime() + IST_OFFSET_MS).toISOString().slice(0, 16).replace('T', ' ')} IST`;
const isCallKind = (k: ReadKind) => k === 'CALL' || k === 'UPDATE';
const settledStatus = (s: string) => s === 'READ' || s === 'CACHED';

/** The cache / dedupe key: the trimmed text, plus the vision result for an image post (captions are often empty). */
function hashOf(j: ReadJob): string {
  return j.imageReading === undefined ? textHash(j.text) : textHash(`${j.text}\n#vision:${JSON.stringify(j.imageReading)}`);
}

/** Underlyings a vision result names (its calls and info items), so the packet carries their data too. */
function imageUnderlyings(reading: unknown): string[] {
  const out: string[] = [];
  if (!reading || typeof reading !== 'object') return out;
  for (const key of ['signals', 'items'] as const) {
    const list = (reading as Record<string, unknown>)[key];
    if (!Array.isArray(list)) continue;
    for (const x of list) {
      const u = (x as { underlying?: unknown } | null)?.underlying;
      if (typeof u === 'string' && u.trim()) out.push(u.trim().toUpperCase());
    }
  }
  return out;
}

/**
 * The AI message reader: every Telegram text post (and every image post once the vision reader stored its
 * result) is read by the AI against our live data and stored in message_readings.
 *
 * Runs beside signal-intake, never in its serial chain: the listeners only enqueue. An in-process FIFO keeps
 * at most 8 reads in flight, dedupes by messageId while queued or in flight, and reads an edit (same
 * messageId, new text) again into the same row. Per job: older than MESSAGE_READER_MAX_AGE_MIN → STALE;
 * the same text read in the last 15 min → CACHED (no AI call); else packet → AI → rule-parse comparison →
 * READ. A failure is stored FAILED and retried once while the post is under 5 min old.
 * Shadow only: it creates no signal and emits nothing. Off with MESSAGE_READER=off or AI agents off.
 */
@Injectable()
export class MessageReaderService {
  private readonly logger = new Logger(MessageReaderService.name);
  private readonly queue: QueuedJob[] = [];
  /** Jobs waiting in `queue`, by messageId (an edit replaces the waiting job in place). */
  private readonly waiting = new Map<string, QueuedJob>();
  /** messageId → text hash of the read in flight. */
  private readonly running = new Map<string, string>();
  /** An edit that arrived while its post was being read: queued when that read ends. */
  private readonly next = new Map<string, QueuedJob>();
  private idleWaiters: Array<() => void> = [];

  constructor(
    @Inject(MessageReaderRepository) private readonly repo: ReaderStore,
    @Inject(ReaderPacketService) private readonly packet: ReaderPacketPort,
    @Inject(MessageReaderLlm) private readonly llm: ReaderLlmPort,
    @Inject(SignalVocabularyService) private readonly vocab: VocabularySource,
    @Inject(MESSAGE_READER_CONFIG) private readonly cfg: MessageReaderConfig,
    @Optional() @Inject(MESSAGE_READER_NOW) private readonly nowFn?: () => Date,
    @Optional() @Inject(MESSAGE_READER_AGENTS_ON) private readonly agentsOnFn?: () => boolean,
  ) {}

  private now(): Date {
    return this.nowFn ? this.nowFn() : new Date();
  }

  private enabled(): boolean {
    if (this.cfg.mode === 'off') return false;
    return this.agentsOnFn ? this.agentsOnFn() : agentsOn();
  }

  /** Text posts. A post with an image waits for signal.vision.done (its caption is read with the image's reading). */
  @OnEvent(TELEGRAM_MESSAGE_EVENT, { async: true })
  onTelegramMessage(evt: TelegramMessageEvent): void {
    if (!this.enabled() || !evt?.messageId || !evt.channelId || evt.media) return;
    const text = String(evt.text ?? '');
    if (!text.trim()) return;
    this.enqueue({ messageId: evt.messageId, channelId: evt.channelId, postedAt: new Date(evt.postedAt), receivedAt: this.now(), text });
  }

  @OnEvent(SIGNAL_VISION_DONE_EVENT, { async: true })
  onVisionDone(evt: VisionDoneEvent): void {
    if (!this.enabled() || !evt?.messageId || !evt.channelId) return;
    this.enqueue({
      messageId: evt.messageId,
      channelId: evt.channelId,
      postedAt: new Date(evt.postedAt),
      receivedAt: this.now(),
      text: String(evt.text ?? ''),
      imageReading: evt.reading ?? null,
    });
  }

  /** Queue one post for reading. Never awaited by callers; never throws. */
  enqueue(job: ReadJob): void {
    const j: QueuedJob = { ...job, hash: hashOf(job), attempt: 1 };
    const waiting = this.waiting.get(j.messageId);
    if (waiting) {
      if (waiting.hash !== j.hash) Object.assign(waiting, j); // an edit before its read started: keep the FIFO place
      return;
    }
    const inFlight = this.running.get(j.messageId);
    if (inFlight !== undefined) {
      if (inFlight !== j.hash) this.next.set(j.messageId, j);
      return;
    }
    this.push(j);
  }

  /** Resolves once nothing is queued or in flight (tests; a hand-started backlog drain). */
  whenIdle(): Promise<void> {
    if (this.queue.length === 0 && this.running.size === 0) return Promise.resolve();
    return new Promise((resolve) => this.idleWaiters.push(resolve));
  }

  private push(j: QueuedJob): void {
    this.queue.push(j);
    this.waiting.set(j.messageId, j);
    this.pump();
  }

  private pump(): void {
    while (this.running.size < READER_MAX_IN_FLIGHT && this.queue.length > 0) {
      const j = this.queue.shift() as QueuedJob;
      this.waiting.delete(j.messageId);
      this.running.set(j.messageId, j.hash);
      void this.run(j)
        .catch((e) => {
          this.logger.warn(`[message-reader] ${j.messageId} failed: ${errText(e)}`);
          return false;
        })
        .then((retry) => this.finish(j, retry));
    }
    if (this.queue.length === 0 && this.running.size === 0) {
      const waiters = this.idleWaiters;
      this.idleWaiters = [];
      for (const w of waiters) w();
    }
  }

  private finish(j: QueuedJob, retry: boolean): void {
    this.running.delete(j.messageId);
    const edit = this.next.get(j.messageId);
    this.next.delete(j.messageId);
    if (edit) this.push(edit); // the newer text supersedes a retry of the old one
    else if (retry) this.push({ ...j, attempt: 2 });
    else this.pump();
  }

  /** One read. Resolves true when the job should be retried. */
  private async run(j: QueuedJob): Promise<boolean> {
    const dequeuedAt = this.now();
    const queuedMs = Math.max(0, dequeuedAt.getTime() - j.receivedAt.getTime());
    const base = { messageId: j.messageId, channelId: j.channelId, postedAt: j.postedAt, textHash: j.hash, queuedMs };

    const existing = await this.repo.readingOf(j.messageId);
    const alreadyRead = !!existing && settledStatus(existing.status);
    if (alreadyRead && existing.textHash === j.hash) return false; // the same post again (event replay)

    if (dequeuedAt.getTime() - j.postedAt.getTime() > this.cfg.maxAgeMin * 60_000) {
      // Too old to matter now; an old post's late edit never replaces the reading it already has.
      if (!alreadyRead) await this.repo.upsertReading({ ...base, readAt: dequeuedAt, status: 'STALE', claims: [] });
      return false;
    }

    const hit = await this.repo.cachedByHash(j.hash, new Date(dequeuedAt.getTime() - CACHE_WINDOW_MS), j.messageId);
    if (hit) {
      const row: ReadingWrite = {
        ...base,
        readAt: this.now(),
        status: 'CACHED',
        kind: hit.kind,
        scope: hit.scope,
        claims: hit.claims,
        call: hit.call,
        summary: hit.summary,
        model: hit.model,
        ...(await this.compareWithRules(j.messageId, hit.kind, hit.call)),
      };
      await this.repo.upsertReading(row);
      this.afterRead(row);
      return false;
    }

    let packetMs: number | null = null;
    try {
      const underlyings = await this.underlyingsOf(j);
      const built = await this.packet.build({ text: j.text, channelId: j.channelId, underlyings, now: dequeuedAt });
      packetMs = built.ms;
      const channelTitle = (await this.repo.channelTitle(j.channelId)) ?? j.channelId;
      const { reply, ms, model } = await this.llm.read({
        text: j.text,
        channelTitle,
        postedAtIst: istClock(j.postedAt),
        packet: built.packet,
        ...(j.imageReading !== undefined ? { imageReading: j.imageReading } : {}),
      });
      const call = reply.call ? { ...reply.call, underlying: reply.call.underlying.trim().toUpperCase() } : null;
      const row: ReadingWrite = {
        ...base,
        readAt: this.now(),
        status: 'READ',
        kind: reply.kind,
        scope: reply.scope,
        claims: reply.claims,
        call,
        summary: reply.summary,
        model,
        packet: built.packet,
        packetMs,
        aiMs: ms,
        ...(await this.compareWithRules(j.messageId, reply.kind, call)),
      };
      await this.repo.upsertReading(row);
      this.afterRead(row);
      return false;
    } catch (e) {
      const failedAt = this.now();
      const error = `${j.attempt > 1 ? 'retry: ' : ''}${errText(e)}`.slice(0, 500);
      this.logger.warn(`[message-reader] read of ${j.messageId} failed: ${error}`);
      await this.repo
        .upsertReading({ ...base, readAt: failedAt, status: 'FAILED', claims: [], model: this.cfg.model, packetMs, error })
        .catch((err) => this.logger.warn(`[message-reader] storing FAILED for ${j.messageId} failed: ${errText(err)}`));
      return j.attempt === 1 && failedAt.getTime() - j.postedAt.getTime() < this.cfg.retryMaxAgeMin * 60_000;
    }
  }

  /**
   * Shadow comparison with the rule classifier (CALL / UPDATE only): the AI's call against the rule parser's,
   * or `missedByRules` when the rules filed the post as NOISE / INFO. A lookup failure leaves both unset.
   */
  private async compareWithRules(messageId: string, kind: ReadKind, call: ReaderCall | null): Promise<{ parseAgrees: boolean | null; missedByRules: boolean }> {
    const none = { parseAgrees: null, missedByRules: false };
    if (!isCallKind(kind)) return none;
    try {
      const rule = await this.repo.ruleClassOf(messageId);
      if (!rule) return none;
      if (rule.status === 'NOISE' || rule.status === 'INFO') return { parseAgrees: null, missedByRules: true };
      if (call && rule.signal) return { parseAgrees: parseAgrees(call, rule.signal).agrees, missedByRules: false };
      return none;
    } catch (e) {
      this.logger.warn(`[message-reader] rule class of ${messageId} unavailable: ${errText(e)}`);
      return none;
    }
  }

  /** The instruments the post names (the intake's free pre-filter vocabulary), plus any the image reading names. */
  private async underlyingsOf(j: QueuedJob): Promise<string[]> {
    let named: string[] = [];
    try {
      named = prefilter(j.text, await this.vocab.get()).underlyings;
    } catch (e) {
      this.logger.warn(`[message-reader] vocabulary unavailable for ${j.messageId}: ${errText(e)}`);
    }
    return [...new Set([...named, ...imageUnderlyings(j.imageReading)])].slice(0, MAX_UNDERLYINGS);
  }

  /**
   * Runs after every stored READ / CACHED row. The single place later work hooks into (Task 7: owner
   * market-note alerts). Must not throw or block the queue.
   */
  private afterRead(_row: ReadingWrite): void {
    // Intentionally empty until owner alerts are added.
  }
}
