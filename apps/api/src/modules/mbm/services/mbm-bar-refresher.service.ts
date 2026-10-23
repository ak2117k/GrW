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
/**
 * A regular tick's budget for the LOW-priority series (measured from the tick's start). Ticks are 5 min
 * apart and do not overlap (`running`), so a pass still pacing through the EQ_* series at 4 min would
 * make the next tick — and its NIFTY/INDIAVIX refresh — a no-op. Past the budget they are skipped
 * (picked up next tick from their last stored bar). The boot catch-up has no budget.
 */
export const LOW_PRIORITY_BUDGET_MS = 3.5 * 60_000;

export interface RefreshSummary {
  ran: boolean;
  stored: number;
  failed: string[];
  /** Low-priority series not attempted (or not retried) because the tick ran past its budget. */
  skipped: string[];
}

const NOT_RUN: RefreshSummary = { ran: false, stored: 0, failed: [], skipped: [] };

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
    if (!this.active) return NOT_RUN;
    const now = this.now();
    if (!isRefreshTick(this.calendar, now)) return NOT_RUN;
    const floor = tickFloor(this.calendar, now);
    if (!floor) return NOT_RUN;
    return this.refresh(floor, now);
  }

  /** Boot catch-up: the last 3 sessions (today included once open). Holidays/weekends simply look further back. */
  async catchUp(): Promise<RefreshSummary> {
    if (!this.active) return NOT_RUN;
    const now = this.now();
    const floor = catchUpFloor(this.calendar, now);
    if (!floor) return NOT_RUN;
    const summary = await this.refresh(floor, now, false);
    if (summary.ran) {
      this.logger.log(
        `[mbm] boot catch-up from ${floor.toISOString()}: ${summary.stored} bars` +
          (summary.failed.length ? `, failed: ${summary.failed.join(',')}` : ''),
      );
    }
    return summary;
  }

  /**
   * NIFTY + INDIAVIX first, with their retries complete, then the low-priority series. A regular tick
   * stops starting low-priority fetches once LOW_PRIORITY_BUDGET_MS has elapsed (skipped, not failed).
   * Prod 2026-10-23: one throttled pass left NIFTY 6 minutes behind and 8 runs skipped, two of them
   * during a 180-point spike, while the EQ_* series were still being retried.
   */
  private async refresh(floor: Date, now: Date, budgeted = true): Promise<RefreshSummary> {
    if (this.running) return NOT_RUN; // previous pass still pacing through
    this.running = true;
    const startedMs = this.now().getTime();
    const inBudget = () => !budgeted || this.now().getTime() - startedMs < LOW_PRIORITY_BUDGET_MS;
    try {
      const high = await this.pass(this.series.filter((s) => s.priority), floor, now, () => true);
      const low = await this.pass(this.series.filter((s) => !s.priority), floor, now, inBudget);
      if (low.skipped.length) {
        this.logger.warn(`[mbm] bar refresh over its ${LOW_PRIORITY_BUDGET_MS / 1000}s budget: skipped ${low.skipped.join(',')} (next tick)`);
      }
      return { ran: true, stored: high.stored + low.stored, failed: [...high.failed, ...low.failed], skipped: low.skipped };
    } finally {
      this.running = false;
    }
  }

  /**
   * Serial fetches of `list` with up to MAX_RETRIES retry rounds for the series the throttle rejected
   * (Angel rejects whole bursts with data:null). `mayStart` is asked before every fetch; a series it
   * refuses is skipped (and so are the rest of the round).
   */
  private async pass(
    list: readonly MbmSeries[],
    floor: Date,
    now: Date,
    mayStart: () => boolean,
  ): Promise<{ stored: number; failed: string[]; skipped: string[] }> {
    let stored = 0;
    let pending = [...list];
    const skipped: string[] = [];
    let cut = false;
    for (let attempt = 0; attempt <= MAX_RETRIES && pending.length > 0; attempt++) {
      if (attempt > 0) {
        if (!mayStart()) {
          cut = true;
          break;
        }
        await this.pause(RETRY_DELAY_MS * attempt);
      }
      const again: MbmSeries[] = [];
      for (const s of pending) {
        if (cut || !mayStart()) {
          cut = true;
          skipped.push(s.series);
          continue;
        }
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
      if (cut) break;
    }
    // Failed = still rejected after its last attempt; a series the budget cut before (or between) attempts is skipped.
    return cut
      ? { stored, failed: [], skipped: [...pending.map((s) => s.series), ...skipped] }
      : { stored, failed: pending.map((s) => s.series), skipped: [] };
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
