import { Inject, Injectable, Logger, OnApplicationBootstrap, Optional } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { AssistBusyError } from '../../ai-assist/assist-slot';
import { findContract, listedExpiries, segmentOf, type SignalContract } from '../domain/contract';
import { inferExpiry } from '../domain/expiry';
import {
  freshnessOf,
  imageSignalText,
  isOptionSell,
  readImageSetupReply,
  validateImageSetup,
  withContractCheck,
  type Freshness,
  type ImageSetupVerdict,
} from '../domain/image-setup';
import { TELEGRAM_MESSAGE_EVENT, type ParsedSignal, type TelegramMessageEvent } from '../domain/types';
import { IMAGE_SETUP_CONFIG, type ImageSetupConfig } from '../image-setup.config';
import type { ImageReadRow, ImageReadStore } from '../repositories/image-read.repository';
import { IMAGE_SETUP_READER, type ImageSetupReader } from './image-setup-reader.service';
import { SIGNAL_MASTER, SIGNAL_NOW, SIGNAL_VOCAB, type MasterSource, type VocabularySource } from './signal-intake.service';

export const IMAGE_SETUP_STORE = Symbol('IMAGE_SETUP_STORE');
export const IMAGE_SETUP_SINK = Symbol('IMAGE_SETUP_SINK');
/** Test seam for the rate-limit wait. */
export const IMAGE_SETUP_SLEEP = Symbol('IMAGE_SETUP_SLEEP');

/** Where a promoted setup goes: SignalIntakeService.ingestImageSetup (the text signals' own path). */
export interface ImageSignalSink {
  ingestImageSetup(evt: TelegramMessageEvent, p: ParsedSignal, signalText: string): Promise<string | null>;
}

type Evt = TelegramMessageEvent & { edited?: boolean };
const IST_OFFSET_MS = 330 * 60_000;
const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));
/** A busy shared slot re-queues the read at most this many times. */
const BUSY_RETRIES = 2;

/**
 * Chart-screenshot setups (owner 2026-11-02). Every photo posted in an IMAGE_SETUP_CHANNELS channel is read
 * once by the vision model (job `signal.image-setup`) into a strict setup JSON, checked in code and stored in
 * telegram_image_reads. Reads are queued in memory and run one at a time, at least IMAGE_SETUP_MIN_GAP_SEC
 * apart, at most IMAGE_SETUP_DAILY_CAP a day, through the sentinel's shared slot — ingest never waits on them.
 *
 * IMAGE_SETUPS=observe (default) stores the read only. IMAGE_SETUPS=signal also turns a valid NEW_SETUP whose
 * screenshot is fresh into a normal parsed signal via {@link ImageSignalSink} — except option writing (SELL
 * CE/PE), which the signal trader refuses unless SIGNAL_ALLOW_OPTION_SELL=true, so it stays observe.
 */
@Injectable()
export class ImageSetupService implements OnApplicationBootstrap {
  private readonly logger = new Logger(ImageSetupService.name);
  private readonly queue: Array<{ evt: Evt; attempts: number }> = [];
  /** Message ids queued or being read (a duplicate delivery is not queued twice). */
  private readonly pending = new Set<string>();
  private draining: Promise<void> | null = null;
  private lastStart = 0;
  private day = '';
  private used = 0;

  constructor(
    @Inject(IMAGE_SETUP_CONFIG) private readonly cfg: ImageSetupConfig,
    @Inject(IMAGE_SETUP_STORE) private readonly store: ImageReadStore,
    @Inject(IMAGE_SETUP_READER) private readonly reader: ImageSetupReader,
    @Inject(SIGNAL_VOCAB) private readonly vocab: VocabularySource,
    @Inject(SIGNAL_MASTER) private readonly master: MasterSource,
    @Inject(IMAGE_SETUP_SINK) private readonly sink: ImageSignalSink,
    @Optional() @Inject(SIGNAL_NOW) private readonly nowFn?: () => Date,
    @Optional() @Inject(IMAGE_SETUP_SLEEP) private readonly sleep: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms)),
  ) {}

  private now(): Date {
    return this.nowFn ? this.nowFn() : new Date();
  }

  onApplicationBootstrap(): void {
    if (this.cfg.mode === 'off') {
      this.logger.log('[image-setup] off (IMAGE_SETUPS=off)');
      return;
    }
    const why = this.reader.unavailable();
    const sell = this.cfg.allowOptionSell ? 'option SELL allowed' : 'option SELL stays observe (SIGNAL_ALLOW_OPTION_SELL not true)';
    this.logger.log(
      `[image-setup] ${this.cfg.mode} for ${this.cfg.channels.size} channel(s), ${this.cfg.model}, cap ${this.cfg.dailyCap}/day, ${sell}` +
        (why ? ` — UNAVAILABLE: ${why}; reads are stored as not read` : ''),
    );
  }

  @OnEvent(TELEGRAM_MESSAGE_EVENT, { async: true })
  onTelegramMessage(evt: Evt): void {
    try {
      this.enqueue(evt);
    } catch (e) {
      this.logger.warn(`[image-setup] message ${evt?.messageId} not queued: ${errText(e)}`);
    }
  }

  /** Queue a photo for reading; returns 'queued' or why it was not (never awaits the read). */
  enqueue(evt: Evt): string {
    if (this.cfg.mode === 'off') return 'off';
    if (!evt?.messageId || !evt.channelId) return 'no message';
    if (!evt.media || evt.media.kind !== 'photo') return 'not a photo';
    if (!this.cfg.channels.has(evt.channelId)) return 'channel not enabled';
    if (evt.edited) return 'caption edit (image already read)';
    if (!evt.backfill && this.now().getTime() - new Date(evt.postedAt).getTime() > this.cfg.maxAgeMs) return 'too old';
    if (this.pending.has(evt.messageId)) return 'already queued';
    if (this.queue.length >= this.cfg.queueMax) {
      this.logger.warn(`[image-setup] queue full (${this.cfg.queueMax}): message ${evt.messageId} not read`);
      return 'queue full';
    }
    this.pending.add(evt.messageId);
    this.queue.push({ evt, attempts: 0 });
    this.draining ??= this.drain().finally(() => {
      this.draining = null;
    });
    return 'queued';
  }

  /** Resolves when the queue is empty (tests). */
  async idle(): Promise<void> {
    while (this.draining) await this.draining;
  }

  private async drain(): Promise<void> {
    for (let job = this.queue.shift(); job; job = this.queue.shift()) {
      const wait = this.lastStart + this.cfg.minGapMs - Date.now();
      if (this.lastStart > 0 && wait > 0) await this.sleep(wait);
      this.lastStart = Date.now();
      try {
        await this.process(job.evt, job.attempts);
      } catch (e) {
        this.logger.warn(`[image-setup] message ${job.evt.messageId} failed: ${errText(e)}`);
      }
      // A busy re-read was pushed back onto the queue: still pending.
      const id = job.evt.messageId;
      if (!this.queue.some((j) => j.evt.messageId === id)) this.pending.delete(id);
    }
  }

  private async usedToday(): Promise<number> {
    const day = new Date(this.now().getTime() + IST_OFFSET_MS).toISOString().slice(0, 10);
    if (day !== this.day) {
      this.day = day;
      this.used = 0;
    }
    let recorded = 0;
    try {
      recorded = await this.store.readsSince(new Date(`${day}T00:00:00+05:30`));
    } catch (e) {
      this.logger.warn(`[image-setup] cap count failed (using the in-process count): ${errText(e)}`);
    }
    return Math.max(recorded, this.used);
  }

  /** Read, check, store and (signal mode) promote one photo. Public for tests; null when skipped / re-queued. */
  async process(evt: Evt, attempts = 0): Promise<ImageReadRow | null> {
    if (await this.store.exists(evt.messageId)) return null;
    const media = evt.media;
    if (!media) return null;
    const postedAt = new Date(evt.postedAt);
    const base = { messageId: evt.messageId, channelId: evt.channelId, postedAt };
    const unread = async (reason: string, model: string | null = null, extra: Record<string, unknown> = {}) => {
      const row: ImageReadRow = { ...base, kind: 'NOT_A_SETUP', valid: false, reason, model, extraction: { error: reason, ...extra } };
      await this.store.save(row);
      return row;
    };

    const unavailable = this.reader.unavailable();
    if (unavailable) return unread(`not read: ${unavailable}`);
    const used = await this.usedToday();
    if (used >= this.cfg.dailyCap) return unread(`not read: daily cap ${this.cfg.dailyCap} reached`);
    this.used = used + 1;

    let reply: { text: string; model: string };
    try {
      const channel = (await this.store.channelTitle?.(evt.channelId).catch(() => null)) ?? '';
      reply = await this.reader.read({ path: media.path, mimeType: media.mimeType, sha256: media.sha256, caption: String(evt.text ?? ''), channel, postedAt });
    } catch (e) {
      if (e instanceof AssistBusyError && attempts < BUSY_RETRIES) {
        this.used = Math.max(0, this.used - 1); // never started: no spend
        this.queue.push({ evt, attempts: attempts + 1 });
        return null;
      }
      return unread(`read failed: ${errText(e)}`.slice(0, 500), e instanceof AssistBusyError ? null : this.cfg.model);
    }

    const read = readImageSetupReply(reply.text);
    if (!read) return unread('model reply is not the setup JSON', reply.model, { raw: reply.text.slice(0, 2000) });
    let v: ImageSetupVerdict = validateImageSetup(read, { caption: evt.text, vocab: await this.vocab.get() });
    let contract: SignalContract | null = null;
    if (v.valid && v.signal) {
      const found = await this.contractOf(v.signal, postedAt);
      v = withContractCheck(v, found);
      contract = found || null;
    }
    const fresh = v.valid && v.signal ? freshnessOf(v.extraction, postedAt, { maxLagMin: this.cfg.freshMaxLagMin, maxDriftPct: this.cfg.maxDriftPct }) : null;
    const promo = this.promotion(v, fresh, evt);
    const row: ImageReadRow = {
      ...base,
      kind: v.kind,
      valid: v.valid,
      reason: [v.reason, promo.reason].filter(Boolean).join(' · ') || null,
      model: reply.model,
      extraction: {
        ...v.extraction,
        modelKind: read.kind,
        ...(contract ? { contract: contract.tradingsymbol } : {}),
        ...(v.signal && v.valid ? { signalText: imageSignalText(v.signal) } : {}),
        ...(fresh ? { fresh } : {}),
        ...(v.untradeable ? { untradeable: v.untradeable } : {}),
      },
    };
    await this.store.save(row);
    if (!promo.promote || !v.signal) return row;

    const signalId = await this.sink.ingestImageSetup(evt, v.signal, imageSignalText(v.signal));
    if (signalId) {
      row.linkedSignalId = signalId;
      row.reason = [v.reason, `signal ${signalId}`].filter(Boolean).join(' · ');
      await this.store.link(evt.messageId, signalId, row.reason);
      this.logger.log(`[image-setup] ${imageSignalText(v.signal)} → signal ${signalId} (message ${evt.messageId})`);
    }
    return row;
  }

  /** May a read become a signal? Only a valid, tradeable NEW_SETUP, in signal mode, fresh, and not refused option writing. */
  private promotion(v: ImageSetupVerdict, fresh: Freshness | null, evt: Evt): { promote: boolean; reason: string | null } {
    if (!v.valid || v.kind !== 'NEW_SETUP') return { promote: false, reason: null };
    if (!v.signal) return { promote: false, reason: v.untradeable ?? 'nothing to trade' };
    const f = fresh as Freshness;
    const sellRefused = isOptionSell(v.signal) && !this.cfg.allowOptionSell;
    if (this.cfg.mode !== 'signal') {
      return { promote: false, reason: `observe mode (${f.fresh ? 'fresh' : `stale: ${f.reason}`}${sellRefused ? '; option SELL would stay observe' : ''})` };
    }
    if (evt.backfill) return { promote: false, reason: 'backfilled image (old post): never traded' };
    if (!f.fresh) return { promote: false, reason: `not fresh: ${f.reason}` };
    if (sellRefused) return { promote: false, reason: 'option SELL kept observe: the signal trader refuses option writing (SIGNAL_ALLOW_OPTION_SELL is not true)' };
    return { promote: true, reason: null };
  }

  /** The contract in the instrument master: found / false (not listed) / null (master unavailable). */
  private async contractOf(s: ParsedSignal, postedAt: Date): Promise<SignalContract | false | null> {
    let rows: readonly unknown[] | null = null;
    try {
      rows = await this.master.rows();
    } catch (e) {
      this.logger.warn(`[image-setup] instrument master unavailable: ${errText(e)}`);
    }
    if (!rows) return null;
    const vocab = await this.vocab.get();
    const seg = segmentOf(s.underlying, s.instrumentKind, vocab.classOf.get(s.underlying));
    const listed = listedExpiries(rows, s.underlying, s.instrumentKind, seg);
    const ex = inferExpiry(s.underlying, s.instrumentKind, s.expiryHint, postedAt, listed.length ? listed : null);
    return findContract(rows, { underlying: s.underlying, instrumentKind: s.instrumentKind, strike: s.strike, expiry: ex.expiry }, seg) ?? false;
  }
}
