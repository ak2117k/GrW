import { ConflictException, Injectable, Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import type { StockMonitor } from '@prisma/client';
import { PrismaService } from '../../../common/prisma/prisma.service';
import { MarketFeedService } from '../../market-data/services/market-feed.service';
import { MarketDataGateway } from '../../market-data/gateways/market-data.gateway';
import {
  CreateStockMonitorDto,
  StockMonitorDto,
  toStockMonitorDto,
} from '../dto/stock-monitor.dto';

/** Round to 2 decimals, stripping binary-float noise (e.g. 110.00000000000001). */
function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/**
 * Percent move of `ltp` off the reference price: `(ltp - ref) / ref * 100`,
 * rounded to 2 decimals. Guards a zero reference (returns 0) so an
 * unpriced/degenerate seed never yields NaN/Infinity. Pure + exported.
 */
export function computePercent(ref: number, ltp: number): number {
  return ref !== 0 ? round2(((ltp - ref) / ref) * 100) : 0;
}

/**
 * The absolute upside target price: `ref * (1 + pct/100)`, rounded to 2
 * decimals. Pure + exported.
 */
export function computeTargetPrice(ref: number, pct: number): number {
  return round2(ref * (1 + pct / 100));
}

/**
 * Whether a live price has reached (or passed) the upside target. `false` for a
 * null target (reference not yet captured). Pure + exported.
 */
export function isHit(ltp: number, targetPrice: number | null): boolean {
  return targetPrice !== null && ltp >= targetPrice;
}

/**
 * Target-profit stock monitor (design feature 2).
 *
 * Owns the DB lifecycle of `stock_monitors`: a user adds a stock with an upside
 * profit target measured from the price captured at add-time; the poller sweeps
 * live socket quotes, and when a stock reaches its target the monitor flips to
 * `TARGET_HIT` and fires ONCE (a persisted `Alert` row + a best-effort WS
 * `alert` event). Every query is EXPLICITLY scoped by `userId` — `StockMonitor`
 * is not a TDA-003 tenant-auto-scoped model and the poller runs in a cron
 * context with no tenant, so isolation here is this service's own contract.
 */
@Injectable()
export class StockMonitorService {
  private readonly logger = new Logger(StockMonitorService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly feed: MarketFeedService,
    private readonly gateway: MarketDataGateway,
  ) {}

  /**
   * Add a stock to the caller's monitor list. Subscribes the token to the live
   * feed, captures the reference price from the current quote (null if the
   * instrument isn't priced yet — the first sweep sets it), derives the target
   * price when priced, and creates a WATCHING row. The unique [userId, token]
   * constraint rejects a duplicate with a 409.
   */
  async add(userId: string, dto: CreateStockMonitorDto): Promise<StockMonitorDto> {
    const { symbol, exchange, token, targetPercent } = dto;

    // Best-effort subscribe — a transient feed hiccup must not block the add;
    // the poller re-subscribes every WATCHING token on its cron regardless.
    try {
      await this.feed.subscribe([token]);
    } catch (err) {
      this.logger.warn(
        `[stock-monitor] feed subscribe failed for ${token}: ${err instanceof Error ? err.message : err}`,
      );
    }

    const quote = this.feed.getQuote(token);
    const referencePrice = quote && quote.ltp > 0 ? quote.ltp : null;
    const targetPrice =
      referencePrice !== null
        ? computeTargetPrice(referencePrice, targetPercent)
        : null;

    try {
      const row = await this.prisma.stockMonitor.create({
        data: {
          userId,
          symbol,
          exchange,
          token,
          targetPercent,
          referencePrice,
          targetPrice,
          status: 'WATCHING',
          lastLtp: referencePrice,
          currentPercent: referencePrice !== null ? 0 : null,
        },
      });
      return toStockMonitorDto(row);
    } catch (err) {
      if (
        err instanceof Prisma.PrismaClientKnownRequestError &&
        err.code === 'P2002'
      ) {
        throw new ConflictException(
          `${symbol} is already being monitored.`,
        );
      }
      throw err;
    }
  }

  /** The caller's monitors, newest first, mapped to the §4.5 DTO. */
  async list(userId: string): Promise<StockMonitorDto[]> {
    const rows = await this.prisma.stockMonitor.findMany({
      where: { userId },
      orderBy: { createdAt: 'desc' },
    });
    return rows.map(toStockMonitorDto);
  }

  /** Delete the caller's monitor. Idempotent (scoped by [id, userId]). */
  async remove(userId: string, id: string): Promise<void> {
    await this.prisma.stockMonitor.deleteMany({ where: { id, userId } });
  }

  /**
   * Distinct tokens across ALL users' WATCHING monitors. Used by the poller to
   * (re)subscribe the feed. A deliberate system-level (cross-tenant) read from
   * the cron.
   */
  async distinctWatchingTokens(): Promise<string[]> {
    const rows = await this.prisma.stockMonitor.findMany({
      where: { status: 'WATCHING' },
      select: { token: true },
      distinct: ['token'],
    });
    return rows.map((r) => r.token);
  }

  /**
   * Fold the latest socket quote into every WATCHING monitor:
   *  - reference not yet captured → set it (+targetPrice) and skip the hit test;
   *  - otherwise update lastLtp + currentPercent, and if the price reached the
   *    target flip to TARGET_HIT and fire the alert exactly once.
   *
   * The flip uses a status-guarded `updateMany` (where status still WATCHING) so
   * a racing/re-sweep can never fire the same target twice.
   */
  async sweep(): Promise<void> {
    const monitors = await this.prisma.stockMonitor.findMany({
      where: { status: 'WATCHING' },
    });
    if (monitors.length === 0) return;

    const now = new Date();
    for (const monitor of monitors) {
      const quote = this.feed.getQuote(monitor.token);
      if (!quote || !(quote.ltp > 0)) continue;
      const ltp = quote.ltp;

      // First priced tick: capture the reference + target and skip the hit test.
      if (monitor.referencePrice === null) {
        const targetPrice = computeTargetPrice(ltp, monitor.targetPercent);
        await this.prisma.stockMonitor.updateMany({
          where: { id: monitor.id, userId: monitor.userId },
          data: {
            referencePrice: ltp,
            targetPrice,
            lastLtp: ltp,
            currentPercent: 0,
          },
        });
        continue;
      }

      const currentPercent = computePercent(monitor.referencePrice, ltp);

      if (isHit(ltp, monitor.targetPrice)) {
        // Atomic status guard → the row is flipped (and the alert fired) exactly
        // once even under overlapping sweeps.
        const res = await this.prisma.stockMonitor.updateMany({
          where: { id: monitor.id, userId: monitor.userId, status: 'WATCHING' },
          data: {
            status: 'TARGET_HIT',
            triggeredAt: now,
            lastLtp: ltp,
            currentPercent,
          },
        });
        if (res.count === 1) {
          await this.fireAlert(monitor, ltp, now);
        }
        continue;
      }

      // Below target — just record the latest price + progress.
      await this.prisma.stockMonitor.updateMany({
        where: { id: monitor.id, userId: monitor.userId },
        data: { lastLtp: ltp, currentPercent },
      });
    }
  }

  /**
   * Persist an `Alert` row for the caller and emit a best-effort WS `alert`
   * event. `prisma.alert.create` is used directly (not AlertsService, which
   * stamps the SYSTEM owner and can't set an already-triggered/inactive alert):
   * the alert is scoped to the monitor's owner, marked inactive, and stamped
   * `triggeredAt`. The WS emit is wrapped so a socket hiccup can never undo the
   * DB write.
   */
  private async fireAlert(
    monitor: StockMonitor,
    ltp: number,
    now: Date,
  ): Promise<void> {
    const targetPrice = monitor.targetPrice ?? ltp;
    const message = `${monitor.symbol} hit target +${monitor.targetPercent}% (₹${targetPrice})`;

    let alertId: string | null = null;
    try {
      const alert = await this.prisma.alert.create({
        data: {
          userId: monitor.userId,
          type: 'price',
          condition: 'above',
          value: targetPrice,
          message,
          isActive: false,
          triggeredAt: now,
        },
      });
      alertId = alert.id;
    } catch (err) {
      this.logger.warn(
        `[stock-monitor] alert persist failed for monitor ${monitor.id}: ${err instanceof Error ? err.message : err}`,
      );
    }

    // Best-effort WS toast — the frontend already listens for `alert` on /ws.
    try {
      this.gateway.server?.emit('alert', {
        id: alertId,
        monitorId: monitor.id,
        type: 'price',
        symbol: monitor.symbol,
        exchange: monitor.exchange,
        token: monitor.token,
        message,
        ltp,
        targetPrice,
        targetPercent: monitor.targetPercent,
        triggeredAt: now.toISOString(),
      });
    } catch (err) {
      this.logger.warn(
        `[stock-monitor] WS alert emit failed for monitor ${monitor.id}: ${err instanceof Error ? err.message : err}`,
      );
    }
  }
}
