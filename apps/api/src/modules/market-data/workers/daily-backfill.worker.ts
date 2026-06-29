import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { PrismaService } from '../../../common/prisma/prisma.service';
import { AngelOneAdapterService } from '../services/angel-one-adapter.service';
import { MarketDataRepository } from '../repositories/market-data.repository';

interface BackfillTarget {
  symbol: string;
  /**
   * Optional. NSE indices have stable tokens (NIFTY = 99926000 forever) so
   * we can hardcode them. MCX commodities roll monthly — leave token absent
   * and the worker will look up whatever the current token is in the DB,
   * which the commodity-roll cron keeps updated.
   */
  token?: string;
  exchange: string;
  timeframes: string[];
}

/**
 * NSE-listed indices we backfill at 15:35 IST (5 min after equity close).
 * Mirrors the symbol set used by scripts/backfill-candles.mjs.
 */
const NSE_TARGETS: BackfillTarget[] = [
  { symbol: 'NIFTY', token: '99926000', exchange: 'NSE', timeframes: ['1d', '1h', '15m', '5m'] },
  { symbol: 'BANKNIFTY', token: '99926009', exchange: 'NSE', timeframes: ['1d', '1h', '15m', '5m'] },
];

/**
 * MCX commodities we backfill at 23:35 IST (5 min after MCX session close).
 * MCX trades 09:00–23:30 IST, so the equity-close cron at 15:35 misses the
 * full evening session — these need their own slot. Tokens are NOT
 * hardcoded because MCX FUTCOM contracts roll every month; the
 * commodity-roll cron keeps the instrument table's token up-to-date and
 * this worker looks it up by (symbol, exchange) at run time.
 */
const MCX_TARGETS: BackfillTarget[] = [
  { symbol: 'CRUDEOIL', exchange: 'MCX', timeframes: ['1d', '1h', '15m', '5m'] },
  { symbol: 'COPPER',   exchange: 'MCX', timeframes: ['1d', '1h', '15m', '5m'] },
];

/** Stay comfortably under Angel One's documented 1 req/sec historical-API cap. */
const RATE_LIMIT_MS = 1200;

/**
 * Daily incremental backfill of candle history from Angel One.
 *
 * WHY: live ticks → CandleAggregator → DB only persists candles while the
 * api process is up AND the market is open. Any downtime (overnight, restart,
 * server crash, weekend) leaves a gap. This worker fires at 15:35 IST every
 * weekday — five minutes after market close, so the day's last 15-min bar has
 * been sealed — and asks the broker's historical API for everything from
 * `MAX(timestamp) in DB` to `now`. Idempotent via skipDuplicates, so re-runs
 * are safe.
 *
 * Operationally this is the missing piece between "tick stream is live" and
 * "DB always has a complete history." Paired with the boot-time catch-up
 * (`onModuleInit` → `backfillUniverseAtBoot`) it covers both steady-state
 * incremental fills and the "API was offline at 15:35 / 23:35 IST" hole.
 */
@Injectable()
export class DailyBackfillWorker implements OnModuleInit {
  private readonly logger = new Logger(DailyBackfillWorker.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly adapter: AngelOneAdapterService,
    private readonly repo: MarketDataRepository,
  ) {}

  /**
   * Boot-time catch-up runner. Fire-and-forget on purpose: the universe
   * pass takes ~19s (rate-limited broker calls + per-target sleeps) and we
   * don't want to block API readiness behind it. The cron at 15:35 / 23:35
   * IST handles the steady-state case; this hook only matters when the API
   * was offline at those windows. `backfillOne` itself is a no-op when the
   * latest candle for an (instrument, timeframe) is already current, so the
   * cost in the common case is just the inter-target sleeps.
   */
  async onModuleInit(): Promise<void> {
    this.backfillUniverseAtBoot().catch((err) => {
      this.logger.warn(
        `Boot-time candle backfill failed: ${err instanceof Error ? err.message : err}`,
      );
    });
  }

  /**
   * 15:35 IST, Mon-Fri — equity close + 5min buffer so the broker has
   * finalised the day's last bar. Backfills NSE indices only.
   */
  @Cron('0 35 15 * * 1-5', { timeZone: 'Asia/Kolkata' })
  async runEquityBackfill(): Promise<void> {
    await this.runBackfill('NSE equity', NSE_TARGETS);
  }

  /**
   * 23:35 IST, Mon-Fri — MCX close (23:30) + 5min buffer. Backfills MCX
   * commodities; without this, the 15:35 cron would miss the entire
   * 15:30–23:30 evening session and commodity gaps would accumulate
   * every weekday.
   */
  @Cron('0 35 23 * * 1-5', { timeZone: 'Asia/Kolkata' })
  async runCommodityBackfill(): Promise<void> {
    await this.runBackfill('MCX commodity', MCX_TARGETS);
  }

  /**
   * Boot-time catch-up for the WHOLE universe (NSE indices + MCX
   * commodities) across all configured timeframes. Closes the
   * "API was offline at 15:35 / 23:35 IST" hole that leaves yesterday's
   * candles missing — without it, LevelBookCron.seedSession reads a
   * stale latest-daily and the chart's analyze() endpoint reads a
   * stale intraday window (analyze uses `take: 25` which skips the
   * repo's gap-fill, so missing data is silently surfaced as
   * "got 0 candles" until tomorrow's cron firing).
   *
   * Worst-case boot delay: (NSE_TARGETS.length + MCX_TARGETS.length) ×
   * timeframes per target × 1.2s rate-limit ≈ 16 × 1.2s = ~19s when
   * everything needs filling. When the table is already current,
   * `backfillOne` skips the broker call but the loop still sleeps —
   * acceptable for a once-per-process boot cost in exchange for
   * correctness across the universe + all timeframes the analyze
   * endpoint reads (1d / 1h / 15m / 5m).
   */
  async backfillUniverseAtBoot(): Promise<void> {
    await this.runBackfill('NSE+MCX universe (boot)', [
      ...NSE_TARGETS,
      ...MCX_TARGETS,
    ]);
  }

  private async runBackfill(label: string, targets: BackfillTarget[]): Promise<void> {
    this.logger.log(`${label} candle backfill starting (${targets.length} symbols)`);
    const startedAt = Date.now();
    let totalInserted = 0;
    let totalFailed = 0;

    for (const target of targets) {
      // Stable tokens (NSE indices) match by token+exchange. Roll-prone
      // tokens (MCX commodities) match by symbol+exchange and pick up the
      // current token from the DB row — populated by the roll cron.
      const where = target.token
        ? { token: target.token, exchange: target.exchange }
        : { symbol: target.symbol, exchange: target.exchange };
      const instrument = await this.prisma.instrument.findFirst({
        where,
        select: { id: true, token: true },
      });
      if (!instrument) {
        this.logger.warn(
          `No instrument row for ${target.symbol}/${target.exchange}; skipping`,
        );
        continue;
      }

      // Use the DB-resolved token for the broker call (matters for MCX
      // where target.token was intentionally absent).
      const resolvedTarget = { ...target, token: instrument.token };

      for (const tf of target.timeframes) {
        try {
          const inserted = await this.backfillOne(resolvedTarget, instrument.id, tf);
          totalInserted += inserted;
        } catch (err) {
          totalFailed += 1;
          this.logger.error(
            `${target.symbol}/${tf} failed: ${err instanceof Error ? err.message : err}`,
          );
        }
        await this.sleep(RATE_LIMIT_MS);
      }
    }

    const elapsedSec = ((Date.now() - startedAt) / 1000).toFixed(1);
    this.logger.log(
      `${label} candle backfill complete in ${elapsedSec}s — inserted=${totalInserted} failed=${totalFailed}`,
    );
  }

  /**
   * For one (instrument, timeframe), fetch from `MAX(timestamp)` to now.
   * If the table has nothing yet, fall back to the past 7 days; deeper
   * history is the job of the one-shot backfill script, not the cron.
   */
  private async backfillOne(
    target: BackfillTarget,
    instrumentId: string,
    timeframe: string,
  ): Promise<number> {
    if (!target.token) {
      // runBackfill resolves token from DB before calling this — only path
      // here without one is a misconfigured target row.
      throw new Error(`backfillOne: ${target.symbol}/${target.exchange} has no token`);
    }
    const last = await this.prisma.candle.findFirst({
      where: { instrumentId, timeframe },
      orderBy: { timestamp: 'desc' },
      select: { timestamp: true },
    });

    const from = last?.timestamp ?? new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
    const to = new Date();

    // Skip the broker call if we're already current (saves a rate-limit slot).
    if (to.getTime() - from.getTime() < 60 * 1000) {
      this.logger.log(`${target.symbol}/${timeframe}: already current (last=${from.toISOString()})`);
      return 0;
    }

    const rows = await this.adapter.getHistoricalData(
      target.token,
      target.exchange,
      timeframe,
      from,
      to,
    );

    if (rows.length === 0) {
      this.logger.log(`${target.symbol}/${timeframe}: broker returned no rows`);
      return 0;
    }

    const saved = await this.repo.saveCandles(
      rows.map((c) => ({
        instrumentId,
        timeframe,
        timestamp: c.timestamp,
        open: c.open,
        high: c.high,
        low: c.low,
        close: c.close,
        volume: c.volume,
      })),
    );

    this.logger.log(
      `${target.symbol}/${timeframe}: fetched=${rows.length} inserted=${saved} (from=${from.toISOString()})`,
    );
    return saved;
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
