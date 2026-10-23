// apps/api/src/modules/mbm/services/mbm-tick-bars.service.ts
import { Inject, Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import type { TickData } from '../../../common/interfaces/broker-adapter.interface';
import { UserFeedManager } from '../../market-data/services/user-feed-manager.service';
import { MBM_CONFIG, type MbmConfig } from '../mbm.config';
import { MBM_UNIVERSE, type MbmSeries } from '../mbm-universe';
import { MbmBarsRepository } from '../repositories/mbm-bars.repository';
import { TickBarBuilder, type TickBar } from '../domain/tick-bars';
import { MBM_NOW } from './mbm-bar-refresher.service';

/** The index series built from ticks: the instrument, its VIX driver and BANKNIFTY (no stock tokens). */
export const TICK_BAR_SERIES = ['NIFTY', 'INDIAVIX', 'BANKNIFTY'] as const;
/** A tick whose exchange timestamp is further than this from our clock is bucketed by receive time. */
export const MAX_CLOCK_SKEW_MS = 5_000;

const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));
const key = (exchange: string | undefined, token: string) => `${String(exchange ?? 'NSE').toUpperCase()}:${token}`;

/**
 * Live-feed fallback for mbm_bars_1m (MBM_TICK_BARS, default `listen`): listens to the OWNER's existing
 * socket through UserFeedManager and writes complete 1m bars for NIFTY / INDIAVIX / BANKNIFTY ONLY where
 * no bar exists yet (`source='tick'`); the broker's historical bar stays the source of truth and
 * overwrites them on the next refresh.
 *
 * `listen` adds NO subscription: bars are built only while those index tokens are already on the owner's
 * socket (the market hub / an open chart / watchlist). `pin` also pins the three index tokens on the
 * owner's session every refresh tick (3 slots; idempotent) — opt in only after checking the slot
 * headroom on the owner's socket. `off` disables it. Inert while MBM_ENABLED=off or without a feed user.
 */
@Injectable()
export class MbmTickBarsService implements OnModuleInit {
  private readonly logger = new Logger(MbmTickBarsService.name);
  private readonly byToken = new Map<string, MbmSeries>();
  private readonly builder: TickBarBuilder;
  private written = 0;
  private lastReportMinute = -1;

  constructor(
    @Inject(MBM_CONFIG) private readonly config: MbmConfig,
    @Inject(MBM_NOW) private readonly now: () => Date,
    private readonly feeds: UserFeedManager,
    private readonly bars: MbmBarsRepository,
  ) {
    const wanted = new Set<string>(TICK_BAR_SERIES);
    for (const inst of config.instruments) {
      for (const s of MBM_UNIVERSE[inst] ?? []) if (wanted.has(s.series)) this.byToken.set(key(s.exchange, s.token), s);
    }
    this.builder = new TickBarBuilder([...new Set([...this.byToken.values()].map((s) => s.series))]);
  }

  get mode(): 'off' | 'listen' | 'pin' {
    return this.config.tickBars ?? 'listen';
  }

  private get active(): boolean {
    return this.config.mode !== 'off' && !!this.config.feedUserId && this.byToken.size > 0 && this.mode !== 'off';
  }

  onModuleInit(): void {
    if (!this.active) return;
    const owner = this.config.feedUserId as string;
    this.feeds.addTickListener((userId, tick) => {
      if (userId === owner) this.onTick(tick);
    });
    this.feeds.addStateListener((userId, state) => {
      if (userId === owner && state !== 'live') this.builder.reset();
    });
    this.logger.log(`[mbm] tick bars ${this.mode}: ${[...this.byToken.values()].map((s) => s.series).join(',')}`);
  }

  /** `pin` mode: keep the index tokens on the owner's socket during the session (same cadence as the refresher). */
  @Cron('10 */5 9-15 * * 1-5', { name: 'mbm-tick-bars-pin', timeZone: 'Asia/Kolkata' })
  async ensurePinned(): Promise<void> {
    if (!this.active || this.mode !== 'pin') return;
    try {
      await this.feeds.pin(this.config.feedUserId as string, [...this.byToken.values()].map((s) => ({ token: s.token, exchange: s.exchange })));
    } catch (e) {
      this.logger.warn(`[mbm] tick bars pin failed: ${errText(e)}`);
    }
  }

  /** Public for specs. Never throws: a bad tick or a failed write must not touch the feed. */
  onTick(tick: TickData): void {
    try {
      const s = this.byToken.get(key(tick.exchange, String(tick.token)));
      const nowMs = this.now().getTime();
      const exch = tick.timestamp instanceof Date ? tick.timestamp.getTime() : NaN;
      const at = Number.isFinite(exch) && Math.abs(exch - nowMs) <= MAX_CLOCK_SKEW_MS ? exch : nowMs;
      const done = this.builder.onTick(s?.series ?? null, Number(tick.ltp), at);
      if (done.length) void this.write(done);
    } catch (e) {
      this.logger.debug(`[mbm] tick bar skipped: ${errText(e)}`);
    }
  }

  private async write(done: TickBar[]): Promise<void> {
    for (const { series, bar } of done) {
      try {
        this.written += await this.bars.insertTickBars(series, [bar]);
      } catch (e) {
        this.logger.warn(`[mbm] tick bar ${series} ${bar.timestamp.toISOString()} not stored: ${errText(e)}`);
      }
    }
    // One line per 5 minutes when tick bars actually filled holes (0 = historical was already there).
    const m = Math.floor(this.now().getTime() / 300_000);
    if (m !== this.lastReportMinute && this.written > 0) {
      this.logger.log(`[mbm] tick bars filled ${this.written} missing 1m bar(s) since the last report`);
      this.written = 0;
      this.lastReportMinute = m;
    }
  }
}
