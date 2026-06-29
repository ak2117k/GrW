import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { WatchStatus } from '@prisma/client';
import { AngelOneAdapterService } from '../../market-data/services/angel-one-adapter.service';
import { UngatedWatchRepository } from '../repositories/ungated-watch.repository';
import { UngatedWatchService } from './ungated-watch.service';
import { UngatedTradeExecutionService } from './ungated-trade-execution.service';
import { ExitPriceService } from '../../signal-generator/services/exit-price.service';

/**
 * REST-poll ungated open positions every 30 seconds during market hours.
 *
 * Why this exists: the broker's WebSocket subscription is capped around
 * 50 tokens, which the gated track already saturates (open positions +
 * NIFTY sectoral indices + chartink scanner rotation). Subscribing the
 * 40-slot ungated pool on top dropped silently — entries opened but
 * never received a single tick, so the 0.4% loss-cut and the
 * +1% partial-exit / target-hit transitions never fired.
 *
 * Path 2 (this file) sidesteps the cap entirely: one batched LTP call
 * fetches all open ungated tokens at once, then each `(token, ltp)`
 * routes through the existing `UngatedWatchService.onTick` which
 * already handles transitions idempotently.
 *
 * Trade-off vs WS: SL/target/partial-exit/trail fire within ≤ 30s of
 * breach instead of within seconds. Intra-30s peaks aren't captured on
 * the trailing-stop high-water — acceptable for the A/B experiment.
 */
@Injectable()
export class UngatedTickPoller {
  private readonly logger = new Logger(UngatedTickPoller.name);

  constructor(
    private readonly adapter: AngelOneAdapterService,
    private readonly repo: UngatedWatchRepository,
    private readonly watch: UngatedWatchService,
    private readonly exec: UngatedTradeExecutionService,
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

    // Group by exchange. The ungated track is equity-only (spec §5.3),
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
          this.logger.warn(`[ungated-poll] ${token} unmonitored — no fresh price, onTick skipped`);
          continue;
        }
        try {
          await this.watch.onTick(token, r.price, now);
          dispatched++;
        } catch (err) {
          this.logger.warn(
            `[ungated-poll] onTick(${token}) threw: ${err instanceof Error ? err.message : err}`,
          );
        }
      }
    }
    if (dispatched > 0) {
      this.logger.debug(
        `[ungated-poll] ${dispatched} ticks dispatched across ${traded.length} open entries`,
      );
    }
  }

  /**
   * EOD square-off at 15:25 IST Mon–Fri.
   * Closes every TRADED ungated entry so stale open positions never
   * carry over to the next session and block tomorrow's re-entries
   * via the symbol-dup gate.
   */
  @Cron('0 25 15 * * 1-5', { timeZone: 'Asia/Kolkata' })
  async eodSquareOff(): Promise<void> {
    this.logger.warn('[ungated-eod] EOD square-off starting');
    const all = await this.repo.findAllActive();
    const traded = all.filter((e) => e.status === WatchStatus.TRADED);
    if (traded.length === 0) {
      this.logger.log('[ungated-eod] no open positions to close');
      return;
    }

    // Fetch live prices for a fair exit; fall back to last known price.
    const tokens = [...new Set(traded.map((e) => e.token))];
    const ltpMap = await this.adapter.getLtpsBatch('NSE', tokens).catch(() => new Map<string, number>());

    let closed = 0;
    let errors = 0;
    for (const entry of traded) {
      try {
        const exitPrice =
          ltpMap.get(entry.token) ??
          (entry as any).currentPrice ??
          (entry as any).executedPrice ??
          0;
        if (exitPrice <= 0) {
          this.logger.warn(`[ungated-eod] no exit price for ${entry.symbol} — skipping`);
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
        this.logger.log(`[ungated-eod] closed ${entry.symbol} @ ₹${exitPrice}`);
      } catch (err) {
        this.logger.warn(
          `[ungated-eod] failed to close ${entry.symbol}: ${err instanceof Error ? err.message : err}`,
        );
        errors++;
      }
    }
    this.logger.warn(`[ungated-eod] done — closed=${closed} errors=${errors}`);
  }
}
