import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { WatchRepository } from '../repositories/watch.repository';
import { WatchService, MAX_INVESTMENT_PER_TRADE } from './watch.service';

/**
 * Two non-negotiable risk rules for intraday trading:
 *   1. EOD square-off at 15:25 IST every trading day.
 *   2. Cumulative daily loss circuit breaker at -₹60,000.
 *
 * Both call WatchService.squareOffAll(reason) which transitions every active
 * (WATCHING or TRADED) watch entry to its terminal state, closing real trades
 * via TradeExecutionService where applicable.
 */
@Injectable()
export class RiskGuardService {
  private readonly logger = new Logger(RiskGuardService.name);

  // Tunable: max cumulative loss (negative ₹) for the day before the breaker trips.
  // Compared against the SUM of all today's TRADED entries' (current - executed) × qty × sideMul.
  static readonly DAILY_LOSS_LIMIT_RUPEES = 60_000;

  constructor(
    private readonly repo: WatchRepository,
    private readonly watch: WatchService,
  ) {}

  /**
   * Sum (currentPrice − executedPrice) × qty × sideMul across all
   * TRADED entries with executedAt today (IST date). Positive = profit,
   * negative = loss.
   * Dynamic qty: floor(MAX_INVESTMENT_PER_TRADE / executedPrice) — matches
   * WatchController.execute's sizing so breaker tracks actual ₹ exposure.
   */
  async computeDailyPnL(): Promise<{ pnl: number; breakdown: Array<{ symbol: string; pnl: number }> }> {
    const tradedToday = await this.repo.findTradedToday();
    let total = 0;
    const breakdown: Array<{ symbol: string; pnl: number }> = [];
    for (const e of tradedToday) {
      const ref = (e as any).executedPrice ?? (e as any).initialPrice;
      const curr = (e as any).currentPrice ?? ref;
      const sideMul = (e as any).side === 'BUY' ? 1 : -1;
      // Real open quantity (trailing remainder, else full filled quantity);
      // floor(MAX/price) is only a fallback for legacy entries with no qty.
      const qty =
        (e as any).remainingQty ??
        (e as any).quantity ??
        Math.max(1, Math.floor(MAX_INVESTMENT_PER_TRADE / Math.max(ref, 1)));
      const pnl = (curr - ref) * qty * sideMul;
      total += pnl;
      breakdown.push({ symbol: (e as any).symbol, pnl });
    }
    return { pnl: total, breakdown };
  }

  /**
   * Check the loss limit. Returns true if breaker tripped (and square-off
   * initiated). Called from WatchMonitorService.tickAll's 60s loop.
   */
  async checkAndTrip(): Promise<boolean> {
    const { pnl, breakdown } = await this.computeDailyPnL();
    if (pnl <= -RiskGuardService.DAILY_LOSS_LIMIT_RUPEES) {
      this.logger.warn(
        `DAILY LOSS LIMIT HIT: pnl=₹${pnl.toFixed(0)} (limit=-₹${RiskGuardService.DAILY_LOSS_LIMIT_RUPEES}). Squaring off all positions.`,
      );
      this.logger.warn(`Breakdown: ${breakdown.map((b) => `${b.symbol}=${b.pnl.toFixed(0)}`).join(', ')}`);
      await this.watch.squareOffAll('daily-loss-breaker');
      return true;
    }
    return false;
  }

  /**
   * Cron: every weekday at 15:25 IST. Cron expression uses server time;
   * if server is in IST (which it is on Aryan's Windows machine), the
   * literal '25 15 * * 1-5' fires at 15:25 IST. If server were in UTC we'd
   * need '55 9 * * 1-5' (15:25 IST = 09:55 UTC).
   *
   * 15:25 not 15:30 to give the broker 5 minutes to acknowledge close
   * orders before the actual market close at 15:30.
   */
  @Cron('25 15 * * 1-5', { name: 'eod-square-off' })
  async eodSquareOff(): Promise<void> {
    this.logger.warn('EOD square-off cron fired (15:25 IST) — closing all positions');
    await this.watch.squareOffAll('eod-square-off');
  }
}
