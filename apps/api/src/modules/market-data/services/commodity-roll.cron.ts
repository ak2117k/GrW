import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { CommodityRollService } from './commodity-roll.service';

/**
 * Daily cron — checks tracked MCX commodities for front-month rollover and
 * rolls atomically when a contract has expired.
 *
 * Schedule: 08:30 IST Mon-Sat. MCX opens at 09:00 IST so this gives the
 * roll + post-roll backfill 30 minutes to settle before live ticks resume.
 * Saturdays included because MCX has a half-session, and contracts can
 * expire on a Saturday too (typically 19th-20th of the expiry month).
 */
@Injectable()
export class CommodityRollCron {
  private readonly logger = new Logger(CommodityRollCron.name);

  constructor(private readonly rollService: CommodityRollService) {}

  @Cron('0 30 8 * * 1-6', { timeZone: 'Asia/Kolkata' })
  async dailyRollCheck(): Promise<void> {
    this.logger.log('Running scheduled commodity roll check (08:30 IST)');
    try {
      const results = await this.rollService.runRoll();
      const rolled = results.filter((r) => r.status === 'ROLLED');
      const errored = results.filter((r) => r.status === 'ERROR');
      if (rolled.length > 0) {
        this.logger.log(
          `Scheduled roll: ${rolled.length} commodity/ies rolled — ${rolled
            .map((r) => `${r.symbol}(${r.oldToken}→${r.newToken})`)
            .join(', ')}`,
        );
      }
      if (errored.length > 0) {
        this.logger.warn(
          `Scheduled roll: ${errored.length} commodity/ies errored — ${errored
            .map((r) => `${r.symbol}(${r.error})`)
            .join('; ')}`,
        );
      }
    } catch (err) {
      this.logger.error(
        `Scheduled commodity roll failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
}
