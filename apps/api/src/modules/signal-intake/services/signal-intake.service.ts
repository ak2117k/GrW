import { createHash } from 'node:crypto';
import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { EventEmitter2, OnEvent } from '@nestjs/event-emitter';
import { AssistBusyError } from '../../ai-assist/assist-slot';
import { dedupKey, planCluster } from '../domain/cluster';
import { findContract, listedExpiries, segmentOf } from '../domain/contract';
import { inferExpiry } from '../domain/expiry';
import { validateLlmSignal, type LlmParseReply, type VisionReply } from '../domain/llm-schema';
import { prefilter } from '../domain/prefilter';
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
import { viewReason } from '../domain/view';
import type { Vocabulary } from '../domain/vocabulary';
import type { ClassRow, SignalIntakeRepository } from '../repositories/signal-intake.repository';
import { SIGNAL_INTAKE_CONFIG, type SignalIntakeConfig } from '../signal-intake.config';
import { SIGNAL_LLM, type SignalLlm } from './signal-parse-llm.service';
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

  constructor(
    @Inject(SIGNAL_INTAKE_REPO) private readonly repo: IntakeStore,
    @Inject(SIGNAL_VOCAB) private readonly vocab: VocabularySource,
    @Inject(SIGNAL_MASTER) private readonly master: MasterSource,
    @Inject(SIGNAL_LLM) private readonly llm: SignalLlm,
    @Inject(SIGNAL_INTAKE_CONFIG) private readonly config: SignalIntakeConfig,
    @Optional() @Inject(SIGNAL_EMITTER) private readonly emitter?: Emitter,
    @Optional() @Inject(SIGNAL_NOW) private readonly nowFn?: () => Date,
    @Optional() @Inject(SIGNAL_VISION) private readonly vision?: SignalVision,
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
    const upd = detectUpdate(text, vocab, pf.norm);
    if (upd) {
      await this.linkUpdate(evt, postedAt, upd, base);
      return;
    }
    const view = viewReason(pf);
    // An image post whose caption alone is not a call: the image may be the call (MCX / tip channels).
    if (evt.media) {
      const blocked = this.visionBlocked();
      if (!blocked) {
        await this.startVision(evt, postedAt, evt.media, base);
        return;
      }
      if (!pf.pass && view === null) {
        await this.repo.saveClass({ ...base, status: 'LLM_SKIPPED', parser: 'vision', reason: `image not read: ${blocked}` });
        return;
      }
    }
    if (view) {
      await this.repo.saveClass({ ...base, status: 'VIEW', reason: view });
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
   * UPDATE / VIEW / NOISE are stored and never emitted. The reply is kept with the image's sha256 —
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
    const stored = { kind: reply.kind, isSignal: reply.isSignal, signals: reply.signals, imageSha256: media.sha256 };
    const save = (status: MessageStatus, reason: string) =>
      this.repo.saveClass({ ...base, status, parser: 'vision', llmResult: stored, reason: `vision (${via}): ${reason}`.slice(0, 500) });
    if (reply.kind === 'VIEW') return save('VIEW', 'image is a view');
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
