import { Injectable, Logger } from '@nestjs/common';
import { Cron, Interval } from '@nestjs/schedule';
import { MarketFeedService } from '../../market-data/services/market-feed.service';
import { StockMonitorService } from './stock-monitor.service';

/**
 * Drives the target-profit stock monitor (design §4.3).
 *
 * Two cooperating schedules:
 *
 *  1. SUBSCRIBE (cron, ~every 5 min): (re)subscribe every WATCHING token to the
 *     shared market feed so the socket carries their ticks (add() also
 *     subscribes on demand; this backstops restarts / slot rotation). Runs
 *     09:00–15:59 IST, Mon–Fri.
 *
 *  2. SWEEP (interval, ~5 s): read the socket-fed quote cache for each WATCHING
 *     monitor and fold it in, flipping to TARGET_HIT + firing on a hit. Guarded
 *     by market hours so it is idle overnight/weekends.
 *
 * Mirrors the trade-tracker poller: 6-field IST cron for the subscribe job, a
 * guarded interval for the light sweep, and an overlap guard so a slow sweep
 * never stacks.
 */
@Injectable()
export class StockMonitorPoller {
  private readonly logger = new Logger(StockMonitorPoller.name);

  /** Light quote sweep cadence — folds socket quotes into WATCHING monitors. */
  private static readonly SWEEP_MS = 5_000;

  /** Guards against overlapping sweeps (a slow DB cycle). */
  private sweeping = false;

  constructor(
    private readonly feed: MarketFeedService,
    private readonly service: StockMonitorService,
  ) {}

  /**
   * (Re)subscribe every WATCHING token to the feed. Runs at minute
   * 0,5,10,…,55 during 09:00–15:59 IST, Mon–Fri (6-field `sec min hour dom mon dow`).
   */
  @Cron('0 */5 9-15 * * 1-5', { timeZone: 'Asia/Kolkata' })
  async subscribeAll(): Promise<void> {
    const tokens = await this.service.distinctWatchingTokens();
    if (tokens.length === 0) return;
    try {
      await this.feed.subscribe(tokens);
      this.logger.log(`[stock-monitor] subscribed ${tokens.length} token(s)`);
    } catch (err) {
      this.logger.warn(
        `[stock-monitor] feed subscribe failed: ${err instanceof Error ? err.message : err}`,
      );
    }
  }

  /**
   * Sweep the socket quote cache for every WATCHING monitor. Guarded by market
   * hours so it is idle when the market is shut, and by an overlap flag so a
   * slow pass never stacks.
   */
  @Interval(StockMonitorPoller.SWEEP_MS)
  async sweep(): Promise<void> {
    if (!this.feed.isMarketOpen()) return;
    if (this.sweeping) return;
    this.sweeping = true;
    try {
      await this.service.sweep();
    } catch (err) {
      this.logger.warn(
        `[stock-monitor] sweep failed: ${err instanceof Error ? err.message : err}`,
      );
    } finally {
      this.sweeping = false;
    }
  }
}
