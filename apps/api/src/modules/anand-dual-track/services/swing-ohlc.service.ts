import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { AnandDualTrackRepository } from '../repositories/anand-dual-track.repository';
import { AngelOneAdapterService } from '../../market-data/services/angel-one-adapter.service';

/** Max post-exit trading days recorded per closed swing trade (Angel only returns trading days). */
const MAX_POST_EXIT_ROWS = 60;
const ONE_DAY_MS = 24 * 60 * 60 * 1000;

interface SwingEntryForOhlc {
  id: string;
  token: string | null;
  symbol: string;
  enteredAt: Date;
  exitedAt: Date | null;
  status: string;
}

/**
 * Records the underlying stock's DAILY OHLC, day by day, for every swing trade:
 * across its holding period (entry → exit) and up to 60 post-exit trading days.
 *
 * Daily candles come from `AngelOneAdapterService.getHistoricalData(token, 'NSE',
 * 'ONE_DAY', from, to)` — already TTL-cached and serially paced for the 3 req/sec
 * historical limit. Entries are processed serially; a single throttled/empty fetch
 * is logged and skipped (filled in on a later run), never crashing the run.
 */
@Injectable()
export class SwingOhlcService implements OnModuleInit {
  private readonly logger = new Logger(SwingOhlcService.name);

  constructor(
    private readonly repo: AnandDualTrackRepository,
    private readonly adapter: AngelOneAdapterService,
  ) {}

  // Backfill existing trades immediately on boot (fire-and-forget) so the
  // feature has data without waiting for the first EOD run.
  onModuleInit(): void {
    this.runForAllInWindow().catch((err) =>
      this.logger.error(`[swing-ohlc] boot backfill failed: ${err instanceof Error ? err.message : err}`),
    );
  }

  // End-of-day run at 16:00 IST, after the 15:30 NSE close, Mon–Fri.
  @Cron('0 0 16 * * 1-5', { timeZone: 'Asia/Kolkata' })
  async runEndOfDay(): Promise<void> {
    await this.runForAllInWindow();
  }

  /**
   * Backfill one entry: fetch daily candles from the day after the last recorded
   * date (or entry day) through today, upserting each. Stops storing further
   * POST_EXIT rows once the entry already has 60.
   */
  async backfillEntry(entry: SwingEntryForOhlc): Promise<number> {
    if (!entry.token) return 0;

    const last = await this.repo.latestSwingOhlcDate(entry.id);
    // First backfill: floor to the START of the entry day (IST). Angel timestamps
    // a daily candle at the session open (00:00 IST); a raw intraday `enteredAt`
    // (e.g. 10:21 IST) would exclude the entry-day candle itself.
    const from = last
      ? new Date(last.getTime() + ONE_DAY_MS)
      : this.tradingDay(entry.enteredAt);
    const to = new Date();
    if (from > to) return 0;

    const candles = await this.adapter.getHistoricalData(entry.token, 'NSE', 'ONE_DAY', from, to);
    if (!Array.isArray(candles) || candles.length === 0) return 0;

    let postExitCount = await this.repo.countSwingPostExitRows(entry.id);
    let upserted = 0;

    for (const c of candles) {
      const candleDate = this.tradingDay(new Date(c.timestamp));
      const phase = entry.exitedAt && candleDate > entry.exitedAt ? 'POST_EXIT' : 'HOLD';

      // Cap post-exit history at 60 trading days; once reached, stop recording.
      if (phase === 'POST_EXIT' && postExitCount >= MAX_POST_EXIT_ROWS) break;

      await this.repo.upsertSwingDailyOhlc(
        entry.id,
        candleDate,
        { open: Number(c.open), high: Number(c.high), low: Number(c.low), close: Number(c.close) },
        phase,
      );
      if (phase === 'POST_EXIT') postExitCount++;
      upserted++;
    }
    return upserted;
  }

  /**
   * Backfill every in-window swing entry, SERIALLY (the historical API is rate-
   * limited to ~3 req/sec). "In window" = status is TRADED (still open) OR the
   * trade has fewer than 60 POST_EXIT rows recorded. Each entry is wrapped in
   * try/catch so one failure (throttle/empty) is skipped, never crashing the run.
   */
  async runForAllInWindow(): Promise<void> {
    const entries = (await this.repo.listAllSwingEntries()) as SwingEntryForOhlc[];

    let processed = 0;
    let totalUpserted = 0;
    for (const entry of entries) {
      try {
        const inWindow =
          entry.status === 'TRADED' ||
          (await this.repo.countSwingPostExitRows(entry.id)) < MAX_POST_EXIT_ROWS;
        if (!inWindow) continue;

        const upserted = await this.backfillEntry(entry);
        processed++;
        totalUpserted += upserted;
      } catch (err) {
        this.logger.warn(
          `[swing-ohlc] ${entry.id} (${entry.symbol}) skipped: ${err instanceof Error ? err.message : err}`,
        );
      }
    }
    this.logger.log(`[swing-ohlc] backfill complete — ${processed} entries processed, ${totalUpserted} rows upserted`);
  }

  /** Normalize a candle timestamp to IST midnight of its trading day (stable upsert key). */
  private tradingDay(d: Date): Date {
    const istOffsetMs = 5.5 * 60 * 60 * 1000;
    const ist = new Date(d.getTime() + istOffsetMs);
    ist.setUTCHours(0, 0, 0, 0);
    return new Date(ist.getTime() - istOffsetMs);
  }
}
