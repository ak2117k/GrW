import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { BOOT_JOBS_DISABLED, bootJobsEnabled } from '../../../common/utils/boot-jobs';
import { inputsHealthEnabled, InputsHealthService } from './inputs-health.service';

const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));

/**
 * Every 15 min, every day: the service itself skips when no venue is open (night, weekend, holiday),
 * so the MCX evening and the NSE day are both covered by one schedule. Off with BOOT_JOBS=false or
 * INPUTS_HEALTH=off.
 */
@Injectable()
export class InputsHealthCron {
  private readonly logger = new Logger(InputsHealthCron.name);
  private busy = false;
  private saidOff = false;

  constructor(private readonly health: InputsHealthService) {}

  @Cron('0 */15 * * * *', { name: 'inputs-health', timeZone: 'Asia/Kolkata' })
  async tick(): Promise<void> {
    if (!bootJobsEnabled()) return void this.logger.log(BOOT_JOBS_DISABLED);
    if (!inputsHealthEnabled()) {
      if (!this.saidOff) this.logger.log('[inputs-health] INPUTS_HEALTH=off — inputs health check not running');
      this.saidOff = true;
      return;
    }
    if (this.busy) return;
    this.busy = true;
    try {
      await this.health.run(new Date());
    } catch (err) {
      this.logger.warn(`[inputs-health] run failed: ${errText(err)}`);
    } finally {
      this.busy = false;
    }
  }
}
