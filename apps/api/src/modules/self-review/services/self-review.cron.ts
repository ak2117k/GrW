import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { CronLeaseService } from '../../../common/cron-lease/cron-lease.service';
import { BOOT_JOBS_DISABLED, bootJobsEnabled } from '../../../common/utils/boot-jobs';
import type { SessionClock } from '../../market-hub/session-clock';
import { SELF_REVIEW_CLOCK, SelfReviewRunService } from './self-review-run.service';

/**
 * 18:45 IST, not the contract's 17:05: analysis_scorecards / news_ideas outcomes are filled by
 * ScorecardService's `scorecard-outcomes` cron at 18:30 IST (ai_exit_outcomes fill within ~60 min of
 * each exit, mbm_predictions within the session), so 17:05 would find S's scorecards still empty.
 * The 09:00 IST catch-up re-verifies the last 3 sessions for anything filled later (the daily-bar
 * backfill runs at 23:45, so a scorecard missing its bar at 18:30 is filled the next evening).
 */
export const SELF_REVIEW_CRON = '0 45 18 * * 1-5';
export const SELF_REVIEW_CATCHUP_CRON = '0 0 9 * * 1-5';
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
  onEvening(): Promise<void> {
    return this.fire('cron');
  }

  @Cron(SELF_REVIEW_CATCHUP_CRON, { name: 'self-review-catchup', timeZone: 'Asia/Kolkata' })
  onCatchUp(): Promise<void> {
    return this.fire('catch-up');
  }

  /** Never throws (scheduler context). NSE trading days only. */
  async fire(trigger: string, now: Date = new Date()): Promise<void> {
    try {
      if (!bootJobsEnabled()) return void this.logger.log(BOOT_JOBS_DISABLED);
      if (!this.clock.isTradingDay('NSE', now)) return;
      const job = () => this.runner.run(now, trigger);
      const out = this.lease ? await this.lease.runExclusiveFailClosed('self-review', LEASE_TTL_MS, job) : await job();
      if (out && !out.started) this.logger.log(`[self-review] ${trigger} skipped: ${out.reason}`);
    } catch (e) {
      this.logger.warn(`[self-review] ${trigger} failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
}
