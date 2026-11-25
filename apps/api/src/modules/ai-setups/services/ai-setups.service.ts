import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { istYmd } from '../../mbm/domain/chain-snapshot';
import type { PacketBlock } from '../../message-reader/services/reader-packet.service';
import type { Claim } from '../../message-reader/domain/reading.types';
import { READER_READING_STORED_EVENT, type ReadingStoredEvent } from '../../message-reader/services/message-reader.service';
import { segmentFor } from '../../signal-trader/domain/contract-resolver';
import { liveSessionClock } from '../../trade-sentinel/overnight/overnight-calendar';
import { AI_SETUPS_CONFIG, type AiSetupsConfig } from '../ai-setups.config';
import { checkSetup, setupCeilingFor, type SetupCheckContext } from '../domain/setup-checks';
import { timeToClose } from '../domain/setup-packet';
import { SETUP_PROMPT_VERSION } from '../domain/setup-prompt';
import type { SetupReply } from '../domain/setup.types';
import { AiSetupsRepository, type AiSetupWrite } from '../repositories/ai-setups.repository';
import { SetupLlm } from './setup-llm.service';
import { SetupPacketService, type SetupPacket } from './setup-packet.service';

export const AI_SETUPS_NOW = Symbol('AI_SETUPS_NOW');
/** Session clock (default: the live NSE / BSE / MCX holiday-aware clock). */
export const AI_SETUPS_CLOCK = Symbol('AI_SETUPS_CLOCK');

/** Setup jobs (packet → AI → checks) running at once (plan: concurrency 2). */
export const AI_SETUPS_MAX_IN_FLIGHT = 2;

export type SetupStore = Pick<AiSetupsRepository, 'insert' | 'setupsToday' | 'recentOnUnderlying' | 'openOnUnderlying' | 'channelTitle'>;
export type SetupPacketPort = Pick<SetupPacketService, 'build'>;
export type SetupLlmPort = Pick<SetupLlm, 'build'>;
export interface SetupClock {
  isOpen(exchange: string, at: Date): boolean;
}

/** Where a stored row stopped: a guard (before any data), the packet (missing data), the AI call, or the code checks. */
export type SetupStage = 'eligibility' | 'guard' | 'packet' | 'ai' | 'checks';

interface SetupJob {
  underlying: string;
  claim: Claim;
  evt: ReadingStoredEvent;
}

const IST_OFFSET_MS = 330 * 60_000;
const MIN_MS = 60_000;
const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));
const istClock = (d: Date) => `${new Date(d.getTime() + IST_OFFSET_MS).toISOString().slice(0, 16).replace('T', ' ')} IST`;
const isRec = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const valueOf = (b: PacketBlock | undefined): Record<string, unknown> | null => (b && b.status === 'present' && isRec(b.value) ? b.value : null);

/**
 * Which claims of a stored reading may become a setup (v1). A CALL / UPDATE post never (the signal trader owns
 * calls); otherwise the CONFIRMED BULL / BEAR claims on a named subject (not MARKET), one per subject:
 * INSTRUMENT scope → jobs; SECTOR scope → sector skips (stored SKIPPED, v1 builds no sector setup); any other
 * scope → nothing.
 */
export function setupCandidates(evt: ReadingStoredEvent): { jobs: SetupJob[]; sectorSkips: SetupJob[] } {
  const none = { jobs: [], sectorSkips: [] };
  if (!evt || evt.status !== 'READ' || evt.kind === 'CALL' || evt.kind === 'UPDATE') return none;
  if (evt.scope !== 'INSTRUMENT' && evt.scope !== 'SECTOR') return none;
  const seen = new Set<string>();
  const out: SetupJob[] = [];
  for (const c of Array.isArray(evt.claims) ? evt.claims : []) {
    if (!c || c.verdict !== 'CONFIRMED' || (c.bias !== 'BULL' && c.bias !== 'BEAR')) continue;
    const u = String(c.subject ?? '').trim().toUpperCase();
    if (!u || u === 'MARKET' || seen.has(u)) continue;
    seen.add(u);
    out.push({ underlying: u, claim: c, evt });
  }
  return evt.scope === 'INSTRUMENT' ? { jobs: out, sectorSkips: [] } : { jobs: [], sectorSkips: out };
}

/** 'HH:mm' IST on `now`'s IST day → the instant. */
function istInstant(now: Date, hhmm: string): Date {
  return new Date(`${istYmd(now)}T${hhmm.trim()}:00+05:30`);
}

/**
 * AI setups (paper mode only; nothing here places or routes an order): a stored reading with a CONFIRMED
 * BULL / BEAR INSTRUMENT claim → guards → setup packet → Opus → code checks → one ai_setups row.
 *
 * - Listener: `reader.reading.stored`. AI_SETUPS=off → returns at once. Never throws into the reader.
 * - Queue: in-process FIFO, {@link AI_SETUPS_MAX_IN_FLIGHT} jobs at once, one job per underlying queued or in
 *   flight (a second claim on it meanwhile is stored SKIPPED).
 * - Guards (plan Global Constraints), serialised so a burst can never overshoot: market open and before the last
 *   entry time; no open / pending signal trade, live position, armed trigger or AI setup (PENDING / FILLED) on the
 *   underlying; no AI-built row on it in the last 30 min; fewer than 3 setups today (PENDING / FILLED / EXITED /
 *   EXPIRED rows, plus jobs in flight that passed the guards — a job that would only exceed the cap because of
 *   one in flight waits for it, then re-counts). A guard failure is stored SKIPPED with its reason.
 * - Then: packet (a throw → SKIPPED); quote / bars15m / chain unavailable → NO_TRADE with the reason, no AI call;
 *   the AI (an error → SKIPPED with it); the AI's NO_TRADE → NO_TRADE; a SETUP → checkSetup + the named option
 *   must be a chain row + validUntil still ahead → PENDING (validUntil) or NO_TRADE naming the failed check.
 */
@Injectable()
export class AiSetupsService {
  private readonly logger = new Logger(AiSetupsService.name);
  private readonly queue: SetupJob[] = [];
  /** Underlyings queued or in flight. */
  private readonly active = new Set<string>();
  private running = 0;
  /** Jobs past the guards and not yet stored: they count toward the daily cap. */
  private reserved = 0;
  private reservationWaiters: Array<() => void> = [];
  private guardChain: Promise<unknown> = Promise.resolve();
  private idleWaiters: Array<() => void> = [];
  /** Stores in flight (skip rows written outside a job), so whenIdle covers them. */
  private pendingStores = 0;

  constructor(
    @Inject(AiSetupsRepository) private readonly repo: SetupStore,
    @Inject(SetupPacketService) private readonly packet: SetupPacketPort,
    @Inject(SetupLlm) private readonly llm: SetupLlmPort,
    @Inject(AI_SETUPS_CONFIG) private readonly cfg: AiSetupsConfig,
    @Optional() @Inject(AI_SETUPS_NOW) private readonly nowFn?: () => Date,
    @Optional() @Inject(AI_SETUPS_CLOCK) private readonly clock?: SetupClock,
  ) {}

  private now(): Date {
    return this.nowFn ? this.nowFn() : new Date();
  }

  @OnEvent(READER_READING_STORED_EVENT, { async: true })
  onReadingStored(evt: ReadingStoredEvent): void {
    if (this.cfg.mode !== 'paper') return;
    try {
      const { jobs, sectorSkips } = setupCandidates(evt);
      for (const s of sectorSkips) this.storeDetached(this.skipRow(s, 'eligibility', `SECTOR scope (${s.underlying}) is skipped in v1: setups are built for named instruments only`));
      for (const j of jobs) this.enqueue(j);
    } catch (e) {
      this.logger.warn(`[ai-setups] reading ${evt?.messageId ?? '?'} not handled: ${errText(e)}`);
    }
  }

  /** Resolves once nothing is queued, in flight or being stored (tests). */
  whenIdle(): Promise<void> {
    if (this.isIdle()) return Promise.resolve();
    return new Promise((resolve) => this.idleWaiters.push(resolve));
  }

  private isIdle(): boolean {
    return this.queue.length === 0 && this.running === 0 && this.pendingStores === 0;
  }

  private notifyIdle(): void {
    if (!this.isIdle()) return;
    const w = this.idleWaiters;
    this.idleWaiters = [];
    for (const f of w) f();
  }

  private enqueue(job: SetupJob): void {
    if (this.active.has(job.underlying)) {
      this.storeDetached(this.skipRow(job, 'guard', `a setup for ${job.underlying} is already queued or in flight (one at a time per underlying)`));
      return;
    }
    this.active.add(job.underlying);
    this.queue.push(job);
    this.pump();
  }

  private pump(): void {
    while (this.running < AI_SETUPS_MAX_IN_FLIGHT && this.queue.length > 0) {
      const job = this.queue.shift() as SetupJob;
      this.running++;
      void this.run(job)
        .catch((e) => this.logger.warn(`[ai-setups] ${job.underlying} (${job.evt.messageId}) failed: ${errText(e)}`))
        .finally(() => {
          this.running--;
          this.active.delete(job.underlying);
          this.pump();
        });
    }
    this.notifyIdle();
  }

  private async run(job: SetupJob): Promise<void> {
    const guard = await this.guard(job);
    if (!guard.ok) {
      await this.store(this.skipRow(job, 'guard', guard.reason));
      return;
    }
    try {
      await this.store(await this.build(job));
    } finally {
      this.releaseReservation();
    }
  }

  /** The guards, one job at a time; on pass the job holds a daily-cap reservation until its row is stored. */
  private guard(job: SetupJob): Promise<{ ok: true } | { ok: false; reason: string }> {
    const run = this.guardChain.then(() => this.guardOnce(job));
    this.guardChain = run.catch(() => undefined);
    return run.catch((e) => ({ ok: false as const, reason: `guard check failed: ${errText(e)}` }));
  }

  private async guardOnce(job: SetupJob): Promise<{ ok: true } | { ok: false; reason: string }> {
    const u = job.underlying;
    const now = this.now();
    const exchange = segmentFor({ underlying: u, instrumentKind: 'FUT' });
    if (!(this.clock ?? liveSessionClock()).isOpen(exchange, now)) return { ok: false, reason: `${exchange} market is closed at ${istClock(now)}` };
    const ttc = timeToClose(exchange, now);
    if (ttc.minutesLeft <= 0) return { ok: false, reason: `after the last entry time ${ttc.lastValidIst} IST (${exchange}, intraday only)` };

    const open = await this.repo.openOnUnderlying(u, now);
    if (open) return { ok: false, reason: open };

    const since = new Date(now.getTime() - this.cfg.cooldownMin * MIN_MS);
    const recent = (await this.repo.recentOnUnderlying(u, since)).filter((r) => !(isRec(r.checks) && (r.checks.stage === 'guard' || r.checks.stage === 'eligibility')));
    if (recent.length > 0) {
      const last = recent.reduce((a, b) => (a.createdAt > b.createdAt ? a : b));
      return { ok: false, reason: `cooldown: ${u} had a setup row (${last.status}) at ${istClock(last.createdAt)}; ${this.cfg.cooldownMin} min per underlying` };
    }

    for (;;) {
      const made = await this.repo.setupsToday(this.now());
      if (made >= this.cfg.maxPerDay) return { ok: false, reason: `daily cap: ${made} AI setups already today (max ${this.cfg.maxPerDay})` };
      if (made + this.reserved < this.cfg.maxPerDay) break;
      // Only the jobs in flight could fill the cap: wait for one to store its row, then count again.
      await new Promise<void>((r) => this.reservationWaiters.push(r));
    }
    this.reserved++;
    return { ok: true };
  }

  private releaseReservation(): void {
    this.reserved = Math.max(0, this.reserved - 1);
    const w = this.reservationWaiters;
    this.reservationWaiters = [];
    for (const f of w) f();
  }

  /** Packet → AI → checks. Every outcome is a row; nothing here throws past a store. */
  private async build(job: SetupJob): Promise<AiSetupWrite> {
    const { underlying: u, claim, evt } = job;
    const now = this.now();
    let built: { packet: SetupPacket; ms: number };
    try {
      built = await this.packet.build({ underlying: u, claim, reading: { channelId: evt.channelId }, now });
    } catch (e) {
      return this.skipRow(job, 'packet', `setup packet failed: ${errText(e)}`);
    }
    const p = built.packet;
    const meta = { promptVersion: SETUP_PROMPT_VERSION, model: this.cfg.model, packetMs: built.ms, claim };
    const row = (r: Omit<AiSetupWrite, 'readingId' | 'underlying' | 'channelId' | 'packet'>): AiSetupWrite => ({ readingId: evt.messageId, underlying: u, channelId: evt.channelId, packet: p, ...r });

    const missing = (['quote', 'bars15m', 'chain'] as const)
      .filter((k) => p[k]?.status !== 'present')
      .map((k) => `${k} unavailable (${(p[k] as { reason?: string } | undefined)?.reason ?? 'missing'})`);
    if (missing.length > 0) {
      const detail = missing.join('; ');
      return row({ decision: 'NO_TRADE', status: 'NO_TRADE', reason: `missing data: ${detail}`, setup: null, validUntil: null, checks: { stage: 'packet', result: { ok: false, failed: 'data_unavailable', detail }, ...meta } });
    }

    let reply: SetupReply;
    let aiMs: number | null = null;
    try {
      const title = (await this.repo.channelTitle(evt.channelId).catch(() => null)) ?? evt.channelId;
      const out = await this.llm.build({
        packet: p,
        claim,
        channelTitle: title,
        postedAtIst: istClock(new Date(evt.postedAt)),
        postText: String(evt.postText ?? ''),
        readAtIst: istClock(new Date(evt.readAt)),
        readingSummary: evt.summary ?? null,
      });
      reply = out.reply;
      aiMs = out.ms;
    } catch (e) {
      return row({ decision: 'SKIPPED', status: 'SKIPPED', reason: `setup AI failed: ${errText(e)}`, setup: null, validUntil: null, checks: { stage: 'ai', error: errText(e), ...meta } });
    }
    const aiMeta = { ...meta, aiMs };
    if (reply.decision !== 'SETUP' || !reply.setup) {
      return row({ decision: 'NO_TRADE', status: 'NO_TRADE', reason: reply.reason, setup: null, validUntil: null, checks: { stage: 'ai', result: { ok: true }, ...aiMeta } });
    }

    const { ctx, missingOption } = this.checkContext(p, reply, u);
    const result = missingOption ?? checkSetup(reply, ctx);
    const context = { ltpUnderlying: ctx.ltpUnderlying, atr15m: ctx.atr15m, delta: ctx.delta, lotSize: ctx.lotSize, ceiling: ctx.ceiling, spreadPct: ctx.spreadPct, oi: ctx.oi, minOi: ctx.minOi, exchange: ctx.exchange };
    let final: { ok: true } | { ok: false; failed: string; detail: string } = result;
    const validUntil = istInstant(now, reply.setup.validUntil);
    if (final.ok && !(validUntil.getTime() > now.getTime())) final = { ok: false, failed: 'valid_until_past', detail: `validUntil ${reply.setup.validUntil} IST is not after now ${istClock(now)}` };
    const checks = { stage: 'checks', result: final, context, aiReason: reply.reason, ...aiMeta };
    if (!final.ok) {
      return row({ decision: 'SETUP', status: 'NO_TRADE', reason: `code check ${final.failed}: ${final.detail}`, setup: reply.setup, validUntil: null, checks });
    }
    return row({ decision: 'SETUP', status: 'PENDING', reason: reply.reason, setup: reply.setup, validUntil, checks });
  }

  /** The numbers checkSetup needs, measured from the packet for the option the AI named (its chain row). */
  private checkContext(p: SetupPacket, reply: SetupReply, u: string): { ctx: SetupCheckContext; missingOption: { ok: false; failed: string; detail: string } | null } {
    const s = reply.setup!;
    const quote = valueOf(p.quote);
    const bars = valueOf(p.bars15m);
    const chain = valueOf(p.chain);
    const exchange = String(chain?.exchange ?? p.optionExchange ?? '');
    const rows = Array.isArray(chain?.rows) ? (chain!.rows as Array<Record<string, unknown>>) : [];
    const ins = s.instrument;
    const sameOption = String(ins?.symbol ?? '').trim().toUpperCase() === u && ins?.expiry === chain?.expiry;
    const r = sameOption ? rows.find((x) => num(x.strike) === ins.strike) : undefined;
    const leg = r && isRec(r[ins.optionType === 'PE' ? 'pe' : 'ce']) ? (r[ins.optionType === 'PE' ? 'pe' : 'ce'] as Record<string, unknown>) : null;
    const ctx: SetupCheckContext = {
      packet: p,
      ltpUnderlying: num(quote?.ltp),
      atr15m: num(bars?.atr15m),
      delta: leg ? num(leg.delta) : null,
      lotSize: num(chain?.lotSize),
      ceiling: setupCeilingFor(u, exchange || null),
      spreadPct: leg ? num(leg.spreadPct) : null,
      oi: leg ? num(leg.oi) : null,
      minOi: this.cfg.minOi,
      exchange: exchange || null,
    };
    const missingOption = leg
      ? null
      : {
          ok: false as const,
          failed: 'option_not_in_chain',
          detail: `${String(ins?.symbol)} ${String(ins?.strike)} ${String(ins?.optionType)} ${String(ins?.expiry)} is not a row of the packet chain (${u} ${String(chain?.expiry)}, ${rows.length} strikes)`,
        };
    return { ctx, missingOption };
  }

  private skipRow(job: SetupJob, stage: SetupStage, reason: string): AiSetupWrite {
    return {
      readingId: job.evt.messageId,
      underlying: job.underlying,
      channelId: job.evt.channelId,
      decision: 'SKIPPED',
      status: 'SKIPPED',
      reason,
      setup: null,
      packet: null,
      validUntil: null,
      checks: { stage, claim: job.claim, promptVersion: SETUP_PROMPT_VERSION },
    };
  }

  private async store(r: AiSetupWrite): Promise<void> {
    try {
      await this.repo.insert(r);
      this.logger.log(`[ai-setups] ${r.underlying} (${r.readingId}) → ${r.status}: ${r.reason.slice(0, 200)}`);
    } catch (e) {
      this.logger.warn(`[ai-setups] storing ${r.status} for ${r.underlying} (${r.readingId}) failed: ${errText(e)}`);
    }
  }

  /** A row written outside a job (eligibility / dedupe skips): tracked for whenIdle, never throws. */
  private storeDetached(r: AiSetupWrite): void {
    this.pendingStores++;
    void this.store(r).finally(() => {
      this.pendingStores--;
      this.notifyIdle();
    });
  }
}
