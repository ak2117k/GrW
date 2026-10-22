import { Inject, Injectable, Logger, type OnApplicationBootstrap, Optional } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { CronLeaseService } from '../../../common/cron-lease/cron-lease.service';
import { BOOT_JOBS_DISABLED, bootJobsEnabled } from '../../../common/utils/boot-jobs';
import type { SessionClock } from '../../market-hub/session-clock';
import { TRADE_SETUP_CLOCK, TradeSetupService } from './trade-setup.service';

/**
 * Night build 23:50 IST: after the news-ideas NIGHT batch (23:30) and the stock-move scoring (20:15,
 * MBM service), so both inputs exist. Morning rebuild 08:50 IST: after the MORNING news batch (08:40),
 * before the 09:15 open (the plan is replaced, never the outcome).
 */
export const TRADE_SETUPS_NIGHT_CRON = '0 50 23 * * *';
export const TRADE_SETUPS_MORNING_CRON = '0 50 8 * * 1-5';
/** Broker funds snapshot while the owner's session is warm: the "last known" margin for the night. */
export const TRADE_SETUPS_MARGIN_CRON = '0 0 15 * * 1-5';
/** Outcomes after the close, before the 18:45 self-review run. */
export const TRADE_SETUPS_OUTCOME_CRON = '0 15 16 * * 1-5';
const LEASE_TTL_MS = 20 * 60_000;
/** A restart inside the night window re-runs the build after this delay (feeds warm up first). */
export const BOOT_CATCH_UP_DELAY_MS = 120_000;

/**
 * True between the night build (23:50 IST) and the morning rebuild (08:50 IST): a process that boots
 * then (a deploy at 23:51 skipped the 2026-10-22 night build) must build itself. build() is an upsert
 * of the plan, so a second run is harmless.
 */
export function inNightWindow(now: Date): boolean {
  const ist = new Date(now.getTime() + 330 * 60_000);
  const min = ist.getUTCHours() * 60 + ist.getUTCMinutes();
  return min >= 23 * 60 + 50 || min < 8 * 60 + 50;
}

@Injectable()
export class TradeSetupCron implements OnApplicationBootstrap {
  private readonly logger = new Logger(TradeSetupCron.name);

  constructor(
    private readonly setups: TradeSetupService,
    @Inject(TRADE_SETUP_CLOCK) private readonly clock: SessionClock,
    @Optional() private readonly lease?: CronLeaseService,
  ) {}

  onApplicationBootstrap(): void {
    if (!inNightWindow(new Date())) return;
    const t = setTimeout(() => {
      this.logger.log('[trade-setups] boot inside the night window: catch-up build');
      void this.fire('trade-setups-build', () => this.setups.build());
    }, BOOT_CATCH_UP_DELAY_MS);
    t.unref?.();
  }

  @Cron(TRADE_SETUPS_NIGHT_CRON, { name: 'trade-setups-night', timeZone: 'Asia/Kolkata' })
  onNight(): Promise<void> {
    return this.fire('trade-setups-build', () => this.setups.build());
  }

  @Cron(TRADE_SETUPS_MORNING_CRON, { name: 'trade-setups-morning', timeZone: 'Asia/Kolkata' })
  onMorning(): Promise<void> {
    if (!this.clock.isTradingDay('NSE', new Date())) return Promise.resolve();
    return this.fire('trade-setups-build', () => this.setups.build());
  }

  @Cron(TRADE_SETUPS_MARGIN_CRON, { name: 'trade-setups-margin', timeZone: 'Asia/Kolkata' })
  onMargin(): Promise<void> {
    if (!this.clock.isTradingDay('NSE', new Date())) return Promise.resolve();
    return this.fire('trade-setups-margin', () => this.setups.snapshotMargin());
  }

  @Cron(TRADE_SETUPS_OUTCOME_CRON, { name: 'trade-setups-outcomes', timeZone: 'Asia/Kolkata' })
  onOutcomes(): Promise<void> {
    if (!this.clock.isTradingDay('NSE', new Date())) return Promise.resolve();
    return this.fire('trade-setups-outcomes', () => this.setups.fillOutcomes());
  }

  /** Never throws (scheduler context); one instance at a time via the cron lease. */
  private async fire(name: string, job: () => Promise<unknown>): Promise<void> {
    try {
      if (!bootJobsEnabled()) return void this.logger.log(BOOT_JOBS_DISABLED);
      if (this.lease) await this.lease.runExclusiveFailClosed(name, LEASE_TTL_MS, job);
      else await job();
    } catch (e) {
      this.logger.warn(`[trade-setups] ${name} failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
}
