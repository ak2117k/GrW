import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { CronLeaseService } from '../../../common/cron-lease/cron-lease.service';
import { BOOT_JOBS_DISABLED, bootJobsEnabled } from '../../../common/utils/boot-jobs';
import type { SessionClock } from '../../market-hub/session-clock';
import { SignalIntakeService } from './signal-intake.service';
import { SIGNAL_CLOCK, SignalOutcomeService } from './signal-outcome.service';

/** Outcomes after the NSE close and the trade-setup replay (16:15), before the 18:45 self-review run. */
export const SIGNAL_OUTCOME_CRON = '0 20 16 * * 1-5';
/** Busy-slot LLM parses are retried while fresh. */
export const SIGNAL_LLM_RETRY_CRON = '30 */3 * * * *';
const LEASE_TTL_MS = 30 * 60_000;

@Injectable()
export class SignalIntakeCron {
  private readonly logger = new Logger(SignalIntakeCron.name);

  constructor(
    private readonly intake: SignalIntakeService,
    private readonly outcomes: SignalOutcomeService,
    @Inject(SIGNAL_CLOCK) private readonly clock: SessionClock,
    @Optional() private readonly lease?: CronLeaseService,
  ) {}

  @Cron(SIGNAL_OUTCOME_CRON, { name: 'signal-intake-outcomes', timeZone: 'Asia/Kolkata' })
  async onOutcomes(): Promise<void> {
    if (!this.clock.isTradingDay('NSE', new Date())) return;
    try {
      if (!bootJobsEnabled()) return void this.logger.log(BOOT_JOBS_DISABLED);
      const job = () => this.outcomes.fillOutcomes();
      if (this.lease) await this.lease.runExclusiveFailClosed('signal-intake-outcomes', LEASE_TTL_MS, job);
      else await job();
    } catch (e) {
      this.logger.warn(`[signal-intake] outcomes failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  @Cron(SIGNAL_LLM_RETRY_CRON, { name: 'signal-intake-llm-retry', timeZone: 'Asia/Kolkata' })
  async onRetry(): Promise<void> {
    try {
      await this.intake.retryPending();
    } catch (e) {
      this.logger.warn(`[signal-intake] LLM retry failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
}
