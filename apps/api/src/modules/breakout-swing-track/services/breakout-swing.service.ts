import { Injectable, Logger } from '@nestjs/common';
import { BreakoutSwingRepository } from '../repositories/breakout-swing.repository';
import { AngelOneAdapterService } from '../../market-data/services/angel-one-adapter.service';
import { detectSwingPivots } from '../../signal-generator/services/swing-pivots';
import { NEAR_RES_PCT, LIMIT_PCT } from '../constants';

/**
 * Thrown by createFromAlert whenever the breakout setup is not admitted (no live
 * quote, no nearby resistance, not above prev close, already active today, …).
 * The caller logs the reason — a reject is a normal, expected outcome.
 */
export class BreakoutSwingRejectError extends Error {
  constructor(public readonly symbol: string, public readonly reason: string) {
    super(`breakout-swing: ${symbol} rejected — ${reason}`);
    this.name = 'BreakoutSwingRejectError';
  }
}

export interface BreakoutSwingCreateFromAlertInput {
  alertId: string;
  symbol: string;
  token: string | null;
  hitPrice: number;
  scoreBreakdown: unknown;
}

@Injectable()
export class BreakoutSwingService {
  private readonly logger = new Logger(BreakoutSwingService.name);

  constructor(
    private readonly repo: BreakoutSwingRepository,
    private readonly adapter: AngelOneAdapterService,
  ) {}

  /** IST midnight of the current day, returned as a UTC Date. */
  private istMidnightTodayUtc(): Date {
    const now = new Date();
    const istNow = new Date(now.getTime() + 5.5 * 60 * 60 * 1000);
    istNow.setUTCHours(0, 0, 0, 0);
    return new Date(istNow.getTime() - 5.5 * 60 * 60 * 1000);
  }

  /**
   * Nearest resistance ABOVE `price`, derived from multi-day 15m swing-pivot
   * highs (3-bar fractal). Returns null when no pivot high sits above price.
   */
  private async nearestResistance(token: string, price: number): Promise<number | null> {
    const to = new Date();
    const from = new Date(to.getTime() - 7 * 24 * 60 * 60 * 1000); // ~5-7 trading days of 15m
    const candles = await this.adapter
      .getHistoricalData(token, 'NSE', '15m', from, to)
      .catch(() => [] as any[]);
    if (!Array.isArray(candles) || candles.length < 7) return null;
    const pivots = detectSwingPivots(
      candles.map((c) => ({ high: Number(c.high), low: Number(c.low) })),
    );
    const highsAbove = pivots
      .filter((p) => p.kind === 'high' && p.price > price)
      .map((p) => p.price);
    if (highsAbove.length === 0) return null;
    return Math.min(...highsAbove);
  }

  /**
   * Previous trading day's CLOSE for the token, from a daily candle. Returns the
   * close of the most recent COMPLETED daily bar before today (IST), or null.
   */
  private async prevDayClose(token: string): Promise<number | null> {
    const to = new Date();
    const from = new Date(to.getTime() - 10 * 24 * 60 * 60 * 1000); // window covers weekends/holidays
    const candles = await this.adapter
      .getHistoricalData(token, 'NSE', '1d', from, to)
      .catch(() => [] as any[]);
    if (!Array.isArray(candles) || candles.length === 0) return null;
    const todayMid = this.istMidnightTodayUtc().getTime();
    // Most recent daily bar that opened before today's IST midnight = prior session.
    let prevClose: number | null = null;
    for (const c of candles) {
      const t = new Date(c.timestamp ?? c.time ?? c[0]).getTime();
      if (Number.isNaN(t) || t >= todayMid) continue;
      prevClose = Number(c.close ?? c[4]);
    }
    return prevClose != null && prevClose > 0 ? prevClose : null;
  }

  /**
   * Breakout-swing entry. Creates a QUEUED resting limit-buy when the stock is
   * near a multi-day resistance AND above the prior day's close. Throws
   * BreakoutSwingRejectError on any reject.
   */
  async createFromAlert(input: BreakoutSwingCreateFromAlertInput): Promise<{ id: string }> {
    const { symbol } = input;
    if (!input.token) throw new BreakoutSwingRejectError(symbol, 'no instrument token');
    const token = input.token;

    // Dedup: skip if the symbol already has an active QUEUED/TRADED entry. This
    // is all-time (not "today") because QUEUED resting limits are GTC — they
    // persist until filled — so a still-resting order from a prior day must
    // block a duplicate when the scan re-fires the same symbol.
    const active = await this.repo.findActiveBySymbol(symbol);
    if (active) throw new BreakoutSwingRejectError(symbol, 'already has an active QUEUED/TRADED entry');

    // 1. Live quote — reject when unavailable (entering at a stale Chartink price
    //    is worse than skipping).
    let price: number | null = null;
    try {
      const live = await this.adapter.getLiveQuote(token, 'NSE');
      if (live?.ltp && live.ltp > 0) price = live.ltp;
    } catch (err) {
      this.logger.warn(`[breakout-swing] live quote failed for ${symbol}: ${err instanceof Error ? err.message : err}`);
    }
    if (price == null) throw new BreakoutSwingRejectError(symbol, 'live quote unavailable');

    // 2. Nearest resistance above the current price (multi-day 15m pivots).
    const resistance = await this.nearestResistance(token, price);
    if (resistance == null) throw new BreakoutSwingRejectError(symbol, 'no resistance found above current price');

    // 3. Gate A — NEAR RESISTANCE: price within NEAR_RES_PCT below the resistance.
    const distPct = ((resistance - price) / resistance) * 100;
    if (distPct > NEAR_RES_PCT) {
      throw new BreakoutSwingRejectError(
        symbol,
        `not near resistance (${distPct.toFixed(2)}% below ₹${resistance}, need ≤ ${NEAR_RES_PCT}%)`,
      );
    }

    // 4. Gate B — ABOVE PREV CLOSE: current price > previous day's close.
    const prevClose = await this.prevDayClose(token);
    if (prevClose == null) throw new BreakoutSwingRejectError(symbol, 'previous-day close unavailable');
    if (price <= prevClose) {
      throw new BreakoutSwingRejectError(symbol, `not above prev close (₹${price} ≤ ₹${prevClose})`);
    }

    // 5. Both gates pass — queue the resting limit-buy. No score filter.
    const limitPrice = price * (1 + LIMIT_PCT / 100);
    const created = await this.repo.createQueuedEntry({
      symbol,
      token,
      alertId: input.alertId,
      scoreBreakdown: input.scoreBreakdown,
      signalPrice: price,
      resistance,
      prevDayClose: prevClose,
      limitPrice,
    });
    this.logger.log(
      `[breakout-swing] ${symbol} QUEUED — signal ₹${price.toFixed(2)}, ` +
        `resistance ₹${resistance.toFixed(2)} (${distPct.toFixed(2)}% away), ` +
        `prevClose ₹${prevClose.toFixed(2)}, limit ₹${limitPrice.toFixed(2)}`,
    );
    return created;
  }
}
