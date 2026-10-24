import { createHash } from 'node:crypto';
import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { EventEmitter2, OnEvent } from '@nestjs/event-emitter';
import { AssistBusyError } from '../../ai-assist/assist-slot';
import { dedupKey, planCluster } from '../domain/cluster';
import { findContract, listedExpiries, segmentOf } from '../domain/contract';
import { inferExpiry } from '../domain/expiry';
import { classifyCommentary, hasBias, recapReason, type CommentaryClass, type InfoItem, type RefPrices } from '../domain/info';
import { validateInfoItems, validateLlmSignal, type InfoLlmReply, type LlmParseReply, type VisionReply } from '../domain/llm-schema';
import { prefilter, type PrefilterResult } from '../domain/prefilter';
import { parseSignal } from '../domain/rule-parser';
import {
  directionOf,
  SIGNAL_READY_EVENT,
  SIGNAL_UPDATE_EVENT,
  TELEGRAM_MESSAGE_EVENT,
  type MessageStatus,
  type ParsedSignal,
  type ParsedUpdate,
  type SignalReadyEvent,
  type SignalUpdateEvent,
  type TelegramMediaRef,
  type TelegramMessageEvent,
} from '../domain/types';
import { detectUpdate } from '../domain/updates';
import type { Vocabulary } from '../domain/vocabulary';
import type { ClassRow, ReclassRow, SignalIntakeRepository } from '../repositories/signal-intake.repository';
import { SIGNAL_INTAKE_CONFIG, type SignalIntakeConfig } from '../signal-intake.config';
import { SIGNAL_INFO_LLM, SIGNAL_LLM, type SignalInfoLlm, type SignalLlm } from './signal-parse-llm.service';
import { SIGNAL_VISION, type SignalVision } from './signal-vision.service';

export const SIGNAL_INTAKE_REPO = Symbol('SIGNAL_INTAKE_REPO');
export const SIGNAL_VOCAB = Symbol('SIGNAL_VOCAB');
export const SIGNAL_MASTER = Symbol('SIGNAL_MASTER');
export const SIGNAL_EMITTER = Symbol('SIGNAL_EMITTER');
export const SIGNAL_NOW = Symbol('SIGNAL_NOW');

export type IntakeStore = Pick<
  SignalIntakeRepository,
  | 'classOf' | 'saveClass' | 'cachedLlm' | 'cachedVision' | 'llmPending' | 'duplicateOf' | 'signalByMessage' | 'createSignal' | 'updateSignal'
  | 'setSignalCluster' | 'messageText' | 'clusters' | 'recentSignals' | 'createCluster' | 'updateCluster' | 'flagConflict' | 'signalsByIds' | 'latestInChannel'
  | 'saveInfo' | 'cachedInfoLlm' | 'refCloses' | 'reclassCandidates'
>;
export interface VocabularySource {
  get(): Promise<Vocabulary>;
}
/** Raw Angel scrip-master rows; null when unavailable (expiry falls back to the calendar rule). */
export interface MasterSource {
  rows(): Promise<readonly unknown[] | null>;
}
export interface Emitter {
  emit(event: string, payload: unknown): unknown;
}

const IST_OFFSET_MS = 330 * 60_000;
const istYmd = (d: Date) => new Date(d.getTime() + IST_OFFSET_MS).toISOString().slice(0, 10);
const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));
/** An update links to the channel's signals of the last few days. */
const UPDATE_LOOKBACK_MS = 4 * 86_400_000;
/** A busy-slot parse is retried at most this many times. */
const LLM_MAX_ATTEMPTS = 3;
/** The one-off re-classification reads at most this many stored rows per boot. */
const RECLASS_MAX_ROWS = 20_000;
const RECLASS_PAGE = 200;

export const textHash = (text: string) => createHash('sha256').update(String(text ?? '').trim()).digest('hex');

/**
 * Stream S: every `telegram.message` → classified (NOISE / SIGNAL / UPDATE / DUPLICATE / LLM_*), a
 * TradeSignal + SignalCluster for each call, `signal.ready` / `signal.update` for stream X.
 *
 * Order per message: free pre-filter → rule parser → update detector → (pre-filter positives only)
 * LLM fallback. Handling is serialised through one promise chain so two channels posting the same
 * idea at once cluster correctly; the LLM call itself runs OUTSIDE the chain and re-enters it.
 */
@Injectable()
export class SignalIntakeService {
  private readonly logger = new Logger(SignalIntakeService.name);
  private chain: Promise<unknown> = Promise.resolve();
  private llmDay = '';
  private llmUsed = 0;
  private readonly inflight = new Set<string>();
  /** In-process count of vision calls today: a floor under the ai_calls count (recording can be off / lag). */
  private visionDay = '';
  private visionUsed = 0;
  private visionInflight = 0;
  /** In-process count of INFO extractions today (a floor under the ai_calls count). */
  private infoDay = '';
  private infoUsed = 0;
  private infoInflight = 0;
  /** Reference closes per IST day of the post ("X se dur nahi"), read once per day. */
  private readonly refCache = new Map<string, Promise<RefPrices>>();

  constructor(
    @Inject(SIGNAL_INTAKE_REPO) private readonly repo: IntakeStore,
    @Inject(SIGNAL_VOCAB) private readonly vocab: VocabularySource,
    @Inject(SIGNAL_MASTER) private readonly master: MasterSource,
    @Inject(SIGNAL_LLM) private readonly llm: SignalLlm,
    @Inject(SIGNAL_INTAKE_CONFIG) private readonly config: SignalIntakeConfig,
    @Optional() @Inject(SIGNAL_EMITTER) private readonly emitter?: Emitter,
    @Optional() @Inject(SIGNAL_NOW) private readonly nowFn?: () => Date,
    @Optional() @Inject(SIGNAL_VISION) private readonly vision?: SignalVision,
    @Optional() @Inject(SIGNAL_INFO_LLM) private readonly infoLlm?: SignalInfoLlm,
  ) {}

  private now(): Date {
    return this.nowFn ? this.nowFn() : new Date();
  }

  @OnEvent(TELEGRAM_MESSAGE_EVENT, { async: true })
  onTelegramMessage(evt: TelegramMessageEvent & { edited?: boolean }): Promise<void> {
    return this.handle(evt).catch((e) => this.logger.warn(`[signal-intake] message ${evt?.messageId} failed: ${errText(e)}`));
  }

  /** Serialised entry point (tests await it). */
  handle(evt: TelegramMessageEvent & { edited?: boolean }): Promise<void> {
    const run = this.chain.then(() => this.classify(evt));
    this.chain = run.catch(() => undefined);
    return run;
  }

  private serial<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.chain.then(fn);
    this.chain = run.catch(() => undefined);
    return run;
  }

  private async classify(evt: TelegramMessageEvent & { edited?: boolean }): Promise<void> {
    if (!this.config.enabled || !evt?.messageId || !evt.channelId) return;
    const text = String(evt.text ?? '');
    const postedAt = new Date(evt.postedAt);
    // An image post's identity is its caption AND its image (an image swap is a different post).
    const hash = evt.media ? textHash(`${text}\n#img:${evt.media.sha256}`) : textHash(text);
    const base = { messageId: evt.messageId, channelId: evt.channelId, postedAt, textHash: hash };

    const prior = await this.repo.classOf(evt.messageId);
    if (prior && prior.textHash === hash) return; // the same event again
    const vocab = await this.vocab.get();
    const pf = prefilter(text, vocab);
    const parsed = pf.pass ? parseSignal(text, vocab, pf.norm) : null;

    if (prior) {
      await this.reclassifyEdit(evt, prior, parsed, base);
      return;
    }
    if (parsed) {
      await this.createFromParsed(evt, postedAt, parsed, 'rule', base, null);
      return;
    }
    // The channel's own results of past calls: kept to score its claims later, never a signal or an update.
    const recap = recapReason(text, pf.norm, vocab);
    if (recap) {
      await this.repo.saveClass({ ...base, status: 'RECAP', reason: recap });
      return;
    }
    const upd = detectUpdate(text, vocab, pf.norm);
    if (upd) {
      await this.linkUpdate(evt, postedAt, upd, base);
      return;
    }
    const info = await this.commentary(text, pf, vocab, postedAt);
    // An image post whose caption alone is not a call: the image may be the call (MCX / tip channels).
    // A caption that already carries a directional view is the post's information: no image read.
    if (evt.media && !(info?.kind === 'INFO' && info.items.some(hasBias))) {
      const blocked = this.visionBlocked();
      if (!blocked) {
        await this.startVision(evt, postedAt, evt.media, base);
        return;
      }
      if (info?.kind !== 'INFO') {
        await this.repo.saveClass({ ...base, status: 'LLM_SKIPPED', parser: 'vision', reason: `image not read: ${blocked}` });
        return;
      }
    }
    if (info?.kind === 'INFO') {
      await this.saveInfo(evt, postedAt, base, info);
      return;
    }
    if (info) {
      await this.repo.saveClass({ ...base, status: info.kind, reason: info.reason });
      return;
    }
    if (!pf.pass) {
      await this.repo.saveClass({ ...base, status: 'NOISE', reason: pf.reason });
      return;
    }
    await this.startLlm(evt, postedAt, base);
  }

  // ─── Vision (image posts) ──────────────────────────────────────────────────

  private visionBlocked(): string | null {
    if (!this.config.visionEnabled) return 'SIGNAL_VISION=off';
    if (!this.vision) return 'no vision transport';
    return this.vision.unavailable();
  }

  private async visionUsedToday(): Promise<number> {
    const now = this.now();
    const day = istYmd(now);
    if (day !== this.visionDay) {
      this.visionDay = day;
      this.visionUsed = 0;
    }
    const midnight = new Date(`${day}T00:00:00+05:30`);
    let recorded = 0;
    try {
      recorded = (await this.vision?.usedSince(midnight)) ?? 0;
    } catch (e) {
      this.logger.warn(`[signal-intake] vision cap count failed (using the in-process count): ${errText(e)}`);
    }
    return Math.max(recorded + this.visionInflight, this.visionUsed);
  }

  private async startVision(evt: TelegramMessageEvent, postedAt: Date, media: TelegramMediaRef, base: Omit<ClassRow, 'status'>): Promise<void> {
    const cached = await this.repo.cachedVision(media.sha256);
    if (cached) {
      await this.applyVision(evt, postedAt, media, cached as VisionReply, base, 'cache');
      return;
    }
    if (this.now().getTime() - postedAt.getTime() > this.config.visionMaxAgeMs) {
      await this.repo.saveClass({ ...base, status: 'LLM_SKIPPED', parser: 'vision', reason: 'image too old for the model (history)' });
      return;
    }
    if (this.inflight.has(evt.messageId)) return;
    const used = await this.visionUsedToday();
    if (used >= this.config.visionDailyCap) {
      await this.repo.saveClass({ ...base, status: 'LLM_SKIPPED', parser: 'vision', reason: `daily vision cap ${this.config.visionDailyCap} reached` });
      return;
    }
    this.visionUsed = used + 1;
    this.visionInflight++;
    this.inflight.add(evt.messageId);
    await this.repo.saveClass({ ...base, status: 'LLM_PENDING', parser: 'vision', attempts: 1 });
    // Outside the serial chain, like the text fallback.
    void (this.vision as SignalVision)
      .classify(String(evt.text ?? ''), media)
      .then(
        (reply) => this.serial(() => this.applyVision(evt, postedAt, media, reply, base, 'llm')),
        (e) =>
          this.serial(async () => {
            if (e instanceof AssistBusyError) this.visionUsed = Math.max(0, this.visionUsed - 1); // never started: no spend
            await this.repo.saveClass({ ...base, status: 'LLM_FAILED', parser: 'vision', attempts: 1, reason: `vision: ${errText(e)}`.slice(0, 500) });
          }),
      )
      .catch((e) => this.logger.warn(`[signal-intake] vision read of ${evt.messageId} failed: ${errText(e)}`))
      .finally(() => {
        this.inflight.delete(evt.messageId);
        this.visionInflight = Math.max(0, this.visionInflight - 1);
      });
  }

  /**
   * Only kind SIGNAL can become a TradeSignal (and so `signal.ready`, under the same age rule as text);
   * UPDATE / INFO (legacy VIEW) / NOISE are stored and never emitted; INFO items go to channel_infos. The reply is kept with the image's sha256 —
   * that is the cache.
   */
  private async applyVision(
    evt: TelegramMessageEvent,
    postedAt: Date,
    media: TelegramMediaRef,
    reply: VisionReply,
    base: Omit<ClassRow, 'status'>,
    via: 'llm' | 'cache',
  ): Promise<void> {
    const stored = { kind: reply.kind, isSignal: reply.isSignal, signals: reply.signals, ...(reply.items ? { items: reply.items } : {}), imageSha256: media.sha256 };
    const save = (status: MessageStatus, reason: string) =>
      this.repo.saveClass({ ...base, status, parser: 'vision', llmResult: stored, reason: `vision (${via}): ${reason}`.slice(0, 500) });
    if (reply.kind === 'INFO' || reply.kind === 'VIEW') {
      const vocab = await this.vocab.get();
      const items = validateInfoItems(reply.items ?? [], vocab);
      await save('INFO', `image is market information (${items.length} item${items.length === 1 ? '' : 's'})`);
      if (items.length) {
        await this.repo.saveInfo({
          messageId: evt.messageId, channelId: evt.channelId, postedAt, sessionDate: istYmd(postedAt), textHash: base.textHash, items, extractor: 'llm', confidence: 0.6,
        });
      }
      return;
    }
    if (reply.kind === 'NOISE') return save('NOISE', 'image is noise');
    if (reply.kind === 'UPDATE') return save('UPDATE_ORPHAN', 'image is an update (not linked)');
    if (!reply.isSignal || reply.signals.length === 0) return save('LLM_NOT_SIGNAL', 'no call in the image');
    const vocab = await this.vocab.get();
    const reasons: string[] = [];
    for (const raw of reply.signals) {
      const v = validateLlmSignal(raw, vocab);
      if (v.ok) {
        await this.createFromParsed(evt, postedAt, { ...v.signal, tags: [...v.signal.tags, 'VISION'] }, 'llm', base, stored);
        return;
      }
      reasons.push(v.reason);
    }
    await save('LLM_NOT_SIGNAL', `invalid: ${reasons.join('; ')}`);
  }

  // ─── INFO (market information) ─────────────────────────────────────────────

  /** The commentary class, re-run with reference closes when an index target would decide the bias. */
  private async commentary(text: string, pf: PrefilterResult, vocab: Vocabulary, postedAt: Date): Promise<CommentaryClass | null> {
    const c = classifyCommentary(text, pf, vocab);
    if (c?.kind !== 'INFO' || !c.wantsRefs) return c;
    return classifyCommentary(text, pf, vocab, await this.refs(postedAt));
  }

  private refs(at: Date): Promise<RefPrices> {
    const day = istYmd(at);
    let hit = this.refCache.get(day);
    if (!hit) {
      hit = this.repo.refCloses(at).catch((e) => {
        this.logger.warn(`[signal-intake] reference closes unavailable: ${errText(e)}`);
        this.refCache.delete(day);
        return new Map<string, number>();
      });
      if (this.refCache.size > 40) this.refCache.clear();
      this.refCache.set(day, hit);
    }
    return hit;
  }

  /** INFO: the class row, the items (channel_infos), and — only when no item got a bias — the cheap-LLM fallback. */
  private async saveInfo(
    evt: TelegramMessageEvent,
    postedAt: Date,
    base: Omit<ClassRow, 'status'>,
    info: CommentaryClass,
    opts: { llm?: boolean; keep?: Partial<ClassRow> } = {},
  ): Promise<void> {
    await this.repo.saveClass({ ...base, ...opts.keep, status: 'INFO', parser: opts.keep?.parser ?? 'rule', reason: info.reason });
    if (info.items.length) {
      await this.repo.saveInfo({
        messageId: evt.messageId, channelId: evt.channelId, postedAt, sessionDate: istYmd(postedAt), textHash: base.textHash, items: info.items, extractor: 'rule', confidence: info.confidence,
      });
    }
    if (info.needsLlm && opts.llm !== false) await this.startInfoLlm(evt, postedAt, base, info);
  }

  private async infoUsedToday(): Promise<number> {
    const day = istYmd(this.now());
    if (day !== this.infoDay) {
      this.infoDay = day;
      this.infoUsed = 0;
    }
    let recorded = 0;
    try {
      recorded = (await this.infoLlm?.usedSince?.(new Date(`${day}T00:00:00+05:30`))) ?? 0;
    } catch (e) {
      this.logger.warn(`[signal-intake] info cap count failed (using the in-process count): ${errText(e)}`);
    }
    return Math.max(recorded + this.infoInflight, this.infoUsed);
  }

  /**
   * The cheap-LLM INFO extraction (job 'signal.info', the parse fallback's transport and shared slot):
   * cached by text hash, never for posts older than SIGNAL_INFO_LLM_MAX_AGE_MIN, at most
   * SIGNAL_INFO_LLM_DAILY_CAP a day. A busy slot or a failure keeps the rule items; nothing is retried.
   */
  private async startInfoLlm(evt: TelegramMessageEvent, postedAt: Date, base: Omit<ClassRow, 'status'>, info: CommentaryClass): Promise<void> {
    const cached = await this.repo.cachedInfoLlm(base.textHash);
    if (cached) {
      await this.applyInfoLlm(evt, postedAt, base, info, cached as InfoLlmReply, 'cache');
      return;
    }
    if (!this.config.infoLlmEnabled || !this.infoLlm) return;
    if (this.now().getTime() - postedAt.getTime() > this.config.infoLlmMaxAgeMs) return;
    const key = `info:${evt.messageId}`;
    if (this.inflight.has(key)) return;
    const used = await this.infoUsedToday();
    if (used >= this.config.infoLlmDailyCap) return;
    this.infoUsed = used + 1;
    this.infoInflight++;
    this.inflight.add(key);
    const llm = this.infoLlm;
    void llm
      .info(String(evt.text ?? ''))
      .then(
        (reply) => this.serial(() => this.applyInfoLlm(evt, postedAt, base, info, reply, 'llm')),
        (e) => {
          if (e instanceof AssistBusyError) this.infoUsed = Math.max(0, this.infoUsed - 1); // never started: no spend
          this.logger.warn(`[signal-intake] info extraction of ${evt.messageId} failed (rule items kept): ${errText(e)}`);
        },
      )
      .catch((e) => this.logger.warn(`[signal-intake] info extraction of ${evt.messageId} failed: ${errText(e)}`))
      .finally(() => {
        this.inflight.delete(key);
        this.infoInflight = Math.max(0, this.infoInflight - 1);
      });
  }

  private async applyInfoLlm(
    evt: TelegramMessageEvent,
    postedAt: Date,
    base: Omit<ClassRow, 'status'>,
    info: CommentaryClass,
    reply: InfoLlmReply,
    via: 'llm' | 'cache',
  ): Promise<void> {
    const vocab = await this.vocab.get();
    const items: InfoItem[] = reply?.isInfo ? validateInfoItems(reply.items, vocab) : [];
    const useLlm = items.some(hasBias);
    await this.repo.saveInfo({
      messageId: evt.messageId, channelId: evt.channelId, postedAt, sessionDate: istYmd(postedAt), textHash: base.textHash,
      items: useLlm ? items : info.items, extractor: useLlm ? 'llm' : 'rule', confidence: useLlm ? 0.6 : info.confidence, llmReply: reply,
    });
    const what = useLlm ? `${items.length} item(s)` : 'no bias';
    await this.repo.saveClass({ ...base, status: 'INFO', parser: useLlm ? 'llm' : 'rule', reason: `${info.reason}; llm (${via}): ${what}`.slice(0, 500) });
  }

  /**
   * One-off (boot, idempotent, SIGNAL_INFO_RECLASSIFY): stored NOISE / VIEW / unread-image rows written
   * before the INFO classifier are classified again with the free rules only — INFO (+ items), RECAP or
   * unchanged. No LLM, no event, no signal. Every visited row gets the class version, so a second run
   * finds nothing.
   */
  async reclassifyStored(): Promise<{ scanned: number; info: number; recap: number; noise: number; kept: number }> {
    const out = { scanned: 0, info: 0, recap: 0, noise: 0, kept: 0 };
    if (!this.config.enabled || !this.config.infoReclassify) return out;
    const vocab = await this.vocab.get();
    while (out.scanned < RECLASS_MAX_ROWS) {
      const rows = await this.repo.reclassCandidates(RECLASS_PAGE);
      if (rows.length === 0) break;
      for (const r of rows) {
        out.scanned++;
        const text = (await this.repo.messageText(r.messageId)) ?? '';
        const res = await this.serial(() => this.reclassOne(r, text, vocab));
        out[res]++;
      }
    }
    if (out.scanned) this.logger.log(`[signal-intake] re-classified ${out.scanned} stored rows: ${out.info} INFO, ${out.recap} RECAP, ${out.noise} NOISE, ${out.kept} unchanged`);
    return out;
  }

  private async reclassOne(r: ReclassRow, text: string, vocab: Vocabulary): Promise<'info' | 'recap' | 'noise' | 'kept'> {
    const base = { messageId: r.messageId, channelId: r.channelId, postedAt: r.postedAt, textHash: r.textHash };
    const keep: Partial<ClassRow> = { parser: r.parser, llmResult: r.llmResult, signalId: r.signalId, updateKind: r.updateKind, attempts: r.attempts };
    const pf = prefilter(text, vocab);
    const info = await this.commentary(text, pf, vocab, r.postedAt);
    const evt: TelegramMessageEvent = { messageId: r.messageId, channelId: r.channelId, postedAt: r.postedAt, text };
    if (info?.kind === 'INFO') {
      await this.saveInfo(evt, r.postedAt, base, info, { llm: false, keep });
      return 'info';
    }
    if (info?.kind === 'RECAP') {
      await this.repo.saveClass({ ...base, ...keep, status: 'RECAP', reason: info.reason });
      return 'recap';
    }
    if (r.status === 'VIEW') {
      // Legacy VIEW is INFO by definition (an image the model called a view stays INFO whatever its caption);
      // a text VIEW that is now an ad / a P&L brag is NOISE.
      if (info?.kind === 'NOISE' && r.parser !== 'vision') {
        await this.repo.saveClass({ ...base, ...keep, status: 'NOISE', reason: info.reason });
        return 'noise';
      }
      await this.repo.saveClass({ ...base, ...keep, status: 'INFO', reason: `${r.reason ?? 'view'} (migrated from VIEW)`.slice(0, 500) });
      return 'info';
    }
    await this.repo.saveClass({ ...base, ...keep, status: r.status as MessageStatus, reason: r.reason });
    return 'kept';
  }

  // ─── Edits ─────────────────────────────────────────────────────────────────

  /**
   * An edit of a stored message never creates a second signal and never re-counts the cluster: the
   * existing signal's levels are corrected in place (typo fixes are the common case). An edit that
   * turns chatter into a call is treated as a new message.
   */
  private async reclassifyEdit(
    evt: TelegramMessageEvent,
    prior: { status: string; signalId: string | null },
    parsed: ParsedSignal | null,
    base: Omit<ClassRow, 'status'>,
  ): Promise<void> {
    if (prior.signalId && prior.status === 'SIGNAL') {
      if (!parsed) {
        await this.repo.saveClass({ ...base, status: 'SIGNAL', parser: 'rule', signalId: prior.signalId, reason: 'edited: new text unparsed, levels kept' });
        return;
      }
      const ex = await this.expiryAndContract(parsed, base.postedAt);
      await this.repo.updateSignal(prior.signalId, {
        entryLow: parsed.entryLow, entryHigh: parsed.entryHigh, entryType: parsed.entryType, sl: parsed.sl, targets: parsed.targets,
        qty: parsed.qty, strike: parsed.strike, expiry: ex.expiry, expirySource: ex.source, exchange: ex.contract?.exchange ?? null,
        token: ex.contract?.token ?? null, tradingsymbol: ex.contract?.tradingsymbol ?? null, rawText: evt.text, confidence: parsed.confidence,
      });
      await this.repo.saveClass({ ...base, status: 'SIGNAL', parser: 'rule', signalId: prior.signalId, reason: 'edited' });
      return;
    }
    if (prior.status === 'NOISE' && parsed) {
      await this.createFromParsed(evt, base.postedAt, parsed, 'rule', base, null);
      return;
    }
    await this.repo.saveClass({ ...base, status: prior.status as MessageStatus, signalId: prior.signalId, reason: 'edited (no change in classification)' });
  }

  // ─── Signals ───────────────────────────────────────────────────────────────

  private async expiryAndContract(p: ParsedSignal, postedAt: Date) {
    const vocab = await this.vocab.get();
    const seg = segmentOf(p.underlying, p.instrumentKind, vocab.classOf.get(p.underlying));
    let rows: readonly unknown[] | null = null;
    try {
      rows = await this.master.rows();
    } catch (e) {
      this.logger.warn(`[signal-intake] instrument master unavailable (calendar-rule expiry): ${errText(e)}`);
    }
    const listed = rows ? listedExpiries(rows, p.underlying, p.instrumentKind, seg) : null;
    const ex = inferExpiry(p.underlying, p.instrumentKind, p.expiryHint, postedAt, listed && listed.length ? listed : null);
    const contract = rows ? findContract(rows, { underlying: p.underlying, instrumentKind: p.instrumentKind, strike: p.strike, expiry: ex.expiry }, seg) : null;
    return { ...ex, contract };
  }

  private async createFromParsed(
    evt: TelegramMessageEvent,
    postedAt: Date,
    p: ParsedSignal,
    parser: 'rule' | 'llm',
    base: Omit<ClassRow, 'status'>,
    llmResult: unknown,
  ): Promise<void> {
    const W = this.config.clusterWindowMs;
    const key = dedupKey({ channelId: evt.channelId, underlying: p.underlying, instrumentKind: p.instrumentKind, strike: p.strike, side: p.side, entryLow: p.entryLow, entryHigh: p.entryHigh });
    const dup = await this.repo.duplicateOf(key, new Date(postedAt.getTime() - W));
    if (dup) {
      await this.repo.saveClass({ ...base, status: 'DUPLICATE', parser, signalId: dup, llmResult, reason: 'same idea re-posted in this channel' });
      return;
    }
    const ex = await this.expiryAndContract(p, postedAt);
    const direction = directionOf(p.instrumentKind, p.side);
    let confidence = p.confidence;
    if (ex.source === 'rule') confidence -= 0.05;
    const signalId = await this.repo.createSignal({
      messageId: evt.messageId,
      channelId: evt.channelId,
      receivedAt: postedAt,
      sessionDate: istYmd(postedAt),
      parser,
      underlying: p.underlying,
      instrumentKind: p.instrumentKind,
      strike: p.strike,
      expiry: ex.expiry,
      expirySource: ex.source,
      exchange: ex.contract?.exchange ?? null,
      token: ex.contract?.token ?? null,
      tradingsymbol: ex.contract?.tradingsymbol ?? null,
      side: p.side,
      direction,
      entryLow: p.entryLow,
      entryHigh: p.entryHigh,
      entryType: p.entryType,
      sl: p.sl,
      targets: p.targets,
      qty: p.qty,
      horizon: p.horizon,
      tags: p.tags,
      confidence: Math.round(Math.max(0, confidence) * 100) / 100,
      rawText: String(evt.text ?? ''),
      dedupKey: key,
    });

    const since = new Date(postedAt.getTime() - W);
    const [sameSide, recent] = await Promise.all([this.repo.clusters(p.underlying, direction, since), this.repo.recentSignals(p.underlying, since)]);
    const plan = planCluster(
      { id: signalId, channelId: evt.channelId, underlying: p.underlying, direction, receivedAt: postedAt },
      sameSide,
      recent.filter((r) => r.id !== signalId),
      W,
    );
    let clusterId: string;
    if (plan.action === 'create') {
      const { id: _drop, ...c } = plan.cluster;
      clusterId = await this.repo.createCluster(c);
    } else {
      clusterId = plan.cluster.id as string;
      await this.repo.updateCluster({ ...plan.cluster, id: clusterId });
    }
    await this.repo.flagConflict(plan.conflictClusterIds.filter((id) => id !== clusterId));
    await this.repo.setSignalCluster(signalId, clusterId);
    await this.repo.saveClass({ ...base, status: 'SIGNAL', parser, signalId, llmResult });

    if (this.now().getTime() - postedAt.getTime() > this.config.readyMaxAgeMs) return; // history: stored, not traded
    const ready = (id: string): SignalReadyEvent => ({ signalId: id, clusterId, agreeCount: plan.cluster.agreeCount, conflict: plan.cluster.conflict });
    this.emit(SIGNAL_READY_EVENT, ready(signalId));
    if (plan.corroborated) {
      // A new channel joined: re-emit the cluster's earlier signals (latest per other channel) with the higher agreeCount.
      const earlier = await this.repo.signalsByIds(plan.cluster.signalIds.filter((id) => id !== signalId));
      const seen = new Set<string>([evt.channelId]);
      for (const s of earlier) {
        if (seen.has(s.channelId)) continue;
        seen.add(s.channelId);
        this.emit(SIGNAL_READY_EVENT, ready(s.id));
      }
    }
  }

  // ─── Updates ───────────────────────────────────────────────────────────────

  private async linkUpdate(evt: TelegramMessageEvent, postedAt: Date, u: ParsedUpdate, base: Omit<ClassRow, 'status'>): Promise<void> {
    const recent = await this.repo.latestInChannel(evt.channelId, new Date(postedAt.getTime() - UPDATE_LOOKBACK_MS));
    const before = recent.filter((s) => s.receivedAt.getTime() <= postedAt.getTime());
    const target =
      before.find((s) => (u.underlying ? s.underlying === u.underlying : true) && (u.strike !== null ? s.strike === u.strike : true)) ??
      (u.underlying === null && u.strike === null ? before[0] : undefined);
    if (!target) {
      await this.repo.saveClass({ ...base, status: 'UPDATE_ORPHAN', updateKind: u.kind, reason: `no earlier signal in this channel (${u.kinds.join(',')})` });
      return;
    }
    await this.repo.saveClass({ ...base, status: 'UPDATE', updateKind: u.kind, signalId: target.id, reason: u.kinds.join(',') });
    if (this.now().getTime() - postedAt.getTime() > this.config.readyMaxAgeMs) return;
    const payload: SignalUpdateEvent & { channelId: string; postedAt: Date; targetIndex: number | null } = {
      signalId: target.id,
      kind: u.kind,
      text: String(evt.text ?? ''),
      channelId: evt.channelId,
      postedAt,
      targetIndex: u.targetIndex,
    };
    this.emit(SIGNAL_UPDATE_EVENT, payload);
  }

  // ─── LLM fallback ──────────────────────────────────────────────────────────

  private async startLlm(evt: TelegramMessageEvent, postedAt: Date, base: Omit<ClassRow, 'status'>, attempts = 0): Promise<void> {
    const cached = await this.repo.cachedLlm(base.textHash);
    if (cached) {
      await this.applyLlm(evt, postedAt, cached as LlmParseReply, base, 'cache');
      return;
    }
    if (!this.config.llmEnabled) {
      await this.repo.saveClass({ ...base, status: 'LLM_SKIPPED', reason: 'SIGNAL_PARSE_LLM=off' });
      return;
    }
    if (this.now().getTime() - postedAt.getTime() > this.config.llmMaxAgeMs) {
      await this.repo.saveClass({ ...base, status: 'LLM_SKIPPED', reason: 'too old for the LLM (history)' });
      return;
    }
    if (!this.takeBudget()) {
      await this.repo.saveClass({ ...base, status: 'LLM_SKIPPED', reason: `daily LLM cap ${this.config.llmDailyCap} reached` });
      return;
    }
    await this.repo.saveClass({ ...base, status: 'LLM_PENDING', attempts: attempts + 1 });
    if (this.inflight.has(evt.messageId)) return;
    this.inflight.add(evt.messageId);
    // Outside the serial chain: a slow model call must not hold up other channels' messages.
    void this.llm
      .parse(String(evt.text ?? ''))
      .then(
        (reply) => this.serial(() => this.applyLlm(evt, postedAt, reply, base, 'llm')),
        (e) =>
          this.serial(async () => {
            const busy = e instanceof AssistBusyError;
            if (busy) this.llmUsed = Math.max(0, this.llmUsed - 1); // never started: no spend
            const status: MessageStatus = busy && attempts + 1 < LLM_MAX_ATTEMPTS ? 'LLM_PENDING' : 'LLM_FAILED';
            await this.repo.saveClass({ ...base, status, attempts: attempts + 1, reason: errText(e).slice(0, 500) });
          }),
      )
      .catch((e) => this.logger.warn(`[signal-intake] LLM parse of ${evt.messageId} failed: ${errText(e)}`))
      .finally(() => this.inflight.delete(evt.messageId));
  }

  private async applyLlm(evt: TelegramMessageEvent, postedAt: Date, reply: LlmParseReply, base: Omit<ClassRow, 'status'>, via: 'llm' | 'cache'): Promise<void> {
    const vocab = await this.vocab.get();
    if (!reply.isSignal || reply.signals.length === 0) {
      await this.repo.saveClass({ ...base, status: 'LLM_NOT_SIGNAL', parser: 'llm', llmResult: reply, reason: via });
      return;
    }
    const reasons: string[] = [];
    for (const raw of reply.signals) {
      const v = validateLlmSignal(raw, vocab);
      if (v.ok) {
        // One TradeSignal per message (messageId is unique); further calls stay in llm_result.
        await this.createFromParsed(evt, postedAt, v.signal, 'llm', base, reply);
        return;
      }
      reasons.push(v.reason);
    }
    await this.repo.saveClass({ ...base, status: 'LLM_NOT_SIGNAL', parser: 'llm', llmResult: reply, reason: `invalid: ${reasons.join('; ')}`.slice(0, 500) });
  }

  private takeBudget(): boolean {
    const day = istYmd(this.now());
    if (day !== this.llmDay) {
      this.llmDay = day;
      this.llmUsed = 0;
    }
    if (this.llmUsed >= this.config.llmDailyCap) return false;
    this.llmUsed += 1;
    return true;
  }

  /** Retry parses that found the shared slot busy, while they are still fresh (cron, every few minutes). */
  async retryPending(): Promise<number> {
    if (!this.config.enabled || !this.config.llmEnabled) return 0;
    const rows = await this.repo.llmPending(new Date(this.now().getTime() - this.config.llmMaxAgeMs));
    let n = 0;
    for (const r of rows) {
      if (r.parser === 'vision') continue; // image reads are never retried as a text parse
      if (this.inflight.has(r.messageId) || r.attempts >= LLM_MAX_ATTEMPTS) continue;
      const msg = await this.repo.messageText(r.messageId);
      if (msg === null) continue;
      const evt: TelegramMessageEvent = { messageId: r.messageId, channelId: r.channelId, postedAt: r.postedAt, text: msg };
      await this.serial(() =>
        this.startLlm(evt, r.postedAt, { messageId: r.messageId, channelId: r.channelId, postedAt: r.postedAt, textHash: r.textHash }, r.attempts),
      );
      n++;
    }
    return n;
  }

  private emit(event: string, payload: unknown): void {
    try {
      this.emitter?.emit(event, payload);
    } catch (e) {
      this.logger.warn(`[signal-intake] emit ${event} failed: ${errText(e)}`);
    }
  }
}

/** Nest EventEmitter2 as the stream-S emitter. */
export const eventEmitterAdapter = (ee: EventEmitter2): Emitter => ({ emit: (event, payload) => ee.emit(event, payload) });
