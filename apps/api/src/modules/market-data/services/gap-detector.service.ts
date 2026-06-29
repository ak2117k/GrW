import { Injectable, Logger, OnModuleInit, Optional } from '@nestjs/common';
import { PrismaService } from '../../../common/prisma/prisma.service';
import { AngelOneAdapterService } from './angel-one-adapter.service';
import { MarketDataRepository } from '../repositories/market-data.repository';
import { LevelBookService } from '../../signal-generator/services/level-book.service';

/**
 * If the most-recent daily candle for a tracked instrument is older than
 * this many days, the gap-detector triggers a backfill. 2 days is the
 * sweet spot:
 *   - Sat/Sun boots with last candle from Friday → ~1-2 days old → SKIP.
 *   - Mon morning boot, last candle from Friday → ~3 days old → FIRE.
 *   - Multi-day downtime → fires reliably.
 *   - Expiry-induced multi-week gaps → fires reliably.
 */
const GAP_THRESHOLD_DAYS = 2;

/** How many days back to fetch when filling a gap. 7 covers any normal week. */
const BACKFILL_DAYS = 7;

/** How long after onModuleInit to run the scan — defers off the boot critical path. */
const BOOT_DEFER_MS = 10_000;

export interface GapCheckResult {
  symbol: string;
  exchange: string;
  token: string;
  status: 'OK' | 'BACKFILLED' | 'NO_DATA' | 'ERROR' | 'DRY_RUN_GAP';
  latestCandleTs?: string;       // ISO date of most-recent 1d candle in DB before backfill
  ageDays?: number;              // age of most-recent candle in days
  backfilledRows?: number;       // rows persisted by the gap-fill
  levelBookInvalidated?: boolean;
  error?: string;
}

/**
 * Boot-time + on-demand gap detector for daily candles.
 *
 * Common failure mode this addresses: the API was offline at 23:35 IST
 * (when the daily-backfill cron normally runs), the cron didn't fire,
 * and the next morning the chart shows yesterday's PDH/PDL pinned to
 * day-before-yesterday's candle. Same pattern hits on long downtimes,
 * machine restarts, and expiry-induced data drops.
 *
 * Scan logic:
 *   1. For every instrument that has at least one daily candle in our DB
 *      (i.e. one we actively track), find the most-recent timestamp.
 *   2. If `now - latestTs > GAP_THRESHOLD_DAYS`, that instrument has a
 *      suspicious gap — backfill the last BACKFILL_DAYS of daily candles
 *      via the auto-chunked broker fetch and invalidate the level book.
 *   3. Skip silently if current — most boot scans should be no-ops.
 *
 * Runs once at boot (deferred BOOT_DEFER_MS so the API is responsive
 * before the broker calls start). Also exposed via
 * POST /api/market-data/gap-check/trigger for ops.
 *
 * NOT a replacement for the daily-backfill cron — that's still the
 * primary path during normal operation. This service is the safety net
 * that catches the cron's own failures.
 */
@Injectable()
export class GapDetectorService implements OnModuleInit {
  private readonly logger = new Logger(GapDetectorService.name);
  private bootScanScheduled = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly adapter: AngelOneAdapterService,
    private readonly repository: MarketDataRepository,
    @Optional() private readonly levelBookService: LevelBookService | null,
  ) {}

  onModuleInit(): void {
    if (this.bootScanScheduled) return;
    this.bootScanScheduled = true;

    // Defer the scan so the API binds + accepts requests immediately.
    // Broker calls happen in the background; per-instrument gaps are
    // rare so the wall-time impact on a typical boot is < 1 second.
    setTimeout(() => {
      this.scanAndBackfill().catch((err) => {
        this.logger.error(
          `Boot-time gap scan failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      });
    }, BOOT_DEFER_MS);
  }

  /**
   * Iterate every instrument that has daily-candle history in our DB.
   * For each, check whether the most-recent candle is older than the
   * gap threshold; if so, fetch the last BACKFILL_DAYS of daily candles
   * and upsert.
   *
   * @param opts.dryRun  detect gaps but make no broker calls and write
   *                     nothing. Returns DRY_RUN_GAP statuses for any
   *                     instrument that would have been backfilled.
   */
  async scanAndBackfill(opts: { dryRun?: boolean } = {}): Promise<GapCheckResult[]> {
    const dryRun = !!opts.dryRun;
    const startedAt = Date.now();

    // Find every instrument with at least one daily candle, plus its
    // most-recent timestamp. groupBy on the candle table is cheap on
    // TimescaleDB even with millions of rows because it uses the
    // (instrumentId, timeframe, timestamp) index.
    const groups = await this.prisma.candle.groupBy({
      by: ['instrumentId'],
      where: { timeframe: '1d' },
      _max: { timestamp: true },
    });

    if (groups.length === 0) {
      this.logger.log('Gap scan: no daily-candle history in DB — nothing to check');
      return [];
    }

    // Pull the instrument metadata in one round-trip.
    const instrumentIds = groups.map((g) => g.instrumentId);
    const instruments = await this.prisma.instrument.findMany({
      where: { id: { in: instrumentIds }, isActive: true },
      select: { id: true, symbol: true, token: true, exchange: true },
    });
    const instrumentById = new Map(instruments.map((i) => [i.id, i]));

    const now = Date.now();
    const thresholdMs = GAP_THRESHOLD_DAYS * 24 * 60 * 60 * 1000;

    // First pass — classify each tracked instrument.
    type ToBackfill = { id: string; symbol: string; token: string; exchange: string; latestTs: Date; ageDays: number };
    const okResults: GapCheckResult[] = [];
    const toBackfill: ToBackfill[] = [];

    for (const g of groups) {
      const inst = instrumentById.get(g.instrumentId);
      if (!inst) continue; // instrument deleted/deactivated — skip
      const latestTs = g._max.timestamp;
      if (!latestTs) {
        okResults.push({
          symbol: inst.symbol,
          exchange: inst.exchange,
          token: inst.token,
          status: 'NO_DATA',
        });
        continue;
      }
      const ageMs = now - latestTs.getTime();
      const ageDays = ageMs / (24 * 60 * 60 * 1000);
      if (ageMs <= thresholdMs) {
        okResults.push({
          symbol: inst.symbol,
          exchange: inst.exchange,
          token: inst.token,
          status: 'OK',
          latestCandleTs: latestTs.toISOString().slice(0, 10),
          ageDays: Math.round(ageDays * 10) / 10,
        });
        continue;
      }
      toBackfill.push({
        id: inst.id,
        symbol: inst.symbol,
        token: inst.token,
        exchange: inst.exchange,
        latestTs,
        ageDays,
      });
    }

    if (toBackfill.length === 0) {
      this.logger.log(
        `Gap scan: ${okResults.length} instruments checked, all current ` +
        `(${((Date.now() - startedAt) / 1000).toFixed(1)}s)`,
      );
      return okResults;
    }

    this.logger.log(
      `Gap scan: ${toBackfill.length}/${groups.length} instruments have stale daily candles ` +
      `(threshold=${GAP_THRESHOLD_DAYS}d) — ${dryRun ? 'DRY RUN, no fetch' : 'starting backfill'}`,
    );

    // Second pass — fetch + upsert sequentially. Sequential because
    // Angel One historical is rate-limited (3 req/sec) and parallel
    // fetches would hit the same throttle.
    const filledResults: GapCheckResult[] = [];
    for (const inst of toBackfill) {
      if (dryRun) {
        filledResults.push({
          symbol: inst.symbol,
          exchange: inst.exchange,
          token: inst.token,
          status: 'DRY_RUN_GAP',
          latestCandleTs: inst.latestTs.toISOString().slice(0, 10),
          ageDays: Math.round(inst.ageDays * 10) / 10,
        });
        continue;
      }
      filledResults.push(await this.backfillOne(inst));
    }

    const totalBackfilled = filledResults
      .filter((r) => r.status === 'BACKFILLED')
      .reduce((sum, r) => sum + (r.backfilledRows ?? 0), 0);
    this.logger.log(
      `Gap scan complete: ${filledResults.filter((r) => r.status === 'BACKFILLED').length} ` +
      `instruments backfilled (${totalBackfilled} rows total) in ` +
      `${((Date.now() - startedAt) / 1000).toFixed(1)}s`,
    );

    return [...okResults, ...filledResults];
  }

  private async backfillOne(inst: {
    id: string;
    symbol: string;
    token: string;
    exchange: string;
    latestTs: Date;
    ageDays: number;
  }): Promise<GapCheckResult> {
    try {
      const to = new Date();
      const from = new Date(to.getTime() - BACKFILL_DAYS * 24 * 60 * 60 * 1000);
      const rows = await this.adapter.getHistoricalData(
        inst.token,
        inst.exchange,
        '1d',
        from,
        to,
      );

      let backfilledRows = 0;
      const CHUNK = 50;
      for (let i = 0; i < rows.length; i += CHUNK) {
        const chunk = rows.slice(i, i + CHUNK);
        await Promise.all(
          chunk.map((c: { timestamp: Date | string; open: number; high: number; low: number; close: number; volume: number }) =>
            this.repository.upsertCandle({
              instrumentId: inst.id,
              timeframe: '1d',
              timestamp: new Date(c.timestamp),
              open: Number(c.open),
              high: Number(c.high),
              low: Number(c.low),
              close: Number(c.close),
              volume: Number(c.volume) || 0,
            }),
          ),
        );
        backfilledRows += chunk.length;
      }

      let levelBookInvalidated = false;
      if (this.levelBookService && backfilledRows > 0) {
        levelBookInvalidated = this.levelBookService.invalidate(inst.token);
      }

      return {
        symbol: inst.symbol,
        exchange: inst.exchange,
        token: inst.token,
        status: 'BACKFILLED',
        latestCandleTs: inst.latestTs.toISOString().slice(0, 10),
        ageDays: Math.round(inst.ageDays * 10) / 10,
        backfilledRows,
        levelBookInvalidated,
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.logger.warn(
        `Gap backfill failed for ${inst.symbol} (${inst.exchange}:${inst.token}): ${message}`,
      );
      return {
        symbol: inst.symbol,
        exchange: inst.exchange,
        token: inst.token,
        status: 'ERROR',
        latestCandleTs: inst.latestTs.toISOString().slice(0, 10),
        ageDays: Math.round(inst.ageDays * 10) / 10,
        error: message,
      };
    }
  }
}
