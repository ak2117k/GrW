import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { CronLeaseService } from '../../../common/cron-lease/cron-lease.service';
import { BOOT_JOBS_DISABLED, bootJobsEnabled } from '../../../common/utils/boot-jobs';
import type { SessionClock } from '../../market-hub/session-clock';
import { istMidnightOf, reviewDay } from '../../night-report/domain/night-report.logic';
import { SELF_REVIEW_CLOCK } from '../services/self-review-run.service';
import { AutoApplyService } from './auto-apply.service';

/** 01:15 IST, Tue-Sat: after the 00:30 self-review run (its lease is 30 min) has proposed and graded the session. */
export const AUTO_APPLY_CRON = '0 15 1 * * 2-6';
const LEASE_TTL_MS = 15 * 60_000;

@Injectable()
export class AutoApplyCron {
  private readonly logger = new Logger(AutoApplyCron.name);

  constructor(
    private readonly svc: AutoApplyService,
    @Inject(SELF_REVIEW_CLOCK) private readonly clock: SessionClock,
    @Optional() private readonly lease?: CronLeaseService,
  ) {}

  @Cron(AUTO_APPLY_CRON, { name: 'self-review-auto-apply', timeZone: 'Asia/Kolkata' })
  onNight(): Promise<void> {
    return this.fire();
  }

  /** Never throws (scheduler context). NSE trading days only. */
  async fire(now: Date = new Date()): Promise<void> {
    try {
      if (!bootJobsEnabled()) return void this.logger.log(BOOT_JOBS_DISABLED);
      if (!this.svc.isEnabled()) return void this.logger.log('[auto-apply] SELF_REVIEW_AUTO_APPLY=off — pending proposals wait for the owner');
      if (!this.clock.isTradingDay('NSE', istMidnightOf(reviewDay(now)))) return;
      const job = () => this.svc.run(now);
      const out = this.lease ? await this.lease.runExclusiveFailClosed('self-review-auto-apply', LEASE_TTL_MS, job) : await job();
      if (out) this.logger.log(`[auto-apply] applied ${out.applied.length}, rolled back ${out.rolledBack.length}, blocked ${out.blocked.length}${out.error ? `, error: ${out.error}` : ''}`);
    } catch (e) {
      this.logger.warn(`[auto-apply] cron failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
}
