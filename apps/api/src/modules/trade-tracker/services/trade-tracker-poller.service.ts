import { Injectable, Logger } from '@nestjs/common';
import { Cron, Interval } from '@nestjs/schedule';
import { PrismaService } from '../../../common/prisma/prisma.service';
import { MarketFeedService } from '../../market-data/services/market-feed.service';
import { TradeTrackerService } from './trade-tracker.service';

/**
 * Drives the per-trade tracker (design §4.2 / §4.3).
 *
 * Two cooperating schedules, both gated to Indian market hours:
 *
 *  1. RECONCILE (cron, ~every 10 min): for every user with a stored broker
 *     credential, take a one-login ephemeral snapshot of their book and
 *     reconcile it, then subscribe every OPEN tracker's token to the shared
 *     market feed so the socket carries their ticks.
 *
 *  2. SWEEP (interval, ~4 s): read the socket-fed quote cache
 *     (`MarketFeedService.getQuote`) for each distinct OPEN token and fold it in
 *     via `applyTick` (itself debounced). This is the "real prices from the
 *     socket" path without coupling to the raw WS event loop.
 *
 * Follows the existing poller patterns (`ungated-tick-poller`,
 * `watch-backstop-poller`): 6-field IST cron for the heavy job, a guarded
 * interval for the light sweep, and per-user try/catch so one user's broker
 * failure never aborts the batch.
 */
@Injectable()
export class TradeTrackerPoller {
  private readonly logger = new Logger(TradeTrackerPoller.name);

  /** Light quote sweep cadence — folds socket quotes into open trackers. */
  private static readonly SWEEP_MS = 4_000;

  /** Guards against overlapping reconcile passes (a slow broker cycle). */
  private reconciling = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly feed: MarketFeedService,
    private readonly service: TradeTrackerService,
  ) {}

  /**
   * Reconcile every credentialed user's book, then (re)subscribe all OPEN
   * tokens to the feed. Runs at minute 0,10,20,30,40,50 during 09:00–15:59 IST,
   * Mon–Fri (6-field `sec min hour dom mon dow`).
   */
  @Cron('0 */10 9-15 * * 1-5', { timeZone: 'Asia/Kolkata' })
  async reconcileAll(): Promise<void> {
    if (this.reconciling) {
      this.logger.debug('[trade-tracker] reconcile already in progress — skipping');
      return;
    }
    this.reconciling = true;
    try {
      const users = await this.prisma.brokerCredential.findMany({
        select: { userId: true },
      });
      if (users.length === 0) return;

      let ok = 0;
      let failed = 0;
      for (const { userId } of users) {
        try {
          await this.service.backfill(userId);
          ok++;
        } catch (err) {
          failed++;
          this.logger.warn(
            `[trade-tracker] reconcile failed for a user: ${err instanceof Error ? err.message : err}`,
          );
        }
      }

      // Subscribe every OPEN token so the shared socket carries their ticks.
      const tokens = await this.service.distinctOpenTokens();
      if (tokens.length > 0) {
        try {
          await this.feed.subscribe(tokens);
        } catch (err) {
          this.logger.warn(
            `[trade-tracker] feed subscribe failed: ${err instanceof Error ? err.message : err}`,
          );
        }
      }

      this.logger.log(
        `[trade-tracker] reconciled ${ok}/${users.length} user(s) (failed=${failed}), tracking ${tokens.length} token(s)`,
      );
    } finally {
      this.reconciling = false;
    }
  }

  /**
   * Read the socket-fed quote for each distinct OPEN token and apply it. Guarded
   * by market hours so it is idle overnight/weekends. `applyTick` debounces the
   * DB writes internally, so this can run frequently and cheaply.
   */
  @Interval(TradeTrackerPoller.SWEEP_MS)
  async sweepQuotes(): Promise<void> {
    if (!this.feed.isMarketOpen()) return;

    const tokens = await this.service.distinctOpenTokens();
    if (tokens.length === 0) return;

    for (const token of tokens) {
      const quote = this.feed.getQuote(token);
      if (quote && quote.ltp > 0) {
        this.service.applyTick(token, quote.ltp);
      }
    }
  }
}
