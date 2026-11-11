import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { CronLeaseService } from '../../../common/cron-lease/cron-lease.service';
import { BOOT_JOBS_DISABLED, bootJobsEnabled } from '../../../common/utils/boot-jobs';
import type { SessionClock } from '../../market-hub/session-clock';
import { isReviewDay, reviewDay } from '../../night-report/domain/night-report.logic';
import { SELF_REVIEW_CLOCK, SelfReviewRunService } from './self-review-run.service';

/**
 * 00:30 IST, Tue-Sat: the night after each session. By then MCX has closed (23:30, or 23:55 while the US
 * is off DST), the scorecard outcomes are in (18:30) and so are the daily bars (23:45). The date has
 * rolled over at this hour, so the trading-day gate asks about {@link reviewDay}, not today.
 * The gate is NSE OR MCX ({@link isReviewDay}): an NSE holiday with an MCX evening session is reviewed
 * (2026-11-10 was skipped silently while real and paper MCX trades had run). Every skip logs its reason.
 * The 09:00 IST catch-up re-verifies the last 3 sessions for anything filled later.
 */
export const SELF_REVIEW_CRON = '0 30 0 * * 2-6';
export const SELF_REVIEW_CATCHUP_CRON = '0 0 9 * * 1-5';
/** 02:30 IST, Tue-Sat: the stock book with every F&O close lands around 01:56, so the missed-move review reruns after it. */
export const SELF_REVIEW_MISSED_MOVES_CRON = '0 30 2 * * 2-6';
const LEASE_TTL_MS = 30 * 60_000;

@Injectable()
export class SelfReviewCron {
  private readonly logger = new Logger(SelfReviewCron.name);

  constructor(
    private readonly runner: SelfReviewRunService,
    @Inject(SELF_REVIEW_CLOCK) private readonly clock: SessionClock,
    @Optional() private readonly lease?: CronLeaseService,
  ) {}

  @Cron(SELF_REVIEW_CRON, { name: 'self-review', timeZone: 'Asia/Kolkata' })
  onNight(): Promise<void> {
    return this.fire('cron');
  }

  @Cron(SELF_REVIEW_MISSED_MOVES_CRON, { name: 'self-review-missed-moves', timeZone: 'Asia/Kolkata' })
  onMissedMoves(now: Date = new Date()): Promise<void> {
    return this.fire('missed-moves', now);
  }

  @Cron(SELF_REVIEW_CATCHUP_CRON, { name: 'self-review-catchup', timeZone: 'Asia/Kolkata' })
  onCatchUp(): Promise<void> {
    return this.fire('catch-up');
  }

  /** Never throws (scheduler context). Days NSE or MCX traded; a skip always logs one line with the reason. */
  async fire(trigger: string, now: Date = new Date()): Promise<void> {
    try {
      if (!bootJobsEnabled()) return void this.logger.log(BOOT_JOBS_DISABLED);
      const day = reviewDay(now);
      if (!isReviewDay(day, this.clock)) return void this.logger.log(`[self-review] ${trigger} skipped: ${day} not a trading day on NSE or MCX`);
      const job = () => this.runner.run(now, trigger);
      const out = this.lease ? await this.lease.runExclusiveFailClosed('self-review', LEASE_TTL_MS, job) : await job();
      if (out && !out.started) this.logger.log(`[self-review] ${trigger} skipped: ${out.reason}`);
    } catch (e) {
      this.logger.warn(`[self-review] ${trigger} failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
}
