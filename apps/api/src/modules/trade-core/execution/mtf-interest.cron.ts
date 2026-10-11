import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { JobRunnerService } from '../../../common/job-registry';
import { istDate } from './ledger-math';
import { PaperLedgerService } from './paper-ledger.service';

/** Job name in job_runs (M5 adds it to health-detail EXPECTED_JOBS with its reconciliation). */
export const MTF_INTEREST_JOB = 'core-mtf-interest';
/** Well above a run (one short transaction per holding), well under a day. */
const MTF_INTEREST_LEASE_MS = 30 * 60 * 1000;

/**
 * Spec §4.4: MTF interest at 15:35 IST, before M5's 15:45 reconciliation. Monday to
 * Friday; calendar days are posted, so the weekend is caught up on Monday. Leased and
 * recorded through the job runner; 'run-anyway' on a Redis outage is safe because the
 * posting is idempotent.
 */
@Injectable()
export class MtfInterestCron {
  private readonly logger = new Logger(MtfInterestCron.name);

  constructor(
    private readonly ledger: PaperLedgerService,
    private readonly jobs: JobRunnerService,
  ) {}

  @Cron('0 35 15 * * 1-5', { name: MTF_INTEREST_JOB, timeZone: 'Asia/Kolkata' })
  async nightly(): Promise<void> {
    await this.run(new Date());
  }

  async run(now: Date): Promise<void> {
    const day = istDate(now);
    try {
      await this.jobs.run(MTF_INTEREST_JOB, { ttlMs: MTF_INTEREST_LEASE_MS, onRedisError: 'run-anyway' }, async () => {
        const r = await this.ledger.postMtfInterest(day);
        this.logger.log(`MTF interest ${day}: ${r.holdings} open holding(s), ${r.posted} day row(s) posted`);
        return r;
      });
    } catch (err) {
      this.logger.error(`MTF interest ${day} failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}
