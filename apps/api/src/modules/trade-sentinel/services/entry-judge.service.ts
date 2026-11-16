import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../../../common/prisma/prisma.service';
import { ClaudeCliTransport } from '../../ai-gateway/providers/claude-cli.provider';
import { AiCallRepository } from '../../ai-gateway/audit/ai-call.repository';
import { aiCallsRecordingOn, directRecordedTransport } from '../../ai-gateway/audit/recorded-transport';
import { withAiCallContext } from '../../ai-gateway/audit/ai-call-context';
import type { MessagesTransport, TransportRequest } from '../../ai-gateway/transport.types';
import { runInSharedSlot, type SharedSlotRunner } from '../../ai-assist/assist-slot';
import { judgeTransportFrom } from './llm-transport';
import { SentinelCycleService } from './sentinel-cycle.service';
import { ContextPacketService } from './context-packet.service';
import { entryRoom, oiQuality, ENTRY_JUDGE_SCHEMA, ENTRY_JUDGE_SYSTEM, parseEntryVerdict, type EntryDirection, type EntryVerdict } from './entry-judge';

/**
 * THE AI ENTRY JUDGE (owner 2026-11-16, correctness review F4). The entry engine and the re-entry watch
 * used to open on their own rule checks only — none of the review's findings (5-timeframe method, full OI
 * read, news & event outcomes, room to levels, the AI's own recent exits) reached an ENTRY. Now, before
 * either opens a trade, this judge reads the SAME market read the exit judge gets and decides
 * ENTER / WAIT / SKIP.
 *
 * ENTRY_AI_JUDGE: on (default; only ENTER opens) | observe (judged and recorded, the engine opens as before)
 * | off. Unavailable (no slot, timeout, bad answer) with `on` ⇒ NOT opened (fail closed). Capacity: the
 * sentinel's shared door (never the live exit reservation). Ledgered in ai_calls as job 'entry.judge'.
 */
export type EntryJudgeMode = 'on' | 'observe' | 'off';
export const ENTRY_JUDGE_JOB = 'entry.judge';

export interface EntryCandidate {
  source: 'ENTRY_ENGINE' | 'REENTRY_WATCH';
  underlying: string;
  /** NFO / BFO / MCX — the option venue. */
  optionExchange: string;
  direction: EntryDirection;
  /** The underlying now. */
  price: number | null;
  /** The engine's own reasons for wanting in, verbatim. */
  why: string[];
  /** The engine's own readings (news / trend / OI / gates), as recorded on its decision. */
  engineInputs?: unknown;
  userId: string | null;
}

export type EntryJudgeResult =
  | { ok: true; mode: EntryJudgeMode; verdict: EntryVerdict; latencyMs: number; open: boolean; note: string }
  | { ok: false; mode: EntryJudgeMode; reason: string; latencyMs: number; open: boolean; note: string };

const MAX_TOKENS = 3_000;
const TIMEOUT_MS = 150_000;
const SLOT_WAIT_MS = 90_000;
const DAY_MS = 86_400_000;
const IST = 19_800_000;

export function parseEntryJudgeMode(raw: string | undefined): EntryJudgeMode {
  const v = String(raw ?? '').trim().toLowerCase();
  return v === 'off' || v === 'false' ? 'off' : v === 'observe' ? 'observe' : 'on';
}

@Injectable()
export class EntryJudgeService {
  private readonly logger = new Logger(EntryJudgeService.name);
  private transport: MessagesTransport | null = null;
  readonly mode: EntryJudgeMode;

  constructor(
    private readonly config: ConfigService,
    private readonly prisma: PrismaService,
    private readonly cycle: SentinelCycleService,
    private readonly packets: ContextPacketService,
    @Optional() private readonly cli?: ClaudeCliTransport,
    @Optional() private readonly calls?: AiCallRepository,
    @Optional() @Inject('ENTRY_JUDGE_TRANSPORT') private readonly injected?: MessagesTransport,
  ) {
    this.mode = parseEntryJudgeMode(this.config.get<string>('ENTRY_AI_JUDGE'));
  }

  /** Judge one candidate entry. Never throws. `open` says whether the caller may open the trade. */
  async judge(c: EntryCandidate, now: Date = new Date()): Promise<EntryJudgeResult> {
    const started = Date.now();
    const mode = this.mode;
    if (mode === 'off') return { ok: false, mode, reason: 'off', latencyMs: 0, open: true, note: 'AI entry judge off' };
    try {
      const packet = await this.packetFor(c, now);
      const message = await this.ask(packet, c.userId);
      const verdict = parseEntryVerdict(message);
      const open = mode === 'observe' ? true : verdict.decision === 'ENTER';
      const note = `AI entry judge ${verdict.decision} (${verdict.confidence}${mode === 'observe' ? ', observe' : ''}): ${verdict.reason}`;
      this.logger.log(`[entry-judge] ${c.source} ${c.underlying} ${c.direction}: ${note}`);
      return { ok: true, mode, verdict, latencyMs: Date.now() - started, open, note };
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      this.logger.warn(`[entry-judge] ${c.source} ${c.underlying} ${c.direction}: unavailable — ${reason}`);
      // Fail CLOSED when on: an entry nobody judged is not taken.
      return { ok: false, mode, reason, latencyMs: Date.now() - started, open: mode === 'observe', note: `AI entry judge unavailable (${reason}) — ${mode === 'observe' ? 'observe: opened as before' : 'not opened'}` };
    }
  }

  /** The judge's packet: the candidate, the shared market read, room, OI quality and today's exits on the underlying. */
  async packetFor(c: EntryCandidate, now: Date): Promise<Record<string, unknown>> {
    const spot = c.price ?? 0;
    const read = await this.packets.marketRead(c.underlying, c.optionExchange, c.userId, spot, now);
    const indicators = read.indicators as { levels?: unknown; timeframes?: Record<string, { available?: boolean; atr14?: number }> } | null;
    const n15 = indicators?.timeframes?.['15m']?.available ? (indicators.timeframes['15m'].atr14 ?? null) : null;
    const room = entryRoom({ direction: c.direction, price: c.price, levels: (indicators?.levels as never) ?? null, n15, oiRead: read.oiRead as never });
    return {
      candidate: { source: c.source, underlying: c.underlying, exchange: c.optionExchange, direction: c.direction, wants: c.direction === 'BULLISH' ? 'buy a CE' : 'buy a PE', underlyingNow: c.price, engineReasons: c.why, engineInputs: c.engineInputs ?? null },
      indicators: read.indicators ?? 'unavailable (no fresh bars could be read)',
      oi: { read: read.oiRead ?? 'unavailable (no usable option chain)', quality: oiQuality(read.oiRead as never) },
      room,
      news: read.news ?? 'unavailable',
      events: read.events ?? 'unavailable',
      recentExits: await this.recentExits(c.underlying, now),
      session: { nowIst: new Date(now.getTime() + IST).toISOString().slice(0, 16).replace('T', ' ') },
    };
  }

  /** Today's closed trades (paper and real) on this underlying, newest first — what the AI and the engines just did. */
  private async recentExits(underlying: string, now: Date): Promise<unknown[]> {
    const d = new Date(now.getTime() + IST);
    const dayStart = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()) - IST);
    const u = underlying.toUpperCase();
    const ofU = (sym: string) => new RegExp(`^${u.replace(/[^A-Z0-9&-]/g, '')}\\d{2}[A-Z]{3}\\d{2}`).test(sym.toUpperCase());
    const hhmm = (t: Date | null) => (t ? new Date(t.getTime() + IST).toISOString().slice(11, 16) : null);
    try {
      const paper = await this.prisma.trade.findMany({
        where: { isPaperTrade: true, exitTime: { gte: dayStart }, instrument: { symbol: { startsWith: u } } },
        select: { entryTime: true, exitTime: true, entryPrice: true, exitPrice: true, pnl: true, strategy: true, exitReasonTag: true, exitNotes: true, instrument: { select: { symbol: true } } },
        orderBy: { exitTime: 'desc' },
        take: 6,
      });
      const real = await this.prisma.tradeTracker.findMany({
        where: { status: 'CLOSED', exitTime: { gte: dayStart }, symbol: { startsWith: u } },
        select: { symbol: true, entryTime: true, exitTime: true, entryPrice: true, exitPrice: true, pnl: true },
        orderBy: { exitTime: 'desc' },
        take: 6,
      });
      return [
        ...paper.filter((t) => ofU(t.instrument.symbol)).map((t) => ({
          book: 'paper', symbol: t.instrument.symbol, engine: t.strategy, entryIst: hhmm(t.entryTime), exitIst: hhmm(t.exitTime),
          entry: t.entryPrice, exit: t.exitPrice, pnl: t.pnl === null ? null : Math.round(t.pnl), exit_how: t.exitReasonTag, exit_note: (t.exitNotes ?? '').slice(0, 320),
        })),
        ...real.filter((t) => ofU(t.symbol)).map((t) => ({
          book: 'real', symbol: t.symbol, entryIst: hhmm(t.entryTime), exitIst: hhmm(t.exitTime), entry: t.entryPrice, exit: t.exitPrice, pnl: t.pnl === null ? null : Math.round(Number(t.pnl)),
        })),
      ];
    } catch (err) {
      return [`unavailable: ${err instanceof Error ? err.message : String(err)}`];
    }
  }

  private async ask(packet: Record<string, unknown>, userId: string | null): Promise<unknown> {
    const model = this.config.get<string>('ENTRY_JUDGE_MODEL') || this.config.get<string>('SENTINEL_MODEL_TRIGGERED') || 'claude-opus-5';
    const request = {
      model,
      max_tokens: MAX_TOKENS,
      output_config: { effort: 'high', format: { type: 'json_schema', schema: ENTRY_JUDGE_SCHEMA } },
      system: [{ type: 'text', text: ENTRY_JUDGE_SYSTEM }],
      messages: [{ role: 'user', content: JSON.stringify(packet) }],
    } as unknown as TransportRequest;
    const transport = this.transportFor();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`no verdict within ${TIMEOUT_MS / 1000} s`)), TIMEOUT_MS);
      timer.unref?.();
    });
    const call = runInSharedSlot(
      this.cycle as unknown as SharedSlotRunner,
      () => withAiCallContext({ userId: userId ?? undefined }, () => transport.messages.create(request)),
      { maxWaitMs: SLOT_WAIT_MS },
    );
    call.catch(() => undefined);
    try {
      return await Promise.race([call, timeout]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  private transportFor(): MessagesTransport {
    if (this.injected) return this.injected;
    if (!this.transport) {
      if (!this.cli || !this.calls) throw new Error('the AI gateway is not wired into this module');
      this.transport = directRecordedTransport({
        judge: judgeTransportFrom(this.config.get<string>('SENTINEL_JUDGE')),
        cli: this.cli,
        apiKey: this.config.get<string>('ANTHROPIC_API_KEY'),
        record: aiCallsRecordingOn(this.config.get<string>('AI_CALLS_RECORD')),
        audit: this.calls,
        jobOf: () => ENTRY_JUDGE_JOB,
      });
    }
    return this.transport;
  }
}

export const ENTRY_JUDGE_DAY_MS = DAY_MS;
