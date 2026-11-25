import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { CronLeaseService } from '../../../common/cron-lease/cron-lease.service';
import { BOOT_JOBS_DISABLED, bootJobsEnabled } from '../../../common/utils/boot-jobs';
import { istYmd } from '../../mbm/domain/chain-snapshot';
import { buildGrade, familyOf, gateTotals, gradeSummaryLine, type ExchangeFamily, type SetupGrade } from '../domain/setup-grade';
import type { Bar15m } from '../domain/setup-watch';
import { AiSetupsRepository, type GradeCandidateRow } from '../repositories/ai-setups.repository';
import { SETUP_WATCH_MARKET, type SetupWatchMarket } from './setup-watch.service';

/** 18:40 IST: NSE / BSE setups of the session (validUntil ≤ 15:15). */
export const SETUP_GRADE_NSE_CRON = '40 18 * * 1-5';
/** 23:45 IST: MCX setups of the session (validUntil ≤ 23:00). */
export const SETUP_GRADE_MCX_CRON = '45 23 * * 1-5';
export const AI_SETUP_GRADE_CLOCK = Symbol('AI_SETUP_GRADE_CLOCK');
export const AI_SETUP_GRADE_NOW = Symbol('AI_SETUP_GRADE_NOW');
const LEASE_TTL_MS = 30 * 60_000;
/** Rows created this far back are (re)tried: 5 sessions of retries + weekends / holidays. */
const LOOKBACK_MS = 14 * 86_400_000;
const DAY_MS = 86_400_000;

export type SetupGradeStore = Pick<AiSetupsRepository, 'gradeCandidates' | 'writeGrade' | 'gradeTrade' | 'gradedSetupGrades'>;
export type SetupGradeMarket = Pick<SetupWatchMarket, 'underlyingRef' | 'bars15m'>;
export interface TradingDayClock {
  isTradingDay(exchange: string, at?: Date): boolean;
}

const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));
/** IST midnight starting the IST day of `at`. */
const istDayStart = (at: Date) => new Date(`${istYmd(at)}T00:00:00+05:30`);

/**
 * Nightly grading of AI setups and NO_TRADE decisions (plan 2026-11-25 Task 6; rules in domain/setup-grade.ts).
 * Two crons — NSE rows at 18:40, MCX rows at 23:45 IST — on that exchange's trading days, under a fail-closed
 * lease, whatever AI_SETUPS is (rows made while it was on still get graded). Each run reads the ungraded / pending
 * rows of the last 14 days, the underlying's 15m bars (the setup watch's loader, once per underlying per session
 * day), the paper trade, and writes `grade` with a conditional update (unchanged since read). One summary line per
 * run, with the running totals toward the live gate.
 */
@Injectable()
export class SetupGradeCron {
  private readonly logger = new Logger(SetupGradeCron.name);

  constructor(
    @Inject(AiSetupsRepository) private readonly store: SetupGradeStore,
    @Inject(SETUP_WATCH_MARKET) private readonly market: SetupGradeMarket,
    @Inject(AI_SETUP_GRADE_CLOCK) private readonly clock: TradingDayClock,
    @Optional() private readonly lease?: CronLeaseService,
    @Optional() @Inject(AI_SETUP_GRADE_NOW) private readonly nowFn?: () => Date,
  ) {}

  @Cron(SETUP_GRADE_NSE_CRON, { name: 'ai-setup-grade-nse', timeZone: 'Asia/Kolkata' })
  async onNse(): Promise<void> {
    await this.nightJob('NSE');
  }

  @Cron(SETUP_GRADE_MCX_CRON, { name: 'ai-setup-grade-mcx', timeZone: 'Asia/Kolkata' })
  async onMcx(): Promise<void> {
    await this.nightJob('MCX');
  }

  private async nightJob(family: ExchangeFamily): Promise<void> {
    const now = this.nowFn ? this.nowFn() : new Date();
    try {
      if (!this.clock.isTradingDay(family, now)) return;
      if (!bootJobsEnabled()) return void this.logger.log(BOOT_JOBS_DISABLED);
      const job = () => this.grade(family, now);
      if (this.lease) await this.lease.runExclusiveFailClosed(`ai-setup-grade-${family}`, LEASE_TTL_MS, job);
      else await job();
    } catch (e) {
      this.logger.warn(`[ai-setup-grade] ${family} run failed: ${errText(e)}`);
    }
  }

  /** One grading pass over `family`'s rows. Returns the grades written. */
  async grade(family: ExchangeFamily, now: Date): Promise<SetupGrade[]> {
    const session = istYmd(now);
    const rows = (await this.store.gradeCandidates(new Date(now.getTime() - LOOKBACK_MS), now)).filter((r) => familyOf(r) === family);
    const bars = new Map<string, Promise<{ bars: Bar15m[] | null; error: string | null }>>();
    const written: Array<{ prev: unknown; grade: SetupGrade }> = [];
    for (const row of rows) {
      try {
        const key = `${row.underlying}|${istYmd(row.createdAt)}`;
        if (!bars.has(key)) bars.set(key, this.barsFor(row, now));
        const b = await bars.get(key)!;
        const trade = row.tradeId ? await this.store.gradeTrade(row.tradeId) : null;
        const grade = buildGrade({ row, trade, bars: b.bars, barsError: b.error, now, session });
        if (!grade) continue;
        if (await this.store.writeGrade(row.id, row.updatedAt, grade)) written.push({ prev: row.grade, grade });
        else this.logger.warn(`[ai-setup-grade] ${row.underlying} ${row.id}: row changed while grading — retried next run`);
      } catch (e) {
        this.logger.warn(`[ai-setup-grade] ${row.underlying} ${row.id}: ${errText(e)}`);
      }
    }
    const totals = gateTotals(await this.store.gradedSetupGrades());
    this.logger.log(gradeSummaryLine(family, written, totals));
    return written.map((w) => w.grade);
  }

  /** The underlying's 15m bars over the row's IST session day (closed bars only are used by the replay). */
  private async barsFor(row: GradeCandidateRow, now: Date): Promise<{ bars: Bar15m[] | null; error: string | null }> {
    try {
      const ref = await this.market.underlyingRef(row.underlying, row.createdAt);
      if (!ref) return { bars: null, error: `no priced line for ${row.underlying} in the instrument master` };
      const from = istDayStart(row.createdAt);
      const to = new Date(Math.min(now.getTime(), from.getTime() + DAY_MS));
      return { bars: await this.market.bars15m(ref, from, to), error: null };
    } catch (e) {
      return { bars: null, error: errText(e) };
    }
  }
}
