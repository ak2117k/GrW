import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { AnandDualTrackRepository } from '../repositories/anand-dual-track.repository';
import { AngelOneAdapterService } from '../../market-data/services/angel-one-adapter.service';
import { supertrend } from '../../signal-generator/strategies/indicators';
import { ReinvestmentService } from './reinvestment.service';
import { ExitPriceService } from '../../signal-generator/services/exit-price.service';

@Injectable()
export class AnandPriceMonitorService {
  private readonly logger = new Logger(AnandPriceMonitorService.name);

  constructor(
    private readonly repo: AnandDualTrackRepository,
    private readonly adapter: AngelOneAdapterService,
    private readonly reinvest: ReinvestmentService,
    private readonly exitPrice: ExitPriceService,
  ) {}

  // Poll both tracks every 30s during market hours Mon–Fri 09:15–15:15 IST.
  @Cron('*/30 * 9-15 * * 1-5', { timeZone: 'Asia/Kolkata' })
  async pollMarketHours(): Promise<void> {
    const [intraday, swing] = await Promise.all([
      this.repo.listWatchingIntraday(),
      this.repo.listWatchingSwing(),
    ]);

    await this.checkIntraday(intraday as any);
    await this.checkEntries(swing, 'swing');
    await this.checkReinvestmentLots();
  }

  // Expire all open intraday entries at 15:15 IST (market close), marking each
  // to its last traded price. Recording exitPrice (rather than leaving it null)
  // is what makes an expired trade count toward realized P&L as its true
  // gain/loss — without it, only TARGET_HIT winners ever carried an exitPrice,
  // so the P&L summary silently summed winners only (100% win rate, inflated).
  @Cron('15 15 15 * * 1-5', { timeZone: 'Asia/Kolkata' })
  async expireIntradayAtClose(): Promise<void> {
    const entries = await this.repo.listWatchingIntraday();
    if (entries.length === 0) {
      this.logger.log('[anand-intraday] no open entries to expire at close');
      return;
    }

    const tokens = [...new Set(entries.map((e) => e.token).filter((t): t is string => !!t))];
    const ltpMap = tokens.length
      ? await this.adapter.getLtpsBatch('NSE', tokens).catch(() => new Map<string, number>())
      : new Map<string, number>();

    const now = new Date();
    let count = 0;
    for (const entry of entries) {
      const ltp = entry.token ? ltpMap.get(entry.token) : undefined;
      // Mark to market at the close LTP. Fall back to entryPrice (breakeven,
      // 0% — neither win nor loss) when no price is available, so the trade is
      // still closed and counted instead of being dropped from P&L.
      const exitPrice = ltp ?? entry.entryPrice;
      if (ltp === undefined) {
        this.logger.warn(
          `[anand-intraday] ${entry.id} (${entry.symbol}) expired with no LTP — marked breakeven at entry ${entry.entryPrice}`,
        );
      }
      await this.repo.updateIntradayStatus(entry.id, {
        status: 'EXPIRED',
        exitPrice,
        exitedAt: now,
      });
      count++;
    }
    this.logger.log(`[anand-intraday] expired ${count} entries (marked to market) at market close`);
  }

  // Poll swing entries every 10 min always; guard skips during market hours
  // (09:15–15:30 IST) since pollMarketHours covers that window.
  @Cron('0 */10 * * * *', { timeZone: 'Asia/Kolkata' })
  async pollOvernight(): Promise<void> {
    // Determine current IST hour+minute to skip the market-hours window.
    const nowUtc = new Date();
    const istOffsetMs = 5.5 * 60 * 60 * 1000;
    const istNow = new Date(nowUtc.getTime() + istOffsetMs);
    const istMinutes = istNow.getUTCHours() * 60 + istNow.getUTCMinutes();

    // Market hours: 09:15–15:30 IST → 555–930 minutes-since-midnight
    const MARKET_OPEN = 9 * 60 + 15;   // 555
    const MARKET_CLOSE = 15 * 60 + 30; // 930
    if (istMinutes >= MARKET_OPEN && istMinutes < MARKET_CLOSE) {
      return; // pollMarketHours handles this window
    }

    const swing = await this.repo.listWatchingSwing();
    await this.checkEntries(swing, 'swing');
    await this.checkReinvestmentLots();
  }

  private static readonly TRAIL_GIVEBACK = 0.02; // 2% give-back fallback
  private static readonly PARTIAL_TRIGGER_PCT = 3;
  private static readonly PARTIAL_FRACTION = 0.5;

  /**
   * Pure trailing decision for one intraday entry.
   * @param stLine current Supertrend(10,3) 15m line value, or null if unavailable
   *
   * `stopMovedToBE` reflects that the partial (50% @ +3%) has been booked and
   * the remaining runner's hard stop is now breakeven (0%) instead of −stopPct.
   */
  static decideIntradayTrail(
    entry: {
      entryPrice: number;
      targetPct: number;
      stopPct: number;
      trailing: boolean;
      peakPrice: number | null;
      stopMovedToBE: boolean;
    },
    ltp: number,
    stLine: number | null,
  ):
    | { action: 'HOLD'; peakPrice: number }
    | { action: 'ARM_TRAIL'; peakPrice: number }
    | { action: 'STOP' }
    | { action: 'EXIT'; exitReason: 'TRAIL_ST' | 'TRAIL_GB'; peakPrice: number } {
    const pnlPct = ((ltp - entry.entryPrice) / entry.entryPrice) * 100;

    if (!entry.trailing) {
      if (pnlPct >= entry.targetPct) return { action: 'ARM_TRAIL', peakPrice: ltp };
      // Once the partial is booked the runner's hard stop is breakeven (0%);
      // otherwise the original −stopPct applies.
      if (pnlPct <= (entry.stopMovedToBE ? 0 : -entry.stopPct)) return { action: 'STOP' };
      return { action: 'HOLD', peakPrice: ltp };
    }

    const peak = Math.max(entry.peakPrice ?? ltp, ltp);
    // A breakeven'd runner can never be allowed to go red — floor at entry.
    if (entry.stopMovedToBE && ltp <= entry.entryPrice) return { action: 'STOP' };
    if (stLine != null) {
      if (ltp < stLine) return { action: 'EXIT', exitReason: 'TRAIL_ST', peakPrice: peak };
      return { action: 'HOLD', peakPrice: peak };
    }
    // Fallback: 2% give-back from the running peak.
    if (ltp <= peak * (1 - AnandPriceMonitorService.TRAIL_GIVEBACK)) {
      return { action: 'EXIT', exitReason: 'TRAIL_GB', peakPrice: peak };
    }
    return { action: 'HOLD', peakPrice: peak };
  }

  /** Latest Supertrend(10,3) line on 15m candles, or null if not enough data. */
  private async supertrend15m(token: string): Promise<number | null> {
    const to = new Date();
    const from = new Date(to.getTime() - 6 * 24 * 60 * 60 * 1000); // ~6 calendar days
    // Note: across long weekends/holidays this ~6-calendar-day window can shrink
    // to a single trading session, yielding < 11 bars; we then return null and
    // the caller intentionally falls back to the 2% give-back trailing stop.
    const candles = await this.adapter
      .getHistoricalData(token, 'NSE', '15m', from, to)
      .catch(() => [] as any[]);
    if (!Array.isArray(candles) || candles.length < 11) return null;
    const highs = candles.map((c) => Number(c.high));
    const lows = candles.map((c) => Number(c.low));
    const closes = candles.map((c) => Number(c.close));
    const st = supertrend(highs, lows, closes, 10, 3);
    return st ? st.value : null;
  }

  /** Intraday checking with trailing. Replaces the generic path for intraday. */
  private async checkIntraday(
    entries: Array<{
      id: string;
      symbol: string;
      token: string | null;
      entryPrice: number;
      targetPct: number;
      stopPct: number;
      trailing: boolean;
      peakPrice: number | null;
      partialBookedAt?: Date | null;
      stopMovedToBE?: boolean | null;
    }>,
  ): Promise<void> {
    const withToken = entries.filter((e) => e.token);
    if (withToken.length === 0) return;
    const tokens = [...new Set(withToken.map((e) => e.token as string))];
    const priceMap = await this.exitPrice.resolveExitPrices('NSE', tokens);
    const now = new Date();

    for (const entry of withToken) {
      const r = priceMap.get(entry.token as string);
      if (!r || !r.fresh) {
        this.logger.warn(`[anand-intraday] ${entry.id} unmonitored — no fresh price, stop not evaluated`);
        continue;
      }
      const ltp = r.price;

      // Supertrend only matters once we are already trailing — the decision for
      // a not-yet-trailing entry never consults stLine — so fetch the
      // rate-limited candles only then.
      const pnlPct = ((ltp - entry.entryPrice) / entry.entryPrice) * 100;

      // Partial profit-booking: at +3%, book 50% at the fresh price and move the
      // remaining runner's stop to breakeven. Happens once per entry — the
      // `!entry.partialBookedAt` guard (the DB row is set after the first fire,
      // and listWatchingIntraday returns it) makes later ticks idempotent.
      let stopMovedToBE = entry.stopMovedToBE ?? false;
      if (!entry.partialBookedAt && pnlPct >= AnandPriceMonitorService.PARTIAL_TRIGGER_PCT) {
        await this.repo.recordIntradayPartial(entry.id, {
          partialExitPrice: ltp,
          partialFraction: AnandPriceMonitorService.PARTIAL_FRACTION,
          partialBookedAt: now,
          stopMovedToBE: true,
        });
        this.logger.log(
          `[anand-intraday] ${entry.id} (${entry.symbol}) partial ${AnandPriceMonitorService.PARTIAL_FRACTION * 100}% booked at +${pnlPct.toFixed(2)}% (₹${ltp}) — stop → breakeven`,
        );
        stopMovedToBE = true;
      }

      const stLine = entry.trailing ? await this.supertrend15m(entry.token as string) : null;

      const d = AnandPriceMonitorService.decideIntradayTrail({ ...entry, stopMovedToBE }, ltp, stLine);
      if (d.action === 'STOP') {
        this.logger.log(`[anand-intraday] ${entry.id} STOPPED at ${ltp} (${pnlPct.toFixed(2)}%)`);
        await this.repo.updateIntradayStatus(entry.id, { status: 'STOPPED', exitPrice: ltp, exitedAt: now });
      } else if (d.action === 'ARM_TRAIL') {
        this.logger.log(`[anand-intraday] ${entry.id} reached +${pnlPct.toFixed(2)}% — arming trail`);
        await this.repo.setIntradayTrailing(entry.id, { trailing: true, peakPrice: d.peakPrice });
      } else if (d.action === 'EXIT') {
        this.logger.log(`[anand-intraday] ${entry.id} TARGET_HIT via ${d.exitReason} at ${ltp} (+${pnlPct.toFixed(2)}%)`);
        await this.repo.updateIntradayStatus(entry.id, { status: 'TARGET_HIT', exitPrice: ltp, exitedAt: now, exitReason: d.exitReason });
      } else if (entry.trailing && d.peakPrice > (entry.peakPrice ?? 0)) {
        await this.repo.setIntradayTrailing(entry.id, { trailing: true, peakPrice: d.peakPrice });
      }
    }
  }

  private async checkEntries(
    entries: Array<{ id: string; symbol: string; token: string | null; entryPrice: number; targetPct: number; stopPct: number }>,
    track: 'intraday' | 'swing',
  ): Promise<void> {
    const withToken = entries.filter((e) => e.token);
    if (withToken.length === 0) return;

    const tokens = [...new Set(withToken.map((e) => e.token as string))];
    const priceMap = await this.exitPrice.resolveExitPrices('NSE', tokens);

    const now = new Date();
    for (const entry of withToken) {
      const r = priceMap.get(entry.token as string);
      if (!r || !r.fresh) {
        this.logger.warn(`[anand-${track}] ${entry.symbol} unmonitored — no fresh price, stop not evaluated`);
        continue;
      }
      const ltp = r.price;

      const pnlPct = ((ltp - entry.entryPrice) / entry.entryPrice) * 100;

      if (pnlPct >= entry.targetPct) {
        this.logger.log(`[anand-${track}] ${entry.id} TARGET_HIT at ${ltp} (+${pnlPct.toFixed(2)}%)`);
        if (track === 'intraday') {
          await this.repo.updateIntradayStatus(entry.id, { status: 'TARGET_HIT', exitPrice: ltp, exitedAt: now });
        } else {
          await this.repo.updateSwingStatus(entry.id, { status: 'TARGET_HIT', exitPrice: ltp, exitedAt: now });
          await this.reinvest
            .onSwingTargetHit({ swingEntryId: entry.id, symbol: entry.symbol, exitPrice: ltp })
            .catch((err) => this.logger.warn(`[reinvest] failed for ${entry.id}: ${err instanceof Error ? err.message : err}`));
        }
      } else if (pnlPct <= -entry.stopPct) {
        this.logger.log(`[anand-${track}] ${entry.id} STOPPED at ${ltp} (${pnlPct.toFixed(2)}%)`);
        await (track === 'intraday'
          ? this.repo.updateIntradayStatus(entry.id, { status: 'STOPPED', exitPrice: ltp, exitedAt: now })
          : this.repo.updateSwingStatus(entry.id, { status: 'STOPPED', exitPrice: ltp, exitedAt: now }));
      }
    }
  }

  private async checkReinvestmentLots(): Promise<void> {
    const lots = await this.repo.listOpenReinvestmentLots();
    if (lots.length === 0) return;
    // Lots store symbol but not token; resolve the token via the most-recent
    // swing entry for each symbol. Lots whose token/LTP is unavailable are
    // skipped in the loop below.
    const symbols = [...new Set(lots.map((l) => l.symbol))];
    const tokenMap = await this.repo.resolveTokens(symbols).catch(() => new Map<string, string>());
    const tokens = [...new Set([...tokenMap.values()])];
    const priceMap = tokens.length
      ? await this.exitPrice.resolveExitPrices('NSE', tokens)
      : new Map<string, import('../../signal-generator/services/exit-price.service').ExitPrice>();

    for (const lot of lots) {
      const token = tokenMap.get(lot.symbol);
      const r = token ? priceMap.get(token) : undefined;
      if (!r || !r.fresh) {
        this.logger.warn(`[anand-reinvest] ${lot.symbol} unmonitored — no fresh price, stop not evaluated`);
        continue;
      }
      const ltp = r.price;
      const pnlPct = ((ltp - lot.entryPrice) / lot.entryPrice) * 100;
      if (pnlPct >= lot.targetPct) {
        await this.reinvest.closeLot({ id: lot.id, capital: lot.capital, entryPrice: lot.entryPrice }, ltp, 'TARGET_HIT');
      } else if (pnlPct <= -lot.stopPct) {
        await this.reinvest.closeLot({ id: lot.id, capital: lot.capital, entryPrice: lot.entryPrice }, ltp, 'STOPPED');
      }
    }
  }
}
