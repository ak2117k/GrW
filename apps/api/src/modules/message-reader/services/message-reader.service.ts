import { Inject, Injectable, Logger, OnModuleDestroy, Optional } from '@nestjs/common';
import { EventEmitter2, OnEvent } from '@nestjs/event-emitter';
import { sendOpsAlert } from '../../../common/utils/ops-alert';
import { agentsOn } from '../../ai-gateway/agents/agent-registry';
import { prefilter } from '../../signal-intake/domain/prefilter';
import { SIGNAL_VISION_DONE_EVENT, TELEGRAM_MESSAGE_EVENT, type TelegramMessageEvent, type VisionDoneEvent } from '../../signal-intake/domain/types';
import { textHash, type VocabularySource } from '../../signal-intake/services/signal-intake.service';
import { SignalVocabularyService } from '../../signal-intake/services/signal-vocabulary.service';
import { parseAgrees } from '../domain/parse-compare';
import { marketNoteClaims, marketNoteText } from '../domain/reader-health';
import { fillReasonCodes } from '../domain/reason-code';
import type { Claim, ReaderCall, ReaderReply, ReadKind, ReadScope } from '../domain/reading.types';
import { AMBIGUOUS_SYMBOLS, type Vocabulary } from '../../signal-intake/domain/vocabulary';
import { MESSAGE_READER_CONFIG, type MessageReaderConfig } from '../message-reader.config';
import { MessageReaderRepository, type ReadingWrite } from '../repositories/message-reader.repository';
import { MessageReaderLlm } from './message-reader-llm.service';
import { ReaderPacketService, type ReaderPacket } from './reader-packet.service';

export const MESSAGE_READER_NOW = Symbol('MESSAGE_READER_NOW');
export const MESSAGE_READER_AGENTS_ON = Symbol('MESSAGE_READER_AGENTS_ON');
/** Owner / ops alert sender (default sendOpsAlert, which sends each key at most once per 30 min). */
export const MESSAGE_READER_ALERT = Symbol('MESSAGE_READER_ALERT');
export type ReaderAlert = (key: string, text: string) => Promise<boolean>;

/** Emitted once after a fresh READ row is stored (never for CACHED / FAILED / STALE). The AI setups module listens. */
export const READER_READING_STORED_EVENT = 'reader.reading.stored';
export interface ReadingStoredEvent {
  messageId: string;
  channelId: string;
  postedAt: Date;
  readAt: Date;
  status: 'READ';
  kind: ReadKind | null;
  scope: ReadScope | null;
  claims: Claim[];
  summary: string | null;
  /** The post text the reader read (untrusted channel content). */
  postText: string;
}

export type ReaderStore = Pick<MessageReaderRepository, 'upsertReading' | 'readingOf' | 'cachedByHash' | 'ruleClassOf' | 'channelTitle' | 'updateRuleComparison'>;
/** `addInstruments` is the optional second pass; without it the first reading is stored as is. */
export type ReaderPacketPort = Pick<ReaderPacketService, 'build'> & Partial<Pick<ReaderPacketService, 'addInstruments'>>;
export type ReaderLlmPort = Pick<MessageReaderLlm, 'read'>;

export interface ReadJob {
  messageId: string;
  channelId: string;
  postedAt: Date;
  /** When the reader got the post (or the vision result): queued latency is measured from here. */
  receivedAt: Date;
  text: string;
  imageReading?: unknown;
  /** The post has an image that was not read (vision off / capped / failed / caption was the call): why. */
  imageSkipped?: string;
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
/** Instruments the second pass may add (AI-named, missed by the pre-filter). */
const MAX_SECOND_PASS = 3;
/** When the rules had not decided at read time, the comparison is re-checked after these delays. */
export const RULE_RECHECK_MS: readonly number[] = [60_000, 5 * 60_000];
/** ruleStatus when the rule class was absent / not final at read time (and still not at the last re-check). */
export const RULE_PENDING = 'PENDING';
/** Rule classes that may still change (the LLM fallback or vision read is running). Absent = not final too. */
const NOT_FINAL_RULE = new Set(['LLM_PENDING']);

const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));
const istClock = (d: Date) => `${new Date(d.getTime() + IST_OFFSET_MS).toISOString().slice(0, 16).replace('T', ' ')} IST`;
const isCallKind = (k: ReadKind) => k === 'CALL' || k === 'UPDATE';
const settledStatus = (s: string) => s === 'READ' || s === 'CACHED';

type RuleComparison = { parseAgrees: boolean | null; missedByRules: boolean; ruleStatus: string | null };

/** The cache / dedupe key: the trimmed text, plus the vision result (or the unread-image mark) for an image post. */
function hashOf(j: ReadJob): string {
  if (j.imageReading !== undefined && j.imageReading !== null) return textHash(`${j.text}\n#vision:${JSON.stringify(j.imageReading)}`);
  if (j.imageSkipped !== undefined) return textHash(`${j.text}\n#image-unread`);
  return textHash(j.text);
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
 * at most MESSAGE_READER_MAX_IN_FLIGHT (default 8) reads in flight, dedupes by messageId while queued or in flight, and reads an edit (same
 * messageId, new text) again into the same row. Per job: older than MESSAGE_READER_MAX_AGE_MIN → STALE;
 * the same text read in the last 15 min → CACHED (no AI call); else packet → AI → rule-parse comparison →
 * READ. A failure is stored FAILED and retried once while the post is under 5 min old.
 * Shadow only: it creates no signal; its one event is reader.reading.stored after a fresh READ row (AI setups). Off with MESSAGE_READER=off or AI agents off.
 */
@Injectable()
export class MessageReaderService implements OnModuleDestroy {
  private readonly logger = new Logger(MessageReaderService.name);
  private readonly queue: QueuedJob[] = [];
  /** Jobs waiting in `queue`, by messageId (an edit replaces the waiting job in place). */
  private readonly waiting = new Map<string, QueuedJob>();
  /** messageId → text hash of the read in flight. */
  private readonly running = new Map<string, string>();
  /** An edit that arrived while its post was being read: queued when that read ends. */
  private readonly next = new Map<string, QueuedJob>();
  private idleWaiters: Array<() => void> = [];
  /** Pending rule re-checks per messageId (cleared on a new read of the post and on shutdown). */
  private readonly rechecks = new Map<string, NodeJS.Timeout[]>();

  constructor(
    @Inject(MessageReaderRepository) private readonly repo: ReaderStore,
    @Inject(ReaderPacketService) private readonly packet: ReaderPacketPort,
    @Inject(MessageReaderLlm) private readonly llm: ReaderLlmPort,
    @Inject(SignalVocabularyService) private readonly vocab: VocabularySource,
    @Inject(MESSAGE_READER_CONFIG) private readonly cfg: MessageReaderConfig,
    @Optional() @Inject(MESSAGE_READER_NOW) private readonly nowFn?: () => Date,
    @Optional() @Inject(MESSAGE_READER_AGENTS_ON) private readonly agentsOnFn?: () => boolean,
    @Optional() @Inject(MESSAGE_READER_ALERT) private readonly alertFn?: ReaderAlert,
    @Optional() @Inject(EventEmitter2) private readonly events?: Pick<EventEmitter2, 'emit'>,
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

  /**
   * Image posts: with the vision reading, or — when the image was not / could not be read (`reading: null`,
   * `skipped` = why) — the caption alone, with that reason. No caption and no reading: nothing to read, no row.
   */
  @OnEvent(SIGNAL_VISION_DONE_EVENT, { async: true })
  onVisionDone(evt: VisionDoneEvent): void {
    if (!this.enabled() || !evt?.messageId || !evt.channelId) return;
    const text = String(evt.text ?? '');
    const reading = evt.reading ?? null;
    const base = { messageId: evt.messageId, channelId: evt.channelId, postedAt: new Date(evt.postedAt), receivedAt: this.now(), text };
    if (reading !== null) {
      this.enqueue({ ...base, imageReading: reading });
      return;
    }
    if (!text.trim()) return;
    this.enqueue({ ...base, imageSkipped: evt.skipped?.trim() || 'image not read' });
  }

  onModuleDestroy(): void {
    for (const timers of this.rechecks.values()) for (const t of timers) clearTimeout(t);
    this.rechecks.clear();
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
    while (this.running.size < (this.cfg.maxInFlight || READER_MAX_IN_FLIGHT) && this.queue.length > 0) {
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
    this.cancelRechecks(j.messageId); // a new read of the post supersedes the old one's pending rule re-checks

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
      this.afterStore(row);
      return false;
    }

    let packetMs: number | null = null;
    let stored: ReadingWrite;
    try {
      const underlyings = await this.underlyingsOf(j);
      const built = await this.packet.build({ text: j.text, channelId: j.channelId, underlyings, now: dequeuedAt });
      packetMs = built.ms;
      let packet = built.packet;
      const channelTitle = (await this.repo.channelTitle(j.channelId)) ?? j.channelId;
      const ask = (p: ReaderPacket) =>
        this.llm.read({
          text: j.text,
          channelTitle,
          postedAtIst: istClock(j.postedAt),
          packet: p,
          ...(j.imageReading !== undefined ? { imageReading: j.imageReading } : {}),
          ...(j.imageSkipped !== undefined ? { imageSkipped: j.imageSkipped } : {}),
        });
      const first = await ask(packet);
      let { reply, model } = first;
      let ms = first.ms;
      const vocab = await this.vocab.get().catch(() => null);
      // Second pass (once): the AI named instruments the pre-filter missed → quote them and ask again.
      const missed = this.missedInstruments(reply, underlyings, packet, vocab);
      if (missed.length > 0 && this.packet.addInstruments) {
        try {
          const more = await this.packet.addInstruments(packet, missed, dequeuedAt);
          const second = await ask(more.packet);
          packet = more.packet;
          packetMs += more.ms;
          ({ reply, model } = second);
          ms += second.ms;
        } catch (e) {
          // The first reading stands.
          this.logger.warn(`[message-reader] second pass for ${j.messageId} (${missed.join(', ')}) failed: ${errText(e)}`);
        }
      }
      const isInstrument = (s: string) => !!vocab && vocab.classOf.has(vocab.names.get(s) ?? s);
      const claims = fillReasonCodes(reply.claims, packet, isInstrument);
      const call = reply.call ? { ...reply.call, underlying: reply.call.underlying.trim().toUpperCase() } : null;
      const row: ReadingWrite = {
        ...base,
        readAt: this.now(),
        status: 'READ',
        kind: reply.kind,
        scope: reply.scope,
        claims,
        call,
        summary: reply.summary,
        model,
        packet,
        packetMs,
        aiMs: ms,
        ...(await this.compareWithRules(j.messageId, reply.kind, call)),
      };
      await this.repo.upsertReading(row);
      stored = row;
    } catch (e) {
      const failedAt = this.now();
      const error = `${j.attempt > 1 ? 'retry: ' : ''}${errText(e)}`.slice(0, 500);
      this.logger.warn(`[message-reader] read of ${j.messageId} failed: ${error}`);
      await this.repo
        .upsertReading({ ...base, readAt: failedAt, status: 'FAILED', claims: [], model: this.cfg.model, packetMs, error })
        .catch((err) => this.logger.warn(`[message-reader] storing FAILED for ${j.messageId} failed: ${errText(err)}`));
      return j.attempt === 1 && failedAt.getTime() - j.postedAt.getTime() < this.cfg.retryMaxAgeMin * 60_000;
    }
    // Outside the try: nothing after the READ row is stored may turn it into FAILED or cause a second AI call.
    this.afterStore(stored);
    this.emitStored(stored, j.text);
    return false;
  }

  /** The single post-store hook: `reader.reading.stored` for a fresh READ row. Never throws into the reader. */
  private emitStored(row: ReadingWrite, postText: string): void {
    if (!this.events || row.status !== 'READ') return;
    try {
      const evt: ReadingStoredEvent = {
        messageId: row.messageId,
        channelId: row.channelId,
        postedAt: row.postedAt,
        readAt: row.readAt,
        status: 'READ',
        kind: row.kind ?? null,
        scope: row.scope ?? null,
        claims: row.claims,
        summary: row.summary ?? null,
        postText,
      };
      this.events.emit(READER_READING_STORED_EVENT, evt);
    } catch (e) {
      this.logger.warn(`[message-reader] ${READER_READING_STORED_EVENT} for ${row.messageId} failed: ${errText(e)}`);
    }
  }

  /**
   * Shadow comparison with the rule classifier (CALL / UPDATE only): the AI's call against the rule parser's,
   * or `missedByRules` when the rules filed the post as NOISE / INFO. `ruleStatus` records the class it saw;
   * PENDING when the class row is absent or not final (or the lookup failed) — the caller then re-checks.
   */
  private async compareWithRules(messageId: string, kind: ReadKind, call: ReaderCall | null): Promise<RuleComparison> {
    const pending: RuleComparison = { parseAgrees: null, missedByRules: false, ruleStatus: RULE_PENDING };
    if (!isCallKind(kind)) return { parseAgrees: null, missedByRules: false, ruleStatus: null };
    try {
      const rule = await this.repo.ruleClassOf(messageId);
      if (!rule || NOT_FINAL_RULE.has(rule.status)) return pending;
      if (rule.status === 'NOISE' || rule.status === 'INFO') return { parseAgrees: null, missedByRules: true, ruleStatus: rule.status };
      if (call && rule.signal) return { parseAgrees: parseAgrees(call, rule.signal).agrees, missedByRules: false, ruleStatus: rule.status };
      return { parseAgrees: null, missedByRules: false, ruleStatus: rule.status };
    } catch (e) {
      this.logger.warn(`[message-reader] rule class of ${messageId} unavailable: ${errText(e)}`);
      return pending;
    }
  }

  /**
   * After a stored READ / CACHED row: rule re-checks at +60 s and +5 min when the rule class was not final
   * (unref'd), then the owner alert. Never throws: the stored row stands whatever happens here.
   */
  private afterStore(row: ReadingWrite): void {
    try {
      if (row.ruleStatus === RULE_PENDING) this.scheduleRechecks(row.messageId, row.textHash, row.kind as ReadKind, row.call ?? null);
      this.afterRead(row);
    } catch (e) {
      this.logger.warn(`[message-reader] after-read work for ${row.messageId} failed: ${errText(e)}`);
    }
  }

  private scheduleRechecks(messageId: string, hash: string, kind: ReadKind, call: ReaderCall | null): void {
    this.cancelRechecks(messageId);
    const timers = RULE_RECHECK_MS.map((ms, i) => {
      const t = setTimeout(() => void this.recheck(messageId, hash, kind, call, i === RULE_RECHECK_MS.length - 1), ms);
      t.unref?.();
      return t;
    });
    this.rechecks.set(messageId, timers);
  }

  private cancelRechecks(messageId: string): void {
    for (const t of this.rechecks.get(messageId) ?? []) clearTimeout(t);
    this.rechecks.delete(messageId);
  }

  /** Updates only the comparison fields once the rules have decided; still undecided at the last check → stays PENDING. */
  private async recheck(messageId: string, hash: string, kind: ReadKind, call: ReaderCall | null, last: boolean): Promise<void> {
    if (last) this.rechecks.delete(messageId);
    const c = await this.compareWithRules(messageId, kind, call);
    if (c.ruleStatus === RULE_PENDING) return;
    this.cancelRechecks(messageId);
    try {
      await this.repo.updateRuleComparison(messageId, hash, c);
    } catch (e) {
      this.logger.warn(`[message-reader] rule re-check of ${messageId} not stored: ${errText(e)}`);
    }
  }

  /**
   * Instruments the AI's reading names (its call's underlying, claim subjects) that the vocabulary knows but
   * the packet does not carry, at most 3. Claim subjects that are ambiguous words (BANK, IT …) are sectors, not stocks.
   */
  private missedInstruments(reply: ReaderReply, underlyings: readonly string[], packet: ReaderPacket, vocab: Vocabulary | null): string[] {
    if (!vocab) return [];
    const have = new Set([...underlyings, ...Object.keys(packet.instruments ?? {})]);
    const canonical = (raw: string, fromCall: boolean): string | null => {
      const s = raw.trim().toUpperCase();
      if (!s || s === 'MARKET' || (!fromCall && AMBIGUOUS_SYMBOLS.has(s))) return null;
      const name = vocab.names.get(s) ?? (vocab.classOf.has(s) ? s : null);
      return name && vocab.classOf.has(name) ? name : null;
    };
    const named = [
      ...(reply.call ? [canonical(reply.call.underlying, true)] : []),
      ...(Array.isArray(reply.claims) ? reply.claims : []).map((c) => (typeof c?.subject === 'string' ? canonical(c.subject, false) : null)),
    ].filter((n): n is string => !!n && !have.has(n));
    return [...new Set(named)].slice(0, MAX_SECOND_PASS);
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
   * Owner market-note alert (MESSAGE_READER=on only): a fresh READ (not a CACHED copy) with a market-wide
   * claim the live data CONFIRMED, bias CAUTION / BEAR / BULL → one alert keyed `market-note:<channelId>`;
   * sendOpsAlert sends each key at most once per 30 min. Fire-and-forget: never throws, never blocks the queue.
   */
  private afterRead(row: ReadingWrite): void {
    if (this.cfg.mode !== 'on' || row.status !== 'READ') return;
    const claims = marketNoteClaims(row.claims);
    if (claims.length === 0) return;
    void this.sendMarketNote(row, claims).catch((e) => this.logger.warn(`[message-reader] market-note alert for ${row.messageId} failed: ${errText(e)}`));
  }

  private async sendMarketNote(row: ReadingWrite, claims: Claim[]): Promise<void> {
    const title = (await this.repo.channelTitle(row.channelId).catch(() => null)) ?? row.channelId;
    await (this.alertFn ?? sendOpsAlert)(`market-note:${row.channelId}`, marketNoteText(title, row.postedAt, claims));
  }
}
