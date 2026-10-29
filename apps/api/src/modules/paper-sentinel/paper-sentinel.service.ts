import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Prisma } from '@prisma/client';
import { PrismaService } from '../../common/prisma/prisma.service';
import { SentinelCycleService, type CycleRoster, type CycleVerdicts, type TickReading, type TickRow, type TickSource } from '../trade-sentinel/services/sentinel-cycle.service';
import { SENTINEL_MAX_WATCHED, type RosterEntry } from '../trade-sentinel/services/roster.service';
import { TripwireService } from '../trade-sentinel/services/tripwire.service';
import { ContextPacketService } from '../trade-sentinel/services/context-packet.service';
import { ThesisService } from '../trade-sentinel/services/thesis.service';
import { SentinelAgentService } from '../trade-sentinel/services/sentinel-agent.service';
import { OiWallSnapshotService } from '../trade-sentinel/services/oi-wall-snapshot.service';
import { REJUDGE_CONFIG, type RejudgeConfig } from '../trade-sentinel/services/rejudge-suppression';
import { FUTILE_REJUDGE_CONFIG, type FutileRejudgeConfig } from '../trade-sentinel/services/futile-rejudge';
import { JUDGE_GATE_CONFIG, type JudgeGateConfig } from '../trade-sentinel/services/judge-gate';
import { makeSentinelClock } from '../trade-sentinel/overnight/overnight-calendar';
import { MARKET_EVENTS, type EventsReader } from '../trade-sentinel/ports/events.port';
import { NEWS_EVENTS_CONFIG, type NewsEventsConfig } from '../news-events/config';
import { EXIT_DISCIPLINE_CONFIG, STREAK_LOOKBACK_MIN, type ExitDisciplineConfig } from '../exit-discipline/config';
import { gateSummary, istDate } from '../exit-discipline/decision';
import { TUNING_READER, type TuningReader } from '../self-review/tuning/tunables';
import { ExitGateRepository } from '../sentinel-executor/repositories/exit-gate.repository';
import { AUTO_EXIT_EXCHANGES } from '../sentinel-executor/domain/auto-exit.types';
import { parseTriggerConfig } from '../sentinel-executor/domain/trigger-config';
import type { SessionClock } from '../market-hub/session-clock';
import { PaperLookRepository } from '../trade-sentinel/paper/paper-look.repository';
import { paperTrackerId, tradeIdOf } from '../trade-sentinel/paper/paper-tracker';
import {
  armPaperTrigger,
  gateExits,
  paperExitGate,
  stepPaperTrigger,
  type PaperTrigger,
  type PendingTrigger,
  type TriggerPrices,
} from './paper-exit';

/** The tick source's row reader (SentinelTickSource.tickForRow), behind a token so this file never imports the adapter. */
export const PAPER_TICK_ROWS = Symbol('PAPER_TICK_ROWS');
export interface PaperTickRows {
  tickForRow(trackerId: string, row: TickRow, opts?: { uncounted?: boolean }): Promise<TickReading>;
}

/** One open paper trade as the paper watch priced it on this sweep. */
export interface PaperPosition {
  tradeId: string;
  userId: string;
  symbol: string;
  exchange: string;
  token: string;
  side: string;
  quantity: number;
  entryPrice: number;
  entryTime: Date;
  /** The product (INTRADAY / CARRYFORWARD / DELIVERY …), for the gate's square-off clause. */
  product: string | null;
  decisionId: string | null;
  ltp: number;
  ltpAt: Date;
}

interface Held extends PaperPosition {
  holdingHigh: number;
  holdingLow: number;
  /** The tick reading of the last cycle pass (the underlying for UNDERLYING triggers). */
  reading: TickReading | null;
  readingAt: number;
  pending: PendingTrigger | null;
  armed: PaperTrigger | null;
  /** The live AI would already have exited: no more looks (the position would be flat). */
  aiExited: string | null;
}

export const AI_RULES = ['AI_EXIT', 'AI_TRIGGER'] as const;

/** An AI exit to act on: the paper watch closes the paper trade at `price` (see `onExit`). */
export interface PaperAiExit {
  tradeId: string;
  rule: (typeof AI_RULES)[number];
  price: number;
  reason: string;
  at: Date;
}
export type PaperExitHandler = (e: PaperAiExit) => Promise<void>;

const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));
const r2 = (n: number) => Math.round(n * 100) / 100;

/**
 * Paper exit shadow, STAGE 2 — the live AI sentinel on paper trades (spec
 * docs/superpowers/specs/2026-10-28-paper-exit-shadow-design.md).
 *
 * It is the live `SentinelCycleService`, a second instance built from the module's own sensors, packet
 * builder, thesis, judge and every live config — so a paper position is sensed, gated and judged exactly
 * as a live one. Three things differ, and only these:
 *  - the ROSTER is the open paper trades the paper watch hands in each sweep (F&O only, as the live
 *    auto-exit; at most PAPER_SENTINEL_MAX, oldest first);
 *  - the TICK is SentinelTickSource.tickForRow over a row built from the paper trade and the watch's LTP;
 *  - the VERDICT STORE is paper_sentinel_looks, never sentinel_verdicts.
 * No hub tick sensors and no news push-wake (decision 6: no feed slots), and the instance has its own
 * judge slots, so a paper look can never take or delay a live one.
 *
 * Each look is then replayed through the live exit paths (paper-exit.ts) and the first AI exit is
 * written to paper_exit_shadows (AI_EXIT / AI_TRIGGER), then handed to the paper watch's `onExit`
 * handler, which closes the PAPER trade (owner 2026-10-29) and follows what holding would have made
 * (the HELD row, for the night review). NEVER an order: nothing in this module can reach order code.
 */
@Injectable()
export class PaperSentinelService {
  private readonly logger = new Logger(PaperSentinelService.name);
  private readonly book = new Map<string, Held>();
  private readonly cycle: SentinelCycleService;
  private readonly clock: SessionClock;
  private readonly risk: ExitGateRepository;
  private readonly triggerCfg = parseTriggerConfig(process.env);
  private running = false;

  constructor(
    tripwires: TripwireService,
    packets: ContextPacketService,
    thesis: ThesisService,
    agent: SentinelAgentService,
    oiWalls: OiWallSnapshotService,
    private readonly looks: PaperLookRepository,
    private readonly prisma: PrismaService,
    config: ConfigService,
    @Inject(PAPER_TICK_ROWS) private readonly rows: PaperTickRows,
    @Optional() @Inject(EXIT_DISCIPLINE_CONFIG) private readonly discipline?: ExitDisciplineConfig,
    @Optional() @Inject(NEWS_EVENTS_CONFIG) newsCfg?: NewsEventsConfig,
    @Optional() @Inject(MARKET_EVENTS) events?: EventsReader,
    @Optional() @Inject(REJUDGE_CONFIG) rejudgeCfg?: RejudgeConfig,
    @Optional() @Inject(FUTILE_REJUDGE_CONFIG) futileCfg?: FutileRejudgeConfig,
    @Optional() @Inject(JUDGE_GATE_CONFIG) gateCfg?: JudgeGateConfig,
    @Optional() @Inject(TUNING_READER) private readonly tuning?: TuningReader,
  ) {
    this.clock = makeSentinelClock(config.get<string>('hub.mcxLateClose'));
    this.risk = new ExitGateRepository(prisma);
    const roster: CycleRoster = { build: async (userId) => this.roster(userId) };
    const ticks: TickSource = { tickFor: (trackerId) => this.tickFor(trackerId) };
    const verdicts: CycleVerdicts = {
      record: async (input) => {
        const row = await this.looks.record(input);
        await this.afterLook(row);
        return row;
      },
      recentForTracker: (trackerId, limit) => this.looks.recentForTracker(trackerId, limit),
    };
    this.cycle = new SentinelCycleService(
      roster,
      tripwires,
      packets,
      thesis,
      agent,
      verdicts,
      oiWalls,
      ticks,
      undefined, // no hub tick sensors (no feed slots)
      discipline,
      undefined, // no news push-wake
      newsCfg,
      events,
      rejudgeCfg,
      futileCfg,
      undefined, // no exit attempts: nothing is ever executed for a paper trade
      gateCfg,
    );
  }

  enabled(): boolean {
    const on = (k: string) => (process.env[k] ?? 'on').trim().toLowerCase() !== 'off';
    return on('PAPER_EXIT_SHADOW') && on('PAPER_SENTINEL');
  }

  private max(): number {
    const n = Number(process.env.PAPER_SENTINEL_MAX);
    return Number.isInteger(n) && n >= 0 && n <= 20 ? n : SENTINEL_MAX_WATCHED;
  }

  /**
   * The paper watch's sweep: the open, market-open paper trades with their fresh LTP. Starts one cycle
   * pass detached (a pass still running is not doubled — the next sweep catches up). Never throws.
   */
  observe(positions: PaperPosition[], now: Date, open?: ReadonlySet<string>): void {
    if (!this.enabled()) return;
    try {
      // Kept: every trade still open with its market open (`open`), priced this sweep or not. A missed
      // quote must not evict a trade mid-pass (its look fails) or wipe its cycle memory; it keeps its
      // last LTP, and the tick source's own staleness guard refuses it once too old — as for a live tracker.
      const seen = new Set<string>(open ?? []);
      for (const p of positions) {
        if (!(p.ltp > 0) || !(p.entryPrice > 0)) continue;
        seen.add(p.tradeId);
        const prev = this.book.get(p.tradeId);
        this.book.set(p.tradeId, {
          ...p,
          holdingHigh: Math.max(prev?.holdingHigh ?? p.entryPrice, p.ltp),
          holdingLow: Math.min(prev?.holdingLow ?? p.entryPrice, p.ltp),
          reading: prev?.reading ?? null,
          readingAt: prev?.readingAt ?? 0,
          pending: prev?.pending ?? null,
          armed: prev?.armed ?? null,
          aiExited: prev?.aiExited ?? null,
        });
      }
      // Closed, or its market shut: off the roster (the cycle prunes its state), triggers dropped as live does.
      for (const id of [...this.book.keys()]) if (!seen.has(id)) this.book.delete(id);
    } catch (err) {
      this.logger.warn(`[paper-sentinel] observe failed: ${errText(err)}`);
      return;
    }
    if (this.running) return;
    this.running = true;
    this.passing = this.pass(now).finally(() => {
      this.running = false;
    });
  }

  /** Resolves once the current pass and every judgement it started have settled (tests, shutdown). */
  async idle(): Promise<void> {
    await this.passing;
    await Promise.all([...this.settling]);
  }
  private passing: Promise<void> = Promise.resolve();
  private readonly settling = new Set<Promise<unknown>>();

  private async pass(now: Date): Promise<void> {
    try {
      await this.restoreExited();
      for (const userId of new Set([...this.book.values()].map((h) => h.userId))) {
        // Judgements run detached, as live: a slow judge never holds up the next sweep's sensors and triggers.
        const { settled } = await this.cycle.startForUser(userId, now);
        const logged = settled.then((r) => {
          if (r.evaluated + r.failed > 0) this.logger.log(`[paper-sentinel] looks: ${r.evaluated} judged, ${r.failed} failed, ${r.skipped} quiet, ${r.unwatched} unwatched`);
        });
        this.settling.add(logged);
        void logged.finally(() => this.settling.delete(logged));
      }
      await this.stepTriggers(now);
    } catch (err) {
      this.logger.warn(`[paper-sentinel] pass failed: ${errText(err)}`);
    }
  }

  /** First sight after a restart: a trade whose AI exit is already recorded stays exited. */
  private async restoreExited(): Promise<void> {
    const unknown = [...this.book.values()].filter((h) => h.aiExited === null && !this.checked.has(h.tradeId));
    if (unknown.length === 0) return;
    const rows = await this.prisma.paperExitShadow.findMany({
      where: { tradeId: { in: unknown.map((h) => h.tradeId) }, rule: { in: [...AI_RULES] } },
      select: { tradeId: true, rule: true, price: true, reason: true, wouldExitAt: true },
    });
    for (const h of unknown) this.checked.add(h.tradeId);
    for (const r of rows) {
      const h = this.book.get(r.tradeId);
      if (!h || h.aiExited !== null) continue;
      h.aiExited = r.rule;
      // Recorded but the trade is still open (a restart between the record and the close, or recorded
      // before closing existed): close it now at the AI's recorded price, saying so.
      if (this.exitHandler && this.closes() && r.price !== null && r.price > 0 && r.wouldExitAt) {
        const at = r.wouldExitAt;
        const late = `closed late — the AI exit was recorded at ${at.toISOString()}`;
        try {
          await this.exitHandler({ tradeId: h.tradeId, rule: r.rule as (typeof AI_RULES)[number], price: r.price, reason: `${r.reason ?? r.rule} (${late})`, at });
        } catch (err) {
          this.logger.warn(`[paper-sentinel] late close of ${h.symbol} on ${r.rule} failed: ${errText(err)}`);
        }
      }
    }
  }
  private readonly checked = new Set<string>();

  private roster(userId: string): RosterEntry[] {
    const mine = [...this.book.values()].filter((h) => h.userId === userId).sort((a, b) => a.entryTime.getTime() - b.entryTime.getTime());
    const max = this.max();
    let slots = 0;
    return mine.map((h) => {
      const exchange = h.exchange.toUpperCase();
      const base = { userId, trackerId: paperTrackerId(h.tradeId), symbol: h.symbol, exchange, kind: 'POSITION' as const, ownership: 'SENTINEL' as const };
      if (!AUTO_EXIT_EXCHANGES.includes(exchange)) return { ...base, watched: false, reason: 'paper: the live AI exit is F&O only' };
      if (h.aiExited) return { ...base, watched: false, reason: `paper: the AI already exited (${h.aiExited})` };
      if (slots >= max) return { ...base, watched: false, reason: `paper: over PAPER_SENTINEL_MAX (${max})` };
      slots += 1;
      return { ...base, watched: true, reason: 'paper trade' };
    });
  }

  private async tickFor(trackerId: string): Promise<TickReading> {
    const h = this.book.get(tradeIdOf(trackerId));
    if (!h) throw new Error(`paper trade ${tradeIdOf(trackerId)} is no longer open`);
    const buy = String(h.side).toUpperCase() === 'BUY';
    const row: TickRow = {
      userId: h.userId,
      symbol: h.symbol,
      exchange: h.exchange,
      token: h.token,
      kind: 'POSITION',
      entryPrice: h.entryPrice,
      qty: buy ? Math.abs(h.quantity) : -Math.abs(h.quantity),
      entryTime: h.entryTime,
      holdingHigh: h.holdingHigh,
      holdingLow: h.holdingLow,
      lastLtp: h.ltp,
      updatedAt: h.ltpAt,
    };
    const reading = await this.rows.tickForRow(trackerId, row, { uncounted: true });
    h.reading = reading;
    h.readingAt = Date.now();
    return reading;
  }

  /** After every look: replay it through the live exit paths. Never throws (the look is already written). */
  private async afterLook(look: { id: string; tradeId: string; trackerId: string; verdict: string; createdAt: Date; packet: unknown; exitTrigger: unknown }): Promise<void> {
    try {
      const h = this.book.get(look.tradeId);
      if (!h || h.aiExited) return;
      if (look.verdict === 'EXIT_NOW') return await this.judgeExit(h, look);
      if ((look.verdict === 'HOLD' || look.verdict === 'EXIT_ARMED') && look.exitTrigger != null) {
        h.pending = { lookId: look.id, exitTrigger: look.exitTrigger, seenAt: Date.now() };
      }
    } catch (err) {
      this.logger.warn(`[paper-sentinel] exit replay for look ${look.id}: ${errText(err)}`);
    }
  }

  /** ExitGateService.load + decide for an EXIT_NOW look. */
  private async judgeExit(h: Held, look: { id: string; trackerId: string; createdAt: Date; packet: unknown }): Promise<void> {
    const now = new Date();
    const since = new Date(look.createdAt.getTime() - STREAK_LOOKBACK_MIN * 60_000);
    const [history, maxLossPerTrade, dailyLossLatched] = await Promise.all([
      this.looks.history(look.trackerId, look.id, look.createdAt, since),
      this.risk.maxRiskPerTrade(h.userId, now),
      this.risk.dailyLossLatched(h.userId, istDate(now)),
    ]);
    const w = this.clock.tradingWindow(h.exchange, now);
    const record = paperExitGate({
      look,
      history,
      ltpNow: h.ltp,
      productType: h.product,
      minutesToClose: this.clock.minutesToClose(h.exchange, now),
      sessionMinutes: w ? w.closeMin - w.openMin : undefined,
      maxLossPerTrade,
      dailyLossLatched,
      cfg: this.discipline ?? { enabled: false } as ExitDisciplineConfig,
      tuning: this.tuning,
      now,
    });
    const summary = gateSummary(record);
    if (!gateExits(record)) {
      this.logger.log(`[paper-sentinel] EXIT_NOW on ${h.symbol} held by the exit gate — ${summary}`);
      return;
    }
    await this.recordExit(h, 'AI_EXIT', h.ltp, `AI EXIT_NOW (${summary})`.slice(0, 500), { lookId: look.id, gate: record as unknown as Prisma.InputJsonValue });
  }

  private async stepTriggers(now: Date): Promise<void> {
    const at = now.getTime();
    for (const h of this.book.values()) {
      if (h.aiExited) continue;
      try {
        const u = h.reading?.underlyingLtp;
        const prices: TriggerPrices = {
          premium: { price: h.ltp, at: h.ltpAt.getTime() },
          underlying: typeof u === 'number' && u > 0 ? { price: u, at: h.readingAt } : null,
        };
        if (h.pending) {
          const buy = String(h.side).toUpperCase() === 'BUY';
          const r = armPaperTrigger({
            pending: h.pending,
            symbol: h.symbol,
            exchange: h.exchange,
            qty: buy ? Math.abs(h.quantity) : -Math.abs(h.quantity),
            prices,
            armed: h.armed,
            cfg: this.triggerCfg,
            fnoExchanges: AUTO_EXIT_EXCHANGES,
            now: at,
          });
          if (r.kind === 'armed') {
            h.armed = r.trigger;
            h.pending = null;
            this.logger.log(`[paper-sentinel] armed ${h.symbol}: exit if ${r.trigger.instrument} ${r.trigger.op} ${r.trigger.price} (now ${r.trigger.refPrice})`);
          } else if (r.kind === 'rejected') {
            this.logger.log(`[paper-sentinel] trigger REJECTED ${r.reason} — ${h.symbol} look ${h.pending.lookId}`);
            h.pending = null;
          }
        }
        if (!h.armed) continue;
        const s = stepPaperTrigger(h.armed, prices, this.triggerCfg, at);
        if (s.kind === 'expired') {
          h.armed = null;
        } else if (s.kind === 'fire') {
          const t = h.armed;
          await this.recordExit(h, 'AI_TRIGGER', h.ltp, `AI trigger ${t.instrument} ${t.op} ${t.price} crossed (${r2(s.watched)})`, {
            lookId: t.lookId,
            trigger: { instrument: t.instrument, op: t.op, price: t.price, refPrice: t.refPrice, armedAt: new Date(t.armedAt).toISOString(), watched: s.watched },
          });
        }
      } catch (err) {
        this.logger.warn(`[paper-sentinel] trigger step ${h.tradeId}: ${errText(err)}`);
      }
    }
  }

  /**
   * Owner 2026-10-29: the AI's exit CLOSES the paper trade, as it closes a live position. The close
   * itself is the paper watch's (signal-trader owns the paper close; this module can reach no trade or
   * order code), registered here at boot. Absent, or PAPER_SENTINEL_CLOSES=off ⇒ recorded only.
   */
  onExit(handler: PaperExitHandler): void {
    this.exitHandler = handler;
  }
  private exitHandler: PaperExitHandler | null = null;

  private closes(): boolean {
    return (process.env.PAPER_SENTINEL_CLOSES ?? 'on').trim().toLowerCase() !== 'off';
  }

  /** The first AI exit of a paper trade: a paper_exit_shadows row, then (closes on) the paper close. */
  private async recordExit(h: Held, rule: (typeof AI_RULES)[number], price: number, reason: string, detail: Record<string, Prisma.InputJsonValue>): Promise<void> {
    await this.writeExit(h, rule, price, reason, detail);
    if (!this.exitHandler || !this.closes()) return;
    try {
      await this.exitHandler({ tradeId: h.tradeId, rule, price, reason, at: new Date() });
    } catch (err) {
      this.logger.warn(`[paper-sentinel] closing paper ${h.symbol} on ${rule} failed: ${errText(err)} — recorded only`);
    }
  }

  private async writeExit(h: Held, rule: (typeof AI_RULES)[number], price: number, reason: string, detail: Record<string, Prisma.InputJsonValue>): Promise<void> {
    if (h.aiExited) return;
    h.aiExited = rule;
    h.armed = null;
    h.pending = null;
    const at = new Date();
    await this.prisma.paperExitShadow.upsert({
      where: { tradeId_rule: { tradeId: h.tradeId, rule } },
      create: {
        tradeId: h.tradeId,
        decisionId: h.decisionId,
        rule,
        wouldExitAt: at,
        price,
        reason,
        detail: { ...detail, baseline: 'held', entry: h.entryPrice, side: h.side, liveTriggersEnabled: this.triggerCfg.enabled } as Prisma.InputJsonValue,
      },
      update: {},
    });
    this.logger.warn(`[paper-sentinel] ${rule} ${h.symbol} @ ${price}: ${reason}`);
  }
}
