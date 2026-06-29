import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { WatchStatus } from '@prisma/client';
import { AngelOneAdapterService } from '../../market-data/services/angel-one-adapter.service';
import { AdaptiveStopWatchRepository } from '../repositories/adaptive-stop-watch.repository';
import { AdaptiveStopWatchService } from './adaptive-stop-watch.service';
import { AdaptiveStopTradeExecutionService } from './adaptive-stop-trade-execution.service';
import { ExitPriceService } from '../../signal-generator/services/exit-price.service';

/**
 * REST-poll adaptive-stop open positions every 30 seconds during market hours.
 *
 * Why this exists: the broker's WebSocket subscription is capped around
 * 50 tokens, which the gated track already saturates (open positions +
 * NIFTY sectoral indices + chartink scanner rotation). Subscribing the
 * 40-slot adaptive-stop pool on top dropped silently — entries opened but
 * never received a single tick, so the 0.4% loss-cut and the
 * +1% partial-exit / target-hit transitions never fired.
 *
 * Path 2 (this file) sidesteps the cap entirely: one batched LTP call
 * fetches all open adaptive-stop tokens at once, then each `(token, ltp)`
 * routes through the existing `AdaptiveStopWatchService.onTick` which
 * already handles transitions idempotently.
 *
 * Trade-off vs WS: SL/target/partial-exit/trail fire within ≤ 30s of
 * breach instead of within seconds. Intra-30s peaks aren't captured on
 * the trailing-stop high-water — acceptable for the A/B experiment.
 */
@Injectable()
export class AdaptiveStopTickPoller {
  private readonly logger = new Logger(AdaptiveStopTickPoller.name);

  constructor(
    private readonly adapter: AngelOneAdapterService,
    private readonly repo: AdaptiveStopWatchRepository,
    private readonly watch: AdaptiveStopWatchService,
    private readonly exec: AdaptiveStopTradeExecutionService,
    private readonly exitPrice: ExitPriceService,
  ) {}

  // Every 30s, Mon–Fri, 09:15–15:30 IST. The cron format is
  // `sec min hour dow` — 6-field crontab. Pacing matches the spec's
  // documented 30-second poll cadence.
  @Cron('*/30 * 9-15 * * 1-5', { timeZone: 'Asia/Kolkata' })
  async pollOpenPositions(): Promise<void> {
    const open = await this.repo.findAllActive();
    const traded = open.filter((e) => e.status === 'TRADED');
    if (traded.length === 0) return;

    // Group by exchange. The adaptive-stop track is equity-only (spec §5.3),
    // so in practice this is one bucket: NSE. But keep the loop generic
    // in case a future fix relaxes that.
    const byExchange = new Map<string, string[]>();
    const tokenToEntries = new Map<string, typeof traded>();
    for (const e of traded) {
      const list = byExchange.get(e.exchange) ?? [];
      list.push(e.token);
      byExchange.set(e.exchange, list);
      const arr = tokenToEntries.get(e.token) ?? [];
      arr.push(e);
      tokenToEntries.set(e.token, arr);
    }

    const now = new Date();
    let dispatched = 0;
    for (const [exchange, tokens] of byExchange) {
      const priceMap = await this.exitPrice.resolveExitPrices(exchange, tokens);
      for (const [token, r] of priceMap) {
        if (!r.fresh) {
          this.logger.warn(`[adaptive-stop-poll] ${token} unmonitored — no fresh price, onTick skipped`);
          continue;
        }
        try {
          await this.watch.onTick(token, r.price, now);
          dispatched++;
        } catch (err) {
          this.logger.warn(
            `[adaptive-stop-poll] onTick(${token}) threw: ${err instanceof Error ? err.message : err}`,
          );
        }
      }
    }
    if (dispatched > 0) {
      this.logger.debug(
        `[adaptive-stop-poll] ${dispatched} ticks dispatched across ${traded.length} open entries`,
      );
    }
  }

  /**
   * EOD square-off at 15:15 IST Mon–Fri — mirrors the broker intraday (MIS)
   * auto-square-off, since every adaptive-stop position is INTRADAY.
   * Closes every TRADED adaptive-stop entry so stale open positions never
   * carry over to the next session and block tomorrow's re-entries
   * via the symbol-dup gate.
   */
  @Cron('0 15 15 * * 1-5', { timeZone: 'Asia/Kolkata' })
  async eodSquareOff(): Promise<SquareOffSummary> {
    this.logger.warn('[adaptive-stop-eod] EOD square-off starting');
    const all = await this.repo.findAllActive();
    const traded = all.filter((e) => e.status === WatchStatus.TRADED);
    if (traded.length === 0) {
      this.logger.log('[adaptive-stop-eod] no open positions to close');
      return { attempted: 0, closed: 0, skipped: 0, errors: 0 };
    }

    // Fetch live prices for a fair exit; fall back to last known price.
    const tokens = [...new Set(traded.map((e) => e.token))];
    const ltpMap = await this.adapter.getLtpsBatch('NSE', tokens).catch(() => new Map<string, number>());

    let closed = 0;
    let errors = 0;
    let skipped = 0;
    for (const entry of traded) {
      try {
        const exitPrice =
          ltpMap.get(entry.token) ??
          (entry as any).currentPrice ??
          (entry as any).executedPrice ??
          0;
        if (exitPrice <= 0) {
          this.logger.warn(`[adaptive-stop-eod] no exit price for ${entry.symbol} — skipping`);
          skipped++;
          continue;
        }
        if (entry.paperTradeId) {
          await this.exec.closeTrade(entry.paperTradeId, { reason: 'eod-square-off', exitPrice });
        }
        await this.repo.update(entry.id, {
          status: WatchStatus.EXITED,
          closedAt: new Date(),
          closedReason: 'eod-square-off',
        });
        closed++;
        this.logger.log(`[adaptive-stop-eod] closed ${entry.symbol} @ ₹${exitPrice}`);
      } catch (err) {
        this.logger.warn(
          `[adaptive-stop-eod] failed to close ${entry.symbol}: ${err instanceof Error ? err.message : err}`,
        );
        errors++;
      }
    }
    this.logger.warn(`[adaptive-stop-eod] done — closed=${closed} skipped=${skipped} errors=${errors}`);
    return { attempted: traded.length, closed, skipped, errors };
  }
}

export interface SquareOffSummary {
  attempted: number;
  closed: number;
  skipped: number;
  errors: number;
}
