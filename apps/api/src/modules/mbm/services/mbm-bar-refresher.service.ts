// apps/api/src/modules/mbm/services/mbm-bar-refresher.service.ts
import { Inject, Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import { runInBootLane } from '../../../common/utils/boot-lane';
import { Cron } from '@nestjs/schedule';
import { UserFeedManager } from '../../market-data/services/user-feed-manager.service';
import { BOOT_JOBS_DISABLED, bootJobsEnabled } from '../../../common/utils/boot-jobs';
import { MBM_CONFIG, mbmBootLine, type MbmConfig } from '../mbm.config';
import { universeFor, type MbmSeries } from '../mbm-universe';
import { MbmBarsRepository } from '../repositories/mbm-bars.repository';
import { catchUpFloor, completedBars, fetchFrom, isRefreshTick, tickFloor, type NseCalendar } from '../domain/bar-window';

export const MBM_CALENDAR = Symbol('MBM_CALENDAR');
export const MBM_NOW = Symbol('MBM_NOW');

const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));
/** Retry passes for series the throttle rejected; 3 s then 6 s keeps a pass well inside the 25 s before the :45 MBM run. */
const MAX_RETRIES = 2;
const RETRY_DELAY_MS = 3_000;

export interface RefreshSummary {
  ran: boolean;
  stored: number;
  failed: string[];
}

/**
 * Keeps mbm_bars_1m current with BROKER 1m bars (plan §4) for the MBM service to read. Uses ONLY the
 * owner's own Angel session through UserFeedManager (no second login; per-user historical pacing
 * applies). Serial, one series at a time; a failed series is logged and picked up next tick. Never throws.
 */
@Injectable()
export class MbmBarRefresherService implements OnModuleInit {
  private readonly logger = new Logger(MbmBarRefresherService.name);
  private readonly series: MbmSeries[];
  private running = false;

  constructor(
    @Inject(MBM_CONFIG) private readonly config: MbmConfig,
    @Inject(MBM_CALENDAR) private readonly calendar: NseCalendar,
    @Inject(MBM_NOW) private readonly now: () => Date,
    private readonly feeds: UserFeedManager,
    private readonly bars: MbmBarsRepository,
  ) {
    const { series, unknown } = universeFor(config.instruments);
    this.series = series;
    for (const p of config.problems) this.logger.warn(`[mbm] ${p}`);
    if (unknown.length) this.logger.warn(`[mbm] no bar universe for ${unknown.join(',')} — skipped`);
  }

  private get active(): boolean {
    return this.config.mode !== 'off' && !!this.config.feedUserId && this.series.length > 0;
  }

  onModuleInit(): void {
    this.logger.log(mbmBootLine(this.config));
    if (!this.active) return;
    if (!bootJobsEnabled()) {
      this.logger.log(`[mbm] ${BOOT_JOBS_DISABLED}`);
      return;
    }
    // Not awaited: a 3-session catch-up of 11 series must never delay the port bind.
    void runInBootLane('mbm-bar-catch-up', 20, () => this.catchUp());
  }

  /** Every 5 min at second 20, Mon–Fri; the 09:15–15:35 IST window and holidays are checked inside. */
  @Cron('20 */5 9-15 * * 1-5', { name: 'mbm-bar-refresh', timeZone: 'Asia/Kolkata' })
  async onTick(): Promise<RefreshSummary> {
    if (!this.active) return { ran: false, stored: 0, failed: [] };
    const now = this.now();
    if (!isRefreshTick(this.calendar, now)) return { ran: false, stored: 0, failed: [] };
    const floor = tickFloor(this.calendar, now);
    if (!floor) return { ran: false, stored: 0, failed: [] };
    return this.refresh(floor, now);
  }

  /** Boot catch-up: the last 3 sessions (today included once open). Holidays/weekends simply look further back. */
  async catchUp(): Promise<RefreshSummary> {
    if (!this.active) return { ran: false, stored: 0, failed: [] };
    const now = this.now();
    const floor = catchUpFloor(this.calendar, now);
    if (!floor) return { ran: false, stored: 0, failed: [] };
    const summary = await this.refresh(floor, now);
    if (summary.ran) {
      this.logger.log(
        `[mbm] boot catch-up from ${floor.toISOString()}: ${summary.stored} bars` +
          (summary.failed.length ? `, failed: ${summary.failed.join(',')}` : ''),
      );
    }
    return summary;
  }

  private async refresh(floor: Date, now: Date): Promise<RefreshSummary> {
    if (this.running) return { ran: false, stored: 0, failed: [] }; // previous pass still pacing through
    this.running = true;
    let stored = 0;
    let failed: string[] = [];
    try {
      let pending = this.series;
      // Angel's historical throttle rejects whole bursts (data:null); without a retry a failed NIFTY
      // left the 5-min prediction stale until the next pass (prod 2026-10-21: half the runs skipped).
      for (let attempt = 0; attempt <= MAX_RETRIES && pending.length > 0; attempt++) {
        if (attempt > 0) await this.pause(RETRY_DELAY_MS * attempt);
        const again: MbmSeries[] = [];
        for (const s of pending) {
          try {
            stored += await this.refreshSeries(s, floor, now);
          } catch (e) {
            again.push(s);
            if (attempt === MAX_RETRIES) {
              this.logger.warn(`[mbm] ${s.series} (${s.exchange}:${s.token}) refresh failed: ${errText(e)}`);
            }
          }
        }
        pending = again;
      }
      failed = pending.map((s) => s.series);
    } finally {
      this.running = false;
    }
    return { ran: true, stored, failed };
  }

  /** Overridable in specs. */
  protected pause(ms: number): Promise<void> {
    return new Promise((r) => setTimeout(r, ms));
  }

  private async refreshSeries(s: MbmSeries, floor: Date, now: Date): Promise<number> {
    const from = fetchFrom(await this.bars.lastTs(s.series), floor);
    if (from.getTime() >= now.getTime()) return 0;
    const candles = await this.feeds.fetchCandleWindow(
      this.config.feedUserId as string,
      { token: s.token, exchange: s.exchange },
      'ONE_MINUTE',
      from,
      now,
    );
    return this.bars.upsert(s.series, completedBars(candles ?? [], from, now));
  }
}
