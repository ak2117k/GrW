import { contractValueFactor } from '@td/shared';
import { Inject, Injectable, Logger } from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import { Cron } from '@nestjs/schedule';
import { bootJobsEnabled } from '../../common/utils/boot-jobs';
import type { CandleRepo } from '../market-hub/candles/candle-repository';
import type { HubCandle } from '../market-hub/candles/candle.types';
import { HUB_CANDLE_SOURCE, type HubCandleSource } from '../market-hub/hub-candle-source';
import type { HubExchange, InstrumentRef } from '../market-hub/hub.types';
import { parseCarryConfig } from './domain/carry-config';
import { carryScorecardLine, scoreCarryDecision, type ScoreBar } from './domain/carry-score';
import { IntradayCarryRepository, type CarryDecisionRow } from './repositories/intraday-carry.repository';

/** The candles_1m reader (a PrismaCandleRepo in the module). */
export const CARRY_SCORE_CANDLES = Symbol('CARRY_SCORE_CANDLES');

const MIN = 60_000;
const DAY = 24 * 60 * MIN;
const IST = 330 * MIN;
/** A row with no next-session bars this long after its decision is NO_DATA (expired contract, no feed). */
const GIVE_UP_MS = 4 * DAY;

const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));
const istYmd = (ms: number) => new Date(ms + IST).toISOString().slice(0, 10);
/** 10:15 IST on the IST date `ymd`, epoch ms. */
const at1015 = (ymd: string) => Date.parse(`${ymd}T10:15:00.000Z`) - IST;
const toBar = (c: Pick<HubCandle, 'ts' | 'open' | 'high' | 'low' | 'close'>): ScoreBar =>
  ({ ts: Number(c.ts), open: Number(c.open), high: Number(c.high), low: Number(c.low), close: Number(c.close) });

/**
 * Next-session scoring of every close decision (spec 2026-11-04 §5.4; a prod cron, not a manual run —
 * memory: night jobs are automatic). 10:20 IST on weekdays: each PENDING CARRY / EXIT /
 * CAP_BLOCKED_BROKER_SQUARE_OFF row decided on an earlier day gets its next session's first hour from
 * candles_1m (else one governed hub fill, as ai_exit_outcomes does), scored by carry-score.ts. Then one
 * `[carry-score]` line: "carry calls: n, right k, Δ₹x" (the night report / self-review reads the rows).
 * A cap-blocked row is scored as the EXIT it became (the broker squared it off). Never throws.
 */
@Injectable()
export class IntradayCarryScoreService {
  private readonly logger = new Logger('IntradayCarryScore');
  private running = false;

  constructor(
    private readonly repo: IntradayCarryRepository,
    @Inject(CARRY_SCORE_CANDLES) private readonly candles: Pick<CandleRepo, 'read'>,
    private readonly moduleRef: ModuleRef,
  ) {}

  @Cron('0 20 10 * * 1-5', { timeZone: 'Asia/Kolkata' })
  async scheduled(): Promise<void> {
    if (!bootJobsEnabled() || parseCarryConfig(process.env).mode === 'off') return;
    await this.runOnce();
  }

  async runOnce(now: Date = new Date()): Promise<{ scored: number; line: string }> {
    if (this.running) return { scored: 0, line: '' };
    this.running = true;
    let scored = 0;
    try {
      const dayStart = Date.parse(`${istYmd(now.getTime())}T00:00:00.000Z`) - IST;
      const due = await this.repo.dueForScoring(new Date(dayStart), new Date(now.getTime() - 10 * DAY));
      for (const row of due) {
        try {
          if (await this.scoreOne(row, now)) scored += 1;
        } catch (err) {
          this.logger.warn(`[carry-score] ${row.symbol} ${row.id}: scoring failed: ${errText(err)}`);
        }
      }
      const line = carryScorecardLine(await this.repo.scoredSince(new Date(now.getTime() - DAY)));
      this.logger.log(`[carry-score] ${istYmd(now.getTime())} ${line}`);
      return { scored, line };
    } catch (err) {
      this.logger.error(`[carry-score] pass failed: ${errText(err)}`);
      return { scored, line: '' };
    } finally {
      this.running = false;
    }
  }

  private async scoreOne(row: CarryDecisionRow, now: Date): Promise<boolean> {
    const ref: InstrumentRef = { exchange: row.exchange as HubExchange, token: row.token, symbol: row.symbol };
    const from = row.decidedAt.getTime() + 30 * MIN;
    let bars = (await this.candles.read('1m', ref, from, now.getTime())).map(toBar);
    let source = 'candles_1m';
    let session = firstSessionBars(bars, row.istDay);
    if (session.bars.length === 0) {
      const hub = this.hub();
      if (hub?.servesCharts()) {
        try {
          const r = await hub.candles(ref, '1m', new Date(from), now);
          bars = r.candles.map(toBar);
          session = firstSessionBars(bars, row.istDay);
          source = 'hub-fill';
        } catch (err) {
          this.logger.debug(`[carry-score] ${row.symbol}: hub fill failed: ${errText(err)}`);
        }
      }
    }
    const decision = row.decision === 'CARRY' ? 'CARRY' : 'EXIT';
    const score = session.ymd && row.decisionPrice !== null
      ? scoreCarryDecision({
          decision, side: row.positionSide === 'SHORT' ? 'SHORT' : 'LONG', qty: row.qty,
          valueFactor: contractValueFactor(row.exchange, row.symbol), decisionPrice: row.decisionPrice,
          bars: session.bars, cutoffMs: at1015(session.ymd),
        })
      : null;
    if (!score) {
      if (now.getTime() - row.decidedAt.getTime() > GIVE_UP_MS) {
        await this.repo.update(row.id, { scoreStatus: 'NO_DATA', scoreNote: row.decisionPrice === null ? 'no decision price' : 'no next-session bars', scoredAt: now });
      }
      return false;
    }
    // Only a session whose first hour is over is scored (the cron runs at 10:20; a late fill may be partial).
    if (now.getTime() < at1015(session.ymd as string)) return false;
    await this.repo.update(row.id, {
      scoreStatus: 'DONE', gapPct: score.gapPct, maxAfter: score.maxAfter, minAfter: score.minAfter, priceAt1015: score.priceAt1015,
      pnlCarry: score.pnlCarry, pnlExit: score.pnlExit, scoreVerdict: score.verdict,
      scoreNote: `${source}, ${score.barsUsed} bars, ${decision} edge ₹${Math.round(score.edge)}`, scoredAt: now,
    });
    return true;
  }

  private hub(): HubCandleSource | null {
    try {
      return this.moduleRef.get<HubCandleSource>(HUB_CANDLE_SOURCE, { strict: false }) ?? null;
    } catch {
      return null;
    }
  }
}

/** The bars of the first IST date after `decisionDay` that has any. */
export function firstSessionBars(bars: ScoreBar[], decisionDay: string): { ymd: string | null; bars: ScoreBar[] } {
  const later = bars.filter((b) => istYmd(b.ts) > decisionDay).sort((a, b) => a.ts - b.ts);
  if (later.length === 0) return { ymd: null, bars: [] };
  const ymd = istYmd(later[0].ts);
  return { ymd, bars: later.filter((b) => istYmd(b.ts) === ymd) };
}
