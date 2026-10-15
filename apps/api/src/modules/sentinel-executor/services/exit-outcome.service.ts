// apps/api/src/modules/sentinel-executor/services/exit-outcome.service.ts
import { Inject, Injectable, Logger } from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import { Prisma, type AiExitOutcome } from '@prisma/client';
import { PrismaService } from '../../../common/prisma/prisma.service';
import { EXIT_DISCIPLINE_CONFIG, type ExitDisciplineConfig } from '../../exit-discipline/config';
import { istDate } from '../../exit-discipline/decision';
import { computeExitOutcome, isWindowCovered, outcomeWindowEnd, type ExitOutcomeValues } from '../../exit-discipline/outcome';
import { readPacketFacts, type PacketFacts } from '../../exit-discipline/packet-facts';
import { scorecard, scorecardLine } from '../../exit-discipline/scorecard';
import type { MinuteBar, OutcomeKind, PositionSide } from '../../exit-discipline/types';
import type { CandleRepo } from '../../market-hub/candles/candle-repository';
import type { HubCandle } from '../../market-hub/candles/candle.types';
import { HUB_CANDLE_SOURCE, type HubCandleSource } from '../../market-hub/hub-candle-source';
import type { HubExchange, InstrumentRef } from '../../market-hub/hub.types';
import type { SessionClock } from '../../market-hub/session-clock';
import { MANUAL_VERDICT_PREFIX } from '../domain/manual-exit';
import { AiExitExecutionRepository, type ScoringCandidate } from '../repositories/ai-exit-execution.repository';
import { AiExitOutcomeRepository, TRIGGER_VERDICT_PREFIX } from '../repositories/ai-exit-outcome.repository';
import { AI_EXIT_SESSION_CLOCK } from './sentinel-exit-executor.service';

/** The candles_1m reader (a PrismaCandleRepo in the module). */
export const EXIT_OUTCOME_CANDLES = Symbol('EXIT_OUTCOME_CANDLES');
/** The allow-listed auto-exit users (their daily scorecard). */
export const EXIT_OUTCOME_USERS = Symbol('EXIT_OUTCOME_USERS');

const MIN = 60_000;
const HOUR = 3_600_000;
const IST_OFFSET_MS = 330 * MIN;
const CANDIDATE_LOOKBACK_MS = 48 * HOUR;
const RETRY_UNTIL_MS = 24 * HOUR;
const CORPUS_LOOKBACK_MS = 7 * 24 * HOUR;
const DUE_PER_PASS = 10;
/** The previous IST day is scored from 00:05 IST. */
const SCORECARD_AFTER_MIN = 5;

const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));
const rupees = (x: number | null | undefined) => `₹${Math.round(x ?? 0)}`;
/** A plain AI verdict id: neither the owner's manual exit nor a price trigger. */
const isPlainAi = (verdictId: string) => !verdictId.startsWith(MANUAL_VERDICT_PREFIX) && !verdictId.startsWith(TRIGGER_VERDICT_PREFIX);
const toBar = (c: Pick<HubCandle, 'ts' | 'open' | 'high' | 'low' | 'close'>): MinuteBar =>
  ({ ts: Number(c.ts), open: Number(c.open), high: Number(c.high), low: Number(c.low), close: Number(c.close) });
const posNum = (x: unknown): number | null => (typeof x === 'number' && Number.isFinite(x) && x > 0 ? x : null);

/**
 * Exit discipline §8 / E4 / E5 / E7 (plan Task 15): what the price did after each
 * AI exit decision, executed or skipped. One pass, every 60 s from the poller,
 * single-flight, never throws, and never touches the broker: bars come from
 * candles_1m, then at most ONE governed HubCandleSource fill per outcome.
 *  1. PENDING outcome rows for new candidates;
 *  2. E5 backfill (decision LTP/time, slippage, latency) of filled rows;
 *  3. score due rows (window ended ≥ 2 min ago), retried until 24 h after the window;
 *  4. merge DONE AI outcomes into the SP3 corpus record (`outcome.exitOutcome`);
 *  5. one `[exit-score]` line per user for the previous IST day, from 00:05 IST.
 */
@Injectable()
export class ExitOutcomeService {
  private readonly logger = new Logger(ExitOutcomeService.name);
  private readonly scorecardDone = new Set<string>();
  /** Backfill rows whose decision LTP cannot be known (no packet, no order LTP): not retried every pass. */
  private readonly backfillGaveUp = new Set<string>();
  private running = false;

  constructor(
    private readonly execRepo: AiExitExecutionRepository,
    private readonly outRepo: AiExitOutcomeRepository,
    private readonly prisma: PrismaService,
    @Inject(EXIT_OUTCOME_CANDLES) private readonly candles: Pick<CandleRepo, 'read'>,
    private readonly moduleRef: ModuleRef,
    @Inject(AI_EXIT_SESSION_CLOCK) private readonly clock: Pick<SessionClock, 'tradingWindow'>,
    @Inject(EXIT_DISCIPLINE_CONFIG) private readonly cfg: ExitDisciplineConfig,
    @Inject(EXIT_OUTCOME_USERS) private readonly userIds: string[],
  ) {}

  async runOnce(now: Date = new Date()): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      await this.step('create', () => this.createPending(now));
      await this.step('backfill', () => this.backfillQuality(now));
      await this.step('score', () => this.scoreDue(now));
      await this.step('corpus', () => this.writeCorpus(now));
      await this.step('scorecard', () => this.logScorecards(now));
    } finally {
      this.running = false;
    }
  }

  private async step(name: string, fn: () => Promise<void>): Promise<void> {
    try {
      await fn();
    } catch (err) {
      this.logger.warn(`[exit-outcome] ${name} step failed: ${errText(err)}`);
    }
  }

  private async packetFacts(verdictId: string): Promise<PacketFacts | null> {
    if (!isPlainAi(verdictId)) return null;
    const row = await this.prisma.sentinelVerdict.findUnique({ where: { id: verdictId }, select: { packet: true } });
    const f = row ? readPacketFacts(row.packet) : null;
    return f && !('unreadable' in f) ? f : null;
  }

  /** When the decision was made: the AI verdict packet's build time, else the row's creation. */
  private decisionAtOf(c: { createdAt: Date }, p: PacketFacts | null): Date {
    const t = p?.builtAt ? Date.parse(p.builtAt) : NaN;
    return Number.isFinite(t) ? new Date(t) : c.createdAt;
  }

  private closeOf(exchange: string, at: Date): Date | null {
    const w = this.clock.tradingWindow(exchange, at);
    if (!w) return null;
    const midnight = Date.parse(`${istDate(at)}T00:00:00Z`) - IST_OFFSET_MS;
    return new Date(midnight + w.closeMin * MIN);
  }

  // 1 ───────────────────────────────────────────────────────────────────────
  private async createPending(now: Date): Promise<void> {
    const rows = await this.execRepo.scoringCandidates(now, new Date(now.getTime() - CANDIDATE_LOOKBACK_MS), this.cfg.outcomeWindowMin);
    for (const c of rows) {
      try {
        const p = await this.packetFacts(c.verdictId);
        const kind = kindOf(c);
        if (!kind) continue;
        const side: PositionSide | null = c.side === 'SELL' ? 'LONG' : c.side === 'BUY' ? 'SHORT' : p?.side ?? null;
        const qty = (isPlainAi(c.verdictId) ? posNum(p?.qty) : null) ?? posNum(c.quantity) ?? posNum(p?.qty);
        const decisionPrice = kind === 'EXECUTED'
          ? posNum(c.fillPrice) ?? posNum(c.orderLtp) ?? posNum(p?.ltp)
          : posNum(c.orderLtp) ?? posNum(c.decisionLtp) ?? posNum(p?.ltp);
        if (!side || qty === null || decisionPrice === null || !c.exchange || !c.token) {
          this.logger.debug?.(`[exit-outcome] ${c.symbol} ${c.id}: side/qty/price unknown — not scored`);
          continue;
        }
        const decisionAt = this.decisionAtOf(c, p);
        await this.outRepo.createPending({
          executionId: c.id, userId: c.userId, verdictId: c.verdictId, trackerId: c.trackerId,
          symbol: c.symbol, exchange: c.exchange, token: c.token,
          kind, positionSide: side, qty, decisionPrice, decisionAt,
          windowEnd: outcomeWindowEnd(decisionAt, this.cfg.outcomeWindowMin, this.closeOf(c.exchange, decisionAt)),
          status: 'PENDING',
        });
      } catch (err) {
        this.logger.warn(`[exit-outcome] ${c.symbol} ${c.id}: could not create the outcome row: ${errText(err)}`);
      }
    }
  }

  // 2 ───────────────────────────────────────────────────────────────────────
  private async backfillQuality(now: Date): Promise<void> {
    const rows = await this.execRepo.qualityBackfillCandidates(new Date(now.getTime() - CANDIDATE_LOOKBACK_MS));
    for (const r of rows) {
      if (this.backfillGaveUp.has(r.id) || r.fillPrice === null) continue;
      const p = await this.packetFacts(r.verdictId);
      const decisionLtp = p ? posNum(p.ltp) : posNum(r.orderLtp);
      const decisionAt = p ? this.decisionAtOf(r, p) : r.createdAt;
      if (decisionLtp === null) {
        this.backfillGaveUp.add(r.id);
        continue;
      }
      await this.execRepo.update(r.id, {
        decisionLtp, decisionAt,
        slippage: r.fillPrice - decisionLtp,
        latencyMs: r.fillAt ? r.fillAt.getTime() - decisionAt.getTime() : null,
      });
    }
  }

  // 3 ───────────────────────────────────────────────────────────────────────
  private hub(): HubCandleSource | null {
    try {
      return this.moduleRef.get<HubCandleSource>(HUB_CANDLE_SOURCE, { strict: false }) ?? null;
    } catch {
      return null;
    }
  }

  private async scoreDue(now: Date): Promise<void> {
    const due = await this.outRepo.due(now, DUE_PER_PASS);
    for (const o of due) {
      try {
        await this.scoreOne(o, now);
      } catch (err) {
        this.logger.warn(`[exit-outcome] ${o.symbol} ${o.id}: scoring failed: ${errText(err)}`);
      }
    }
  }

  private async scoreOne(o: AiExitOutcome, now: Date): Promise<void> {
    const ref: InstrumentRef = { exchange: o.exchange as HubExchange, token: o.token, symbol: o.symbol };
    const side = o.positionSide as PositionSide;
    const compute = (bars: MinuteBar[]) => computeExitOutcome({
      positionSide: side, qty: o.qty, decisionPrice: o.decisionPrice, decisionAt: o.decisionAt, windowEnd: o.windowEnd, bars,
    });

    const dbBars = (await this.candles.read('1m', ref, o.decisionAt.getTime(), o.windowEnd.getTime())).map(toBar);
    if (isWindowCovered(dbBars, o.decisionAt, o.windowEnd)) {
      const v = compute(dbBars);
      if (v) return this.done(o, v, 'candles_1m', null, now);
    }

    let hubBars: MinuteBar[] = [];
    const hub = this.hub();
    if (hub?.servesCharts()) {
      try {
        hubBars = (await hub.candles(ref, '1m', o.decisionAt, o.windowEnd)).candles.map(toBar);
      } catch (err) {
        this.logger.debug?.(`[exit-outcome] ${o.symbol}: hub fill failed: ${errText(err)}`);
      }
      if (isWindowCovered(hubBars, o.decisionAt, o.windowEnd)) {
        const v = compute(hubBars);
        if (v) return this.done(o, v, 'hub-fill', null, now);
      }
    }

    if (now.getTime() > o.windowEnd.getTime() + RETRY_UNTIL_MS) {
      // Last chance: whatever bars exist (the DB's win a tie with the hub's).
      const byTs = new Map<number, MinuteBar>();
      for (const b of hubBars) byTs.set(b.ts, b);
      for (const b of dbBars) byTs.set(b.ts, b);
      const v = compute([...byTs.values()]);
      if (v) return this.done(o, v, hubBars.length > 0 && dbBars.length < v.barsUsed ? 'hub-fill' : 'candles_1m', 'partial', now);
      await this.outRepo.markNoData(o.id, `no 1m bars for ${o.exchange}:${o.token} in the window`, now);
      this.logger.warn(`[exit-outcome] ${o.symbol} ${o.kind} NO_DATA — no 1m bars after ${o.decisionAt.toISOString()}`);
      return;
    }
    await this.outRepo.markRetry(o.id, `window not covered (db ${dbBars.length} bars, hub ${hubBars.length})`);
  }

  private async done(o: AiExitOutcome, v: ExitOutcomeValues, source: string, note: string | null, now: Date): Promise<void> {
    await this.outRepo.markDone(o.id, v, source, note, now);
    this.logger.log(`[exit-outcome] ${o.symbol} ${o.kind} missed=${rupees(v.missedPnl)} saved=${rupees(v.savedPnl)} net=${rupees(v.netAtEnd)} (${source})`);
  }

  // 4 ───────────────────────────────────────────────────────────────────────
  private async writeCorpus(now: Date): Promise<void> {
    const rows = await this.outRepo.corpusPending(new Date(now.getTime() - CORPUS_LOOKBACK_MS));
    for (const o of rows) {
      if (!isPlainAi(o.verdictId)) continue; // manual and price-trigger decisions are not AI verdicts (plan M4)
      const exitOutcome = {
        executionId: o.executionId, kind: o.kind, positionSide: o.positionSide, qty: o.qty,
        decisionPrice: o.decisionPrice, decisionAt: o.decisionAt, windowEnd: o.windowEnd,
        maxAfter: o.maxAfter, minAfter: o.minAfter, closeAt15: o.closeAt15, closeAt30: o.closeAt30, closeAt60: o.closeAt60,
        closeAtEnd: o.closeAtEnd, missedPnl: o.missedPnl, savedPnl: o.savedPnl, netAtEnd: o.netAtEnd,
        dataSource: o.dataSource, note: o.note,
      };
      // The importer's upsert keeps an existing outcome (COALESCE), so a record imported later is caught by a retry.
      const n = await this.prisma.$executeRaw(Prisma.sql`
        UPDATE "ai_decision_records"
        SET "outcome" = COALESCE("outcome", '{}'::jsonb) || jsonb_build_object('exitOutcome', ${JSON.stringify(exitOutcome)}::jsonb),
            "outcomeAt" = ${now}
        WHERE "source" = 'sentinel' AND "decision"->>'verdictId' = ${o.verdictId}`);
      if (n >= 1) await this.outRepo.markCorpus(o.id, now);
    }
  }

  // 5 ───────────────────────────────────────────────────────────────────────
  private async logScorecards(now: Date): Promise<void> {
    const istMinutes = Math.floor(((now.getTime() + IST_OFFSET_MS) % 86_400_000) / MIN);
    if (istMinutes < SCORECARD_AFTER_MIN) return;
    const day = istDate(new Date(now.getTime() - 86_400_000));
    for (const userId of this.userIds) {
      const key = `${userId}|${day}`;
      if (this.scorecardDone.has(key)) continue;
      const rows = await this.outRepo.forDay(userId, day);
      const s = scorecard(day, rows.map((r) => ({
        kind: r.kind as OutcomeKind, missedPnl: r.missedPnl ?? 0, savedPnl: r.savedPnl ?? 0, netAtEnd: r.netAtEnd ?? 0,
      })));
      this.logger.log(scorecardLine(s));
      this.scorecardDone.add(key);
    }
    if (this.scorecardDone.size > 1_000) this.scorecardDone.clear();
  }
}

/** R10. Null for a row the candidate query should not have returned. */
function kindOf(c: Pick<ScoringCandidate, 'status' | 'reason'>): OutcomeKind | null {
  if (c.status === 'FILLED' || c.status === 'PLACED') return 'EXECUTED';
  if (c.status === 'DRY_RUN') return 'DRY_RUN';
  if (c.status === 'SKIPPED' && c.reason === 'GATED_THESIS_INTACT') return 'GATED';
  if (c.status === 'SKIPPED' && c.reason === 'AWAITING_CONFIRMATION') return 'AWAITING';
  return null;
}
