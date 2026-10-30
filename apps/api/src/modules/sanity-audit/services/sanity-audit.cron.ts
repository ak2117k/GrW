import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { BOOT_JOBS_DISABLED, bootJobsEnabled } from '../../../common/utils/boot-jobs';
import { SanityAuditService } from './sanity-audit.service';

const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** SANITY_AUDIT=off (or false / 0) disables the sweep; default on. */
export function sanityAuditEnabled(env: Record<string, string | undefined> = process.env): boolean {
  const raw = (env.SANITY_AUDIT ?? 'on').trim().toLowerCase();
  return raw !== 'off' && raw !== 'false' && raw !== '0';
}

/** Every 5 min, all day (the night heartbeats need it too). Off with BOOT_JOBS=false or SANITY_AUDIT=off. */
@Injectable()
export class SanityAuditCron {
  private readonly logger = new Logger(SanityAuditCron.name);
  private busy = false;
  private saidOff = false;

  constructor(private readonly audit: SanityAuditService) {}

  @Cron('0 */5 * * * *', { name: 'sanity-audit', timeZone: 'Asia/Kolkata' })
  async tick(): Promise<void> {
    if (!bootJobsEnabled()) return void this.logger.log(BOOT_JOBS_DISABLED);
    if (!sanityAuditEnabled()) {
      if (!this.saidOff) this.logger.log('[sanity] SANITY_AUDIT=off — sanity audit not running');
      this.saidOff = true;
      return;
    }
    if (this.busy) return;
    this.busy = true;
    try {
      await this.audit.run(new Date());
    } catch (err) {
      this.logger.warn(`[sanity] run failed: ${errText(err)}`);
    } finally {
      this.busy = false;
    }
  }
}
